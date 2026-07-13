import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectBinaryLicenses } from "./collect-binary-licenses.mjs";
import {
	assertPublishedPackageMatchesRelease,
	NPM_PROVENANCE_PREDICATE_TYPE,
	NPM_PUBLISHED_METADATA_FIELDS,
} from "./npm-publish-verification.mjs";
import {
	BOOTSTRAP_VERSION,
	npmViewPackageMetadata,
	parseBootstrapVerificationArgs,
	verifyPreflightPackageMetadata,
	verifyTagWorkflowPackageMetadata,
} from "./verify-npm-package-bootstrap.mjs";
import {
	assertCandidateMatchesHead,
	assertCandidateRunId,
	assertCandidateWorkflowArtifact,
	assertCandidateWorkflowRun,
	parseReleaseInvocation,
} from "./release-phase.mjs";
import { assertReleaseTagAvailable, getPlannedReleaseVersion, planReleaseTarget } from "./release-target.mjs";
import {
	RELEASE_PACKAGE_IDENTITIES,
	RELEASE_PACKAGES,
	verifyReleaseGitProvenance,
	verifyReleasePackageMetadata,
	versionFromReleaseTag,
} from "./verify-release-provenance.mjs";

test("release tags are canonical semver tags", () => {
	assert.equal(versionFromReleaseTag("v0.1.0"), "0.1.0");
	for (const invalid of ["0.1.0", "v00.1.0", "v0.1", "main", "v0.1.0-rc.1", "v0.1.0\nmain"]) {
		assert.throws(() => versionFromReleaseTag(invalid));
	}
});

test("initial release can prepare the current version without changing normal release targets", () => {
	assert.deepEqual(planReleaseTarget("0.1.0", "0.1.0"), { type: "current", value: "0.1.0" });
	assert.deepEqual(planReleaseTarget("0.1.1", "0.1.0"), { type: "set", value: "0.1.1" });
	assert.deepEqual(planReleaseTarget("patch", "0.1.0"), { type: "bump", value: "patch" });
	assert.equal(getPlannedReleaseVersion("patch", "0.1.0"), "0.1.1");
	assert.equal(getPlannedReleaseVersion("minor", "0.1.9"), "0.2.0");
	assert.equal(getPlannedReleaseVersion("major", "9.8.7"), "10.0.0");
	assert.throws(() => planReleaseTarget("0.0.9", "0.1.0"), /must not be lower/);
	assert.throws(() => planReleaseTarget("0.2.0", "0.2.0"), /one-time 0\.1\.0 bootstrap/);
	assert.throws(() => planReleaseTarget("00.1.0", "0.1.0"), /Invalid release target/);

	const available = (_command, args) => ({ status: args[0] === "show-ref" ? 1 : 2 });
	assert.doesNotThrow(() => assertReleaseTagAvailable("0.1.0", available));
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", (_command, args) => ({ status: args[0] === "show-ref" ? 0 : 2 })),
		/already exists locally.*Refusing to rerun/s,
	);
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", (_command, args) => ({ status: args[0] === "show-ref" ? 1 : 0 })),
		/already exists on origin.*Refusing to rerun/s,
	);
	assert.throws(
		() => assertReleaseTagAvailable("0.1.0", () => ({ status: 128, stderr: "network unavailable" })),
		/network unavailable/,
	);

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	const prepareFlow = releaseScript.slice(releaseScript.indexOf("function prepareRelease"), releaseScript.indexOf("function finalizeRelease"));
	assert.ok(prepareFlow.indexOf("verifyNpmVersionAvailable(plannedVersion") < prepareFlow.indexOf("bumpOrSetVersion(target)"));
	assert.doesNotMatch(prepareFlow, /git tag/);
});

test("release finalization requires explicit sign-off for the exact prepared candidate", () => {
	const commit = "a".repeat(40);
	assert.deepEqual(parseReleaseInvocation(["prepare", "patch"]), { phase: "prepare", target: "patch" });
	assert.deepEqual(parseReleaseInvocation(["prepare", "0.1.0"]), { phase: "prepare", target: "0.1.0" });
	assert.deepEqual(parseReleaseInvocation(["finalize", commit]), { phase: "finalize", candidateCommit: commit });
	for (const invalid of [
		["patch"],
		["prepare"],
		["prepare", "patch", "extra"],
		["finalize"],
		["finalize", "A".repeat(40)],
		["finalize", "a".repeat(39)],
		["finalize", commit, "extra"],
	]) {
		assert.throws(() => parseReleaseInvocation(invalid), /Usage:/);
	}
	assert.equal(assertCandidateMatchesHead(commit, commit), commit);
	assert.throws(() => assertCandidateMatchesHead(commit, "b".repeat(40)), /does not match current HEAD/);
	assert.equal(assertCandidateRunId("123456789"), "123456789");
	for (const invalidRunId of [undefined, "", "0", "01", "-1", "1.5", "abc", "1\n2"]) {
		assert.throws(() => assertCandidateRunId(invalidRunId), /VOLT_APPROVED_CANDIDATE_RUN_ID/);
	}
	const workflowRun = {
		id: 123456789,
		repository: { full_name: "hansjm10/Volt" },
		path: ".github/workflows/build-standalone-candidate.yml",
		event: "workflow_dispatch",
		head_branch: "main",
		head_sha: commit,
		status: "completed",
		conclusion: "success",
	};
	assert.equal(assertCandidateWorkflowRun(workflowRun, { candidateCommit: commit, runId: "123456789" }), workflowRun);
	for (const override of [
		{ id: 987654321 },
		{ repository: { full_name: "someone/fork" } },
		{ path: ".github/workflows/other.yml" },
		{ event: "push" },
		{ head_branch: "feature" },
		{ head_sha: "b".repeat(40) },
		{ status: "in_progress", conclusion: null },
		{ conclusion: "failure" },
	]) {
		assert.throws(
			() => assertCandidateWorkflowRun({ ...workflowRun, ...override }, { candidateCommit: commit, runId: "123456789" }),
			/approved|workflow run/,
		);
	}
	const artifact = {
		id: 42,
		name: `standalone-candidate-${commit}`,
		expired: false,
		size_in_bytes: 1024,
		workflow_run: { id: 123456789 },
	};
	assert.equal(
		assertCandidateWorkflowArtifact({ total_count: 1, artifacts: [artifact] }, { candidateCommit: commit, runId: "123456789" }),
		artifact,
	);
	for (const response of [
		{ total_count: 0, artifacts: [] },
		{ total_count: 1, artifacts: [{ ...artifact, expired: true }] },
		{ total_count: 1, artifacts: [{ ...artifact, size_in_bytes: 0 }] },
		{ total_count: 1, artifacts: [{ ...artifact, workflow_run: undefined }] },
		{ total_count: 1, artifacts: [{ ...artifact, workflow_run: { id: 987654321 } }] },
		{ total_count: 2, artifacts: [artifact, { ...artifact, id: 43 }] },
	]) {
		assert.throws(
			() => assertCandidateWorkflowArtifact(response, { candidateCommit: commit, runId: "123456789" }),
			/artifact|workflow run/,
		);
	}

	const packageManifest = JSON.parse(readFileSync("package.json", "utf8"));
	assert.equal(packageManifest.scripts["release:initial"], "node scripts/release.mjs prepare 0.1.0");
	assert.equal(packageManifest.scripts["release:patch"], "node scripts/release.mjs prepare patch");
	assert.equal(packageManifest.scripts["release:minor"], "node scripts/release.mjs prepare minor");
	assert.equal(packageManifest.scripts["release:major"], "node scripts/release.mjs prepare major");
	assert.equal(packageManifest.scripts["release:finalize"], "node scripts/release.mjs finalize");

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	const prepareFlow = releaseScript.slice(releaseScript.indexOf("function prepareRelease"), releaseScript.indexOf("function finalizeRelease"));
	const finalizeFlow = releaseScript.slice(releaseScript.indexOf("function finalizeRelease"), releaseScript.indexOf("console.log(`\\n=== Release"));
	assert.doesNotMatch(prepareFlow, /git tag|git push origin \$\{tag\}/);
	assert.match(prepareFlow, /git push origin main/);
	assert.ok(finalizeFlow.indexOf("assertCandidateMatchesHead(candidateCommit, head)") < finalizeFlow.indexOf("git tag -a -m"));
	assert.ok(finalizeFlow.indexOf("assertCandidateRunId(process.env.VOLT_APPROVED_CANDIDATE_RUN_ID)") < finalizeFlow.indexOf("requireCleanPublishedMain()"));
	assert.match(finalizeFlow, /verifyReleasePackageMetadata\(tag\)/);
	assert.ok(finalizeFlow.indexOf("verifyApprovedCandidateRun(candidateCommit, candidateRunId)") < finalizeFlow.indexOf("git tag -a -m"));
	assert.match(finalizeFlow, /Standalone-Candidate-Commit: \$\{candidateCommit\}/);
	assert.match(finalizeFlow, /Standalone-Candidate-Run: \$\{candidateRunId\}/);
	assert.match(finalizeFlow, /git tag -a -m .* -m .* \$\{tag\} \$\{candidateCommit\}/s);
	assert.ok(finalizeFlow.indexOf("git push origin ${tag}") < finalizeFlow.indexOf("addUnreleasedSection()"));
});

test("npm bootstrap verification reserves names without publishing the real initial version", () => {
	assert.equal(BOOTSTRAP_VERSION, "0.0.0-bootstrap.0");
	assert.deepEqual(parseBootstrapVerificationArgs(["preflight", "--version", "0.1.0", "--initial"]), {
		initial: true,
		mode: "preflight",
		version: "0.1.0",
	});
	assert.deepEqual(parseBootstrapVerificationArgs(["tag", "--version", "0.1.0"]), {
		initial: false,
		mode: "tag",
		version: "0.1.0",
	});
	assert.throws(
		() => parseBootstrapVerificationArgs(["tag", "--version", "0.1.0", "--initial"]),
		/only valid for the preflight/,
	);

	const name = "@hansjm10/volt-ai";
	const placeholder = {
		name,
		versions: [BOOTSTRAP_VERSION],
		"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
	};
	assert.doesNotThrow(() => verifyPreflightPackageMetadata(name, "0.1.0", placeholder, { initial: true }));
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, versions: [BOOTSTRAP_VERSION, "0.1.0"] },
				{ initial: true },
			),
		/already published/,
	);
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, versions: [BOOTSTRAP_VERSION, "0.0.1"] },
				{ initial: true },
			),
		/only placeholder version/,
	);
	assert.throws(
		() =>
			verifyPreflightPackageMetadata(
				name,
				"0.1.0",
				{ ...placeholder, "dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: "0.1.0" } },
				{ initial: true },
			),
		/npm-required latest/,
	);

	let queriedArgs;
	const queried = npmViewPackageMetadata(name, (_command, args) => {
		queriedArgs = args;
		return { status: 0, stdout: JSON.stringify(placeholder), stderr: "" };
	});
	assert.deepEqual(queried, placeholder);
	assert.equal(queriedArgs[1], `${name}@${BOOTSTRAP_VERSION}`);
	assert.doesNotThrow(() =>
		verifyPreflightPackageMetadata(name, "0.1.1", {
			name,
			versions: [BOOTSTRAP_VERSION, "0.1.0"],
			"dist-tags": { beta: "0.1.0", bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
		}),
	);
});

test("tag workflow bootstrap verification supports absent, partial, and idempotent publication", () => {
	const name = "@hansjm10/volt-ai";
	assert.doesNotThrow(() =>
		verifyTagWorkflowPackageMetadata(name, "0.1.0", {
			name,
			versions: [BOOTSTRAP_VERSION],
			"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
		}),
	);
	assert.throws(
		() =>
			verifyTagWorkflowPackageMetadata(name, "0.1.0", {
				name,
				versions: [BOOTSTRAP_VERSION, "0.0.1"],
				"dist-tags": { bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
			}),
		/only placeholder version/,
	);
	assert.doesNotThrow(() =>
		verifyTagWorkflowPackageMetadata(name, "0.1.0", {
			name,
			versions: [BOOTSTRAP_VERSION, "0.1.0"],
			"dist-tags": { beta: "0.1.0", bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
		}),
	);
	assert.throws(
		() =>
			verifyTagWorkflowPackageMetadata(name, "0.1.0", {
				name,
				versions: [BOOTSTRAP_VERSION, "0.1.0"],
				"dist-tags": { beta: BOOTSTRAP_VERSION, bootstrap: BOOTSTRAP_VERSION, latest: BOOTSTRAP_VERSION },
			}),
		/beta does not point to it/,
	);
});

test("release package versions and changelogs must match the tag", () => {
	const files = new Map();
	for (const { directory, name } of RELEASE_PACKAGE_IDENTITIES) {
		files.set(
			`${directory}/package.json`,
			JSON.stringify({
				name,
				version: "1.2.3",
				repository: { url: "git+https://github.com/hansjm10/Volt.git", directory },
			}),
		);
		files.set(`${directory}/CHANGELOG.md`, "# Changelog\n\n## [1.2.3] - 2026-07-12\n");
	}
	assert.equal(verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), "1.2.3");
	files.set("packages/ai/CHANGELOG.md", "A link to ## [1.2.3] is not a release heading.\n");
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /no release section/);
	files.set("packages/ai/CHANGELOG.md", "# Changelog\n\n## [1.2.3] - 2026-07-12\n");
	files.set("packages/ai/package.json", JSON.stringify({ name: "@hansjm10/volt-ai", version: "1.2.4" }));
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /expected 1\.2\.3/);
	files.set("packages/ai/package.json", JSON.stringify({ name: "@earendil-works/volt-ai", version: "1.2.3" }));
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /expected @hansjm10\/volt-ai/);
});

test("release tooling publishes only the canonical Volt package identities under the beta dist-tag", () => {
	assert.deepEqual(RELEASE_PACKAGE_IDENTITIES, [
		{ directory: "packages/ai", name: "@hansjm10/volt-ai" },
		{ directory: "packages/tui", name: "@hansjm10/volt-tui" },
		{ directory: "packages/agent", name: "@hansjm10/volt-agent-core" },
		{ directory: "packages/coding-agent", name: "@hansjm10/volt-coding-agent" },
	]);
	const publishScript = readFileSync("scripts/publish.mjs", "utf8");
	assert.match(publishScript, /const NPM_DIST_TAG = "beta";/);
	assert.match(publishScript, /"--tag", NPM_DIST_TAG/);
	assert.doesNotMatch(publishScript, /@earendil-works\/volt-/);
	assert.doesNotMatch(publishScript, /@hansjm10\/volt-cli/);
});

test("idempotent npm publication requires exact release bytes and provenance", () => {
	assert.deepEqual(NPM_PUBLISHED_METADATA_FIELDS, ["name", "version", "gitHead", "repository", "dist-tags", "dist"]);
	const release = {
		name: "@hansjm10/volt-ai",
		version: "0.1.0",
		directory: "packages/ai",
		sourceCommit: "a".repeat(40),
		packed: { integrity: "sha512-release" },
		metadata: {
			name: "@hansjm10/volt-ai",
			version: "0.1.0",
			gitHead: "a".repeat(40),
			repository: {
				url: "git+https://github.com/hansjm10/Volt.git",
				directory: "packages/ai",
			},
			"dist-tags": { beta: "0.1.0", bootstrap: "0.0.0-bootstrap.0", latest: "0.0.0-bootstrap.0" },
			dist: {
				integrity: "sha512-release",
				attestations: {
					url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
					provenance: { predicateType: NPM_PROVENANCE_PREDICATE_TYPE },
				},
			},
		},
	};
	assert.doesNotThrow(() => assertPublishedPackageMatchesRelease(release));
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, dist: { ...release.metadata.dist, integrity: "sha512-other" } },
			}),
		/does not match/,
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, dist: { integrity: "sha512-release" } },
			}),
		/no valid npm provenance/,
	);
	assert.throws(
		() =>
			assertPublishedPackageMatchesRelease({
				...release,
				metadata: { ...release.metadata, gitHead: "b".repeat(40) },
			}),
		/published from git commit/,
	);
	assert.doesNotThrow(() =>
		assertPublishedPackageMatchesRelease({
			...release,
			metadata: { ...release.metadata, gitHead: undefined },
		}),
	);
});

test("release git provenance requires an annotated tag reachable from origin/main", () => {
	const commit = "a".repeat(40);
	const successfulGit = (...args) => {
		const command = args.join(" ");
		if (command === "rev-parse HEAD" || command === "rev-parse refs/tags/v1.2.3^{commit}") return commit;
		if (command === "cat-file -t refs/tags/v1.2.3") return "tag";
		if (command === `merge-base --is-ancestor ${commit} refs/remotes/origin/main`) return "";
		throw new Error(`unexpected git command: ${command}`);
	};
	assert.equal(verifyReleaseGitProvenance("v1.2.3", successfulGit), commit);
	assert.throws(
		() =>
			verifyReleaseGitProvenance("v1.2.3", (...args) => {
				if (args[0] === "merge-base") throw new Error("not an ancestor");
				return successfulGit(...args);
			}),
		/not reachable from origin\/main/,
	);
	assert.throws(
		() =>
			verifyReleaseGitProvenance("v1.2.3", (...args) => {
				if (args[0] === "cat-file") return "commit";
				return successfulGit(...args);
			}),
		/must be an annotated tag/,
	);

	const releaseScript = readFileSync("scripts/release.mjs", "utf8");
	assert.match(releaseScript, /git branch --show-current/);
	assert.match(releaseScript, /refs\/remotes\/origin\/main/);
	assert.match(releaseScript, /git tag -a -m/);
});

test("standalone runtime archives and the consolidated Node license are checksum pinned", () => {
	const runtime = JSON.parse(readFileSync("compliance/standalone-runtime.json", "utf8"));
	assert.equal(runtime.schemaVersion, 1);
	assert.equal(runtime.runtime, "node");
	assert.equal(runtime.version, "22.23.1");
	assert.equal(runtime.releaseBaseUrl, "https://nodejs.org/download/release/v22.23.1");
	assert.equal(
		runtime.seaDocumentation,
		"https://nodejs.org/download/release/v22.23.1/docs/api/single-executable-applications.html",
	);
	assert.deepEqual(runtime.license, {
		source: "https://raw.githubusercontent.com/nodejs/node/v22.23.1/LICENSE",
		sha256: "c738ae413cf561f174e34f6961f8ca458aae2369a73640dda6234c629b98bcc4",
		path: "compliance/node-v22.23.1/LICENSE",
	});
	assert.equal(
		createHash("sha256").update(readFileSync(runtime.license.path)).digest("hex"),
		runtime.license.sha256,
	);

	const expectedTargets = {
		"darwin-arm64": {
			runner: "macos-15",
			archive: "node-v22.23.1-darwin-arm64.tar.gz",
			sha256: "ef28d8fab2c0e4314522d4bb1b7173270aa3937e93b92cb7de79c112ac1fa953",
		},
		"darwin-x64": {
			runner: "macos-15-intel",
			archive: "node-v22.23.1-darwin-x64.tar.gz",
			sha256: "b8da981b8a0b1241b70249204916da76c63573ddf5814dbd2d1e41069105cb81",
		},
		"linux-arm64": {
			runner: "ubuntu-24.04-arm",
			archive: "node-v22.23.1-linux-arm64.tar.xz",
			sha256: "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1",
		},
		"linux-x64": {
			runner: "ubuntu-24.04",
			archive: "node-v22.23.1-linux-x64.tar.xz",
			sha256: "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
		},
		"windows-arm64": {
			runner: "windows-11-arm",
			archive: "node-v22.23.1-win-arm64.zip",
			sha256: "b470fdfe3502c05151656e06d495e3f47544f2ee8b1d9c8705090f2dd5996bd0",
		},
		"windows-x64": {
			runner: "windows-2025",
			archive: "node-v22.23.1-win-x64.zip",
			sha256: "7df0bc9375723f4a86b3aa1b7cc73342423d9677a8df4538aca31a049e309c29",
		},
	};
	assert.deepEqual(runtime.targets, expectedTargets);
});

test("binary license collection fails closed and records exact copied license bytes", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-binary-license-test-"));
	try {
		const packageRoot = join(directory, "fixture", "node_modules", "fixture-license-package");
		const input = join(packageRoot, "index.js");
		const metafile = join(directory, "binary-metafile.json");
		const licenses = join(directory, "LICENSES", "npm");
		const manifestPath = join(directory, "binary-license-manifest.json");
		mkdirSync(packageRoot, { recursive: true });
		writeFileSync(
			join(packageRoot, "package.json"),
			`${JSON.stringify({ name: "fixture-license-package", version: "1.2.3", license: "MIT" })}\n`,
		);
		writeFileSync(input, "export const fixture = true;\n");
		writeFileSync(metafile, `${JSON.stringify({ inputs: { [input]: { bytes: 29 } }, outputs: {} })}\n`);

		assert.throws(
			() => collectBinaryLicenses({ metafilePath: metafile, outputDirectory: licenses, manifestPath }),
			/fixture-license-package@1\.2\.3/,
		);

		const licenseBytes = Buffer.from("fixture license bytes\n");
		writeFileSync(join(packageRoot, "LICENSE"), licenseBytes);
		const manifest = collectBinaryLicenses({
			metafilePath: metafile,
			outputDirectory: licenses,
			manifestPath,
		});
		assert.equal(manifest.npmPackageCount, 1);
		assert.equal(manifest.packages[0].name, "fixture-license-package");
		assert.equal(manifest.packages[0].version, "1.2.3");
		assert.equal(manifest.packages[0].declaredLicense, "MIT");
		assert.equal(manifest.packages[0].licenseFiles.length, 1);
		assert.equal(
			manifest.packages[0].licenseFiles[0].sha256,
			createHash("sha256").update(licenseBytes).digest("hex"),
		);
		assert.deepEqual(
			readFileSync(join(licenses, "fixture-license-package-1.2.3", "LICENSE")),
			licenseBytes,
		);
		assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), manifest);

		const protectedDirectory = join(directory, "protected");
		const protectedFile = join(protectedDirectory, "keep.txt");
		mkdirSync(protectedDirectory);
		writeFileSync(protectedFile, "keep\n");
		assert.throws(
			() =>
				collectBinaryLicenses({
					metafilePath: metafile,
					outputDirectory: protectedDirectory,
					manifestPath: join(protectedDirectory, "manifest.json"),
				}),
			/owned LICENSES\/npm directory/,
		);
		assert.equal(readFileSync(protectedFile, "utf8"), "keep\n");

		const protectedPackagesDirectory = join(directory, "packages");
		const protectedPackageFile = join(protectedPackagesDirectory, "keep.txt");
		mkdirSync(protectedPackagesDirectory);
		writeFileSync(protectedPackageFile, "keep packages\n");
		assert.throws(
			() =>
				collectBinaryLicenses({
					metafilePath: metafile,
					outputDirectory: protectedPackagesDirectory,
					manifestPath,
				}),
			/owned LICENSES\/npm directory/,
		);
		assert.equal(readFileSync(protectedPackageFile, "utf8"), "keep packages\n");
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("tag workflow publishes the inspected exact-commit candidate and never clobbers release assets", () => {
	const workflow = readFileSync(".github/workflows/build-binaries.yml", "utf8");
	const validateJob = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  assemble:"));
	const assembleJob = workflow.slice(workflow.indexOf("  assemble:"), workflow.indexOf("  publish-npm:"));
	const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  release:"));
	const releaseJob = workflow.slice(workflow.indexOf("  release:"));
	assert.doesNotMatch(workflow, /source_ref|SOURCE_REF|--clobber/);
	assert.doesNotMatch(workflow, /^\s*cache:\s*npm\s*$/m);
	assert.doesNotMatch(workflow, /oven-sh|setup-bun|bun build/i);
	assert.doesNotMatch(workflow, /build-standalone:|matrix\.runner|build-binaries\.sh/);
	assert.equal(workflow.match(/actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/g)?.length, 4);
	assert.equal(workflow.match(/actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/g)?.length, 3);
	assert.equal(workflow.match(/node-version: '22\.23\.1'/g)?.length, 3);
	assert.equal(workflow.match(/package-manager-cache: false/g)?.length, 3);
	assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
	assert.match(workflow, /actions\/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3/);
	assert.match(workflow, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/);
	assert.match(workflow, /verify-release-provenance\.mjs --tag/);
	assert.match(workflow, /verify-npm-package-bootstrap\.mjs tag --version/);
	assert.match(validateJob, /permissions:\s+contents: read/);
	assert.match(validateJob, /npm run check:release-security/);
	assert.ok(validateJob.indexOf("npm ci --ignore-scripts") < validateJob.indexOf("npm run check:release-security"));
	assert.match(assembleJob, /needs: validate/);
	assert.match(assembleJob, /permissions:\s+actions: read\s+contents: read/);
	assert.match(assembleJob, /git cat-file -t .*RELEASE_TAG/);
	assert.match(assembleJob, /Standalone-Candidate-Commit:/);
	assert.match(assembleJob, /Standalone-Candidate-Run:/);
	assert.match(assembleJob, /actions\/runs\/\$\{candidate_run_id\}/);
	assert.match(assembleJob, /\.github\/workflows\/build-standalone-candidate\.yml/);
	for (const binding of ["head_sha", "head_branch", "event", "status", "conclusion", "workflow_path"]) {
		assert.match(assembleJob, new RegExp(binding));
	}
	assert.match(assembleJob, /name: standalone-candidate-\$\{\{ steps\.candidate\.outputs\.source-commit \}\}/);
	assert.match(assembleJob, /run-id: \$\{\{ steps\.candidate\.outputs\.run-id \}\}/);
	assert.match(assembleJob, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
	assert.match(assembleJob, /Candidate artifact commit .* does not match tag commit/);
	assert.match(assembleJob, /Unexpected standalone archive set/);
	assert.match(assembleJob, /sha256sum --strict -c SHA256SUMS/);
	assert.match(publishJob, /needs: assemble/);
	assert.ok(publishJob.indexOf("node scripts/publish.mjs") < publishJob.lastIndexOf("verify-npm-package-bootstrap.mjs tag --version"));
	assert.match(releaseJob, /needs: \[assemble, publish-npm\]/);
	assert.match(releaseJob, /environment: binary-release/);
	assert.match(releaseJob, /permissions:\s+contents: write/);
	assert.match(releaseJob, /source-commit\.txt/);
	assert.match(releaseJob, /Release artifact commit .* does not match checked-out tag commit/);
	assert.match(workflow, /Refusing to replace existing release asset with different bytes/);
	assert.match(workflow, /cmp -s/);
});

test("pre-tag standalone candidates build the exact main commit without publishing", () => {
	const workflow = readFileSync(".github/workflows/build-standalone-candidate.yml", "utf8");
	assert.match(workflow, /workflow_dispatch:/);
	assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
	assert.match(workflow, /git rev-parse HEAD/);
	assert.match(workflow, /git rev-parse refs\/remotes\/origin\/main/);
	assert.match(workflow, /test "\$\{GITHUB_SHA\}" = "\$\{CANDIDATE_COMMIT\}"/);
	assert.match(workflow, /test "\$\{GITHUB_REF\}" = "refs\/heads\/main"/);
	assert.match(workflow, /npm run check:release-security/);
	assert.match(workflow, /VOLT_REQUIRE_CLEAN_SOURCE: '1'/);
	assert.match(workflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
	assert.match(workflow, /\.\/scripts\/build-binaries\.sh --skip-install --skip-build --platform/);
	for (const [target, runner] of [
		["darwin-arm64", "macos-15"],
		["darwin-x64", "macos-15-intel"],
		["linux-arm64", "ubuntu-24.04-arm"],
		["linux-x64", "ubuntu-24.04"],
		["windows-arm64", "windows-11-arm"],
		["windows-x64", "windows-2025"],
	]) {
		assert.match(workflow, new RegExp(`- target: ${target}\\s+runner: ${runner}`));
	}
	assert.match(workflow, /standalone-candidate-\$\{\{ inputs\.commit \}\}/);
	assert.match(workflow, /LC_ALL=C sha256sum/);
	assert.doesNotMatch(workflow, /contents: write|id-token: write|npm publish|publish\.mjs|gh release|secrets\./);
});

test("installers use the published package and verify binary checksums before exact extraction", () => {
	const shellInstaller = readFileSync("site/public/install.sh", "utf8");
	const windowsInstaller = readFileSync("site/public/install.ps1", "utf8");
	for (const installer of [shellInstaller, windowsInstaller]) {
		assert.match(installer, /@hansjm10\/volt-coding-agent/);
		assert.doesNotMatch(installer, /@hansjm10\/volt-cli/);
		assert.match(installer, /SHA256SUMS/);
		assert.match(installer, /SHA-256 verification failed/);
		assert.match(installer, /local CLI\/TUI only/i);
	}
	assert.match(shellInstaller, /npm_spec="\$PACKAGE@beta"/);
	assert.match(windowsInstaller, /\$npmSpec = "\$package@beta"/);
	assert.match(shellInstaller, /tar -xzf "\$tmp\/\$asset" -C "\$tmp\/extract"/);
	assert.match(shellInstaller, /standalone-file-manifest\.json/);
	assert.match(shellInstaller, /release_tag="v\$\{VERSION#v\}"/);
	assert.doesNotMatch(shellInstaller, /find .* -name volt/);
	assert.match(windowsInstaller, /FullName -eq "volt\.exe"/);
	assert.match(windowsInstaller, /ExtractToDirectory/);
	assert.match(windowsInstaller, /standalone-file-manifest\.json/);
	assert.match(windowsInstaller, /\$releaseTag = "v\$\(\$version\.TrimStart\('v'\)\)"/);
	assert.doesNotMatch(windowsInstaller, /Expand-Archive/);
	assert.equal(spawnSync("sh", ["-n", "site/public/install.sh"]).status, 0);
});

test("site sources never rewrite documentation to the obsolete npm identity", () => {
	for (const file of [
		"site/src/pages/index.astro",
		"site/scripts/sync-docs.mjs",
		"site/README.md",
		"site/public/install.sh",
		"site/public/install.ps1",
	]) {
		assert.doesNotMatch(readFileSync(file, "utf8"), /@hansjm10\/volt-cli/, file);
	}
	const landingPage = readFileSync("site/src/pages/index.astro", "utf8");
	assert.match(landingPage, /public beta gates in progress/i);
	assert.match(landingPage, /traffic may traverse configured Iroh relays/i);
});

test("published packages and binary build include the repository license and notices", () => {
	const rootLicense = readFileSync("LICENSE", "utf8");
	for (const directory of RELEASE_PACKAGES) {
		assert.equal(readFileSync(`${directory}/LICENSE`, "utf8").trimEnd(), rootLicense.trimEnd());
		const manifest = JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
		assert.equal(manifest.license, "MIT");
		assert.deepEqual(manifest.contributors, ["Mario Zechner", "Jordan Hans"]);
		assert.equal(manifest.repository.url, "git+https://github.com/hansjm10/Volt.git");
		assert.equal(manifest.repository.directory, directory);
		assert.deepEqual(manifest.publishConfig, { access: "public", tag: "beta" });
	}
	const buildScript = readFileSync("scripts/build-binaries.sh", "utf8");
	const standaloneBuild = readFileSync("scripts/build-standalone.mjs", "utf8");
	for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md", "BINARY-CAPABILITIES.md", "npm-shrinkwrap.json"]) {
		assert.match(standaloneBuild, new RegExp(`"${file.replaceAll(".", "\\.")}"`));
	}
	const codingAgentManifest = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
	assert.ok(codingAgentManifest.files.includes("!docs/images/doom-extension.png"));
	assert.ok(codingAgentManifest.files.includes("!examples/**/node_modules/**"));
	assert.ok(codingAgentManifest.files.includes("!examples/extensions/doom-overlay"));
	assert.ok(codingAgentManifest.files.includes("!examples/extensions/doom-overlay/**"));
	const packCache = mkdtempSync(join(tmpdir(), "volt-npm-pack-cache-"));
	try {
		const packResult = JSON.parse(
			execFileSync(
				process.platform === "win32" ? "npm.cmd" : "npm",
				["pack", "--dry-run", "--json", "--ignore-scripts"],
				{
					cwd: "packages/coding-agent",
					encoding: "utf8",
					env: { ...process.env, npm_config_cache: packCache },
				},
			),
		);
		assert.equal(packResult.length, 1);
		assert.equal(
			packResult[0].files.some(
				({ path }) =>
					path === "docs/images/doom-extension.png" ||
					path === "examples/extensions/doom-overlay" ||
					path.startsWith("examples/extensions/doom-overlay/"),
			),
			false,
		);
	} finally {
		rmSync(packCache, { force: true, recursive: true });
	}
	assert.match(standaloneBuild, /remote\/firebase-push-relay\/functions\/node_modules/);
	assert.match(standaloneBuild, /extensions\/doom-overlay/);
	assert.match(standaloneBuild, /Doom overlay must not be present in standalone release staging/);
	assert.match(standaloneBuild, /Standalone staging contains unexpected WASM files/);
	assert.match(standaloneBuild, /Standalone staging contains unexpected binary files/);
	assert.match(standaloneBuild, /git.*ls-files/);
	assert.match(standaloneBuild, /images\/doom-extension\.png/);
	assert.match(standaloneBuild, /binary-metafile\.json/);
	assert.match(standaloneBuild, /binary-license-manifest\.json/);
	assert.match(standaloneBuild, /standalone-file-manifest\.json/);
	assert.match(standaloneBuild, /normalizedArchiveFileMode/);
	assert.match(standaloneBuild, /stagedPath === "volt\.exe".*"0755".*"0644"/s);
	assert.match(standaloneBuild, /sourceTreeClean/);
	assert.match(standaloneBuild, /VOLT_REQUIRE_CLEAN_SOURCE/);
	assert.match(standaloneBuild, /process\.platform === "win32".*powershell\.exe.*Expand-Archive/s);
	assert.match(standaloneBuild, /VOLT_NODE_ARCHIVE.*VOLT_NODE_RUNTIME/s);
	assert.match(standaloneBuild, /collect-binary-licenses\.mjs/);
	assert.match(standaloneBuild, /node-v\$\{runtime\.version\}-LICENSE\.txt/);
	assert.match(standaloneBuild, /Node runtime license checksum mismatch/);

	const licenseCopies = [
		["node_modules/clipboard-image/license", "packages/coding-agent/dist/LICENSES/clipboard-image-MIT.txt"],
		["node_modules/run-jxa/license", "packages/coding-agent/dist/LICENSES/run-jxa-MIT.txt"],
		["node_modules/highlight.js/LICENSE", "packages/coding-agent/dist/LICENSES/highlight.js-10.7.3-BSD-3-Clause.txt"],
		[
			"packages/coding-agent/src/core/export-html/vendor/highlight.LICENSE",
			"packages/coding-agent/dist/LICENSES/highlight.js-11.9.0-BSD-3-Clause.txt",
		],
		[
			"packages/coding-agent/src/core/export-html/vendor/marked.LICENSE",
			"packages/coding-agent/dist/LICENSES/marked-18.0.5-LICENSE.txt",
		],
	];
	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "copy-third-party-licenses"], {
		cwd: "packages/coding-agent",
		stdio: "pipe",
	});
	for (const [source, copied] of licenseCopies) {
		assert.deepEqual(readFileSync(copied), readFileSync(source));
	}
	assert.equal(codingAgentManifest.dependencies["@silvia-odwyer/photon-node"], undefined);
	assert.equal(existsSync("packages/coding-agent/src/utils/photon.ts"), false);
	assert.doesNotMatch(JSON.stringify(codingAgentManifest.scripts), /photon|photon_rs|\.wasm/i);
	assert.doesNotMatch(JSON.stringify(codingAgentManifest.scripts), /bun build|dist\/bun/i);
	assert.doesNotMatch(`${buildScript}\n${standaloneBuild}`, /bun build|dist\/bun/i);
	assert.doesNotMatch(
		`${buildScript}\n${standaloneBuild}`,
		/@silvia-odwyer\/photon-node|photon_rs_bg\.wasm/,
	);
	assert.doesNotMatch(
		readFileSync("packages/coding-agent/THIRD-PARTY-NOTICES.md", "utf8"),
		/@silvia-odwyer|photon_rs|Photon/,
	);
	for (const generatedDoomArtifact of [
		"packages/coding-agent/docs/images/doom-extension.png",
		"packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.js",
		"packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm",
	]) {
		assert.equal(existsSync(generatedDoomArtifact), false, generatedDoomArtifact);
	}
	const doomBuild = readFileSync("packages/coding-agent/examples/extensions/doom-overlay/doom/build.sh", "utf8");
	assert.match(doomBuild, /DOOMGENERIC_COMMIT="[0-9a-f]{40}"/);
	assert.match(doomBuild, /git -C doomgeneric checkout --detach "\$DOOMGENERIC_COMMIT"/);
	const doomIgnore = readFileSync("packages/coding-agent/examples/extensions/doom-overlay/.gitignore", "utf8");
	assert.match(doomIgnore, /doom\/build\//);
	assert.match(doomIgnore, /doom\/doomgeneric\//);
	assert.doesNotMatch(buildScript, /@mariozechner\/clipboard|clipboard_native_package/);

	const betaReadiness = readFileSync("BETA-READINESS.md", "utf8");
	assert.match(betaReadiness, /not ready for public beta\s+distribution/i);
	assert.match(betaReadiness, /Do not create the release tag until/i);
	assert.match(betaReadiness, /Prove the npm daemon distribution/);
	assert.match(betaReadiness, /Node\.js 22\.23\.1/);
	assert.match(betaReadiness, /glibc 2\.28/);
	assert.match(betaReadiness, /Windows beta executables are not\s+Authenticode-signed/);
	assert.match(betaReadiness, /Resolve Doom source-archive provenance/);
});

test("release archive creation is deterministic and rejects symlinks", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-release-archive-test-"));
	try {
		const input = join(directory, "input");
		mkdirSync(join(input, "docs"), { recursive: true });
		writeFileSync(join(input, "volt"), "binary\n", { mode: 0o755 });
		writeFileSync(join(input, "docs", "README.md"), "docs\n");

		for (const format of ["tar.gz", "zip"]) {
			const first = join(directory, `first.${format}`);
			const second = join(directory, `second.${format}`);
			const args = [
				"scripts/create-release-archive.py",
				"--input",
				input,
				"--format",
				format,
				"--epoch",
				"1700000000",
			];
			execFileSync("python3", [...args, "--output", first, ...(format === "tar.gz" ? ["--root", "volt"] : [])]);
			execFileSync("python3", [...args, "--output", second, ...(format === "tar.gz" ? ["--root", "volt"] : [])]);
			assert.deepEqual(readFileSync(first), readFileSync(second));
		}

		for (const unsafeRoot of [".", "..", "../escape", "..\\escape", "C:\\escape"]) {
			const result = spawnSync("python3", [
				"scripts/create-release-archive.py",
				"--input",
				input,
				"--output",
				join(directory, "unsafe-root.tar.gz"),
				"--format",
				"tar.gz",
				"--root",
				unsafeRoot,
			]);
			assert.notEqual(result.status, 0, unsafeRoot);
			assert.match(result.stderr.toString(), /one safe relative path component/);
		}

		symlinkSync("volt", join(input, "linked-volt"));
		const result = spawnSync("python3", [
			"scripts/create-release-archive.py",
			"--input",
			input,
			"--output",
			join(directory, "unsafe.zip"),
			"--format",
			"zip",
		]);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr.toString(), /must not contain symlinks/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("binary build refuses destructive output paths before invoking the compiler", () => {
	const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
	const result = spawnSync(
		"bash",
		[
			"scripts/build-binaries.sh",
			"--skip-install",
			"--skip-build",
			"--platform",
			platform,
			"--out",
			".",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /contains the repository/);
	assert.doesNotMatch(readFileSync("scripts/build-binaries.sh", "utf8"), /rm -rf "\$OUTPUT_DIR"(?:\s|$)/);
});

test("Unix npm installer defaults to the beta channel and does not promise daemon support on Darwin x64", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-intel-installer-test-"));
	try {
		const fakeBin = join(directory, "bin");
		const home = join(directory, "home");
		mkdirSync(fakeBin);
		mkdirSync(home);
		const fakeNode = join(fakeBin, "node");
		writeFileSync(
			fakeNode,
			`#!/bin/sh
case "$*" in
  *process.versions.node*) printf '1\\n' ;;
  *process.platform*) printf 'darwin-x64\\n' ;;
  *) exit 1 ;;
esac
`,
		);
		chmodSync(fakeNode, 0o755);
		const fakeNpm = join(fakeBin, "npm");
		writeFileSync(fakeNpm, "#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$VOLT_INSTALL_NPM_LOG\"\n");
		chmodSync(fakeNpm, 0o755);
		const fakeVolt = join(fakeBin, "volt");
		writeFileSync(fakeVolt, "#!/bin/sh\nprintf 'volt 1.2.3\\n'\n");
		chmodSync(fakeVolt, 0o755);

		const result = spawnSync("sh", ["site/public/install.sh"], {
			encoding: "utf8",
				env: {
					...process.env,
					HOME: home,
					PATH: `${fakeBin}:/usr/bin:/bin`,
					VOLT_INSTALL_METHOD: "npm",
					VOLT_INSTALL_NPM_LOG: join(directory, "npm-args.log"),
				},
			});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			readFileSync(join(directory, "npm-args.log"), "utf8").trim(),
			"install -g --ignore-scripts @hansjm10/volt-coding-agent@beta",
		);
		assert.match(result.stdout, /unavailable on Intel macOS/);
		assert.doesNotMatch(result.stdout, /This npm install supports 'volt daemon'/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release notes link to the canonical GitHub repository", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-release-notes-test-"));
	try {
		const changelog = join(directory, "CHANGELOG.md");
		const output = join(directory, "notes.md");
		writeFileSync(changelog, "# Changelog\n\n## [1.2.3] - 2026-07-12\n\nSee [README](README.md).\n");
		execFileSync(process.execPath, [
			"scripts/release-notes.mjs",
			"extract",
			"--version",
			"1.2.3",
			"--changelog",
			changelog,
			"--out",
			output,
		]);
		assert.match(
			readFileSync(output, "utf8"),
			/https:\/\/github\.com\/hansjm10\/Volt\/blob\/v1\.2\.3\/packages\/coding-agent\/README\.md/,
		);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("Unix binary installer verifies a pinned archive before installing its exact executable", () => {
	const directory = mkdtempSync(join(tmpdir(), "volt-installer-test-"));
	try {
		const payload = join(directory, "payload");
		const fixtures = join(directory, "fixtures");
		const fakeBin = join(directory, "fake-bin");
		const home = join(directory, "home");
		mkdirSync(payload);
		mkdirSync(fixtures);
		mkdirSync(fakeBin);
		mkdirSync(home);
		writeFileSync(join(payload, "volt"), "#!/bin/sh\nprintf 'fixture volt\\n'\n", { mode: 0o755 });
		for (const directory of ["LICENSES", "theme", "export-html"]) {
			mkdirSync(join(payload, directory));
		}
		for (const file of [
			"package.json",
			"image-resize-worker.cjs",
			"binary-metafile.json",
			"binary-license-manifest.json",
			"standalone-build-manifest.json",
			"standalone-file-manifest.json",
		]) {
			writeFileSync(join(payload, file), `${file}\n`);
		}
		writeFileSync(join(payload, "LICENSES", "node-v22.23.1-LICENSE.txt"), "node license\n");
		writeFileSync(join(payload, "theme", "dark.json"), "{}\n");
		writeFileSync(join(payload, "export-html", "template.html"), "<html></html>\n");
		const asset = "volt-linux-x64.tar.gz";
		const archive = join(fixtures, asset);
		execFileSync("python3", [
			"scripts/create-release-archive.py",
			"--input",
			payload,
			"--output",
			archive,
			"--format",
			"tar.gz",
			"--root",
			"volt",
		]);
		const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
		writeFileSync(join(fixtures, "SHA256SUMS"), `${checksum}  ${asset}\n`);

		const fakeCurl = join(fakeBin, "curl");
		writeFileSync(
			fakeCurl,
			`#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ]; then
        output="$2"
        shift 2
    else
        url="$1"
        shift
    fi
done
cp "$VOLT_INSTALL_FIXTURES/\${url##*/}" "$output"
printf '%s\n' "$url" >> "$VOLT_INSTALL_URL_LOG"
`,
		);
		chmodSync(fakeCurl, 0o755);
		const fakeUname = join(fakeBin, "uname");
		writeFileSync(fakeUname, "#!/bin/sh\n[ \"$1\" = \"-s\" ] && printf 'Linux\\n' || printf 'x86_64\\n'\n");
		chmodSync(fakeUname, 0o755);

		const env = {
			...process.env,
			HOME: home,
			PATH: `${fakeBin}:/usr/bin:/bin`,
			VOLT_INSTALL_FIXTURES: fixtures,
			VOLT_INSTALL_METHOD: "binary",
			VOLT_INSTALL_URL_LOG: join(directory, "download-urls.log"),
			VOLT_VERSION: "1.2.3",
		};
		const installed = spawnSync("sh", ["site/public/install.sh"], { encoding: "utf8", env });
		assert.equal(installed.status, 0, installed.stderr);
		assert.equal(readFileSync(join(home, ".volt", "bin", "volt"), "utf8"), readFileSync(join(payload, "volt"), "utf8"));
		assert.deepEqual(
			readFileSync(join(home, ".volt", "bin", "image-resize-worker.cjs")),
			readFileSync(join(payload, "image-resize-worker.cjs")),
		);
		assert.deepEqual(
			readFileSync(join(home, ".volt", "bin", "LICENSES", "node-v22.23.1-LICENSE.txt")),
			readFileSync(join(payload, "LICENSES", "node-v22.23.1-LICENSE.txt")),
		);
		assert.match(installed.stdout, /Installed verified standalone release/);
		assert.match(readFileSync(env.VOLT_INSTALL_URL_LOG, "utf8"), /\/releases\/download\/v1\.2\.3\/volt-linux-x64\.tar\.gz/);

		writeFileSync(join(fixtures, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);
		const secondHome = join(directory, "unverified-home");
		mkdirSync(secondHome);
		const rejected = spawnSync("sh", ["site/public/install.sh"], {
			encoding: "utf8",
			env: { ...env, HOME: secondHome },
		});
		assert.notEqual(rejected.status, 0);
		assert.match(rejected.stderr, /SHA-256 verification failed/);
		assert.throws(() => readFileSync(join(secondHome, ".volt", "bin", "volt")));

		const unsafeArchiveRoot = join(directory, "unsafe-archive");
		mkdirSync(join(unsafeArchiveRoot, "volt"), { recursive: true });
		symlinkSync("/tmp", join(unsafeArchiveRoot, "volt", "unsafe-link"));
		execFileSync("tar", ["-czf", archive, "-C", unsafeArchiveRoot, "volt"]);
		const unsafeChecksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
		writeFileSync(join(fixtures, "SHA256SUMS"), `${unsafeChecksum}  ${asset}\n`);
		const unsafeHome = join(directory, "unsafe-home");
		mkdirSync(unsafeHome);
		const unsafe = spawnSync("sh", ["site/public/install.sh"], {
			encoding: "utf8",
			env: { ...env, HOME: unsafeHome },
		});
		assert.notEqual(unsafe.status, 0);
		assert.match(unsafe.stderr, /only regular files and directories/);
		assert.equal(existsSync(join(unsafeHome, ".volt", "bin")), false);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
