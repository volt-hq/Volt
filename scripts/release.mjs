#!/usr/bin/env node
/**
 * Release script for volt
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Require an up-to-date main branch
 * 3. Bump version via npm run version:xxx or set an explicit version
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date
 * 5. Regenerate release artifacts
 * 6. Run checks
 * 7. Commit and create an annotated release tag
 * 8. Add new [Unreleased] section to changelogs
 * 9. Commit next-cycle changelog updates
 * 10. Push main and the tag to trigger CI publishing
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import {
	assertReleaseTagAvailable,
	getPlannedReleaseVersion,
	isReleaseTarget,
	planReleaseTarget,
} from "./release-target.mjs";

const RELEASE_TARGET = process.argv[2];

if (!isReleaseTarget(RELEASE_TARGET)) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z>");
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function stageChangedFiles() {
	const output = run("git ls-files -m -o -d --exclude-standard", { silent: true });
	const paths = [...new Set((output || "").split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		return;
	}

	run(`git add -- ${paths.map(shellQuote).join(" ")}`);
}

function requireReleaseTagAvailable(version) {
	try {
		assertReleaseTagAvailable(version);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

function bumpOrSetVersion(target) {
	const currentVersion = getVersion();
	const plan = planReleaseTarget(target, currentVersion);

	if (plan.type === "bump") {
		console.log(`Bumping version (${plan.value})...`);
		run(`npm run version:${plan.value}`);
		return getVersion();
	}

	if (plan.type === "current") {
		console.log(`Preparing current version (${plan.value}) without incrementing package manifests...`);
		return currentVersion;
	}

	console.log(`Setting explicit version (${plan.value})...`);
	run(`npm version ${plan.value} -ws --no-git-tag-version && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		// Insert after "# Changelog\n\n"
		const updated = content.replace(
			/^(# Changelog\n\n)/,
			`$1${unreleasedSection}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

// Main flow
console.log("\n=== Release Script ===\n");

// 1. Check for uncommitted changes
console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status && status.trim()) {
	console.error("Error: Uncommitted changes detected. Commit or stash first.");
	console.error(status);
	process.exit(1);
}
console.log("  Working directory clean\n");

// 2. Require the protected release branch at its published tip
console.log("Checking release branch provenance...");
const branch = run("git branch --show-current", { silent: true })?.trim();
if (branch !== "main") {
	console.error(`Error: releases must start from main, not ${branch || "a detached HEAD"}.`);
	process.exit(1);
}
run("git fetch --prune origin +refs/heads/main:refs/remotes/origin/main");
const head = run("git rev-parse HEAD", { silent: true })?.trim();
const originMain = run("git rev-parse refs/remotes/origin/main", { silent: true })?.trim();
if (head !== originMain) {
	console.error(`Error: local main ${head} must exactly match origin/main ${originMain} before release.`);
	process.exit(1);
}
console.log("  main matches origin/main\n");

// 3. Prove the intended version is unpublished before changing release files
const currentVersion = getVersion();
const releasePlan = planReleaseTarget(RELEASE_TARGET, currentVersion);
const plannedVersion = getPlannedReleaseVersion(RELEASE_TARGET, currentVersion);
console.log(`Checking release target v${plannedVersion}...`);
requireReleaseTagAvailable(plannedVersion);
run(
	`node scripts/verify-npm-package-bootstrap.mjs preflight --version ${shellQuote(plannedVersion)}${releasePlan.type === "current" ? " --initial" : ""}`,
);
console.log(`  v${plannedVersion} is available for release\n`);

// 4. Bump or set version
const version = bumpOrSetVersion(RELEASE_TARGET);
if (version !== plannedVersion) {
	console.error(`Error: version command produced ${version}; expected planned version ${plannedVersion}.`);
	process.exit(1);
}
console.log(`  New version: ${version}\n`);

// 5. Update changelogs
console.log("Updating CHANGELOG.md files...");
updateChangelogsForRelease(version);
console.log();

// 6. Regenerate release artifacts
console.log("Regenerating release artifacts...");
run("npm --prefix packages/ai run generate-models");
run("npm --prefix packages/ai run generate-image-models");
run("npm run shrinkwrap:coding-agent");
console.log();

// 7. Run checks
console.log("Running checks...");
run("npm run check");
console.log();

// 8. Commit and tag
console.log("Committing and tagging...");
stageChangedFiles();
run(`git commit -m "Release v${version}"`);
run(`git tag -a -m "Release v${version}" v${version}`);
console.log();

// 9. Add new [Unreleased] sections
console.log("Adding [Unreleased] sections for next cycle...");
addUnreleasedSection();
console.log();

// 10. Commit
console.log("Committing changelog updates...");
stageChangedFiles();
run(`git commit -m "Add [Unreleased] section for next cycle"`);
console.log();

// 11. Push
console.log("Pushing to remote...");
run("git push origin main");
run(`git push origin v${version}`);
console.log();

console.log(`=== Prepared release v${version}; CI publishing starts after the tag push ===`);
