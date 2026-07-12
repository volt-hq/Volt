import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RELEASE_PACKAGES,
	verifyReleaseGitProvenance,
	verifyReleasePackageMetadata,
	versionFromReleaseTag,
} from "./verify-release-provenance.mjs";

test("release tags are canonical semver tags", () => {
	assert.equal(versionFromReleaseTag("v0.79.6"), "0.79.6");
	for (const invalid of ["0.79.6", "v01.2.3", "v1.2", "main", "v1.2.3-rc.1", "v1.2.3\nmain"]) {
		assert.throws(() => versionFromReleaseTag(invalid));
	}
});

test("release package versions and changelogs must match the tag", () => {
	const files = new Map();
	for (const directory of RELEASE_PACKAGES) {
		files.set(
			`${directory}/package.json`,
			JSON.stringify({
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
	files.set("packages/ai/package.json", JSON.stringify({ version: "1.2.4" }));
	assert.throws(() => verifyReleasePackageMetadata("v1.2.3", (path) => files.get(path)), /expected 1\.2\.3/);
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
	assert.doesNotMatch(workflow, /source_ref|SOURCE_REF|--clobber/);
	assert.doesNotMatch(workflow, /^\s*cache:\s*npm\s*$/m);
	assert.equal(workflow.match(/actions\/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd/g)?.length, 2);
	assert.equal(workflow.match(/actions\/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e/g)?.length, 2);
	assert.equal(workflow.match(/package-manager-cache: false/g)?.length, 2);
	assert.match(workflow, /ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/);
	assert.match(workflow, /verify-release-provenance\.mjs --tag/);
	assert.match(workflow, /verify-npm-package-bootstrap\.mjs/);
	assert.match(workflow, /Refusing to replace existing release asset with different bytes/);
	assert.match(workflow, /cmp -s/);
});

test("installers use the published package and verify binary checksums before exact extraction", () => {
	const shellInstaller = readFileSync("site/public/install.sh", "utf8");
	const windowsInstaller = readFileSync("site/public/install.ps1", "utf8");
	for (const installer of [shellInstaller, windowsInstaller]) {
		assert.match(installer, /@earendil-works\/volt-coding-agent/);
		assert.doesNotMatch(installer, /@hansjm10\/volt-cli/);
		assert.match(installer, /SHA256SUMS/);
		assert.match(installer, /SHA-256 verification failed/);
		assert.match(installer, /local CLI\/TUI only/i);
	}
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

test("Unix npm installer does not promise daemon support on Darwin x64", () => {
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
		writeFileSync(fakeNpm, "#!/bin/sh\nexit 0\n");
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
				VOLT_VERSION: "1.2.3",
			},
		});
		assert.equal(result.status, 0, result.stderr);
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
