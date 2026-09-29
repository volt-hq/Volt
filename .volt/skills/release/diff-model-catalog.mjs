#!/usr/bin/env node
// Lists model catalog entries that differ between two revisions of packages/ai/src/models.generated.ts,
// the fields that changed, and the test files that quote each changed or removed model key.
//
// Usage (from the repository root):
//   node .volt/skills/release/diff-model-catalog.mjs [<base-ref> [<head-ref>]]
//
// <base-ref> defaults to HEAD. Without <head-ref> the working tree is compared, which covers a local
// `npm --prefix packages/ai run generate-models`. For a release pull request, pass the pre-release
// main SHA and the release branch head.

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CATALOG = "packages/ai/src/models.generated.ts";
const TESTS = "packages/*/test/*";

function readCatalog(ref) {
	if (ref === undefined) return readFileSync(CATALOG, "utf8");
	return execFileSync("git", ["show", `${ref}:${CATALOG}`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// Maps "<provider>/<model key>" to the entry's lines, each prefixed with its nested field path.
// The generator emits `\t"<provider>": {` per provider and `\t\t"<model>": {` ... `\t\t} satisfies Model<...>,`
// per model.
function parseCatalog(text, label) {
	const entries = new Map();
	let provider;
	let key;
	let lines;
	let path;
	for (const line of text.split("\n")) {
		const providerMatch = /^\t"?([^"\t]+)"?: \{$/.exec(line);
		if (providerMatch) {
			provider = providerMatch[1];
			continue;
		}
		const modelMatch = /^\t\t"([^"]+)": \{$/.exec(line);
		if (modelMatch) {
			key = `${provider}/${modelMatch[1]}`;
			lines = [];
			path = [];
			continue;
		}
		if (key === undefined) continue;
		if (/^\t\t\}/.test(line)) {
			entries.set(key, lines);
			key = undefined;
			continue;
		}
		const trimmed = line.trim();
		const open = /^"?([^":]+)"?: \{$/.exec(trimmed);
		if (open) path.push(open[1]);
		else if (/^\},?$/.test(trimmed)) path.pop();
		else lines.push(path.length ? `${path.join(".")}.${trimmed}` : trimmed);
	}
	if (entries.size === 0) throw new Error(`No model entries parsed from ${label}; the generated format changed`);
	return entries;
}

function changedFields(before, after) {
	const beforeLines = new Set(before);
	const afterLines = new Set(after);
	const fields = new Set();
	for (const line of [...before.filter((l) => !afterLines.has(l)), ...after.filter((l) => !beforeLines.has(l))]) {
		fields.add(/^([^:]+):/.exec(line)?.[1] ?? line);
	}
	return [...fields];
}

function testsQuoting(modelKey, ref) {
	const args = ["grep", "-l", "-F", "-e", `"${modelKey}"`, ...(ref === undefined ? [] : [ref]), "--", TESTS];
	const result = spawnSync("git", args, { encoding: "utf8" });
	if (result.status === 1) return [];
	if (result.status !== 0) throw new Error(`git grep failed: ${result.stderr.trim()}`);
	const prefix = ref === undefined ? "" : `${ref}:`;
	return result.stdout
		.trim()
		.split("\n")
		.map((file) => (file.startsWith(prefix) ? file.slice(prefix.length) : file));
}

const [baseRef = "HEAD", headRef, ...extra] = process.argv.slice(2);
if (extra.length > 0 || baseRef.startsWith("-")) {
	console.error("Usage: diff-model-catalog.mjs [<base-ref> [<head-ref>]]");
	process.exit(1);
}

const headLabel = headRef ?? "working tree";
const base = parseCatalog(readCatalog(baseRef), baseRef);
const head = parseCatalog(readCatalog(headRef), headLabel);
const report = [];
let added = 0;
let changed = 0;
let removed = 0;
for (const key of [...new Set([...base.keys(), ...head.keys()])].sort()) {
	const before = base.get(key);
	const after = head.get(key);
	const modelKey = key.slice(key.indexOf("/") + 1);
	if (!before) {
		added++;
		report.push(`added    ${key}`);
		continue;
	}
	if (!after) {
		removed++;
		report.push(`removed  ${key}`);
	} else {
		const fields = changedFields(before, after);
		if (fields.length === 0) continue;
		changed++;
		report.push(`changed  ${key}: ${fields.join(", ")}`);
	}
	const tests = testsQuoting(modelKey, headRef);
	if (tests.length > 0) report.push(`  quoted in ${tests.join(", ")}`);
}

console.log(
	`Model catalog ${baseRef} -> ${headLabel}: ${changed} changed, ${added} added, ${removed} removed (${head.size} entries)`,
);
for (const line of report) console.log(line);
