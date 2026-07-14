#!/usr/bin/env node
/**
 * Changeset-driven changelog generation for Volt.
 *
 * Pending changes live as fragment files in `.changeset/` (see
 * .changeset/README.md for the authoring format). Release preparation consumes
 * every fragment into a generated version section in the single product
 * changelog, so the changelog itself is never edited by hand.
 *
 * Usage:
 *   node scripts/changelog.mjs render [--version <x.y.z>] [--date <YYYY-MM-DD>]
 *   node scripts/changelog.mjs release --version <x.y.z> [--date <YYYY-MM-DD>]
 *
 * `render` prints the section the pending fragments would produce. `release`
 * inserts that section into the changelog and deletes the consumed fragments.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RELEASE_CHANGELOG, RELEASE_PACKAGE_IDENTITIES } from "./verify-release-provenance.mjs";

export const CHANGESET_DIR = ".changeset";

const KNOWN_PACKAGE_NAMES = new Set(RELEASE_PACKAGE_IDENTITIES.map(({ name }) => name));
const RENDERED_SECTIONS = [
	{ heading: "Highlights", kind: "feature" },
	{ heading: "Breaking Changes", kind: "breaking" },
	{ heading: "Improvements", kind: "improvement" },
	{ heading: "Fixes", kind: "fix" },
];
const FRONT_MATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const FRONT_MATTER_LINE_RE = /^"?([^":\s]+)"?\s*:\s*(patch|minor|major)\s*$/;
const SUMMARY_RE = /^(breaking|feature|improvement|fix|internal)(?:\(([a-z0-9][a-z0-9./-]*)\))?:\s+(\S.*)$/;

export function listChangesetFiles(changesetDir = CHANGESET_DIR) {
	if (!existsSync(changesetDir)) {
		return [];
	}
	return readdirSync(changesetDir)
		.filter((name) => name.endsWith(".md") && name.toLowerCase() !== "readme.md")
		.sort()
		.map((name) => path.join(changesetDir, name));
}

export function parseChangeset(file, content) {
	const normalized = content.replaceAll("\r\n", "\n");
	const match = FRONT_MATTER_RE.exec(normalized);
	if (!match) {
		throw new Error(`${file}: changeset must start with a --- front matter block`);
	}

	const bumps = new Set();
	const packages = [];
	for (const rawLine of match[1].split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			continue;
		}
		const entry = FRONT_MATTER_LINE_RE.exec(line);
		if (!entry) {
			throw new Error(`${file}: unparseable front matter line: ${line}`);
		}
		const [, packageName, bump] = entry;
		if (!KNOWN_PACKAGE_NAMES.has(packageName)) {
			throw new Error(`${file}: unknown package ${packageName}; expected one of ${[...KNOWN_PACKAGE_NAMES].join(", ")}`);
		}
		if (bump === "major") {
			throw new Error(`${file}: major releases are not used; breaking changes use a minor bump`);
		}
		packages.push(packageName);
		bumps.add(bump);
	}
	if (packages.length === 0) {
		throw new Error(`${file}: front matter must list at least one package`);
	}
	if (bumps.size > 1) {
		throw new Error(`${file}: all packages in one changeset must share the same bump`);
	}

	const summary = match[2].trim();
	if (!summary) {
		throw new Error(`${file}: changeset has no summary`);
	}
	const newlineIndex = summary.indexOf("\n");
	const firstLine = newlineIndex === -1 ? summary : summary.slice(0, newlineIndex);
	const details = newlineIndex === -1 ? "" : summary.slice(newlineIndex + 1).trim();

	const parsedSummary = SUMMARY_RE.exec(firstLine);
	if (!parsedSummary) {
		throw new Error(
			`${file}: first summary line must be "kind(area): One user-facing sentence." with kind one of breaking, feature, improvement, fix, internal; found: ${firstLine}`,
		);
	}
	const [, kind, area, sentence] = parsedSummary;

	const [bump] = bumps;
	if (kind === "breaking" && bump !== "minor") {
		throw new Error(`${file}: breaking changes must use a minor bump`);
	}
	if (kind !== "breaking" && bump !== "patch") {
		throw new Error(`${file}: only breaking changes may use a minor bump`);
	}
	if (kind === "breaking" && !details) {
		throw new Error(`${file}: breaking changes must describe the migration in the body below the first line`);
	}

	return { area: area ?? "", bump, details, file, kind, packages, sentence };
}

export function readChangesets(changesetDir = CHANGESET_DIR) {
	const errors = [];
	const changesets = [];
	for (const file of listChangesetFiles(changesetDir)) {
		try {
			changesets.push(parseChangeset(file, readFileSync(file, "utf8")));
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (errors.length > 0) {
		throw new Error(`invalid changesets:\n${errors.join("\n")}`);
	}
	return changesets;
}

export function requiredReleaseBump(changesets) {
	return changesets.some(({ kind }) => kind === "breaking") ? "minor" : "patch";
}

export function assertReleaseTargetSatisfiesChangesets(currentVersion, plannedVersion, changesets) {
	if (requiredReleaseBump(changesets) !== "minor") {
		return;
	}
	const [currentMajor, currentMinor] = currentVersion.split(".").map(Number);
	const [plannedMajor, plannedMinor] = plannedVersion.split(".").map(Number);
	if (plannedMajor === currentMajor && plannedMinor === currentMinor) {
		throw new Error(
			`changesets contain breaking changes, so ${plannedVersion} must bump the minor version from ${currentVersion}; release with the minor target`,
		);
	}
}

function compareGroupedEntries(a, b) {
	if (Boolean(a.area) !== Boolean(b.area)) {
		return a.area ? -1 : 1;
	}
	return a.area.localeCompare(b.area) || a.file.localeCompare(b.file);
}

function renderEntry(changeset, { includeArea }) {
	const prefix = includeArea && changeset.area ? `**${changeset.area}:** ` : "";
	const lines = [`- ${prefix}${changeset.sentence}`];
	if (changeset.details) {
		for (const detailLine of changeset.details.split("\n")) {
			lines.push(detailLine ? `  ${detailLine}` : "");
		}
	}
	return lines;
}

export function renderReleaseSection(changesets, version, date) {
	const lines = [`## [${version}] - ${date}`, ""];
	const visible = changesets.filter(({ kind }) => kind !== "internal");
	if (visible.length === 0) {
		lines.push("Maintenance release with no user-facing changes.", "");
		return lines.join("\n");
	}

	for (const { heading, kind } of RENDERED_SECTIONS) {
		const entries = visible.filter((changeset) => changeset.kind === kind);
		if (entries.length === 0) {
			continue;
		}
		const sorted = kind === "improvement" || kind === "fix" ? [...entries].sort(compareGroupedEntries) : entries;
		lines.push(`### ${heading}`, "");
		for (const changeset of sorted) {
			lines.push(...renderEntry(changeset, { includeArea: kind !== "feature" }));
		}
		lines.push("");
	}
	return lines.join("\n");
}

export function assertNoPendingChangesets(changesetDir = CHANGESET_DIR) {
	const pending = listChangesetFiles(changesetDir);
	if (pending.length > 0) {
		throw new Error(`unconsumed changesets remain: ${pending.join(", ")}`);
	}
}

export function applyReleaseSection({ version, date, changelogPath = RELEASE_CHANGELOG, changesetDir = CHANGESET_DIR }) {
	const changesets = readChangesets(changesetDir);
	if (changesets.length === 0) {
		throw new Error(`no changesets found in ${changesetDir}; add release fragments before preparing a release`);
	}

	const raw = readFileSync(changelogPath, "utf8");
	const usesCrlf = raw.includes("\r\n");
	const changelog = usesCrlf ? raw.replaceAll("\r\n", "\n") : raw;
	if (!changelog.startsWith("# Changelog\n")) {
		throw new Error(`${changelogPath} does not start with the expected changelog heading`);
	}
	if (new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m").test(changelog)) {
		throw new Error(`${changelogPath} already contains a section for ${version}`);
	}

	const section = renderReleaseSection(changesets, version, date);
	const rest = changelog.slice("# Changelog\n".length).replace(/^\n+/, "");
	const updated = `# Changelog\n\n${section}${rest ? `\n${rest}` : ""}`;
	writeFileSync(changelogPath, usesCrlf ? updated.replaceAll("\n", "\r\n") : updated);

	for (const changeset of changesets) {
		rmSync(changeset.file);
	}
	return { changesets, section };
}

function parseCliOptions(args) {
	const options = { date: undefined, version: undefined };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg !== "--version" && arg !== "--date") {
			throw new Error(`Unknown option: ${arg}`);
		}
		const value = args[++i];
		if (!value) {
			throw new Error(`${arg} requires a value`);
		}
		if (arg === "--version") options.version = value;
		if (arg === "--date") options.date = value;
	}
	options.date ??= new Date().toISOString().split("T")[0];
	return options;
}

function main(argv) {
	const [command, ...args] = argv;
	const options = parseCliOptions(args);
	if (command === "render") {
		const changesets = readChangesets();
		if (changesets.length === 0) {
			console.log("No pending changesets.");
			return;
		}
		process.stdout.write(renderReleaseSection(changesets, options.version ?? "Unreleased", options.date));
		return;
	}
	if (command === "release") {
		if (!options.version) {
			throw new Error("release requires --version");
		}
		const { changesets } = applyReleaseSection(options);
		console.log(`Consumed ${changesets.length} changeset(s) into ${RELEASE_CHANGELOG} for ${options.version}.`);
		return;
	}
	throw new Error("Usage: node scripts/changelog.mjs <render|release> [--version <x.y.z>] [--date <YYYY-MM-DD>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
