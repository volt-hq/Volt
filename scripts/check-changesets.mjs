#!/usr/bin/env node
/**
 * Changeset guards so nobody has to remember the changelog.
 *
 * Modes:
 *   node scripts/check-changesets.mjs
 *     Validate the format of every pending fragment in .changeset/.
 *     Wired into `npm run check`, so malformed fragments fail locally and in CI.
 *
 *   node scripts/check-changesets.mjs --require --base <git-ref>
 *     CI gate for pull requests: fail when the diff from <git-ref> to HEAD
 *     touches product source without adding a changeset fragment, and print a
 *     ready-to-edit suggested fragment (derived from the PR title when
 *     GITHUB_EVENT_PATH is available). Pure refactors satisfy the gate with an
 *     `internal:` fragment.
 *
 *   node scripts/check-changesets.mjs --warn --staged
 *     Pre-commit nudge: print a warning (never fails) when staged changes
 *     touch product source and no fragment is staged or pending.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { listChangesetFiles, readChangesets } from "./changelog.mjs";
import { RELEASE_PACKAGE_IDENTITIES } from "./verify-release-provenance.mjs";

const PRODUCT_SOURCE_RE = /^packages\/(?:ai|tui|agent|coding-agent)\/src\//;
const GENERATED_RE = /\.generated\./;
const FRAGMENT_RE = /^\.changeset\/(?!README\.md$).+\.md$/i;
const TITLE_RE = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/;
const KIND_BY_TITLE_PREFIX = {
	feat: "feature",
	feature: "feature",
	fix: "fix",
	perf: "improvement",
	improvement: "improvement",
	breaking: "breaking",
	refactor: "internal",
	chore: "internal",
	ci: "internal",
	build: "internal",
	test: "internal",
	docs: "internal",
	meta: "internal",
	style: "internal",
};

export function isProductSourcePath(path) {
	return PRODUCT_SOURCE_RE.test(path) && !GENERATED_RE.test(path);
}

export function isFragmentPath(path) {
	return FRAGMENT_RE.test(path);
}

export function suggestFragment({ changedPaths = [], title = "", pullNumber = undefined } = {}) {
	const parsedTitle = TITLE_RE.exec(title.trim());
	const kind = (parsedTitle && KIND_BY_TITLE_PREFIX[parsedTitle[1].toLowerCase()]) || "improvement";
	const area = parsedTitle?.[2] ? parsedTitle[2].trim().toLowerCase().replaceAll(/[^a-z0-9./-]+/g, "-") : "";

	let sentence = (parsedTitle?.[3] ?? title.trim() ?? "").trim();
	sentence = sentence ? sentence[0].toUpperCase() + sentence.slice(1) : "One user-facing sentence describing the change";
	if (!/[.!?]$/.test(sentence)) {
		sentence += ".";
	}
	if (pullNumber) {
		sentence += ` ([#${pullNumber}](https://github.com/volt-hq/Volt/pull/${pullNumber}))`;
	}

	const changedDirectories = new Set(
		changedPaths.filter(isProductSourcePath).map((path) => path.split("/").slice(0, 2).join("/")),
	);
	const packages = RELEASE_PACKAGE_IDENTITIES.filter(({ directory }) => changedDirectories.has(directory)).map(
		({ name }) => name,
	);
	if (packages.length === 0) {
		packages.push("@hansjm10/volt-coding-agent");
	}

	const bump = kind === "breaking" ? "minor" : "patch";
	const frontMatter = packages.map((name) => `"${name}": ${bump}`).join("\n");
	const areaPart = area && area !== "coding-agent" ? `(${area})` : "";
	const body = kind === "breaking" ? `\n\nDescribe the migration here.` : "";
	return `---\n${frontMatter}\n---\n\n${kind}${areaPart}: ${sentence}${body}\n`;
}

function git(args) {
	return execFileSync("git", args, { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function readPullRequestEvent() {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		return {};
	}
	try {
		const event = JSON.parse(readFileSync(eventPath, "utf8"));
		return { pullNumber: event.pull_request?.number, title: event.pull_request?.title ?? "" };
	} catch {
		return {};
	}
}

function validatePendingFragments() {
	const changesets = readChangesets();
	console.log(`check-changesets: ${changesets.length} pending fragment(s), all valid.`);
}

function requireFragmentForDiff(base) {
	const changedPaths = git(["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD"]);
	const productChanges = changedPaths.filter(isProductSourcePath);
	if (productChanges.length === 0) {
		console.log("check-changesets: no product source changes; no fragment required.");
		return;
	}
	if (changedPaths.some(isFragmentPath)) {
		console.log("check-changesets: product source changed and a changeset fragment is included.");
		return;
	}

	const { pullNumber, title } = readPullRequestEvent();
	const suggestion = suggestFragment({ changedPaths, pullNumber, title });
	const lines = [
		"This change touches product source but adds no changeset fragment:",
		...productChanges.slice(0, 10).map((path) => `  - ${path}`),
	];
	if (productChanges.length > 10) {
		lines.push(`  ... and ${productChanges.length - 10} more`);
	}
	lines.push(
		"",
		"Add a fragment describing the user-visible change (see .changeset/README.md),",
		"or use kind `internal` if there is no user-visible behavior change:",
		"",
		`cat > .changeset/${suggestSlug(title)}.md <<'FRAGMENT'`,
		suggestion.trimEnd(),
		"FRAGMENT",
		"",
		'Or run: npm run changeset:add -- <kind> [area] "One user-facing sentence."',
		"Or have Volt draft it from your diff: npm run changeset:draft",
	);
	console.error(lines.join("\n"));
	process.exit(1);
}

export function suggestSlug(title = "") {
	const words = title
		.toLowerCase()
		.replaceAll(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 6);
	return words.length > 0 ? words.join("-") : "describe-this-change";
}

function warnForStagedChanges() {
	const stagedPaths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
	if (!stagedPaths.some(isProductSourcePath)) {
		return;
	}
	if (stagedPaths.some(isFragmentPath) || listChangesetFiles().length > 0) {
		return;
	}
	console.warn(
		"⚠️  Staged changes touch product source (packages/*/src) but no changeset fragment exists.\n" +
			"   Let Volt draft it: npm run changeset:draft\n" +
			'   Or write it yourself: npm run changeset:add -- <kind> [area] "One user-facing sentence."\n' +
			"   Pure refactor? Use kind `internal`. CI will require a fragment on the pull request.",
	);
}

function main(argv) {
	const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
	const baseIndex = argv.indexOf("--base");
	const base = baseIndex !== -1 ? argv[baseIndex + 1] : undefined;

	if (flags.has("--warn")) {
		warnForStagedChanges();
		return;
	}
	validatePendingFragments();
	if (flags.has("--require")) {
		if (!base) {
			throw new Error("--require needs --base <git-ref>");
		}
		requireFragmentForDiff(base);
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
