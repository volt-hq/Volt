#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const RELEASE_PACKAGES = [
	"packages/ai",
	"packages/tui",
	"packages/agent",
	"packages/coding-agent",
];
const RELEASE_REPOSITORY_URL = "git+https://github.com/hansjm10/Volt.git";

export function versionFromReleaseTag(tag) {
	const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
	if (!match) {
		throw new Error(`release tag must be canonical vMAJOR.MINOR.PATCH: ${tag}`);
	}
	return tag.slice(1);
}

export function verifyReleasePackageMetadata(tag, readText = (path) => readFileSync(path, "utf8")) {
	const version = versionFromReleaseTag(tag);
	for (const directory of RELEASE_PACKAGES) {
		const manifest = JSON.parse(readText(`${directory}/package.json`));
		if (manifest.version !== version) {
			throw new Error(`${directory}/package.json is ${manifest.version}; expected ${version} from ${tag}`);
		}
		if (manifest.repository?.url !== RELEASE_REPOSITORY_URL || manifest.repository?.directory !== directory) {
			throw new Error(`${directory}/package.json must identify ${RELEASE_REPOSITORY_URL} and its package directory`);
		}
		const changelog = readText(`${directory}/CHANGELOG.md`);
		const escapedVersion = version.replaceAll(".", "\\.");
		if (!new RegExp(`^## \\[${escapedVersion}\\](?:\\s|$)`, "m").test(changelog)) {
			throw new Error(`${directory}/CHANGELOG.md has no release section for ${version}`);
		}
	}
	return version;
}

function git(...args) {
	return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function verifyReleaseGitProvenance(tag, runGit = git) {
	versionFromReleaseTag(tag);
	const head = runGit("rev-parse", "HEAD");
	let taggedCommit;
	try {
		taggedCommit = runGit("rev-parse", `refs/tags/${tag}^{commit}`);
	} catch {
		throw new Error(`release tag does not exist in this checkout: ${tag}`);
	}
	if (taggedCommit !== head) {
		throw new Error(`checked-out commit ${head} does not match ${tag} commit ${taggedCommit}`);
	}
	if (runGit("cat-file", "-t", `refs/tags/${tag}`) !== "tag") {
		throw new Error(`release tag must be an annotated tag: ${tag}`);
	}
	try {
		runGit("merge-base", "--is-ancestor", head, "refs/remotes/origin/main");
	} catch {
		throw new Error(`release tag commit ${head} is not reachable from origin/main`);
	}
	return head;
}

function parseTagArgument(args) {
	const index = args.indexOf("--tag");
	if (index === -1 || !args[index + 1] || args.length !== 2) {
		throw new Error("Usage: node scripts/verify-release-provenance.mjs --tag vMAJOR.MINOR.PATCH");
	}
	return args[index + 1];
}

function main() {
	const tag = parseTagArgument(process.argv.slice(2));
	const version = verifyReleasePackageMetadata(tag);
	const commit = verifyReleaseGitProvenance(tag);
	process.stdout.write(`${tag} (${version}) is bound to ${commit}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`release provenance verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
