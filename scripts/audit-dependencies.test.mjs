import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { AUDIT_ARGS, AUDIT_GRAPHS, auditGraph, classifyAudit, main } from "./audit-dependencies.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function npmResult(severity) {
	const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: severity ? 1 : 0 };
	if (severity) counts[severity] = 1;
	return {
		status: ["moderate", "high", "critical"].includes(severity) ? 1 : 0,
		signal: null,
		stdout: JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: severity ? { zod: { name: "zod", severity, via: [], nodes: ["node_modules/zod"] } } : {},
			metadata: { vulnerabilities: counts },
		}),
		stderr: "offline scanner diagnostics\n",
	};
}

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "volt-audit-test-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const root = join(directory, "repo");
	const temporaryDirectory = join(directory, "snapshots");
	const outputDirectory = join(directory, "reports");
	mkdirSync(temporaryDirectory);
	const originals = new Map();
	for (const graph of AUDIT_GRAPHS) {
		const cwd = resolve(root, graph.directory);
		mkdirSync(cwd, { recursive: true });
		const manifest = JSON.stringify({ name: graph.id, private: true, ...(graph.id === "root" ? { workspaces: ["packages/*"] } : {}) });
		const lock = JSON.stringify({ name: graph.id, lockfileVersion: 3, packages: { "": { name: graph.id } } });
		for (const [file, content] of [["package.json", manifest], [graph.lockfile, lock]]) {
			const path = join(cwd, file);
			writeFileSync(path, content);
			originals.set(path, content);
		}
	}
	writeFileSync(join(root, ".npmrc"), "min-release-age=2\n");
	// A sibling lock must never replace the selected shipped shrinkwrap.
	writeFileSync(join(root, "packages/coding-agent/package-lock.json"), '{"name":"wrong-lock"}');
	return { root, temporaryDirectory, outputDirectory, originals };
}

test("audit graphs cover every tracked lock exactly once, including independent workspace examples", () => {
	const env = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
	const tracked = execFileSync("git", ["ls-files", "-z", "*package-lock.json", "*npm-shrinkwrap.json"], {
		cwd: repoRoot,
		encoding: "utf8",
		env,
	}).split("\0").filter(Boolean).sort();
	const selected = AUDIT_GRAPHS.map((graph) => `${graph.directory === "." ? "" : `${graph.directory}/`}${graph.lockfile}`).sort();
	assert.deepEqual(selected, tracked);
	assert.equal(new Set(AUDIT_GRAPHS.map((graph) => graph.id)).size, 8);
});

test("root retains workspace context; nested graphs receive only their own immutable manifest and lock", (t) => {
	const world = fixture(t);
	for (const graph of AUDIT_GRAPHS) {
		let snapshot;
		const result = auditGraph(graph.id, {
			...world,
			execute: (args, cwd) => {
				snapshot = cwd;
				assert.deepEqual(args, ["audit", "--package-lock-only", "--ignore-scripts", "--include=dev", "--audit-level=moderate", "--json"]);
				assert.deepEqual(args, AUDIT_ARGS);
				assert.equal(JSON.parse(readFileSync(join(cwd, "package.json"))).name, graph.id);
				assert.equal(JSON.parse(readFileSync(join(cwd, graph.lockfile))).name, graph.id);
				if (graph.isolate) {
					assert.equal(dirname(cwd), world.temporaryDirectory);
					assert.deepEqual(readdirSync(cwd).sort(), [".npmrc", "package.json", graph.lockfile].sort());
					assert.equal(readFileSync(join(cwd, ".npmrc"), "utf8"), "min-release-age=2\n");
				} else {
					assert.equal(cwd, world.root);
					assert.deepEqual(JSON.parse(readFileSync(join(cwd, "package.json"))).workspaces, ["packages/*"]);
					assert(existsSync(join(cwd, "packages/coding-agent/package.json")));
				}
				return npmResult();
			},
		});
		assert.equal(result.outcome, "ok");
		if (graph.isolate) assert.equal(existsSync(snapshot), false);
	}
	for (const [path, content] of world.originals) assert.equal(readFileSync(path, "utf8"), content);
	assert.deepEqual(readdirSync(world.temporaryDirectory), []);
});

for (const severity of [undefined, "info", "low", "moderate", "high", "critical"]) {
	test(`audit preserves ${severity ?? "healthy"} results and raw reports without allowlisting Zod`, (t) => {
		const world = fixture(t);
		const raw = npmResult(severity);
		const result = auditGraph("sandbox", { ...world, execute: () => raw });
		assert.equal(result.exitCode, raw.status);
		assert.equal(result.outcome, raw.status === 1 ? "vulnerabilities" : "ok");
		assert.equal(readFileSync(join(world.outputDirectory, "sandbox.audit.json"), "utf8"), raw.stdout);
		assert.equal(readFileSync(join(world.outputDirectory, "sandbox.stderr.txt"), "utf8"), raw.stderr);
		assert.deepEqual(JSON.parse(readFileSync(join(world.outputDirectory, "sandbox.result.json"))), result);
		assert.deepEqual(readdirSync(world.temporaryDirectory), []);
	});
}

const failures = [
	["malformed JSON", { ...npmResult(), stdout: "not JSON" }],
	["truncated JSON", { ...npmResult(), stdout: '{"auditReportVersion":' }],
	["missing report", { ...npmResult(), stdout: "{}" }],
	["null report", { ...npmResult(), stdout: "null" }],
	["registry error", { ...npmResult(), status: 1, stdout: '{"error":{"code":"ECONNRESET"}}' }],
	["missing executable", { error: new Error("ENOENT"), status: null, stdout: "", stderr: "" }],
	["timeout", { error: new Error("ETIMEDOUT"), status: null, signal: "SIGTERM", stdout: "partial" }],
	["signal", { ...npmResult(), status: null, signal: "SIGKILL" }],
	["unexpected process failure", { ...npmResult(), status: 7 }],
	["nonzero exit with healthy JSON", { ...npmResult(), status: 1 }],
	["successful exit with high findings", { ...npmResult("high"), status: 0 }],
];
for (const [name, raw] of failures) {
	test(`scanner failure is distinct from advisories: ${name}`, (t) => {
		const world = fixture(t);
		const result = auditGraph("gondolin", { ...world, execute: () => raw });
		assert.equal(result.outcome, "error");
		assert.equal(result.exitCode, 2);
		assert(result.reason);
		assert.equal(result.npmExitStatus, raw.status);
		assert.equal(readFileSync(join(world.outputDirectory, "gondolin.audit.json"), "utf8"), raw.stdout);
		assert.deepEqual(readdirSync(world.temporaryDirectory), []);
	});
}

test("inconsistent counts and invalid severities fail closed", () => {
	for (const mutate of [
		(report) => { report.metadata.vulnerabilities.total = -1; },
		(report) => { report.metadata.vulnerabilities.high = 0.5; },
		(report) => { report.vulnerabilities.zod.severity = "low"; },
		(report) => { report.vulnerabilities.zod = null; },
		(report) => { report.vulnerabilities = []; },
	]) {
		const raw = npmResult("high");
		const report = JSON.parse(raw.stdout);
		mutate(report);
		assert.equal(classifyAudit({ ...raw, stdout: JSON.stringify(report) }).outcome, "error");
	}
});

test("thrown process and snapshot-copy failures retain error reports and clean temporary state", (t) => {
	const world = fixture(t);
	const thrown = auditGraph("site", { ...world, execute: () => { throw new Error("simulated process failure"); } });
	assert.equal(thrown.exitCode, 2);
	assert.match(thrown.reason, /simulated process failure/);
	rmSync(join(world.root, "site/package-lock.json"));
	const missing = auditGraph("site", { ...world, execute: () => { assert.fail("scanner must not run without its lock"); } });
	assert.equal(missing.exitCode, 2);
	assert.match(missing.reason, /ENOENT/);
	assert.equal(JSON.parse(readFileSync(join(world.outputDirectory, "site.result.json"))).outcome, "error");
	assert.deepEqual(readdirSync(world.temporaryDirectory), []);
});

test("CLI rejects unknown graphs and malformed arguments before invoking npm", () => {
	assert.throws(() => main(["--graph", "unknown"]), /Unknown audit graph/);
	assert.throws(() => main(["--graph"]), /Usage/);
	assert.throws(() => main(["--fix"]), /Usage/);
});

const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/npm-audit.yml"), "utf8"));

test("scheduled/manual audit jobs remain independent, read-only, bounded and retain failed reports", () => {
	assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
	assert.equal(workflow.on.schedule[0].cron, "37 7 * * *");
	assert.deepEqual(workflow.permissions, { contents: "read" });
	assert.equal(workflow.jobs.audit.strategy["fail-fast"], false);
	assert.deepEqual([...workflow.jobs.audit.strategy.matrix.graph].sort(), AUDIT_GRAPHS.map((graph) => graph.id).sort());
	for (const job of Object.values(workflow.jobs)) {
		assert.equal(job.needs, undefined);
		assert.equal(job["continue-on-error"], undefined);
		assert(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 15);
		const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
		assert.equal(upload.if, "always()");
		assert.equal(upload.with["retention-days"], 14);
		for (const step of job.steps) {
			assert.equal(step["continue-on-error"], undefined);
			if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
			if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
			if (step.uses?.startsWith("actions/setup-node@")) assert.equal(step.with["node-version"], "22.23.1");
			if (step.uses?.startsWith("actions/setup-go@")) assert.equal(step.with["go-version"], "1.27.x");
			if (step.run?.includes("npm install")) assert.equal(step.run, "npm install -g npm@11.17.0 --ignore-scripts");
		}
	}
	assert(workflow.jobs.audit.steps.some((step) => step.run === 'node scripts/audit-dependencies.mjs --graph "$AUDIT_GRAPH" --output "$RUNNER_TEMP/dependency-audit"'));
	assert(workflow.jobs.signatures.steps.some((step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund"));
	assert(workflow.jobs.broker.steps.some((step) => step.run === "go install golang.org/x/vuln/cmd/govulncheck@v1.9.0"));
	assert(workflow.jobs.broker.steps.some((step) => step.run === "npm ci --ignore-scripts --no-audit --no-fund"));
	const broker = workflow.jobs.broker.steps;
	const contractIndex = broker.findIndex((step) => step.run === "node --test scripts/audit-go-dependencies.integration.test.mjs");
	const scanIndex = broker.findIndex((step) => step.run === 'node scripts/audit-go-dependencies.mjs --output "$RUNNER_TEMP/broker-govulncheck"');
	assert(contractIndex > broker.findIndex((step) => step.run === "go install golang.org/x/vuln/cmd/govulncheck@v1.9.0"));
	assert(scanIndex > contractIndex);
	assert.equal(broker[scanIndex].if, undefined);
	assert.equal(broker.find((step) => step.uses?.startsWith("actions/upload-artifact@")).with.path, "${{ runner.temp }}/broker-govulncheck/");
});

for (const [id, command, reportName] of [
	["signatures", "npm audit signatures --omit=dev", "npm-signatures.txt"],
]) {
	test(`${id} workflow pipeline retains output and real success, vulnerability and error exits`, (t) => {
		const world = fixture(t);
		const scan = workflow.jobs[id].steps.find((step) => step.run?.includes("| tee"));
		assert.equal(scan.shell, "bash");
		assert(scan.run.includes(command));
		assert(!scan.run.includes("-json"));
		assert.equal(scan.if, undefined);
		for (const status of [0, 1, 2]) {
			const result = spawnSync("bash", ["-eo", "pipefail", "-c", `npm() { echo offline-fixture; return ${status}; }\ngovulncheck() { echo offline-fixture; return ${status}; }\n${scan.run}`], {
				encoding: "utf8",
				env: { ...process.env, RUNNER_TEMP: world.temporaryDirectory.replaceAll("\\", "/") },
			});
			assert.equal(result.status, status, result.stderr);
			assert.match(readFileSync(join(world.temporaryDirectory, reportName), "utf8"), /offline-fixture/);
		}
	});
}
