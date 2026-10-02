#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION, currentTarget, sourceFingerprint, targets, verifyAddon, verifyLicenses } from "./workspace-fs-native.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativePath = "packages/coding-agent/native/workspace-fs";
const artifactPrefix = "workspace-fs-prebuild-";

function digest(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function readRegularFile(path) {
	if (!lstatSync(path).isFile()) throw new Error(`Expected a regular file: ${path}`);
	return readFileSync(path);
}

function directoryEntries(path) {
	if (!lstatSync(path).isDirectory()) throw new Error(`Expected a directory: ${path}`);
	return readdirSync(path).sort();
}

function assertCommit(commit) {
	if (typeof commit !== "string" || commit.length !== 40 || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error("Source commit must be an exact lowercase 40-character SHA");
	}
}

/** Stage only a freshly built, target-native load-verified binary; never the other committed prebuilds. */
export function stageNativePrebuild({ target, commit, outputDirectory }) {
	assertCommit(commit);
	if (!Object.hasOwn(targets, target) || currentTarget() !== target) throw new Error(`Not running on native target ${target}`);
	const fingerprint = sourceFingerprint();
	const binary = join(root, nativePath, "prebuilds", target, "workspace-fs.node");
	const bytes = readRegularFile(binary);
	verifyAddon(binary, { apiVersion: API_VERSION, sourceFingerprint: fingerprint });
	mkdirSync(outputDirectory);
	writeFileSync(join(outputDirectory, "workspace-fs.node"), bytes);
	writeFileSync(join(outputDirectory, "receipt.json"), `${JSON.stringify({
		schemaVersion: 1,
		target,
		commit,
		apiVersion: API_VERSION,
		sourceFingerprint: fingerprint,
		sha256: `sha256:${digest(bytes)}`,
	}, null, 2)}\n`);
}

/** Assemble only the exact eight same-run receipts. Missing targets cannot fall back to checked-in binaries. */
export function assembleNativePrebuilds({ inputDirectory, outputDirectory, licensesDirectory, commit, fingerprint }) {
	assertCommit(commit);
	if (typeof fingerprint !== "string" || fingerprint.length !== 64 || !/^[0-9a-f]{64}$/.test(fingerprint)) {
		throw new Error("Invalid source fingerprint");
	}
	const expectedTargets = Object.keys(targets);
	const expectedDirectories = expectedTargets.map((target) => `${artifactPrefix}${target}`).sort();
	if (JSON.stringify(directoryEntries(inputDirectory)) !== JSON.stringify(expectedDirectories)) {
		throw new Error("Native input artifact set must contain exactly all eight targets");
	}
	const files = new Map();
	const receipts = [];
	const artifacts = [];
	for (const target of expectedTargets) {
		const directory = join(inputDirectory, `${artifactPrefix}${target}`);
		if (JSON.stringify(directoryEntries(directory)) !== JSON.stringify(["receipt.json", "workspace-fs.node"])) {
			throw new Error(`Unexpected files in native artifact ${target}`);
		}
		const receipt = JSON.parse(readRegularFile(join(directory, "receipt.json")).toString("utf8"));
		const bytes = readRegularFile(join(directory, "workspace-fs.node"));
		const sha256 = `sha256:${digest(bytes)}`;
		if (receipt.schemaVersion !== 1 || receipt.target !== target || receipt.commit !== commit ||
			receipt.apiVersion !== API_VERSION || receipt.sourceFingerprint !== fingerprint || receipt.sha256 !== sha256) {
			throw new Error(`Native build receipt mismatch for ${target}`);
		}
		const path = `${target}/workspace-fs.node`;
		artifacts.push({ target, path, sha256 });
		receipts.push(receipt);
		files.set(`${nativePath}/prebuilds/${path}`, bytes);
	}
	const inventory = JSON.parse(readRegularFile(join(licensesDirectory, "inventory.json")).toString("utf8"));
	if (inventory.schemaVersion !== 1 || inventory.sourceFingerprint !== fingerprint) {
		throw new Error("License inventory does not match the native source fingerprint");
	}
	const copyLicenses = (directory, prefix) => {
		for (const name of directoryEntries(directory)) {
			const path = join(directory, name);
			const destination = `${prefix}/${name}`;
			if (lstatSync(path).isDirectory()) copyLicenses(path, destination);
			else files.set(destination, readRegularFile(path));
		}
	};
	copyLicenses(licensesDirectory, `${nativePath}/licenses`);
	files.set(`${nativePath}/prebuilds/manifest.json`, Buffer.from(`${JSON.stringify({
		schemaVersion: 1, apiVersion: API_VERSION, sourceFingerprint: fingerprint, artifacts,
	}, null, 2)}\n`));
	files.set("source-commit.txt", Buffer.from(`${commit}\n`));
	files.set("build-record.json", Buffer.from(`${JSON.stringify({ schemaVersion: 1, commit, sourceFingerprint: fingerprint, builds: receipts }, null, 2)}\n`));
	const ordered = [...files].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
	files.set("SHA256SUMS", Buffer.from(ordered.map(([path, bytes]) => `${digest(bytes)}  ${path}\n`).join("")));
	// Refuse an existing output directory rather than mixing runs or deleting user data.
	mkdirSync(outputDirectory);
	for (const [path, bytes] of files) {
		const destination = join(outputDirectory, path);
		mkdirSync(dirname(destination), { recursive: true });
		writeFileSync(destination, bytes);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const [command, first, second, commit] = process.argv.slice(2);
		assertCommit(commit);
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
		if (head !== commit) throw new Error("Checked-out source does not match the requested commit");
		if (command === "stage") {
			stageNativePrebuild({ target: first, outputDirectory: resolve(second), commit });
		} else if (command === "assemble") {
			verifyLicenses();
			const fingerprint = sourceFingerprint();
			assembleNativePrebuilds({
				inputDirectory: resolve(first), outputDirectory: resolve(second),
				licensesDirectory: join(root, nativePath, "licenses"), commit, fingerprint,
			});
			verifyAddon(join(resolve(second), nativePath, "prebuilds", currentTarget(), "workspace-fs.node"), {
				apiVersion: API_VERSION, sourceFingerprint: fingerprint,
			});
		} else {
			throw new Error("Usage: workspace-fs-prebuilds.mjs stage <target> <output> <commit> | assemble <inputs> <output> <commit>");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.stack || error.message : String(error));
		process.exitCode = 1;
	}
}
