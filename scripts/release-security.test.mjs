import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
	const mainFlow = releaseScript.slice(releaseScript.indexOf("// Main flow"));
	assert.ok(mainFlow.indexOf("requireReleaseTagAvailable(plannedVersion)") < mainFlow.indexOf("bumpOrSetVersion(RELEASE_TARGET)"));
	assert.ok(
		mainFlow.indexOf("verify-npm-package-bootstrap.mjs preflight") < mainFlow.indexOf("bumpOrSetVersion(RELEASE_TARGET)"),
	);
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

test("workflow binds builds to tags and never clobbers release assets", () => {
	const workflow = readFileSync(".github/workflows/build-binaries.yml", "utf8");
	const buildJob = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  publish-npm:"));
	const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  release:"));
	const releaseJob = workflow.slice(workflow.indexOf("  release:"));
	assert.doesNotMatch(workflow, /source_ref|SOURCE_REF|--clobber/);
	assert.doesNotMatch(workflow, /^\s*cache:\s*npm\s*$/m);
	assert.equal(workflow.match(/actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/g)?.length, 3);
	assert.equal(workflow.match(/actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/g)?.length, 2);
	assert.equal(workflow.match(/package-manager-cache: false/g)?.length, 2);
	assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
	assert.match(workflow, /actions\/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3/);
	assert.match(workflow, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/);
	assert.match(workflow, /verify-release-provenance\.mjs --tag/);
	assert.match(workflow, /verify-npm-package-bootstrap\.mjs tag --version/);
	assert.match(buildJob, /permissions:\s+contents: read/);
	assert.doesNotMatch(buildJob, /gh release (?:create|edit|upload)/);
	assert.match(buildJob, /npm run check:release-security/);
	assert.match(buildJob, /\.\/scripts\/build-binaries\.sh --skip-install/);
	assert.ok(buildJob.indexOf("npm ci --ignore-scripts") < buildJob.indexOf("npm run check:release-security"));
	assert.ok(buildJob.indexOf("npm run check:release-security") < buildJob.indexOf("./scripts/build-binaries.sh --skip-install"));
	assert.match(publishJob, /needs: build/);
	assert.ok(publishJob.indexOf("node scripts/publish.mjs") < publishJob.lastIndexOf("verify-npm-package-bootstrap.mjs tag --version"));
	assert.match(releaseJob, /needs: \[build, publish-npm\]/);
	assert.match(releaseJob, /environment: binary-release/);
	assert.match(releaseJob, /permissions:\s+contents: write/);
	assert.match(releaseJob, /source-commit\.txt/);
	assert.match(releaseJob, /Release artifact commit .* does not match checked-out tag commit/);
	assert.match(workflow, /Refusing to replace existing release asset with different bytes/);
	assert.match(workflow, /cmp -s/);
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
	assert.match(shellInstaller, /tar -xzf .* volt\/volt/);
	assert.match(shellInstaller, /release_tag="v\$\{VERSION#v\}"/);
	assert.doesNotMatch(shellInstaller, /find .* -name volt/);
	assert.match(windowsInstaller, /FullName -eq "volt\.exe"/);
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
	for (const file of ["LICENSE", "THIRD-PARTY-NOTICES.md", "BINARY-CAPABILITIES.md", "npm-shrinkwrap.json"]) {
		assert.match(buildScript, new RegExp(`cp ${file.replaceAll(".", "\\.")}`));
	}
	const codingAgentManifest = JSON.parse(readFileSync("packages/coding-agent/package.json", "utf8"));
	assert.ok(codingAgentManifest.files.includes("!examples/**/node_modules/**"));
	assert.match(buildScript, /firebase-push-relay\/functions\/node_modules/);
	assert.match(buildScript, /cp -r dist\/LICENSES/);

	const licenseCopies = [
		["node_modules/@silvia-odwyer/photon-node/LICENSE.md", "packages/coding-agent/dist/LICENSES/photon-node-Apache-2.0.txt"],
		["node_modules/highlight.js/LICENSE", "packages/coding-agent/dist/LICENSES/highlight.js-BSD-3-Clause.txt"],
		["node_modules/marked/LICENSE", "packages/coding-agent/dist/LICENSES/marked-LICENSE.txt"],
	];
	execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "copy-third-party-licenses"], {
		cwd: "packages/coding-agent",
		stdio: "pipe",
	});
	for (const [source, copied] of licenseCopies) {
		assert.deepEqual(readFileSync(copied), readFileSync(source));
	}
	assert.match(readFileSync("packages/coding-agent/THIRD-PARTY-NOTICES.md", "utf8"), /clipboard packages do not contain an authoritative license text/);

	const betaReadiness = readFileSync("BETA-READINESS.md", "utf8");
	assert.match(betaReadiness, /not ready for public beta\s+distribution/i);
	assert.match(betaReadiness, /Do not publish the standalone binary until/i);
	assert.match(betaReadiness, /Prove the npm daemon distribution/);
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
	const result = spawnSync(
		"bash",
		[
			"scripts/build-binaries.sh",
			"--skip-install",
			"--skip-deps",
			"--skip-build",
			"--platform",
			"darwin-arm64",
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
		assert.match(installed.stdout, /Installed verified standalone binary/);
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
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});
