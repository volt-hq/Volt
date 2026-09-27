#!/usr/bin/env node
// Verifies a downloaded Build Standalone Candidate artifact before Approve Release.
//
// Usage (from the repository root):
//   node .volt/skills/release/verify-candidate.mjs <candidate-dir> --commit <sha> --run <run-id> [--skip-attestations]
//
// Checks the combined artifact layout, source-commit.txt, SHA256SUMS, and release-record.json;
// every archive's build manifest against compliance/standalone-runtime.json, the copied Node
// license, the bundle metafile checksum, every copied npm license file, and the complete file
// manifest; prohibited files; that Windows executables carry no certificate table; and one
// matching GitHub attestation per archive and record.
// Exits non-zero when any check fails.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { readPeCertificateTable } from "../../../scripts/pe-certificate.mjs";

const REPOSITORY = "volt-hq/Volt";
const CANDIDATE_WORKFLOW = `${REPOSITORY}/.github/workflows/build-standalone-candidate.yml`;
const PROHIBITED_PATH = /doom|\.wad$|(^|\/)\.env|\.pem$|\.map$/i;
const RESTRICTED_LICENSE = /GPL|SSPL|BUSL|Commons-Clause|UNLICENSED|SEE LICENSE/i;

function parseArgs(argv) {
	const options = { attestations: true, candidateDir: undefined, commit: undefined, runId: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--commit") options.commit = argv[++index];
		else if (arg === "--run") options.runId = argv[++index];
		else if (arg === "--skip-attestations") options.attestations = false;
		else if (!arg.startsWith("--") && options.candidateDir === undefined) options.candidateDir = arg;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!options.candidateDir || !/^[0-9a-f]{40}$/.test(options.commit ?? "") || !/^[1-9]\d*$/.test(options.runId ?? "")) {
		throw new Error("Usage: verify-candidate.mjs <candidate-dir> --commit <40-char sha> --run <run-id> [--skip-attestations]");
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

function verifyArchive(archive, target, context) {
	const { commit, compliance, fail, licenses } = context;
	const extracted = mkdtempSync(join(tmpdir(), "volt-candidate-"));
	try {
		const extract = spawnSync("tar", ["-xf", archive, "-C", extracted], { encoding: "utf8" });
		if (extract.status !== 0) return fail(`${target}: extraction failed: ${extract.stderr}`);
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
	const context = { ...options, compliance, fail: (message) => problems.push(message), licenses: new Map() };

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
	console.log(problems.length ? `\nProblems:\n  ${problems.join("\n  ")}` : "\nProblems: none");
	process.exitCode = problems.length ? 1 : 0;
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
