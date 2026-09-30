#!/usr/bin/env node
// Verifies a downloaded Build Standalone Candidate artifact before Approve Release.
//
// Usage (from the repository root):
//   node .volt/skills/release/verify-candidate.mjs <candidate-dir> --commit <sha> --run <run-id> [--previous <tag>] [--skip-attestations]
//
// Checks the combined artifact layout, source-commit.txt, SHA256SUMS, and release-record.json;
// every archive's build manifest against compliance/standalone-runtime.json, the copied Node
// license, the bundle metafile checksum, every copied npm license file, and the complete file
// manifest; prohibited files; that Windows executables carry no certificate table; and one
// matching GitHub attestation per archive and record.
// With --previous, also downloads that release's archives and lists bundled npm packages that
// were added, removed, updated, or relicensed since then.
// Exits non-zero when any check fails.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readPeCertificateTable } from "../../../scripts/pe-certificate.mjs";

const REPOSITORY = "volt-hq/Volt";
const CANDIDATE_WORKFLOW = `${REPOSITORY}/.github/workflows/build-standalone-candidate.yml`;
const PROHIBITED_PATH = /doom|\.wad$|(^|\/)\.env|\.pem$|\.map$/i;
const RESTRICTED_LICENSE = /GPL|SSPL|BUSL|Commons-Clause|UNLICENSED|SEE LICENSE/i;

function parseArgs(argv) {
	const options = { attestations: true, candidateDir: undefined, commit: undefined, previous: undefined, runId: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--commit") options.commit = argv[++index];
		else if (arg === "--run") options.runId = argv[++index];
		else if (arg === "--previous") options.previous = argv[++index];
		else if (arg === "--skip-attestations") options.attestations = false;
		else if (!arg.startsWith("--") && options.candidateDir === undefined) options.candidateDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (
		!options.candidateDir ||
		!/^[0-9a-f]{40}$/.test(options.commit ?? "") ||
		!/^[1-9]\d*$/.test(options.runId ?? "") ||
		(options.previous !== undefined && !/^v\d+\.\d+\.\d+$/.test(options.previous))
	) {
		throw new Error(
			"Usage: verify-candidate.mjs <candidate-dir> --commit <40-char sha> --run <run-id> [--previous <vX.Y.Z>] [--skip-attestations]",
		);
	}
	return options;
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function walk(directory, root = directory, files = []) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) walk(path, root, files);
		else files.push(relative(root, path).replaceAll("\\", "/"));
	}
	return files;
}

function describeLicense(declared) {
	if (typeof declared === "string" && declared) return declared;
	if (Array.isArray(declared)) return declared.map((entry) => entry?.type ?? JSON.stringify(entry)).join(" OR ");
	if (declared && typeof declared === "object") return declared.type ?? JSON.stringify(declared);
	return "(undeclared)";
}

function extractArchive(archive) {
	const extracted = mkdtempSync(join(tmpdir(), "volt-candidate-"));
	// GNU tar cannot read zip archives, so Windows zips go through unzip on every host (#532).
	const [command, args] = archive.endsWith(".zip")
		? ["unzip", ["-q", archive, "-d", extracted]]
		: ["tar", ["-xf", archive, "-C", extracted]];
	const extract = spawnSync(command, args, { encoding: "utf8" });
	if (extract.status !== 0) {
		rmSync(extracted, { force: true, recursive: true });
		throw new Error(`extraction failed: ${extract.error?.message ?? extract.stderr}`);
	}
	return extracted;
}

function verifyArchive(archive, target, context) {
	const { commit, compliance, fail, licenses, packages } = context;
	let extracted;
	try {
		extracted = extractArchive(archive);
	} catch (error) {
		return fail(`${target}: ${error.message}`);
	}
	try {
		const windows = target.startsWith("windows-");
		const top = readdirSync(extracted);
		if (windows ? !top.includes("volt.exe") : top.length !== 1 || top[0] !== "volt") {
			return fail(`${target}: unexpected archive root ${JSON.stringify(top)}`);
		}
		const root = windows ? extracted : join(extracted, "volt");
		const files = walk(root);

		const build = JSON.parse(readFileSync(join(root, "standalone-build-manifest.json"), "utf8"));
		const pin = compliance.targets[target];
		if (!pin) return fail(`${target}: not in compliance/standalone-runtime.json`);
		if (build.target !== target) fail(`${target}: build manifest target is ${build.target}`);
		if (build.sourceCommit !== commit) fail(`${target}: sourceCommit ${build.sourceCommit} is not ${commit}`);
		if (build.sourceTreeClean !== true) fail(`${target}: source tree was not clean`);
		if (build.runtime.version !== compliance.version) fail(`${target}: runtime ${build.runtime.version} is not ${compliance.version}`);
		if (build.runtime.archive !== pin.archive || build.runtime.archiveSha256 !== pin.sha256) {
			fail(`${target}: runtime archive does not match the compliance pin`);
		}
		if (build.runtime.licenseSha256 !== compliance.license.sha256 || sha256(join(root, build.runtime.license)) !== compliance.license.sha256) {
			fail(`${target}: copied Node license does not match the compliance pin`);
		}

		const licenseManifest = JSON.parse(readFileSync(join(root, build.binaryLicenseManifest), "utf8"));
		if (sha256(join(root, build.bundleMetafile)) !== licenseManifest.metafileSha256) fail(`${target}: bundle metafile checksum mismatch`);
		if (licenseManifest.packages.length !== licenseManifest.npmPackageCount) fail(`${target}: npm package count mismatch`);
		let licenseFiles = 0;
		for (const pkg of licenseManifest.packages) {
			const license = describeLicense(pkg.declaredLicense);
			const id = `${pkg.name}@${pkg.version}`;
			if (!licenses.has(license)) licenses.set(license, new Set());
			licenses.get(license).add(id);
			packages.set(id, { name: pkg.name, version: pkg.version, license });
			if (!pkg.licenseFiles?.length) fail(`${target}: ${id} ships no license file`);
			if (RESTRICTED_LICENSE.test(license) && !/LGPL/i.test(license)) fail(`${target}: ${id} declares ${license}`);
			for (const file of pkg.licenseFiles ?? []) {
				licenseFiles++;
				if (sha256(join(root, file.path)) !== file.sha256) fail(`${target}: license file ${file.path} checksum mismatch`);
			}
		}

		const fileManifest = JSON.parse(readFileSync(join(root, build.fileManifest), "utf8"));
		const listed = new Set();
		for (const entry of fileManifest.files) {
			listed.add(entry.path);
			const path = join(root, entry.path);
			let stat;
			try {
				stat = statSync(path);
			} catch {
				fail(`${target}: manifest file missing: ${entry.path}`);
				continue;
			}
			if (stat.size !== entry.size || sha256(path) !== entry.sha256) fail(`${target}: file manifest mismatch: ${entry.path}`);
		}
		const unlisted = files.filter((file) => !listed.has(file) && file !== build.fileManifest);
		if (unlisted.length > 0) fail(`${target}: files missing from the file manifest: ${unlisted.slice(0, 5).join(", ")}`);
		const prohibited = files.filter((file) => PROHIBITED_PATH.test(file));
		if (prohibited.length > 0) fail(`${target}: prohibited files: ${prohibited.slice(0, 5).join(", ")}`);
		const executable = windows ? "volt.exe" : "volt";
		if (!files.includes(executable)) fail(`${target}: ${executable} is missing`);
		let signature = "";
		if (windows && files.includes(executable)) {
			const { offset, size } = readPeCertificateTable(readFileSync(join(root, executable)));
			if (size === 0) signature = ", no certificate table (unsigned)";
			else {
				fail(
					`${target}: ${executable} has a certificate table (${size} bytes at offset ${offset}); releases ship unsigned Windows executables, so a signed build must update this check and the unsigned-Windows notice in scripts/changelog.mjs`,
				);
			}
		}
		console.log(
			`${target}: ${files.length} files, ${licenseManifest.npmPackageCount} npm packages, ${licenseFiles} license files, commit ${build.sourceCommit.slice(0, 9)}${signature}`,
		);
	} finally {
		rmSync(extracted, { force: true, recursive: true });
	}
}

// Collects the npm packages bundled in a published release's archives, keyed by name@version.
function readReleasePackages(tag, archives, fail) {
	const directory = mkdtempSync(join(tmpdir(), "volt-previous-"));
	try {
		const download = spawnSync(
			"gh",
			["release", "download", tag, "--repo", REPOSITORY, "--dir", directory, ...archives.flatMap(({ name }) => ["--pattern", name])],
			{ encoding: "utf8" },
		);
		if (download.status !== 0) {
			fail(`${tag}: gh release download failed: ${(download.stderr || download.stdout).trim().slice(0, 300)}`);
			return undefined;
		}
		const packages = new Map();
		for (const { name, target } of archives) {
			// gh exits 0 when any pattern matches, so a target missing from the older release is only visible here.
			if (!existsSync(join(directory, name))) {
				console.log(`${tag} has no ${name}; its ${target} packages count as added`);
				continue;
			}
			let extracted;
			try {
				extracted = extractArchive(join(directory, name));
			} catch (error) {
				fail(`${tag} ${target}: ${error.message}`);
				continue;
			}
			try {
				const root = target.startsWith("windows-") ? extracted : join(extracted, "volt");
				const build = JSON.parse(readFileSync(join(root, "standalone-build-manifest.json"), "utf8"));
				const manifest = JSON.parse(readFileSync(join(root, build.binaryLicenseManifest), "utf8"));
				for (const pkg of manifest.packages) {
					const license = describeLicense(pkg.declaredLicense);
					packages.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license });
				}
			} finally {
				rmSync(extracted, { force: true, recursive: true });
			}
		}
		return packages;
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
}

function describeDependencyChanges(previous, current) {
	const missingFrom = (from, to) => {
		const names = new Map();
		for (const [id, pkg] of from) {
			if (to.has(id)) continue;
			if (!names.has(pkg.name)) names.set(pkg.name, []);
			names.get(pkg.name).push(pkg);
		}
		return names;
	};
	const removed = missingFrom(previous, current);
	const added = missingFrom(current, previous);
	const versions = (pkgs) => pkgs.map((pkg) => pkg.version).join(", ");
	const licenses = (pkgs) => [...new Set(pkgs.map((pkg) => pkg.license))].join(" / ");
	const lines = [];
	for (const name of [...new Set([...removed.keys(), ...added.keys()])].sort()) {
		const before = removed.get(name);
		const after = added.get(name);
		if (before && after) {
			const license = licenses(before) === licenses(after) ? licenses(after) : `${licenses(before)} -> ${licenses(after)}`;
			lines.push(`updated  ${name} ${versions(before)} -> ${versions(after)} (${license})`);
		} else if (after) lines.push(`added    ${name}@${versions(after)} (${licenses(after)})`);
		else lines.push(`removed  ${name}@${versions(before)} (${licenses(before)})`);
	}
	for (const [id, pkg] of current) {
		const old = previous.get(id);
		if (old && old.license !== pkg.license) lines.push(`license  ${id}: ${old.license} -> ${pkg.license}`);
	}
	return lines;
}

function verifyAttestation(file, { candidateDir, commit, runId, fail }) {
	const path = join(candidateDir, file);
	const result = spawnSync(
		"gh",
		[
			"attestation",
			"verify",
			path,
			"--repo",
			REPOSITORY,
			"--signer-workflow",
			CANDIDATE_WORKFLOW,
			"--source-ref",
			"refs/heads/main",
			"--source-digest",
			commit,
			"--format",
			"json",
		],
		{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.status !== 0) return fail(`${file}: gh attestation verify failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
	const digest = sha256(path);
	const matching = JSON.parse(result.stdout).filter(({ verificationResult }) => {
		const certificate = verificationResult?.signature?.certificate ?? {};
		return (
			verificationResult?.statement?.subject?.some((subject) => subject.digest?.sha256 === digest) &&
			certificate.sourceRepositoryDigest === commit &&
			certificate.sourceRepositoryRef === "refs/heads/main" &&
			String(certificate.buildSignerURI).endsWith("/.github/workflows/build-standalone-candidate.yml@refs/heads/main") &&
			String(certificate.runInvocationURI).includes(`/actions/runs/${runId}/`)
		);
	});
	if (matching.length === 0) fail(`${file}: no attestation binds this digest to ${commit} and run ${runId}`);
	else console.log(`${file}: attestation verified (commit, main, candidate workflow, run ${runId})`);
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const { candidateDir, commit, runId } = options;
	const compliance = JSON.parse(readFileSync("compliance/standalone-runtime.json", "utf8"));
	const problems = [];
	const context = {
		...options,
		compliance,
		fail: (message) => problems.push(message),
		licenses: new Map(),
		packages: new Map(),
	};

	const archives = Object.keys(compliance.targets).map((target) => ({
		name: `volt-${target}.${target.startsWith("windows-") ? "zip" : "tar.gz"}`,
		target,
	}));
	const expectedTop = ["SHA256SUMS", "release-record.json", "source-commit.txt", ...archives.map(({ name }) => name)].sort();
	const top = readdirSync(candidateDir).sort();
	if (JSON.stringify(top) !== JSON.stringify(expectedTop)) context.fail(`unexpected top-level files: ${JSON.stringify(top)}`);
	if (readFileSync(join(candidateDir, "source-commit.txt"), "utf8").trim() !== commit) context.fail("source-commit.txt does not match");

	const sums = new Map(
		readFileSync(join(candidateDir, "SHA256SUMS"), "utf8")
			.trim()
			.split("\n")
			.map((line) => line.split(/\s+/).reverse()),
	);
	const record = JSON.parse(readFileSync(join(candidateDir, "release-record.json"), "utf8"));
	if (record.candidate?.commit !== commit || record.candidate?.ref !== "refs/heads/main") context.fail("release-record.json candidate mismatch");
	if (record.workflow?.runId !== runId) context.fail(`release-record.json names run ${record.workflow?.runId}, not ${runId}`);
	if (record.runtime?.version !== compliance.version) context.fail("release-record.json runtime version mismatch");
	if (sums.size !== archives.length) context.fail(`SHA256SUMS lists ${sums.size} archives`);

	for (const { name, target } of archives) {
		const digest = sha256(join(candidateDir, name));
		if (sums.get(name) !== digest) context.fail(`${name}: SHA256SUMS mismatch`);
		if (record.archives?.find((archive) => archive.name === name)?.sha256 !== digest) context.fail(`${name}: release record mismatch`);
		verifyArchive(join(candidateDir, name), target, context);
	}
	if (options.attestations) {
		for (const file of [...archives.map(({ name }) => name), "release-record.json"]) verifyAttestation(file, context);
	}

	console.log("\nDeclared licenses (distinct packages):");
	for (const [license, packages] of [...context.licenses].sort((a, b) => b[1].size - a[1].size)) {
		console.log(`  ${license}: ${packages.size}`);
	}
	if (options.previous) {
		const previous = readReleasePackages(options.previous, archives, context.fail);
		if (previous) {
			const changes = describeDependencyChanges(previous, context.packages);
			console.log(`\nBundled npm packages since ${options.previous} (all targets):`);
			console.log(changes.length ? `  ${changes.join("\n  ")}` : "  no changes");
		}
	}
	console.log(problems.length ? `\nProblems:\n  ${problems.join("\n  ")}` : "\nProblems: none");
	process.exitCode = problems.length ? 1 : 0;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
