#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const BROKER_DIRECTORY = fileURLToPath(new URL("../services/relay-credential-broker/", import.meta.url));
export const SCANNER_VERSION = "v1.9.0";
const MAX_ARGUMENT_BYTES = 4096;
const MAX_BATCH_MODULES = 64;
const AUDIT_TIMEOUT_MS = 600_000;

function object(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Go and govulncheck emit concatenated, potentially pretty-printed JSON objects. */
export function parseJsonStream(text) {
	if (typeof text !== "string") throw new Error("Missing JSON stream");
	const records = [];
	let start = -1;
	let depth = 0;
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (start === -1) {
			if (/\s/.test(character)) continue;
			if (character !== "{") throw new Error("Expected a JSON object in stream");
			start = index;
		}
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
		} else if (character === '"') quoted = true;
		else if (character === "{") depth++;
		else if (character === "}") {
			depth--;
			if (depth === 0) {
				records.push(JSON.parse(text.slice(start, index + 1)));
				start = -1;
			}
		}
	}
	if (start !== -1) throw new Error("Truncated JSON stream");
	if (records.length === 0) throw new Error("Empty JSON stream");
	return records;
}

export function normalizeVersion(value) {
	if (typeof value !== "string") throw new Error("Missing module version");
	let version = value.replace(/^(?:go|v)/, "");
	// x/mod/semver accepts shortened major and minor versions, unlike node-semver.
	if (/^\d+(?:\.\d+)?$/.test(version)) version += ".0".repeat(3 - version.split(".").length);
	if (!semver.valid(version)) throw new Error(`Invalid module version: ${value}`);
	return version;
}

function modulePath(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~!+/-]*$/.test(value)) {
		throw new Error(`Invalid module path: ${String(value)}`);
	}
	return value;
}

export function parseInventory(stdout, environment, cwd) {
	if (!object(environment) || typeof environment.GOMOD !== "string" || resolve(environment.GOMOD) !== resolve(cwd, "go.mod")) {
		throw new Error("Go environment does not select the broker go.mod");
	}
	const goVersion = environment.GOVERSION;
	const tag = typeof goVersion === "string" && /^go(\d+\.\d+)(\.\d+)?(?:(beta|rc)(\d+))?$/.exec(goVersion);
	if (!tag) throw new Error(`Unsupported Go toolchain version: ${String(goVersion)}`);
	const stdlibVersion = normalizeVersion(`${tag[1]}${tag[2] ?? ".0"}${tag[3] ? `-${tag[3]}.${tag[4]}` : ""}`);
	const modules = new Map();
	let mainModule;
	const paths = new Set();
	for (const entry of parseJsonStream(stdout)) {
		if (entry.Error || (entry.Main !== undefined && typeof entry.Main !== "boolean")) throw new Error("Incomplete Go module inventory");
		const originalPath = modulePath(entry.Path);
		if (paths.has(originalPath)) throw new Error(`Duplicate inventory path: ${originalPath}`);
		paths.add(originalPath);
		if (entry.Main) {
			if (mainModule || entry.Replace) throw new Error("Expected exactly one unreplaced main module");
			mainModule = originalPath;
			continue;
		}
		normalizeVersion(entry.Version);
		if (entry.Replace !== undefined && (!object(entry.Replace) || !entry.Replace.Version || entry.Replace.Error)) {
			throw new Error(`Unversioned/local or invalid replacement for ${originalPath}`);
		}
		const selected = entry.Replace ?? entry;
		const path = modulePath(selected.Path);
		const version = `v${normalizeVersion(selected.Version)}`;
		modules.set(`${path}@${version}`, { path, version });
	}
	if (!mainModule) throw new Error("Missing main module in inventory");
	modules.set(`stdlib@v${stdlibVersion}`, { path: "stdlib", version: `v${stdlibVersion}` });
	return { mainModule, goVersion, modules: [...modules.values()].sort((a, b) => `${a.path}@${a.version}`.localeCompare(`${b.path}@${b.version}`)) };
}

export function queryBatches(modules) {
	const batches = [];
	let batch = [];
	let bytes = 0;
	for (const module of modules) {
		const size = Buffer.byteLength(`${module.path}@${module.version}`) + 1;
		if (size > MAX_ARGUMENT_BYTES) throw new Error("Module query exceeds argument limit");
		if (batch.length === MAX_BATCH_MODULES || bytes + size > MAX_ARGUMENT_BYTES) {
			batches.push(batch);
			batch = [];
			bytes = 0;
		}
		batch.push(module);
		bytes += size;
	}
	if (batch.length) batches.push(batch);
	return batches;
}

export function executeCommand(command, args, cwd, timeout) {
	return spawnSync(command, args, {
		cwd,
		env: { ...process.env, GOWORK: "off", GOTOOLCHAIN: "local", GOFLAGS: "" },
		encoding: "utf8",
		timeout,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
}

/** Collection is separate from classification: a successful query is not a clean audit. */
export function collectAudit({ cwd = BROKER_DIRECTORY, execute = executeCommand, onRun = () => {}, database } = {}) {
	const deadline = Date.now() + AUDIT_TIMEOUT_MS;
	const run = (name, command, args) => {
		const timeout = Math.min(120_000, deadline - Date.now());
		if (timeout <= 0) throw new Error("Go audit exceeded its time limit");
		let result;
		try {
			result = execute(command, args, cwd, timeout);
		} catch (error) {
			result = { error, status: null, stdout: "", stderr: "" };
		}
		onRun({ name, command: [command, ...args], result });
		if (result.error || result.signal || result.status !== 0) {
			throw new Error(`${name} failed: ${result.error?.message ?? result.signal ?? `exit ${result.status}`}`);
		}
		return result.stdout;
	};
	const environment = parseJsonStream(run("environment", "go", ["env", "-json", "GOVERSION", "GOMOD"]));
	if (environment.length !== 1) throw new Error("Unexpected Go environment report");
	const inventory = parseInventory(run("inventory", "go", ["list", "-mod=readonly", "-m", "-json", "all"]), environment[0], cwd);
	const queries = queryBatches(inventory.modules).map((modules, index) => ({
		modules,
		stdout: run(`query-${index + 1}`, "govulncheck", ["-mode=query", "-json", ...(database ? ["-db", database] : []), ...modules.map((module) => `${module.path}@${module.version}`)]),
	}));
	return { inventory, queries };
}

export function affectedVersion(ranges, version) {
	const selected = normalizeVersion(version);
	if (ranges === undefined) return true;
	if (!Array.isArray(ranges)) throw new Error("Invalid OSV ranges");
	if (ranges.length === 0) return true;
	let matches = false;
	for (const range of ranges) {
		if (!object(range) || range.type !== "SEMVER" || !Array.isArray(range.events) || range.events.length === 0) {
			throw new Error("Unsupported or malformed OSV range");
		}
		const events = range.events.map((event) => {
			if (!object(event) || Object.keys(event).length !== 1 || !("introduced" in event || "fixed" in event)) {
				throw new Error("Unsupported or malformed OSV range event");
			}
			const introduced = "introduced" in event;
			const value = introduced ? event.introduced : event.fixed;
			return { introduced, version: introduced && value === "0" ? null : normalizeVersion(value) };
		}).sort((a, b) => a.version === null ? (b.version === null ? 0 : -1) : b.version === null ? 1 : semver.compare(a.version, b.version));
		let open = false;
		let start;
		for (const event of events) {
			if (event.introduced) {
				if (open) throw new Error("Overlapping OSV introduction events");
				start = event.version;
				open = true;
			} else {
				if (!open || (start !== null && !semver.lt(start, event.version))) throw new Error("Invalid OSV fixed boundary");
				if ((start === null || semver.gte(selected, start)) && semver.lt(selected, event.version)) matches = true;
				open = false;
			}
		}
		if (open && (start === null || semver.gte(selected, start))) matches = true;
	}
	return matches;
}

export function classifyQuery(stdout, modules, now = Date.now()) {
	const messages = parseJsonStream(stdout);
	const config = messages[0].config;
	if (!object(config) || config.protocol_version !== "v1.0.0" || config.scanner_name !== "govulncheck" || config.scanner_version !== SCANNER_VERSION || config.scan_mode !== "query") {
		throw new Error("Unexpected govulncheck protocol, version or mode");
	}
	const findings = new Map();
	for (const [index, message] of messages.entries()) {
		if (Object.keys(message).length !== 1) throw new Error("Invalid govulncheck message");
		if (index === 0) continue;
		if (object(message.progress) && typeof message.progress.message === "string") continue;
		const entry = message.osv;
		if (!object(entry) || typeof entry.id !== "string" || !/^GO-\d{4}-\d+$/.test(entry.id) || !Array.isArray(entry.affected) || entry.affected.length === 0) {
			throw new Error("Unexpected or incomplete govulncheck OSV message");
		}
		if (entry.withdrawn !== undefined) {
			if (typeof entry.withdrawn !== "string" || !Number.isFinite(Date.parse(entry.withdrawn))) throw new Error("Invalid OSV withdrawal date");
			if (Date.parse(entry.withdrawn) <= now) continue;
		}
		if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string"))) throw new Error("Invalid OSV aliases");
		for (const affected of entry.affected) {
			if (!object(affected) || !object(affected.package) || affected.package.ecosystem !== "Go") throw new Error("Unsupported OSV ecosystem");
			const path = modulePath(affected.package.name);
			for (const module of modules.filter((candidate) => candidate.path === path)) {
				if (affected.versions !== undefined) throw new Error("Unsupported explicit OSV version list");
				if (!affectedVersion(affected.ranges, module.version)) continue;
				const fixedVersions = [...new Set((affected.ranges ?? []).flatMap((range) => range.events.filter((event) => event.fixed !== undefined).map((event) => `v${normalizeVersion(event.fixed)}`)))].sort(semver.compare);
				const key = `${entry.id}:${path}@${module.version}`;
				const previous = findings.get(key);
				findings.set(key, {
					id: entry.id, module: path, version: module.version,
					summary: typeof entry.summary === "string" ? entry.summary : "",
					aliases: entry.aliases ?? [],
					fixedVersions: [...new Set([...(previous?.fixedVersions ?? []), ...fixedVersions])].sort(semver.compare),
				});
			}
		}
	}
	return [...findings.values()];
}

export function auditBroker({ outputDirectory, cwd = BROKER_DIRECTORY, execute = executeCommand, database } = {}) {
	const record = { startedAt: new Date().toISOString(), cwd, commands: [], outcome: "error", exitCode: 2 };
	try {
		mkdirSync(outputDirectory, { recursive: true });
		const collected = collectAudit({
			cwd, execute, database,
			onRun({ name, command, result }) {
				record.commands.push({ name, command, status: result.status ?? null, signal: result.signal ?? null, error: result.error?.message ?? null });
				writeFileSync(join(outputDirectory, `${name}.json`), result.stdout ?? "");
				writeFileSync(join(outputDirectory, `${name}.stderr.txt`), result.stderr ?? "");
			},
		});
		record.inventory = collected.inventory;
		writeFileSync(join(outputDirectory, "selected-modules.json"), `${JSON.stringify(record.inventory, null, 2)}\n`);
		const findings = new Map();
		for (const query of collected.queries) {
			for (const finding of classifyQuery(query.stdout, query.modules)) findings.set(`${finding.id}:${finding.module}@${finding.version}`, finding);
		}
		record.findings = [...findings.values()].sort((a, b) => `${a.id}:${a.module}@${a.version}`.localeCompare(`${b.id}:${b.module}@${b.version}`));
		record.advisoryCount = new Set(record.findings.map((finding) => finding.id)).size;
		record.outcome = findings.size ? "vulnerabilities" : "ok";
		record.exitCode = findings.size ? 1 : 0;
	} catch (error) {
		record.outcome = "error";
		record.exitCode = 2;
		record.reason = error instanceof Error ? error.message : String(error);
	}
	record.finishedAt = new Date().toISOString();
	try {
		writeFileSync(join(outputDirectory, "result.json"), `${JSON.stringify(record, null, 2)}\n`);
	} catch (error) {
		record.outcome = "error";
		record.exitCode = 2;
		record.reason = `Cannot retain audit result: ${String(error)}`;
	}
	return record;
}

export function main(args, options = {}) {
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output" || !args[1] || args[1].startsWith("--"))) {
		throw new Error("Usage: node scripts/audit-go-dependencies.mjs [--output <directory>]");
	}
	const outputDirectory = args.length ? resolve(args[1]) : mkdtempSync(join(tmpdir(), "volt-go-audit-"));
	const result = auditBroker({ ...options, outputDirectory });
	console.log(`Broker module audit: ${result.outcome}${result.reason ? ` (${result.reason})` : `; ${result.inventory.modules.length} modules; ${result.advisoryCount} advisories`}`);
	console.log(`Go audit reports: ${outputDirectory}`);
	return result.exitCode;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 2;
	}
}
