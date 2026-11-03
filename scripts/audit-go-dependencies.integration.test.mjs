import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { auditBroker, parseJsonStream } from "./audit-go-dependencies.mjs";

// Deliberately separate from offline root checks: requires real Go and pinned govulncheck on PATH.
for (const scenario of ["clean", "vulnerable", "withdrawn", "scanner-error"]) {
	test(`real govulncheck query contract: ${scenario}`, () => {
		const temporary = mkdtempSync(join(tmpdir(), "volt-govulncheck-contract-"));
		try {
			const cwd = join(temporary, "module");
			const db = join(temporary, "database");
			const outputDirectory = join(temporary, "reports");
			mkdirSync(cwd);
			mkdirSync(db);
			const goMod = "module example.com/no-go-files\n\ngo 1.27.0\n";
			writeFileSync(join(cwd, "go.mod"), goMod);
			const entry = (id, introduced, extra = {}) => ({
				schema_version: "1.3.1", id,
				modified: "2026-01-01T00:00:00Z", published: "2026-01-01T00:00:00Z",
				summary: "Synthetic local scanner contract fixture", details: "Never published or sent to a remote service.",
				affected: [{ package: { name: "stdlib", ecosystem: "Go" }, ranges: [{ type: "SEMVER", events: [{ introduced }, { fixed: "99.0.0" }] }] }],
				...extra,
			});
			// The pinned client can return this out-of-range candidate when another record matches.
			writeFileSync(join(db, "GO-2026-0002.json"), JSON.stringify(entry("GO-2026-0002", "98.0.0")));
			if (scenario === "vulnerable" || scenario === "withdrawn") {
				writeFileSync(join(db, "GO-2026-0001.json"), JSON.stringify(entry("GO-2026-0001", "0", scenario === "withdrawn" ? { withdrawn: "2026-02-01T00:00:00Z" } : {})));
			}
			const result = auditBroker({ cwd, outputDirectory, database: pathToFileURL(scenario === "scanner-error" ? join(temporary, "missing") : db).href });
			const expected = scenario === "vulnerable" ? 1 : scenario === "scanner-error" ? 2 : 0;
			assert.equal(result.exitCode, expected, JSON.stringify(result, null, 2));
			assert.equal(JSON.parse(readFileSync(join(outputDirectory, "result.json"))).exitCode, expected);
			assert.equal(readFileSync(join(cwd, "go.mod"), "utf8"), goMod);
			assert.deepEqual(readdirSync(cwd), ["go.mod"]);
			if (scenario === "scanner-error") {
				assert(result.commands.find((command) => command.name === "query-1").status !== 0);
				assert(readFileSync(join(outputDirectory, "query-1.stderr.txt"), "utf8").length > 0);
			} else {
				assert.equal(result.inventory.modules.length, 1);
				assert.equal(result.inventory.modules[0].path, "stdlib");
				assert.equal(result.commands.find((command) => command.name === "query-1").status, 0);
				const messages = parseJsonStream(readFileSync(join(outputDirectory, "query-1.json"), "utf8"));
				assert.equal(messages[0].config.scanner_version, "v1.9.0");
				if (scenario === "vulnerable") {
					assert.deepEqual(messages.filter((message) => message.osv).map((message) => message.osv.id).sort(), ["GO-2026-0001", "GO-2026-0002"]);
					assert.deepEqual(result.findings.map((finding) => finding.id), ["GO-2026-0001"]);
				}
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
}
