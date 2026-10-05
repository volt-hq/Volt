import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkCatalog, checkPackage, fetchPinnedPackage, isOnBranch } from "./validate-store-catalog.mjs";

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
	const copied = entry({}, NEXT_COMMIT);
	assert.match(
		checkCatalog(catalog(copied), base, "2026-10-06").problems.join("\n"),
		/rtk: the pin changed, but the review notes are the previous review's/,
	);
	const backdated = entry({}, NEXT_COMMIT);
	backdated.review = { ...backdated.review, date: "2026-10-01", notes: "Reviewed the fix." };
	assert.match(
		checkCatalog(catalog(backdated), base, "2026-10-06").problems.join("\n"),
		/review.date 2026-10-01 is older than the previous review \(2026-10-05\)/,
	);
	const reviewed = entry({}, NEXT_COMMIT);
	reviewed.review = { ...reviewed.review, date: "2026-10-06", notes: "Reviewed the fix." };
	assert.deepEqual(checkCatalog(catalog(reviewed), base, "2026-10-06").problems, []);
});

test("the repo link must point into the pinned repository", () => {
	const result = checkCatalog(catalog(entry({ repo: "https://github.com/someone/else" })), undefined, "2026-10-06");
	assert.deepEqual(result.problems, [
		"rtk: repo https://github.com/someone/else is not a link into https://github.com/volt-hq/Volt",
	]);
	const prefix = checkCatalog(catalog(entry({ repo: "https://github.com/volt-hq/Volt-evil" })), undefined, "2026-10-06");
	assert.equal(prefix.problems.length, 1);
});

test("a review dated in the future fails", () => {
	const result = checkCatalog(catalog(entry()), undefined, "2026-10-04");
	assert.deepEqual(result.problems, ["rtk: review.date 2026-10-05 is in the future"]);
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

test("references to @earendil-works modules and submodules fail", () => {
	const pkg = writePackage(
		{ name: "volt-rtk", version: "0.2.0", volt: manifest },
		{ "extensions/rtk.ts": 'import type { ExtensionAPI } from "@earendil-works/volt-coding-agent";\n' },
	);
	pkg.files.push({ path: "vendor/lib", mode: "160000", content: Buffer.alloc(0) });
	assert.deepEqual(checkPackage(entry(), pkg), [
		"extensions/rtk.ts refers to @earendil-works/*; use the @hansjm10/* modules Volt serves",
		"vendor/lib is a submodule; store packages must contain their files",
	]);
});

test("fetching refuses hosts off the allowlist before running git", () => {
	const pin = { host: "example.com", path: "a/b", repo: "https://example.com/a/b", commit: COMMIT };
	assert.throws(() => fetchPinnedPackage(pin, join(tempDir, "package")), /host example.com is not allowlisted/);
	assert.throws(() => isOnBranch(pin, join(tempDir, "branches")), /host example.com is not allowlisted/);
});
