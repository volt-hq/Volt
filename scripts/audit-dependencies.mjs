#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const examples = "packages/coding-agent/examples/extensions";
export const AUDIT_GRAPHS = [
	{ id: "root", directory: ".", lockfile: "package-lock.json", isolate: false },
	{ id: "site", directory: "site", lockfile: "package-lock.json", isolate: true },
	{
		id: "firebase",
		directory: "packages/coding-agent/examples/remote/firebase-push-relay/functions",
		lockfile: "package-lock.json",
		isolate: true,
	},
	...["gondolin", "sandbox", "with-deps", "custom-provider-anthropic"].map((id) => ({
		id,
		directory: `${examples}/${id}`,
		lockfile: "package-lock.json",
		isolate: true,
	})),
	{ id: "shrinkwrap", directory: "packages/coding-agent", lockfile: "npm-shrinkwrap.json", isolate: true },
];

export const AUDIT_ARGS = [
	"audit",
	"--package-lock-only",
	"--ignore-scripts",
	"--include=dev",
	"--audit-level=moderate",
	"--json",
];

function executeNpm(args, cwd) {
	// Windows cannot execute npm.cmd without a shell. Invoke npm's JS entrypoint
	// directly instead, preserving argument boundaries and timeout/error reporting.
	const cli = process.platform === "win32" ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined;
	return spawnSync(cli ? process.execPath : "npm", cli ? [cli, ...args] : args, {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
}

const severities = ["info", "low", "moderate", "high", "critical"];

export function classifyAudit(result) {
	const error = (reason) => ({ outcome: "error", exitCode: 2, reason });
	if (result.error || result.signal || !Number.isInteger(result.status)) {
		return error(result.error?.message ?? `npm did not exit normally (${result.signal ?? "unknown status"})`);
	}
	if (result.status !== 0 && result.status !== 1) return error(`npm exited with status ${result.status}`);
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		return error("npm returned malformed JSON");
	}
	if (report?.error) return error(`npm audit error: ${report.error.code ?? report.error.message ?? "unknown error"}`);
	const counts = report?.metadata?.vulnerabilities;
	const vulnerabilities = report?.vulnerabilities;
	if (
		report?.auditReportVersion !== 2 ||
		!counts ||
		!vulnerabilities ||
		typeof vulnerabilities !== "object" ||
		Array.isArray(vulnerabilities) ||
		[...severities, "total"].some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0) ||
		counts.total !== severities.reduce((sum, severity) => sum + counts[severity], 0) ||
		Object.keys(vulnerabilities).length !== counts.total ||
		Object.values(vulnerabilities).some((entry) => !entry || !severities.includes(entry.severity)) ||
		severities.some((severity) => Object.values(vulnerabilities).filter((entry) => entry?.severity === severity).length !== counts[severity])
	) {
		return error("npm returned an incomplete or inconsistent audit report");
	}
	const aboveThreshold = counts.moderate + counts.high + counts.critical > 0;
	if (result.status !== (aboveThreshold ? 1 : 0)) return error("npm exit status disagrees with the moderate audit threshold");
	return { outcome: aboveThreshold ? "vulnerabilities" : "ok", exitCode: result.status, counts };
}

/** Root keeps its workspace context; every standalone graph has exactly one isolated lock. */
export function auditGraph(id, { root = repoRoot, outputDirectory, temporaryDirectory = tmpdir(), execute = executeNpm }) {
	const graph = AUDIT_GRAPHS.find((candidate) => candidate.id === id);
	if (!graph) throw new Error(`Unknown audit graph: ${id}`);
	mkdirSync(outputDirectory, { recursive: true });
	let snapshot;
	let result = {};
	let summary;
	try {
		let cwd = resolve(root, graph.directory);
		if (graph.isolate) {
			snapshot = mkdtempSync(join(temporaryDirectory, `volt-audit-${graph.id}-`));
			copyFileSync(join(cwd, "package.json"), join(snapshot, "package.json"));
			copyFileSync(join(cwd, graph.lockfile), join(snapshot, graph.lockfile));
			// Preserve registry/project policy without copying any installed packages.
			const config = existsSync(join(cwd, ".npmrc")) ? join(cwd, ".npmrc") : join(root, ".npmrc");
			if (existsSync(config)) copyFileSync(config, join(snapshot, ".npmrc"));
			cwd = snapshot;
		}
		result = execute([...AUDIT_ARGS], cwd);
		summary = classifyAudit(result);
	} catch (error) {
		summary = { outcome: "error", exitCode: 2, reason: error instanceof Error ? error.message : String(error) };
	} finally {
		if (snapshot) {
			try {
				rmSync(snapshot, { recursive: true, force: true });
			} catch (error) {
				summary = { outcome: "error", exitCode: 2, reason: `Snapshot cleanup failed: ${String(error)}` };
			}
		}
	}
	const record = {
		graph: graph.id,
		lockfile: `${graph.directory}/${graph.lockfile}`,
		command: ["npm", ...AUDIT_ARGS],
		npmExitStatus: result.status ?? null,
		npmSignal: result.signal ?? null,
		...summary,
	};
	writeFileSync(join(outputDirectory, `${graph.id}.audit.json`), result.stdout ?? "");
	writeFileSync(join(outputDirectory, `${graph.id}.stderr.txt`), result.stderr ?? "");
	writeFileSync(join(outputDirectory, `${graph.id}.result.json`), `${JSON.stringify(record, null, 2)}\n`);
	return record;
}

export function main(args) {
	let graph;
	let outputDirectory;
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if ((argument !== "--graph" && argument !== "--output") || !args[index + 1] || args[index + 1].startsWith("--")) {
			throw new Error("Usage: node scripts/audit-dependencies.mjs [--graph <id>] [--output <directory>]");
		}
		if (argument === "--graph") graph = args[++index];
		else outputDirectory = resolve(args[++index]);
	}
	if (graph && !AUDIT_GRAPHS.some((candidate) => candidate.id === graph)) throw new Error(`Unknown audit graph: ${graph}`);
	outputDirectory ??= mkdtempSync(join(tmpdir(), "volt-audit-reports-"));
	console.log(`Dependency audit reports: ${outputDirectory}`);
	let exitCode = 0;
	for (const id of graph ? [graph] : AUDIT_GRAPHS.map((candidate) => candidate.id)) {
		const result = auditGraph(id, { outputDirectory });
		console.log(`${id}: ${result.outcome}${result.reason ? ` (${result.reason})` : ""}`);
		exitCode = Math.max(exitCode, result.exitCode);
	}
	return exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
