import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { affectedVersion, auditBroker, classifyQuery, collectAudit, main, normalizeVersion, parseInventory, parseJsonStream, queryBatches } from "./audit-go-dependencies.mjs";

const cwd = resolve("fixture-broker");
const environment = { GOVERSION: "go1.27.0", GOMOD: join(cwd, "go.mod") };
const root = { Path: "example.com/broker", Main: true };
const dependency = { Path: "example.com/unimported", Version: "v1.2.3" };
const modules = [{ path: dependency.Path, version: dependency.Version }];
const config = { config: { protocol_version: "v1.0.0", scanner_name: "govulncheck", scanner_version: "v1.9.0", scan_mode: "query" } };
const stream = (...records) => records.map((record) => JSON.stringify(record, null, 2)).join("\n");
const ranges = (...events) => [{ type: "SEMVER", events }];
function advisory(id = "GO-2026-0001", affectedRanges = ranges({ introduced: "0" }, { fixed: "2.0.0" }), extra = {}) {
	return { osv: { id, summary: "Fixture advisory", affected: [{ package: { name: dependency.Path, ecosystem: "Go" }, ...(affectedRanges === undefined ? {} : { ranges: affectedRanges }) }], ...extra } };
}
function directory(t) {
	const path = mkdtempSync(join(tmpdir(), "volt-go-audit-test-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}
function executor(queryResult = { status: 0, stdout: stream(config), stderr: "query diagnostics" }) {
	return (command, args, selectedDirectory, timeout) => {
		assert.equal(selectedDirectory, cwd);
		assert(timeout > 0 && timeout <= 120_000);
		if (command === "go" && args[0] === "env") {
			assert.deepEqual(args, ["env", "-json", "GOVERSION", "GOMOD"]);
			return { status: 0, stdout: stream(environment), stderr: "" };
		}
		if (command === "go") {
			assert.deepEqual(args, ["list", "-mod=readonly", "-m", "-json", "all"]);
			return { status: 0, stdout: stream(root, dependency), stderr: "" };
		}
		assert.equal(command, "govulncheck");
		assert.deepEqual(args, ["-mode=query", "-json", "example.com/unimported@v1.2.3", "stdlib@v1.27.0"]);
		return queryResult;
	};
}

test("JSON streams preserve nested objects, escaped quotes and braces inside strings", () => {
	const values = [{ value: 'a \\" } {', nested: [{ value: {} }] }, { config: {} }];
	assert.deepEqual(parseJsonStream(` \n${stream(...values)}\n`), values);
	for (const value of ["", " ", "null", "[]", "{}junk", '{"a":', "{} {", '{"a": [}', '{"a":"unterminated}']) assert.throws(() => parseJsonStream(value));
});

test("inventory includes unimported modules, versioned replacements and actual stdlib; only main is excluded", () => {
	const replaced = { Path: "example.com/original", Version: "v1.0.0", Replace: { Path: "example.com/fork", Version: "v2.1.0+incompatible" } };
	const duplicateReplacement = { Path: "example.com/other", Version: "v0.0.0", Replace: replaced.Replace };
	const inventory = parseInventory(stream(root, dependency, replaced, duplicateReplacement), environment, cwd);
	assert.equal(inventory.mainModule, root.Path);
	assert.equal(inventory.goVersion, "go1.27.0");
	assert.deepEqual(inventory.modules, [
		{ path: "example.com/fork", version: "v2.1.0+incompatible" },
		...modules,
		{ path: "stdlib", version: "v1.27.0" },
	]);
	assert.equal(parseInventory(stream(root), { ...environment, GOVERSION: "go1.28rc2" }, cwd).modules[0].version, "v1.28.0-rc.2");
});

for (const [name, entries] of [
	["missing main", [dependency]],
	["multiple mains", [root, { Path: "example.com/other", Main: true }]],
	["duplicate paths", [root, dependency, dependency]],
	["inventory error", [root, { ...dependency, Error: { Err: "missing go.sum" } }]],
	["missing version", [root, { Path: dependency.Path }]],
	["local replacement", [root, { ...dependency, Replace: { Path: "../local" } }]],
	["replacement error", [root, { ...dependency, Replace: { Path: "example.com/fork", Version: "v1.0.0", Error: {} } }]],
	["invalid version", [root, { ...dependency, Version: "latest" }]],
	["invalid path", [root, { ...dependency, Path: "-option" }]],
]) test(`inventory fails closed: ${name}`, () => assert.throws(() => parseInventory(stream(...entries), environment, cwd)));

test("inventory rejects wrong go.mod and unknown toolchain versions", () => {
	assert.throws(() => parseInventory(stream(root), { ...environment, GOMOD: join(cwd, "other.mod") }, cwd));
	assert.throws(() => parseInventory(stream(root), { ...environment, GOVERSION: "devel" }, cwd));
});

test("query batches retain every module and bound count and byte length", () => {
	const inventory = Array.from({ length: 180 }, (_, index) => ({ path: `example.com/${"long".repeat(index % 50)}/${index}`, version: "v1.0.0" }));
	const batches = queryBatches(inventory);
	assert.deepEqual(batches.flat(), inventory);
	for (const batch of batches) {
		assert(batch.length <= 64);
		assert(batch.reduce((sum, module) => sum + Buffer.byteLength(`${module.path}@${module.version}`) + 1, 0) <= 4096);
	}
	assert.throws(() => queryBatches([{ path: "x".repeat(5000), version: "v1.0.0" }]));
	const collected = collectAudit({ cwd, execute: executor() });
	assert.deepEqual(collected.queries.flatMap((query) => query.modules), collected.inventory.modules);
});

for (const [version, expected] of [["v0.9.9", false], ["v1.0.0", true], ["v1.9.9", true], ["v2.0.0", false], ["v2.5.0", true], ["v3.0.0", true]]) {
	test(`Go OSV disjoint range boundaries: ${version}`, () => {
		assert.equal(affectedVersion(ranges({ introduced: "1.0.0" }, { fixed: "2.0.0" }, { introduced: "2.5.0" }), version), expected);
	});
}

test("Go version semantics include beginning of time, absent ranges, prereleases, pseudo-versions and build metadata", () => {
	assert.equal(affectedVersion(undefined, "v1.0.0"), true);
	assert.equal(affectedVersion([], "v1.0.0"), true);
	assert.equal(affectedVersion(ranges({ introduced: "0" }, { fixed: "1.0.0" }), "v0.0.0"), true);
	assert.equal(affectedVersion(ranges({ introduced: "1.0.0-beta.1" }, { fixed: "1.0.0" }), "v1.0.0-rc.1"), true);
	assert.equal(affectedVersion(ranges({ introduced: "0" }, { fixed: "0.0.0-20260202195803-dba9d589def2" }), "v0.0.0-20260202195802-aaaaaaaaaaaa"), true);
	assert.equal(affectedVersion(ranges({ introduced: "0" }, { fixed: "2.0.0" }), "v2.0.0+incompatible"), false);
	assert.equal(affectedVersion([...ranges({ introduced: "3.0.0" }), ...ranges({ introduced: "1.0.0" }, { fixed: "2.0.0" })], "v1.5.0"), true);
	assert.equal(normalizeVersion("go1.27"), "1.27.0");
	assert.equal(normalizeVersion("v1"), "1.0.0");
});

test("malformed or unsupported relevant ranges cannot silently produce a clean report", () => {
	for (const invalid of [null, {}, [{ type: "GIT", events: [] }], ranges(), ranges({ last_affected: "1.0.0" }), ranges({ introduced: "0", fixed: "1.0.0" }), ranges({ fixed: "1.0.0" }), ranges({ introduced: "0" }, { introduced: "1.0.0" }), ranges({ introduced: "bad" }), ranges({ introduced: "1.0.0" }, { fixed: "1.0.0" })]) {
		assert.throws(() => affectedVersion(invalid, "v1.2.3"));
	}
	assert.throws(() => affectedVersion([...ranges({ introduced: "0" }), { type: "GIT" }], "v1.2.3"));
});

test("query classification filters withdrawn and out-of-range candidates, matches exact module paths and deduplicates", () => {
	const matching = advisory();
	matching.osv.affected[0].ecosystem_specific = { imports: [{ path: "example.com/unimported/unused", goos: ["plan9"], symbols: ["NotCalled"] }] };
	const later = advisory("GO-2026-0002", ranges({ introduced: "2.0.0" }));
	const withdrawn = advisory("GO-2026-0003", undefined, { withdrawn: "2020-01-01T00:00:00Z" });
	const unrelated = advisory("GO-2026-0004");
	unrelated.osv.affected[0].package.name += "/other";
	const findings = classifyQuery(stream(config, { progress: { message: "querying" } }, matching, later, withdrawn, unrelated, matching), modules);
	assert.equal(findings.length, 1);
	assert.equal(findings[0].id, "GO-2026-0001");
	assert.equal(findings[0].module, dependency.Path);
	assert.deepEqual(findings[0].fixedVersions, ["v2.0.0"]);
	assert.equal(classifyQuery(stream(config), modules).length, 0);
});

test("query validates complete streams and pinned scanner protocol", () => {
	for (const mutation of [
		(report) => { report.config.scan_mode = "source"; },
		(report) => { report.config.scanner_version = "v1.8.0"; },
		(report) => { report.config.protocol_version = "v2.0.0"; },
		(report) => { report.extra = true; },
	]) {
		const invalid = structuredClone(config);
		mutation(invalid);
		assert.throws(() => classifyQuery(stream(invalid), modules));
	}
	for (const invalid of ["", "{}", `${stream(config)}{`, stream(config, config), stream(config, { finding: {} }), stream(config, { osv: { id: "GO-2026-0001" } })]) assert.throws(() => classifyQuery(invalid, modules));
	assert.throws(() => classifyQuery(stream(config, advisory("GO-2026-0001", undefined, { withdrawn: "bad" })), modules));
});

for (const [name, result] of [
	["malformed JSON", { status: 0, stdout: "bad" }],
	["truncated JSON", { status: 0, stdout: `${stream(config)}{` }],
	["missing executable", { status: null, error: new Error("ENOENT") }],
	["timeout", { status: null, signal: "SIGTERM", error: new Error("ETIMEDOUT"), stdout: "partial" }],
	["signal", { status: null, signal: "SIGKILL" }],
	["nonzero query exit", { status: 1, stdout: stream(config, advisory()) }],
]) test(`scan error retains evidence and exits 2: ${name}`, (t) => {
	const outputDirectory = directory(t);
	const raw = { stdout: "", stderr: "fixture diagnostic", ...result };
	const record = auditBroker({ cwd, outputDirectory, execute: executor(raw) });
	assert.equal(record.exitCode, 2);
	assert.equal(record.outcome, "error");
	assert(record.reason);
	assert.equal(readFileSync(join(outputDirectory, "query-1.json"), "utf8"), raw.stdout);
	assert.equal(readFileSync(join(outputDirectory, "query-1.stderr.txt"), "utf8"), raw.stderr);
	assert.equal(JSON.parse(readFileSync(join(outputDirectory, "result.json"))).exitCode, 2);
});

test("inventory execution errors and report write failures are audit errors", (t) => {
	const outputDirectory = directory(t);
	const record = auditBroker({ cwd, outputDirectory, execute: () => { throw new Error("inventory unavailable"); } });
	assert.equal(record.exitCode, 2);
	assert.match(record.reason, /inventory unavailable/);
	assert.equal(record.commands[0].error, "inventory unavailable");
	const file = join(outputDirectory, "not-a-directory");
	writeFileSync(file, "occupied");
	assert.equal(auditBroker({ cwd, outputDirectory: file, execute: executor() }).exitCode, 2);
});

test("CLI entrypoint produces actual 0/1/2 process exits with retained reports", (t) => {
	const temporaryDirectory = directory(t);
	const driver = join(temporaryDirectory, "driver.mjs");
	writeFileSync(driver, `import { main } from ${JSON.stringify(new URL("./audit-go-dependencies.mjs", import.meta.url).href)};
const config = ${JSON.stringify(config)};
const advisory = ${JSON.stringify(advisory())};
const status = Number(process.argv[2]);
process.exitCode = main(["--output", process.argv[3]], { cwd: ${JSON.stringify(cwd)}, execute(command, args) {
 if (command === "go") return { status: 0, stdout: args[0] === "env" ? ${JSON.stringify(stream(environment))} : ${JSON.stringify(stream(root, dependency))} };
 return { status: status === 2 ? 7 : 0, stdout: [config, ...(status === 1 ? [advisory] : [])].map(JSON.stringify).join("\\n") };
} });
`);
	for (const status of [0, 1, 2]) {
		const output = join(temporaryDirectory, String(status));
		const child = spawnSync(process.execPath, [driver, String(status), output], { encoding: "utf8" });
		assert.equal(child.status, status, child.stderr);
		assert.equal(JSON.parse(readFileSync(join(output, "result.json"))).exitCode, status);
	}
	assert.throws(() => main(["--fix"]), /Usage/);
	assert.throws(() => main(["--output"]), /Usage/);
});
