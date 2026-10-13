#!/usr/bin/env node
/**
 * Selects the CI jobs a change needs.
 *
 *   node scripts/ci-changed-areas.mjs --base <git-ref>
 *     Classify the diff from <git-ref> to HEAD. Pull requests pass the first
 *     parent of GitHub's merge commit.
 *
 *   node scripts/ci-changed-areas.mjs --all
 *     Select every area. Pushes to main use this as the full checkpoint.
 *
 * Writes `<area>=true|false` lines to $GITHUB_OUTPUT when it is set. Any path
 * this script does not recognize selects the test shards, so new inputs fail
 * toward running more work.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const CI_AREAS = ["tests", "workspace-fs-native", "iroh-native", "relay-credential-broker"];

/** Changing how CI selects work reruns everything. */
const SELECTION_INPUTS = new Set([".github/workflows/ci.yml", "scripts/ci-changed-areas.mjs"]);

/** Documentation that no Node test reads. `npm run check` still validates it in build-check. */
const DOCS_ONLY_RE = [/^[^/]+\.md$/, /^docs\//, /^packages\/[^/]+\/README\.md$/, /^packages\/[^/]+\/docs\//];

/** Documents that Vitest suites read as contracts. */
const TEST_PINNED_DOCS = new Set(["packages/coding-agent/docs/sqlite-session-storage-design.md"]);

/** Services with their own CI job and no Node test coverage. */
const SERVICE_RE = /^services\/relay-credential-broker\//;

const AREA_INPUTS = {
	"workspace-fs-native": [/^packages\/coding-agent\/native\/workspace-fs\//, /^scripts\/workspace-fs-native\.mjs$/],
	"iroh-native": [
		/^(?:package\.json|package-lock\.json|\.npmrc|packages\/coding-agent\/package\.json)$/,
		/^scripts\/check-iroh-native-load\.mjs$/,
	],
	"relay-credential-broker": [SERVICE_RE],
};

function allAreas(selected) {
	return Object.fromEntries(CI_AREAS.map((area) => [area, selected]));
}

function isDocsOnly(path) {
	return !TEST_PINNED_DOCS.has(path) && DOCS_ONLY_RE.some((pattern) => pattern.test(path));
}

/**
 * @param {readonly string[]} paths repository-relative paths changed by the diff
 * @returns {Record<string, boolean>} whether each CI area must run
 */
export function selectAreas(paths) {
	if (paths.length === 0 || paths.some((path) => SELECTION_INPUTS.has(path))) {
		return allAreas(true);
	}
	const areas = allAreas(false);
	areas.tests = paths.some((path) => !isDocsOnly(path) && !SERVICE_RE.test(path));
	for (const [area, patterns] of Object.entries(AREA_INPUTS)) {
		areas[area] = paths.some((path) => patterns.some((pattern) => pattern.test(path)));
	}
	return areas;
}

function changedPaths(base) {
	// Without rename detection a moved file lists both its old and new path.
	return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function main(argv) {
	let areas;
	if (argv.length === 1 && argv[0] === "--all") {
		console.log("ci-changed-areas: selecting every area.");
		areas = allAreas(true);
	} else if (argv.length === 2 && argv[0] === "--base" && argv[1]) {
		const paths = changedPaths(argv[1]);
		console.log(`ci-changed-areas: ${paths.length} changed path(s) since ${argv[1]}.`);
		areas = selectAreas(paths);
	} else {
		throw new Error("Usage: node scripts/ci-changed-areas.mjs --base <git-ref> | --all");
	}
	const lines = CI_AREAS.map((area) => `${area}=${areas[area]}`);
	for (const line of lines) console.log(line);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
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
