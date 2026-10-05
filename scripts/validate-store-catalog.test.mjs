import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkCatalog, checkPackage, escapeForLog, fetchPinnedPackage, isOnBranch } from "./validate-store-catalog.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NEXT_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

function entry(overrides = {}, commit = COMMIT) {
	return {
		id: "rtk",
		name: "RTK Output Compression",
		description: "Token optimized shell output",
		version: "0.2.0",
		source: `git:https://github.com/volt-hq/Volt@${commit}`,
		repo: "https://github.com/volt-hq/Volt/tree/store/rtk",
		permissions: ["exec"],
		review: { commit, reviewer: "hansjm10", date: "2026-10-05", notes: "Manifest only." },
		author: "Volt",
		license: "MIT",
		categories: ["shell"],
		resources: ["extensions"],
		...overrides,
	};
}

function catalog(...packages) {
	return JSON.stringify({ schemaVersion: 2, packages });
}

function reviewed(pkg, review) {
	return { ...pkg, review: { ...pkg.review, ...review } };
}

test("a catalog without changed pins passes", () => {
	const raw = catalog(entry());
	const result = checkCatalog(raw, raw, "2026-10-06");
	assert.deepEqual(result.problems, []);
	assert.deepEqual([...result.changed], []);
	assert.equal(result.catalog.packages.length, 1);
});

test("an entry the client would skip fails the check", () => {
	const result = checkCatalog(catalog({ ...entry(), verified: true }), undefined, "2026-10-06");
	assert.equal(result.problems.length, 1);
	assert.match(result.problems[0], /"verified" is not a recognized field/);
});

test("a v1 catalog fails the check", () => {
	const result = checkCatalog(JSON.stringify({ schemaVersion: 1, packages: [] }), undefined, "2026-10-06");
	assert.deepEqual(result.problems, ["Store catalog schemaVersion must be 2"]);
	assert.equal(result.catalog, undefined);
});

test("a new entry or an entry repinned from a v1 base counts as a new pin", () => {
	const base = JSON.stringify({ schemaVersion: 1, packages: [{ id: "rtk", source: "git:https://github.com/volt-hq/Volt@old" }] });
	const result = checkCatalog(catalog(entry(), entry({ id: "other" })), base, "2026-10-06");
	assert.deepEqual(result.problems, []);
	assert.deepEqual([...result.changed].sort(), ["other", "rtk"]);
});

test("a changed pin needs a new review record", () => {
	const base = catalog(entry());
	assert.match(
		checkCatalog(catalog(entry({}, NEXT_COMMIT)), base, "2026-10-06").problems.join("\n"),
		/rtk: the pin changed, but its review notes repeat an earlier review's/,
	);
	const backdated = reviewed(entry({}, NEXT_COMMIT), { date: "2026-10-01", notes: "Reviewed the fix." });
	assert.match(
		checkCatalog(catalog(backdated), base, "2026-10-06").problems.join("\n"),
		/review.date 2026-10-01 is older than the previous review \(2026-10-05\)/,
	);
	const fresh = reviewed(entry({}, NEXT_COMMIT), { date: "2026-10-06", notes: "Reviewed the fix." });
	assert.deepEqual(checkCatalog(catalog(fresh), base, "2026-10-06").problems, []);
});

test("a renamed entry cannot reuse another entry's review notes", () => {
	const base = catalog(entry());
	const renamed = entry({ id: "rtk-two" }, NEXT_COMMIT);
	assert.match(
		checkCatalog(catalog(renamed), base, "2026-10-06").problems.join("\n"),
		/rtk-two: the pin changed, but its review notes repeat an earlier review's/,
	);
});

test("the repo link must point into the pinned repository after URL normalization", () => {
	for (const repo of [
		"https://github.com/someone/else",
		"https://github.com/volt-hq/Volt-evil",
		"https://github.com/volt-hq/Volt/../../attacker/evil",
		"https://github.com/volt-hq/Volt/%2e%2e/%2e%2e/attacker/evil",
		"https://gitlab.com/volt-hq/Volt",
	]) {
		const result = checkCatalog(catalog(entry({ repo })), undefined, "2026-10-06");
		assert.deepEqual(result.problems, [`rtk: repo ${repo} is not a link into https://github.com/volt-hq/Volt`], repo);
	}
	for (const repo of ["https://github.com/volt-hq/Volt", "https://github.com/Volt-HQ/volt/tree/store/rtk"]) {
		assert.deepEqual(checkCatalog(catalog(entry({ repo })), undefined, "2026-10-06").problems, [], repo);
	}
});

test("a review dated in the future fails", () => {
	const result = checkCatalog(catalog(entry()), undefined, "2026-10-04");
	assert.deepEqual(result.problems, ["rtk: review.date 2026-10-05 is in the future"]);
});

test("log lines escape control and bidirectional characters", () => {
	assert.equal(escapeForLog("a\n::error::forged\u001b[31m\u202e"), "a\\u000a::error::forged\\u001b[31m\\u202e");
});

let tempDir;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "volt-validate-store-catalog-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writePackage(packageJson, files = {}) {
	writeFileSync(join(tempDir, "package.json"), JSON.stringify(packageJson));
	const all = { "package.json": JSON.stringify(packageJson), ...files };
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(tempDir, path, ".."), { recursive: true });
		writeFileSync(join(tempDir, path), content);
	}
	return {
		dir: tempDir,
		files: Object.entries(all).map(([path, content]) => ({ path, mode: "100644", content: Buffer.from(content) })),
	};
}

const manifest = {
	id: "rtk",
	displayName: "RTK Output Compression",
	entry: "extensions/rtk.ts",
	permissions: ["exec"],
};

test("a package that matches its entry passes", () => {
	const pkg = writePackage({ name: "volt-rtk", version: "0.2.0", volt: manifest }, { "extensions/rtk.ts": "" });
	assert.deepEqual(checkPackage(entry(), pkg), []);
});

test("the manifest, version, permissions, and resources must match the entry", () => {
	const pkg = writePackage(
		{
			name: "volt-rtk",
			version: "0.1.0",
			volt: { ...manifest, id: "rtk-two", displayName: "RTK", permissions: ["exec", "network"], skills: ["skills"] },
		},
		{ "extensions/rtk.ts": "" },
	);
	assert.deepEqual(checkPackage(entry(), pkg), [
		"manifest id rtk-two is not the catalog id rtk",
		'manifest displayName "RTK" is not the catalog name "RTK Output Compression"',
		"package version 0.1.0 is not the catalog version 0.2.0",
		"manifest permissions [exec, network] are not the catalog permissions [exec]",
		"package resources [extensions, skills] are not the catalog resources [extensions]",
	]);
});

test("a package without a valid manifest fails", () => {
	const old = writePackage({ name: "volt-rtk", version: "0.2.0", volt: { extensions: ["extensions/rtk.ts"] } });
	assert.match(checkPackage(entry(), old).join("\n"), /invalid manifest: "volt.extensions" is replaced/);
	const none = writePackage({ name: "volt-rtk", version: "0.2.0" });
	assert.match(checkPackage(entry(), none).join("\n"), /package.json declares no extension/);
	const escaping = writePackage({ name: "volt-rtk", version: "0.2.0", volt: { ...manifest, entry: "../x.ts" } });
	assert.match(checkPackage(entry(), escaping).join("\n"), /invalid manifest: "entry" must be a relative path/);
});

test("references to @earendil-works modules fail", () => {
	const pkg = writePackage(
		{ name: "volt-rtk", version: "0.2.0", volt: manifest },
		{ "extensions/rtk.ts": 'import type { ExtensionAPI } from "@earendil-works/volt-coding-agent";\n' },
	);
	assert.deepEqual(checkPackage(entry(), pkg), [
		"extensions/rtk.ts refers to @earendil-works/*; use the @hansjm10/* modules Volt serves",
	]);
});

test("a tree a checkout could change fails before its manifest is read", () => {
	const pkg = writePackage({ name: "volt-rtk", version: "0.2.0", volt: manifest }, { "extensions/rtk.ts": "" });
	pkg.files.push(
		{ path: "vendor/lib", mode: "160000", content: Buffer.alloc(0) },
		{ path: "link.ts", mode: "120000", content: Buffer.from("/dev/zero") },
		{ path: "big.ts", mode: "100644", content: Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:00\n") },
		{ path: ".lfsconfig", mode: "100644", content: Buffer.from("[lfs]\n\turl = https://example.com/lfs\n") },
		{ path: ".gitattributes", mode: "100644", content: Buffer.from("*.ts filter=lfs diff=lfs merge=lfs\n") },
		{ path: "Extensions/RTK.ts", mode: "100644", content: Buffer.alloc(0) },
	);
	assert.deepEqual(checkPackage(entry(), pkg), [
		"vendor/lib is a submodule; store packages contain their files",
		"link.ts is a symbolic link; store packages contain plain files",
		"big.ts uses Git LFS; store packages contain their files",
		".lfsconfig uses Git LFS; store packages contain their files",
		".gitattributes assigns a filter; a checkout must not depend on local filters",
		"Extensions/RTK.ts and extensions/rtk.ts differ only in case",
	]);
});

function lockfile(packages, overrides = {}) {
	return JSON.stringify({
		name: "volt-rtk",
		version: "0.2.0",
		lockfileVersion: 3,
		requires: true,
		packages: { "": { name: "volt-rtk", version: "0.2.0", dependencies: { leftpad: "1.0.0" } }, ...packages },
		...overrides,
	});
}

const lockedLeftpad = {
	"node_modules/leftpad": {
		version: "1.0.0",
		resolved: "https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz",
		integrity: "sha512-abc",
	},
};

test("dependencies must be locked to registry tarballs with integrity", () => {
	const packageJson = { name: "volt-rtk", version: "0.2.0", volt: manifest, dependencies: { leftpad: "1.0.0" } };
	const locked = writePackage(packageJson, { "extensions/rtk.ts": "", "package-lock.json": lockfile(lockedLeftpad) });
	assert.deepEqual(checkPackage(entry(), locked), []);

	const unlocked = writePackage(packageJson, { "extensions/rtk.ts": "" });
	assert.deepEqual(checkPackage(entry(), unlocked), [
		"package.json has dependencies but no package-lock.json; lock them at the pinned commit",
	]);

	const stale = writePackage(
		{ ...packageJson, dependencies: { leftpad: "2.0.0" } },
		{ "extensions/rtk.ts": "", "package-lock.json": lockfile(lockedLeftpad, { lockfileVersion: 2 }) },
	);
	assert.deepEqual(checkPackage(entry(), stale), [
		"package-lock.json must be lockfileVersion 3",
		"package-lock.json does not lock package.json's dependencies; refresh it",
	]);

	const offRegistry = writePackage(packageJson, {
		"extensions/rtk.ts": "",
		"package-lock.json": lockfile({
			"node_modules/leftpad": { version: "1.0.0", resolved: "git+https://example.com/leftpad.git#abc" },
			"node_modules/other": { version: "1.0.0", resolved: "https://registry.npmjs.org/other/-/other-1.0.0.tgz" },
		}),
	});
	assert.deepEqual(checkPackage(entry(), offRegistry), [
		"package-lock.json node_modules/leftpad does not resolve from https://registry.npmjs.org/",
		"package-lock.json node_modules/other has no sha512 integrity",
	]);
});

test("fetching refuses hosts off the allowlist before running git", () => {
	const pin = { host: "example.com", path: "a/b", repo: "https://example.com/a/b", commit: COMMIT };
	assert.throws(() => fetchPinnedPackage(pin, join(tempDir, "package")), /host example.com is not allowlisted/);
	assert.throws(() => isOnBranch(pin, join(tempDir, "branches")), /host example.com is not allowlisted/);
});
