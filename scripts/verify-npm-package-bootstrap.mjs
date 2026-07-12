#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RELEASE_PACKAGES } from "./verify-release-provenance.mjs";

function npmViewPackageName(name) {
	const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
		"view",
		name,
		"name",
		"--json",
		"--registry=https://registry.npmjs.org/",
	], {
		encoding: "utf8",
		timeout: 30_000,
	});
	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		if (output.includes("E404") || output.includes("404 Not Found")) {
			throw new Error(
				`${name} does not exist on npm. Bootstrap the scoped public package and configure its trusted publisher before creating a release tag; see docs/npm-release-bootstrap.md.`,
			);
		}
		throw new Error(output || `npm view failed for ${name}`);
	}
	const registryName = JSON.parse(result.stdout);
	if (registryName !== name) {
		throw new Error(`npm returned unexpected package identity for ${name}: ${String(registryName)}`);
	}
}

try {
	for (const directory of RELEASE_PACKAGES) {
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		npmViewPackageName(manifest.name);
		process.stdout.write(`npm package exists: ${manifest.name}\n`);
	}
} catch (error) {
	process.stderr.write(`npm release bootstrap verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
