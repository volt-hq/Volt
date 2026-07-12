import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BOOTSTRAP_PACKAGE_IDENTITIES,
	NPM_REGISTRY,
	PLACEHOLDER_TAG,
	PLACEHOLDER_VERSION,
	bootstrapNpmPackages,
	expectedPlaceholderManifest,
	inspectBootstrapPackage,
} from "./bootstrap-npm-packages.mjs";

function result(status, stdout = "", stderr = "") {
	return { status, stdout, stderr };
}

function expectedQueryResult(pkg, args) {
	if (args[0] === "view" && args[1] === `${pkg.name}@${PLACEHOLDER_VERSION}`) {
		return result(
			0,
			JSON.stringify({
				...expectedPlaceholderManifest(pkg),
				versions: PLACEHOLDER_VERSION,
				"dist-tags": { [PLACEHOLDER_TAG]: PLACEHOLDER_VERSION },
			}),
		);
	}
	if (args[0] === "pack") {
		return result(0, JSON.stringify([{ files: [{ path: "LICENSE" }, { path: "README.md" }, { path: "package.json" }] }]));
	}
	throw new Error(`Unexpected npm command: ${args.join(" ")}`);
}

test("bootstrap package inspection accepts only the exact placeholder", () => {
	const pkg = BOOTSTRAP_PACKAGE_IDENTITIES[0];
	assert.deepEqual(inspectBootstrapPackage(pkg, (args) => expectedQueryResult(pkg, args)), { state: "placeholder" });
	assert.deepEqual(inspectBootstrapPackage(pkg, () => result(1, "", "npm error code E404")), { state: "absent" });

	assert.throws(
		() =>
			inspectBootstrapPackage(pkg, (args) => {
				if (args[0] === "view") {
					return result(
						0,
						JSON.stringify({
							...expectedPlaceholderManifest(pkg),
							versions: [PLACEHOLDER_VERSION, "0.1.0"],
							"dist-tags": { bootstrap: PLACEHOLDER_VERSION },
						}),
					);
				}
				return expectedQueryResult(pkg, args);
			}),
		/unexpected versions/,
	);
	assert.throws(
		() =>
			inspectBootstrapPackage(pkg, (args) => {
				if (args[0] === "view") {
					return result(
						0,
						JSON.stringify({
							...expectedPlaceholderManifest(pkg),
							versions: PLACEHOLDER_VERSION,
							"dist-tags": { bootstrap: PLACEHOLDER_VERSION, latest: PLACEHOLDER_VERSION },
						}),
					);
				}
				return expectedQueryResult(pkg, args);
			}),
		/unexpected dist-tags/,
	);
	assert.throws(
		() => inspectBootstrapPackage(pkg, () => result(1, "", "registry unavailable")),
		/registry unavailable/,
	);
	assert.throws(
		() =>
			inspectBootstrapPackage(pkg, (args) => {
				if (args[0] === "view" && args[1].includes(`@${PLACEHOLDER_VERSION}`)) return result(1, "", "npm error code E404");
				return result(0, "");
			}),
		/exists but does not contain the exact Volt bootstrap placeholder/,
	);
	assert.throws(
		() =>
			inspectBootstrapPackage(pkg, (args) => {
				if (args[0] === "view") {
					return result(
						0,
						JSON.stringify({
							...expectedPlaceholderManifest(pkg),
							scripts: { postinstall: "malicious-command" },
							versions: PLACEHOLDER_VERSION,
							"dist-tags": { bootstrap: PLACEHOLDER_VERSION },
						}),
					);
				}
				return expectedQueryResult(pkg, args);
			}),
		/unexpectedly defines scripts/,
	);
});

test("bootstrap defaults to a read-only preflight", () => {
	const commands = [];
	const run = (args) => {
		commands.push(args);
		return result(1, "", "npm error code E404");
	};
	const outcome = bootstrapNpmPackages({ run, log: () => {} });
	assert.deepEqual(outcome.published, []);
	assert.equal(commands.length, BOOTSTRAP_PACKAGE_IDENTITIES.length * 2);
	assert.ok(commands.every((args) => args[0] === "view"));
	for (let index = 0; index < commands.length; index += 2) {
		assert.equal(commands[index][1], `${BOOTSTRAP_PACKAGE_IDENTITIES[index / 2].name}@${PLACEHOLDER_VERSION}`);
		assert.equal(commands[index + 1][1], BOOTSTRAP_PACKAGE_IDENTITIES[index / 2].name);
	}
});

test("explicit bootstrap publishes minimal placeholders in dependency order and verifies each one", () => {
	const published = new Set();
	const publishCalls = [];
	const run = (args, options = {}) => {
		if (args[0] === "whoami") return result(0, "hansjm10\n");
		if (args[0] === "publish") {
			assert.equal(options.interactive, true);
			assert.equal(options.disableProvenance, true);
			assert.ok(options.cwd.startsWith(join(tmpdir(), "volt-npm-bootstrap-")));
			const manifest = JSON.parse(readFileSync(`${options.cwd}/package.json`, "utf8"));
			assert.deepEqual(manifest, expectedPlaceholderManifest(BOOTSTRAP_PACKAGE_IDENTITIES[publishCalls.length]));
			assert.match(readFileSync(`${options.cwd}/README.md`, "utf8"), /only reserves the npm name/);
			assert.equal(readFileSync(`${options.cwd}/LICENSE`, "utf8"), readFileSync("LICENSE", "utf8"));
			assert.ok(args.includes("--access") && args.includes("public"));
			assert.ok(args.includes("--tag") && args.includes(PLACEHOLDER_TAG));
			assert.ok(args.includes("--ignore-scripts"));
			assert.ok(args.includes(`--registry=${NPM_REGISTRY}`));
			assert.ok(!args.some((arg) => arg.includes("provenance") || arg === "beta" || arg === "latest"));
			publishCalls.push(manifest.name);
			published.add(manifest.name);
			return result(0);
		}

		const name = args[1].split(`@${PLACEHOLDER_VERSION}`)[0];
		const pkg = BOOTSTRAP_PACKAGE_IDENTITIES.find((candidate) => candidate.name === name);
		if (!pkg) throw new Error(`Unexpected package query: ${args.join(" ")}`);
		if (!published.has(pkg.name)) return result(1, "", "npm error code E404");
		return expectedQueryResult(pkg, args);
	};

	const outcome = bootstrapNpmPackages({ publish: true, interactive: true, run, log: () => {} });
	assert.deepEqual(
		publishCalls,
		BOOTSTRAP_PACKAGE_IDENTITIES.map(({ name }) => name),
	);
	assert.deepEqual(outcome.published, publishCalls);
});

test("explicit bootstrap requires a TTY before publishing", () => {
	assert.throws(
		() => bootstrapNpmPackages({ publish: true, interactive: false, run: () => result(1, "", "npm error code E404"), log: () => {} }),
		/requires an interactive terminal/,
	);
});

test("explicit bootstrap rejects a successful publish that is not visible for verification", () => {
	const run = (args) => {
		if (args[0] === "whoami") return result(0, "hansjm10\n");
		if (args[0] === "publish") return result(0);
		return result(1, "", "npm error code E404");
	};
	assert.throws(
		() => bootstrapNpmPackages({ publish: true, interactive: true, run, log: () => {} }),
		/was not visible as the exact placeholder/,
	);
});
