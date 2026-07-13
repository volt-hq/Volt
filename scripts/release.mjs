#!/usr/bin/env node
/**
 * Two-phase release script for Volt.
 *
 * Usage:
 *   node scripts/release.mjs prepare <major|minor|patch|x.y.z>
 *   VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> node scripts/release.mjs finalize <exact-40-character-candidate-commit>
 *
 * `prepare` creates and pushes the final release commit, but deliberately does
 * not create a tag. Build and inspect all six native standalone candidates for
 * that exact commit before running `finalize`. Finalization requires the exact
 * inspected commit and successful workflow run as an explicit sign-off,
 * records both in the annotated tag, pushes it, then starts the next changelog
 * cycle on main.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
	assertCandidateMatchesHead,
	assertCandidateRunId,
	assertCandidateWorkflowArtifact,
	assertCandidateWorkflowRun,
	parseReleaseInvocation,
	RELEASE_USAGE,
} from "./release-phase.mjs";
import {
	assertReleaseTagAvailable,
	getPlannedReleaseVersion,
	planReleaseTarget,
} from "./release-target.mjs";
import { verifyReleasePackageMetadata } from "./verify-release-provenance.mjs";

let invocation;
try {
	invocation = parseReleaseInvocation(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : RELEASE_USAGE);
	process.exit(1);
}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (error) {
		if (!options.ignoreError) {
			console.error(`Command failed: ${cmd}`);
			process.exit(1);
		}
		return null;
	}
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
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
	if (paths.length > 0) {
		run(`git add -- ${paths.map(shellQuote).join(" ")}`);
	}
}

function requireReleaseTagAvailable(version) {
	try {
		assertReleaseTagAvailable(version);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
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
	return readdirSync("packages")
		.map((pkg) => join("packages", pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	for (const changelog of getChangelogs()) {
		const content = readFileSync(changelog, "utf-8");
		if (!content.includes("## [Unreleased]")) {
			fail(`${changelog} has no [Unreleased] section`);
		}
		writeFileSync(changelog, content.replace("## [Unreleased]", `## [${version}] - ${date}`));
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const unreleasedSection = "## [Unreleased]\n\n";
	for (const changelog of getChangelogs()) {
		const content = readFileSync(changelog, "utf-8");
		if (content.includes("## [Unreleased]")) {
			fail(`${changelog} already contains an [Unreleased] section`);
		}
		const updated = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);
		if (updated === content) {
			fail(`${changelog} does not start with the expected changelog heading`);
		}
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

function requireCleanPublishedMain() {
	console.log("Checking for uncommitted changes...");
	const status = run("git status --porcelain", { silent: true });
	if (status && status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean\n");

	console.log("Checking release branch provenance...");
	const branch = run("git branch --show-current", { silent: true })?.trim();
	if (branch !== "main") {
		fail(`releases must run from main, not ${branch || "a detached HEAD"}.`);
	}
	run("git fetch --prune origin +refs/heads/main:refs/remotes/origin/main");
	const head = run("git rev-parse HEAD", { silent: true })?.trim();
	const originMain = run("git rev-parse refs/remotes/origin/main", { silent: true })?.trim();
	if (head !== originMain) {
		fail(`local main ${head} must exactly match origin/main ${originMain} before release.`);
	}
	console.log("  main matches origin/main\n");
	return head;
}

function verifyNpmVersionAvailable(version, initial) {
	requireReleaseTagAvailable(version);
	run(
		`node scripts/verify-npm-package-bootstrap.mjs preflight --version ${shellQuote(version)}${initial ? " --initial" : ""}`,
	);
}

function parseGitHubJson(output, description) {
	try {
		return JSON.parse(output);
	} catch {
		fail(`GitHub returned invalid JSON for ${description}`);
	}
}

function verifyApprovedCandidateRun(candidateCommit, runId) {
	const runPath = `/repos/hansjm10/Volt/actions/runs/${runId}`;
	const runMetadata = parseGitHubJson(run(`gh api ${shellQuote(runPath)}`, { silent: true }), "candidate workflow run");
	try {
		assertCandidateWorkflowRun(runMetadata, { candidateCommit, runId });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	const artifactName = `standalone-candidate-${candidateCommit}`;
	const artifactsPath = `${runPath}/artifacts?name=${artifactName}&per_page=100`;
	const artifactMetadata = parseGitHubJson(
		run(`gh api ${shellQuote(artifactsPath)}`, { silent: true }),
		"candidate workflow artifacts",
	);
	try {
		return assertCandidateWorkflowArtifact(artifactMetadata, { candidateCommit, runId });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

function prepareRelease(target) {
	requireCleanPublishedMain();

	const currentVersion = getVersion();
	const releasePlan = planReleaseTarget(target, currentVersion);
	const plannedVersion = getPlannedReleaseVersion(target, currentVersion);
	console.log(`Checking release target v${plannedVersion}...`);
	verifyNpmVersionAvailable(plannedVersion, releasePlan.type === "current");
	console.log(`  v${plannedVersion} is available for release\n`);

	const version = bumpOrSetVersion(target);
	if (version !== plannedVersion) {
		fail(`version command produced ${version}; expected planned version ${plannedVersion}.`);
	}
	console.log(`  New version: ${version}\n`);

	console.log("Updating CHANGELOG.md files...");
	updateChangelogsForRelease(version);
	console.log();

	console.log("Regenerating release artifacts...");
	run("npm --prefix packages/ai run generate-models");
	run("npm --prefix packages/ai run generate-image-models");
	run("npm run shrinkwrap:coding-agent");
	console.log();

	console.log("Running checks...");
	run("npm run check");
	console.log();

	console.log("Committing the exact pre-tag release candidate...");
	stageChangedFiles();
	run(`git commit -m "Release v${version}"`);
	const candidateCommit = run("git rev-parse HEAD", { silent: true })?.trim();
	assertCandidateMatchesHead(candidateCommit, candidateCommit);
	console.log();

	console.log("Pushing the candidate commit to main (no tag is created)...");
	run("git push origin main");
	console.log();

	console.log(`=== Prepared release v${version} at ${candidateCommit} ===`);
	console.log("No release tag exists yet. Next:");
	console.log(`  1. Run the Build Standalone Candidate workflow with commit ${candidateCommit}`);
	console.log("  2. Inspect and record all six native archives, manifests, smoke tests, and checksums");
	console.log(
		`  3. Finalize only after approval: VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> npm run release:finalize -- ${candidateCommit}`,
	);
}

function finalizeRelease(candidateCommit) {
	let candidateRunId;
	try {
		candidateRunId = assertCandidateRunId(process.env.VOLT_APPROVED_CANDIDATE_RUN_ID);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	const head = requireCleanPublishedMain();
	try {
		assertCandidateMatchesHead(candidateCommit, head);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	const version = getVersion();
	const tag = `v${version}`;
	const subject = run("git log -1 --format=%s", { silent: true })?.trim();
	if (subject !== `Release ${tag}`) {
		fail(`approved candidate must be the prepared release commit named "Release ${tag}"; found ${JSON.stringify(subject)}.`);
	}
	try {
		verifyReleasePackageMetadata(tag);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	for (const changelog of getChangelogs()) {
		if (readFileSync(changelog, "utf-8").includes("## [Unreleased]")) {
			fail(`${changelog} still contains [Unreleased]; finalize only the exact commit produced by prepare.`);
		}
	}

	console.log(`Verifying approved candidate workflow run ${candidateRunId} before tag creation...`);
	const approvedArtifact = verifyApprovedCandidateRun(candidateCommit, candidateRunId);
	console.log(`  Found unexpired artifact ${approvedArtifact.name} (${approvedArtifact.size_in_bytes} bytes)\n`);

	console.log(`Rechecking tag and npm availability for ${tag}...`);
	verifyNpmVersionAvailable(version, version === "0.1.0");
	console.log(`  Explicit candidate sign-off matches ${head} from workflow run ${candidateRunId}\n`);

	console.log(`Creating annotated ${tag} at the approved candidate commit...`);
	const candidateAttestation =
		`Standalone-Candidate-Commit: ${candidateCommit}\n` + `Standalone-Candidate-Run: ${candidateRunId}`;
	run(
		`git tag -a -m ${shellQuote(`Release ${tag}`)} -m ${shellQuote(candidateAttestation)} ${tag} ${candidateCommit}`,
	);
	console.log();

	console.log("Pushing the release tag to trigger CI publication...");
	run(`git push origin ${tag}`);
	console.log();

	console.log("Starting the next changelog cycle...");
	addUnreleasedSection();
	stageChangedFiles();
	run('git commit -m "Add [Unreleased] section for next cycle"');
	run("git push origin main");
	console.log();

	console.log(
		`=== Finalized ${tag} at approved candidate ${candidateCommit} from workflow run ${candidateRunId}; CI publishing has started ===`,
	);
}

console.log(`\n=== Release ${invocation.phase === "prepare" ? "Preparation" : "Finalization"} ===\n`);
if (invocation.phase === "prepare") {
	prepareRelease(invocation.target);
} else {
	finalizeRelease(invocation.candidateCommit);
}
