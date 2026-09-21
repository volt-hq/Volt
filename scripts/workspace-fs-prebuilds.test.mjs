import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse } from "yaml";
import { API_VERSION, currentTarget, sourceFingerprint, targets } from "./workspace-fs-native.mjs";
import { assembleNativePrebuilds } from "./workspace-fs-prebuilds.mjs";

const commit = "1".repeat(40);
const fingerprint = "2".repeat(64);
const nativePath = "packages/coding-agent/native/workspace-fs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
	const directory = mkdtempSync(join(tmpdir(), "volt-native-prebuilds-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const inputDirectory = join(directory, "inputs");
	mkdirSync(inputDirectory);
	for (const target of Object.keys(targets)) {
		const path = join(inputDirectory, `workspace-fs-prebuild-${target}`);
		mkdirSync(path);
		const bytes = Buffer.from(`native fixture: ${target}`);
		writeFileSync(join(path, "workspace-fs.node"), bytes);
		writeFileSync(join(path, "receipt.json"), JSON.stringify({
			schemaVersion: 1, target, commit, sourceFingerprint: fingerprint,
			apiVersion: API_VERSION, sha256: `sha256:${digest(bytes)}`,
		}));
	}
	const licensesDirectory = join(directory, "licenses");
	mkdirSync(licensesDirectory);
	writeFileSync(join(licensesDirectory, "inventory.json"), JSON.stringify({ schemaVersion: 1, sourceFingerprint: fingerprint }));
	mkdirSync(join(licensesDirectory, "dependency"));
	writeFileSync(join(licensesDirectory, "dependency", "LICENSE"), "license fixture\n");
	return { inputDirectory, outputDirectory: join(directory, "bundle"), licensesDirectory, commit, fingerprint };
}

test("assembles the exact eight targets, regenerated manifest, licenses, source record and verifiable checksums", (t) => {
	const options = fixture(t);
	assembleNativePrebuilds(options);
	const bundle = options.outputDirectory;
	assert.deepEqual(readdirSync(bundle).sort(), ["SHA256SUMS", "build-record.json", "packages", "source-commit.txt"]);
	assert.equal(readFileSync(join(bundle, "source-commit.txt"), "utf8"), `${commit}\n`);
	const manifest = JSON.parse(readFileSync(join(bundle, nativePath, "prebuilds", "manifest.json"), "utf8"));
	assert.equal(manifest.apiVersion, API_VERSION);
	assert.equal(manifest.sourceFingerprint, fingerprint);
	assert.deepEqual(manifest.artifacts.map((artifact) => artifact.target), Object.keys(targets));
	for (const artifact of manifest.artifacts) {
		const bytes = readFileSync(join(bundle, nativePath, "prebuilds", artifact.path));
		assert.equal(artifact.sha256, `sha256:${digest(bytes)}`);
	}
	const checksums = readFileSync(join(bundle, "SHA256SUMS"), "utf8").trim().split("\n");
	assert.equal(checksums.length, 13);
	for (const line of checksums) {
		const [hash, path] = line.split("  ");
		assert.equal(digest(readFileSync(join(bundle, path))), hash, path);
	}
	assert.equal(readFileSync(join(bundle, nativePath, "licenses", "dependency", "LICENSE"), "utf8"), "license fixture\n");
	const record = JSON.parse(readFileSync(join(bundle, "build-record.json"), "utf8"));
	assert.equal(record.commit, commit);
	assert.equal(record.builds.length, 8);
	assert.throws(() => assembleNativePrebuilds(options), /EEXIST/);
});

for (const kind of ["missing", "extra", "extra-file", "commit", "fingerprint", "target", "api", "checksum", "license"]) {
	test(`rejects ${kind} artifact mismatch without producing a partial bundle`, (t) => {
		const options = fixture(t);
		const path = join(options.inputDirectory, "workspace-fs-prebuild-linux-x64-gnu");
		if (kind === "missing") rmSync(path, { recursive: true });
		else if (kind === "extra") mkdirSync(join(options.inputDirectory, "unexpected"));
		else if (kind === "extra-file") writeFileSync(join(path, "extra"), "unexpected");
		else if (kind === "checksum") writeFileSync(join(path, "workspace-fs.node"), "tampered");
		else if (kind === "license") writeFileSync(join(options.licensesDirectory, "inventory.json"), JSON.stringify({ schemaVersion: 1, sourceFingerprint: "0".repeat(64) }));
		else {
			const receipt = JSON.parse(readFileSync(join(path, "receipt.json"), "utf8"));
			const field = { commit: "commit", fingerprint: "sourceFingerprint", target: "target", api: "apiVersion" }[kind];
			receipt[field] = "mismatch";
			writeFileSync(join(path, "receipt.json"), JSON.stringify(receipt));
		}
		assert.throws(() => assembleNativePrebuilds(options), /artifact|receipt|inventory/);
		assert.equal(existsSync(options.outputDirectory), false);
	});
}

test("rejects malformed commit identities", (t) => {
	const options = fixture(t);
	for (const invalid of ["main", "abc123", "A".repeat(40), `${commit}\n`, "../outside"]) {
		assert.throws(() => assembleNativePrebuilds({ ...options, commit: invalid }), /exact lowercase/);
	}
	assert.equal(existsSync(options.outputDirectory), false);
});

test("refuses symlinked native payloads", { skip: process.platform === "win32" }, (t) => {
	const options = fixture(t);
	const path = join(options.inputDirectory, "workspace-fs-prebuild-linux-x64-gnu", "workspace-fs.node");
	rmSync(path);
	symlinkSync(join(options.licensesDirectory, "inventory.json"), path);
	assert.throws(() => assembleNativePrebuilds(options), /regular file/);
	assert.equal(existsSync(options.outputDirectory), false);
});

test("stage CLI load-verifies the current addon and binds its exact bytes to the checked-out commit", (t) => {
	const directory = mkdtempSync(join(tmpdir(), "volt-native-stage-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const output = join(directory, "upload");
	const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	const script = fileURLToPath(new URL("./workspace-fs-prebuilds.mjs", import.meta.url));
	const rejected = spawnSync(process.execPath, [script, "stage", currentTarget(), output, "0".repeat(40)], { encoding: "utf8" });
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /Checked-out source does not match/);
	assert.equal(existsSync(output), false);
	execFileSync(process.execPath, [script, "stage", currentTarget(), output, actualCommit]);
	assert.deepEqual(readdirSync(output).sort(), ["receipt.json", "workspace-fs.node"]);
	const receipt = JSON.parse(readFileSync(join(output, "receipt.json"), "utf8"));
	assert.equal(receipt.commit, actualCommit);
	assert.equal(receipt.target, currentTarget());
	assert.equal(receipt.sourceFingerprint, sourceFingerprint());
	assert.equal(receipt.sha256, `sha256:${digest(readFileSync(join(output, "workspace-fs.node")))}`);
});

test("workflow is manual, read-only, SHA-pinned and builds every native target before assembling same-run artifacts", () => {
	const workflow = parse(readFileSync(new URL("../.github/workflows/build-workspace-fs-prebuilds.yml", import.meta.url), "utf8"));
	assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.commit.required, true);
	assert.deepEqual(workflow.permissions, {});
	assert.equal(workflow.jobs.build.needs, "validate");
	assert.equal(workflow.jobs.assemble.needs, "build");
	const matrix = workflow.jobs.build.strategy.matrix.include;
	assert.deepEqual(matrix.map((entry) => entry.target).sort(), Object.keys(targets).sort());
	for (const entry of matrix) assert.equal(entry["rust-target"], targets[entry.target].rust);
	for (const job of Object.values(workflow.jobs)) {
		assert.deepEqual(job.permissions, { contents: "read" });
		// GitHub evaluates job-level env before the runner context is available.
		for (const value of Object.values(job.env ?? {})) assert.doesNotMatch(String(value), /runner\./);
		for (const step of job.steps) {
			if (step.uses) assert.match(step.uses, /^actions\/[a-z-]+@[0-9a-f]{40}$/);
			if (step.uses?.startsWith("actions/checkout@")) {
				assert.equal(step.with.ref, "${{ inputs.commit }}");
				assert.equal(step.with["persist-credentials"], false);
			}
		}
	}
	const download = workflow.jobs.assemble.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
	assert.deepEqual(download.with, {
		pattern: "workspace-fs-prebuild-*", path: "${{ runner.temp }}/native-inputs", "merge-multiple": false,
	});
	const musl = workflow.jobs.build.steps.find((step) => step.name.startsWith("Load and stage musl"));
	assert.match(musl.env.NODE_IMAGE, /^node:22\.19\.0-alpine@sha256:[0-9a-f]{64}$/);
	assert.equal(musl.if, "endsWith(matrix.target, '-musl')");
});
