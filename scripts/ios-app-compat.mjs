#!/usr/bin/env node
/**
 * Flags changes that can break the Volt iOS build recorded in
 * .github/ios-app-baseline.json (the latest build submitted to App Review or
 * released). See "iOS app compatibility" in AGENTS.md.
 *
 *   node scripts/ios-app-compat.mjs --base <git-ref>
 *     Classify the diff from <git-ref> to HEAD. Pull requests pass the first
 *     parent of GitHub's merge commit.
 *
 * Prints one line per app-facing change and writes `app-facing=true|false` to
 * $GITHUB_OUTPUT when it is set.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const BASELINE_PATH = ".github/ios-app-baseline.json";
export const PROTOCOL_CONTRACT_PATH = "packages/protocol/contract/protocol-schema.json";
export const CODING_AGENT_PACKAGE_PATH = "packages/coding-agent/package.json";
export const IROH_BINDING = "@hansjm10/volt-iroh";

/** Inputs outside the protocol contract that the app reads or calls. */
export const APP_FACING_PATHS = [
	{
		pattern: /^packages\/coding-agent\/src\/core\/remote\/iroh\/(?:protocol|ticket|push|completion-notifications)\.ts$/,
		surface: "pairing ticket, remote features, or push payloads",
	},
	{
		pattern: /^packages\/coding-agent\/examples\/remote\/firebase-push-relay\/functions\/(?!.*\.test\.js$)[^/]+\.js$/,
		surface: "push relay function",
	},
	{
		pattern: /^services\/relay-credential-broker\/(?!.*(?:_test\.go|\.md)$)/,
		surface: "relay credential broker or relay",
	},
];

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;

/** @returns {{ build: string, version: string, status: string, appCommit: string, protocolContract: { voltCommit: string, sha256: string }, voltIroh: string }} */
export function parseBaseline(text) {
	const baseline = JSON.parse(text);
	const valid =
		typeof baseline?.build === "string" &&
		/^[1-9][0-9]*$/.test(baseline.build) &&
		typeof baseline.version === "string" &&
		typeof baseline.status === "string" &&
		COMMIT_RE.test(baseline.appCommit ?? "") &&
		COMMIT_RE.test(baseline.protocolContract?.voltCommit ?? "") &&
		SHA256_RE.test(baseline.protocolContract?.sha256 ?? "") &&
		typeof baseline.voltIroh === "string" &&
		baseline.voltIroh.length > 0;
	if (!valid) {
		throw new Error(`${BASELINE_PATH} must record build, version, status, appCommit, protocolContract, and voltIroh.`);
	}
	return baseline;
}

export function describeBaseline(baseline) {
	return `Volt iOS ${baseline.version} (${baseline.build}), ${baseline.status}`;
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function irohBinding(packageJson) {
	if (packageJson === undefined) return undefined;
	return JSON.parse(packageJson).dependencies?.[IROH_BINDING];
}

/**
 * @param {object} input
 * @param {readonly string[]} input.paths repository-relative paths changed by the diff
 * @param {ReturnType<typeof parseBaseline>} input.baseline
 * @param {(path: string) => string | undefined} input.readBase file contents at the base, or undefined if absent
 * @param {(path: string) => string | undefined} input.readHead file contents at HEAD, or undefined if absent
 * @returns {string[]} one description per app-facing change; empty when none
 */
export function appFacingChanges({ paths, baseline, readBase, readHead }) {
	const changes = [];
	const changed = new Set(paths);
	if (changed.has(PROTOCOL_CONTRACT_PATH)) {
		const contract = readHead(PROTOCOL_CONTRACT_PATH);
		if (contract === undefined || sha256(contract) !== baseline.protocolContract.sha256) {
			changes.push(
				`${PROTOCOL_CONTRACT_PATH}: protocol contract differs from the one the baseline pins (Volt ${baseline.protocolContract.voltCommit.slice(0, 9)})`,
			);
		}
	}
	for (const path of paths) {
		const rule = APP_FACING_PATHS.find(({ pattern }) => pattern.test(path));
		if (rule) changes.push(`${path}: ${rule.surface}`);
	}
	if (changed.has(CODING_AGENT_PACKAGE_PATH)) {
		const before = irohBinding(readBase(CODING_AGENT_PACKAGE_PATH));
		const after = irohBinding(readHead(CODING_AGENT_PACKAGE_PATH));
		if (after !== before && after !== baseline.voltIroh) {
			changes.push(
				`${CODING_AGENT_PACKAGE_PATH}: ${IROH_BINDING} ${after ?? "removed"} (baseline ${baseline.voltIroh})`,
			);
		}
	}
	return changes;
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function readAt(ref, path) {
	try {
		return git(["show", `${ref}:${path}`]);
	} catch {
		return undefined;
	}
}

function main(argv) {
	if (argv.length !== 2 || argv[0] !== "--base" || !argv[1]) {
		throw new Error("Usage: node scripts/ios-app-compat.mjs --base <git-ref>");
	}
	const base = argv[1];
	const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
	// Without rename detection a moved file lists both its old and new path.
	const paths = git(["diff", "--name-only", "--no-renames", base, "HEAD"])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const changes = appFacingChanges({
		paths,
		baseline,
		readBase: (path) => readAt(base, path),
		readHead: (path) => readAt("HEAD", path),
	});
	console.log(`ios-app-compat: baseline ${describeBaseline(baseline)}.`);
	if (changes.length === 0) {
		console.log("ios-app-compat: no app-facing changes.");
	} else {
		console.log(`ios-app-compat: ${changes.length} app-facing change(s):`);
		for (const change of changes) console.log(`- ${change}`);
	}
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `app-facing=${changes.length > 0}\n`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
