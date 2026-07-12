#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BOOTSTRAP_VERSION } from "./verify-npm-package-bootstrap.mjs";
import { RELEASE_PACKAGE_IDENTITIES } from "./verify-release-provenance.mjs";

export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const PLACEHOLDER_VERSION = BOOTSTRAP_VERSION;
export const PLACEHOLDER_TAG = "bootstrap";
const LICENSE_PATH = fileURLToPath(new URL("../LICENSE", import.meta.url));
const FORBIDDEN_PACKAGE_FIELDS = [
	"bin",
	"bundleDependencies",
	"bundledDependencies",
	"dependencies",
	"devDependencies",
	"directories",
	"engines",
	"exports",
	"imports",
	"main",
	"man",
	"optionalDependencies",
	"os",
	"peerDependencies",
	"scripts",
	"type",
	"types",
	"typings",
	"workspaces",
];

const packageByName = new Map(RELEASE_PACKAGE_IDENTITIES.map((pkg) => [pkg.name, pkg]));
export const BOOTSTRAP_PACKAGE_IDENTITIES = [
	"@hansjm10/volt-ai",
	"@hansjm10/volt-agent-core",
	"@hansjm10/volt-tui",
	"@hansjm10/volt-coding-agent",
].map((name) => {
	const pkg = packageByName.get(name);
	if (!pkg) throw new Error(`Missing release package identity for ${name}`);
	return pkg;
});

function npmCommand() {
	return process.platform === "win32" ? "npm.cmd" : "npm";
}

function runNpm(args, options = {}) {
	const environment = { ...process.env };
	if (options.disableProvenance) {
		for (const key of Object.keys(environment)) {
			if (key.toLowerCase() === "npm_config_provenance") delete environment[key];
		}
		environment.npm_config_provenance = "false";
	}
	return spawnSync(npmCommand(), args, {
		cwd: options.cwd,
		encoding: "utf8",
		env: environment,
		stdio: options.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
		timeout: options.interactive ? undefined : 30_000,
	});
}

function outputFrom(result) {
	return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function commandFailure(args, result) {
	const detail = result.error?.message || outputFrom(result) || `exit code ${result.status ?? "unknown"}`;
	return new Error(`npm ${args.join(" ")} failed: ${detail}`);
}

function parseJsonResult(args, result) {
	if (result.error || result.status !== 0) throw commandFailure(args, result);
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(`npm ${args.join(" ")} returned invalid JSON`);
	}
}

function isMissingPackage(result) {
	if (result.error || result.status === 0) return false;
	const output = outputFrom(result);
	return output.includes("E404") || output.includes("404 Not Found");
}

export function expectedPlaceholderManifest(pkg) {
	return {
		name: pkg.name,
		version: PLACEHOLDER_VERSION,
		description: "Name reservation placeholder for Volt; not an installable release.",
		license: "MIT",
		repository: {
			type: "git",
			url: "git+https://github.com/hansjm10/Volt.git",
			directory: pkg.directory,
		},
		voltBootstrapPlaceholder: true,
		files: ["README.md", "LICENSE"],
		publishConfig: {
			access: "public",
			tag: PLACEHOLDER_TAG,
			registry: NPM_REGISTRY,
		},
	};
}

function assertExactPlaceholderMetadata(pkg, metadata) {
	const expected = expectedPlaceholderManifest(pkg);
	for (const [field, value] of Object.entries(expected)) {
		if (!isDeepStrictEqual(metadata[field], value)) {
			throw new Error(`${pkg.name} exists with unexpected ${field}; refusing to publish`);
		}
	}
	for (const field of FORBIDDEN_PACKAGE_FIELDS) {
		if (Object.hasOwn(metadata, field)) {
			throw new Error(`${pkg.name} placeholder unexpectedly defines ${field}; refusing to publish`);
		}
	}
}

export function inspectBootstrapPackage(pkg, run = runNpm) {
	const metadataArgs = [
		"view",
		`${pkg.name}@${PLACEHOLDER_VERSION}`,
		"name",
		"version",
		"description",
		"license",
		"repository",
		"voltBootstrapPlaceholder",
		"files",
		"publishConfig",
		...FORBIDDEN_PACKAGE_FIELDS,
		"versions",
		"dist-tags",
		"--json",
		`--registry=${NPM_REGISTRY}`,
	];
	const metadataResult = run(metadataArgs);
	if (isMissingPackage(metadataResult)) {
		const existenceArgs = ["view", pkg.name, "name", "--json", `--registry=${NPM_REGISTRY}`];
		const existenceResult = run(existenceArgs);
		if (isMissingPackage(existenceResult)) return { state: "absent" };
		if (existenceResult.error || existenceResult.status !== 0) throw commandFailure(existenceArgs, existenceResult);
		throw new Error(`${pkg.name} exists but does not contain the exact Volt bootstrap placeholder; refusing to publish`);
	}

	const metadata = parseJsonResult(metadataArgs, metadataResult);
	assertExactPlaceholderMetadata(pkg, metadata);
	const versionsValue = metadata.versions;
	const versions = typeof versionsValue === "string" ? [versionsValue] : versionsValue;
	if (!Array.isArray(versions) || versions.length !== 1 || versions[0] !== PLACEHOLDER_VERSION) {
		throw new Error(
			`${pkg.name} exists with unexpected versions (${Array.isArray(versions) ? versions.join(", ") : String(versions)}); refusing to publish`,
		);
	}

	const tags = metadata["dist-tags"];
	const tagEntries = tags && typeof tags === "object" && !Array.isArray(tags) ? Object.entries(tags) : [];
	if (tagEntries.length !== 1 || tags[PLACEHOLDER_TAG] !== PLACEHOLDER_VERSION) {
		throw new Error(`${pkg.name} exists with unexpected dist-tags; expected only ${PLACEHOLDER_TAG}@${PLACEHOLDER_VERSION}`);
	}

	const packArgs = [
		"pack",
		`${pkg.name}@${PLACEHOLDER_VERSION}`,
		"--dry-run",
		"--ignore-scripts",
		"--json",
		`--registry=${NPM_REGISTRY}`,
	];
	const packed = parseJsonResult(packArgs, run(packArgs));
	const packedPaths = Array.isArray(packed) && packed.length === 1 ? packed[0].files?.map(({ path }) => path).sort() : undefined;
	const expectedPaths = ["LICENSE", "README.md", "package.json"];
	if (!isDeepStrictEqual(packedPaths, expectedPaths)) {
		throw new Error(`${pkg.name} placeholder tarball contains unexpected files; refusing to publish`);
	}

	return { state: "placeholder" };
}

function writePlaceholderPackage(root, pkg) {
	const directory = join(root, pkg.name.slice(1).replaceAll("/", "-"));
	mkdirSync(directory);
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(expectedPlaceholderManifest(pkg), null, 2)}\n`);
	writeFileSync(
		join(directory, "README.md"),
		`# ${pkg.name}\n\nThis package only reserves the npm name for [Volt](https://github.com/hansjm10/Volt).\n\nInstallable releases begin at \`0.1.0\` and use the \`beta\` dist-tag.\n`,
	);
	writeFileSync(join(directory, "LICENSE"), readFileSync(LICENSE_PATH, "utf8"));
	return directory;
}

export function bootstrapNpmPackages(options = {}) {
	const publish = options.publish ?? false;
	const run = options.run ?? runNpm;
	const log = options.log ?? ((message) => process.stdout.write(`${message}\n`));
	const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

	const states = BOOTSTRAP_PACKAGE_IDENTITIES.map((pkg) => ({ pkg, ...inspectBootstrapPackage(pkg, run) }));
	for (const { pkg, state } of states) {
		log(`${pkg.name}: ${state === "absent" ? "available" : `reserved at ${PLACEHOLDER_VERSION}`}`);
	}

	const absent = states.filter(({ state }) => state === "absent");
	if (!publish) {
		if (absent.length > 0) log(`Read-only check complete. Re-run with --publish to reserve ${absent.length} package name(s).`);
		return { published: [], states };
	}
	if (absent.length === 0) {
		log("All npm package names already have the exact Volt bootstrap placeholder; nothing to publish.");
		return { published: [], states };
	}
	if (!interactive) {
		throw new Error("--publish requires an interactive terminal for npm authentication");
	}

	const whoamiArgs = ["whoami", `--registry=${NPM_REGISTRY}`];
	const whoami = run(whoamiArgs);
	if (whoami.error || whoami.status !== 0 || !whoami.stdout?.trim()) {
		throw new Error(`npm authentication check failed. Run npm login interactively first. ${outputFrom(whoami)}`.trim());
	}
	log(`Authenticated to npm as ${whoami.stdout.trim()}.`);

	const root = mkdtempSync(join(tmpdir(), "volt-npm-bootstrap-"));
	const published = [];
	try {
		for (const { pkg } of absent) {
			const directory = writePlaceholderPackage(root, pkg);
			const publishArgs = [
				"publish",
				"--access",
				"public",
				"--tag",
				PLACEHOLDER_TAG,
				"--ignore-scripts",
				`--registry=${NPM_REGISTRY}`,
			];
			log(`Publishing ${pkg.name}@${PLACEHOLDER_VERSION} with dist-tag ${PLACEHOLDER_TAG}...`);
			const result = run(publishArgs, { cwd: directory, disableProvenance: true, interactive: true });
			if (result.error || result.status !== 0) throw commandFailure(publishArgs, result);
			if (inspectBootstrapPackage(pkg, run).state !== "placeholder") {
				throw new Error(`${pkg.name} was not visible as the exact placeholder after npm publish`);
			}
			published.push(pkg.name);
		}
	} finally {
		rmSync(root, { force: true, recursive: true });
	}

	log("Bootstrap reservations verified. No beta or latest dist-tag was created.");
	return { published, states };
}

function usage() {
	return "Usage: node scripts/bootstrap-npm-packages.mjs [--publish]";
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes("--help")) {
		if (args.length !== 1) throw new Error(usage());
		process.stdout.write(`${usage()}\n\nWithout --publish, the command only checks package availability and existing placeholders.\n`);
		return;
	}
	if (args.some((arg) => arg !== "--publish") || args.filter((arg) => arg === "--publish").length > 1) {
		throw new Error(usage());
	}
	bootstrapNpmPackages({ publish: args.includes("--publish") });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`npm package bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
