#!/usr/bin/env node
/**
 * Release phase helpers for Volt.
 *
 * Usage:
 *   node scripts/release.mjs prepare <major|minor|patch|x.y.z>
 *   node scripts/release.mjs prepare-pr <patch|minor>
 *   VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> node scripts/release.mjs finalize <exact-40-character-candidate-commit>
 *   VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST=<sha256:digest> node scripts/release.mjs authorize <exact-40-character-candidate-commit>
 *   node scripts/release.mjs next-cycle <exact-40-character-candidate-commit>
 *
 * `prepare`/`finalize` preserve the original local fallback. The GitHub-native
 * phases split mutation boundaries: `prepare-pr` creates only a release commit,
 * `authorize` performs the exact candidate preflight and emits machine outputs,
 * and `next-cycle` creates only the post-release changelog commit. GitHub owns
 * branch, tag, release, and pull-request publication for those phases.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
	assertCandidateArtifactDigest,
	assertCandidateMatchesHead,
	assertCandidateRunId,
	assertCandidateWorkflowArtifact,
	assertCandidateWorkflowRun,
	assertReleaseTagMatchesCandidate,
	candidateTagAttestation,
	createReleaseAuthorization,
	formatGitHubOutputs,
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

function requireCleanPublishedMain(options = {}) {
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
	if (options.requireMainBranch !== false && branch !== "main") {
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

function verifyApprovedCandidateRun(candidateCommit, runId, artifactDigest) {
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
		return assertCandidateWorkflowArtifact(artifactMetadata, { candidateCommit, runId, artifactDigest });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

function prepareReleaseCommit(target, options = {}) {
	requireCleanPublishedMain({ requireMainBranch: options.requireMainBranch !== false });

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
	return { candidateCommit, version };
}

function printPreparedReleaseNextSteps(version, candidateCommit, options = {}) {
	console.log(`=== Prepared release v${version} at ${candidateCommit} ===`);
	if (options.pullRequest === true) {
		console.log("No release tag exists yet. Next:");
		console.log("  1. Push this commit to a release branch and merge it through a protected PR");
		console.log("  2. Record the resulting exact main SHA, which may differ from this pre-merge commit");
		console.log("  3. Run the Build Standalone Candidate workflow with that post-merge main SHA");
		console.log("  4. Inspect and record all six native archives, manifests, smoke tests, and checksums");
		console.log("  5. Authorize the merged exact candidate through the GitHub release approval workflow");
	} else {
		console.log("No release tag exists yet. Next:");
		console.log(`  1. Run the Build Standalone Candidate workflow with commit ${candidateCommit}`);
		console.log("  2. Inspect and record all six native archives, manifests, smoke tests, and checksums");
		console.log(
			`  3. Finalize only after approval: VOLT_APPROVED_CANDIDATE_RUN_ID=<run-id> npm run release:finalize -- ${candidateCommit}`,
		);
	}
}

function prepareRelease(target) {
	const { candidateCommit, version } = prepareReleaseCommit(target, { requireMainBranch: true });
	console.log("Pushing the candidate commit to main (no tag is created)...");
	run("git push origin main");
	console.log();
	printPreparedReleaseNextSteps(version, candidateCommit);
}

function preparePrRelease(target) {
	const { candidateCommit, version } = prepareReleaseCommit(target, { requireMainBranch: false });
	console.log("Release PR commit created locally; no branch, main commit, or tag was pushed.\n");
	printPreparedReleaseNextSteps(version, candidateCommit, { pullRequest: true });
}

function verifyReleaseAuthorization(candidateCommit, candidateRunId, candidateArtifactDigest) {
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
	const approvedArtifact = verifyApprovedCandidateRun(candidateCommit, candidateRunId, candidateArtifactDigest);
	console.log(
		`  Found unexpired artifact ${approvedArtifact.name} (${approvedArtifact.size_in_bytes} bytes, ${approvedArtifact.digest ?? "digest not required"})\n`,
	);

	console.log(`Rechecking tag and npm availability for ${tag}...`);
	verifyNpmVersionAvailable(version, version === "0.1.0");
	console.log(`  Explicit candidate sign-off matches ${head} from workflow run ${candidateRunId}\n`);
	return { approvedArtifact, head, tag, version };
}

function approvedCandidateEnvironment(options = {}) {
	try {
		const candidateRunId = assertCandidateRunId(process.env.VOLT_APPROVED_CANDIDATE_RUN_ID);
		const rawDigest = process.env.VOLT_APPROVED_CANDIDATE_ARTIFACT_DIGEST;
		const candidateArtifactDigest = rawDigest === undefined && options.requireDigest !== true
			? undefined
			: assertCandidateArtifactDigest(rawDigest);
		return { candidateArtifactDigest, candidateRunId };
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

function githubOutputPath() {
	const path = process.env.GITHUB_OUTPUT;
	if (!path) fail("GITHUB_OUTPUT is required for GitHub-native release phases");
	return path;
}

function writeGitHubOutputs(path, outputs) {
	writeFileSync(path, formatGitHubOutputs(outputs), { flag: "a" });
}

function authorizeRelease(candidateCommit) {
	const outputPath = githubOutputPath();
	const { candidateArtifactDigest, candidateRunId } = approvedCandidateEnvironment({ requireDigest: true });
	const { tag, version } = verifyReleaseAuthorization(candidateCommit, candidateRunId, candidateArtifactDigest);
	const outputs = createReleaseAuthorization({
		tag,
		version,
		candidateCommit,
		candidateRunId,
		candidateArtifactDigest,
	});
	writeGitHubOutputs(outputPath, outputs);
	console.log(`=== Authorized ${tag} at ${candidateCommit}; no tag, release, changelog, or Git ref was mutated ===`);
}

function finalizeRelease(candidateCommit) {
	const { candidateArtifactDigest, candidateRunId } = approvedCandidateEnvironment();
	const { tag } = verifyReleaseAuthorization(candidateCommit, candidateRunId, candidateArtifactDigest);

	console.log(`Creating annotated ${tag} at the approved candidate commit...`);
	const candidateAttestation = candidateTagAttestation(candidateCommit, candidateRunId, candidateArtifactDigest);
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

function nextCycle(candidateCommit) {
	const outputPath = githubOutputPath();
	const head = requireCleanPublishedMain();
	try {
		assertCandidateMatchesHead(candidateCommit, head);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	const version = getVersion();
	const tag = `v${version}`;
	try {
		verifyReleasePackageMetadata(tag);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	run(`git fetch --prune origin +refs/tags/${tag}:refs/tags/${tag}`);
	const tagType = run(`git cat-file -t refs/tags/${tag}`, { silent: true })?.trim();
	const taggedCommit = run(`git rev-parse refs/tags/${tag}^{commit}`, { silent: true })?.trim();
	const tagMessage = run(`git for-each-ref --format='%(contents)' refs/tags/${tag}`, { silent: true }) ?? "";
	try {
		assertReleaseTagMatchesCandidate({ tag, candidateCommit, tagType, taggedCommit, tagMessage });
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}

	console.log(`Starting the post-${tag} changelog cycle...`);
	addUnreleasedSection();
	stageChangedFiles();
	run(`git commit -m ${shellQuote(`docs: start post-${tag} changelog cycle`)}`);
	const nextCycleCommit = run("git rev-parse HEAD", { silent: true })?.trim();
	try {
		assertCandidateMatchesHead(nextCycleCommit, nextCycleCommit);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
	writeGitHubOutputs(outputPath, { tag, commit: nextCycleCommit });
	console.log(`=== Created post-${tag} changelog commit ${nextCycleCommit}; nothing was pushed ===`);
}

console.log(`\n=== Release ${invocation.phase} ===\n`);
switch (invocation.phase) {
	case "prepare":
		prepareRelease(invocation.target);
		break;
	case "prepare-pr":
		preparePrRelease(invocation.target);
		break;
	case "authorize":
		authorizeRelease(invocation.candidateCommit);
		break;
	case "finalize":
		finalizeRelease(invocation.candidateCommit);
		break;
	case "next-cycle":
		nextCycle(invocation.candidateCommit);
		break;
}
