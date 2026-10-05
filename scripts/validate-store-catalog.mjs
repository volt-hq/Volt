#!/usr/bin/env node
/**
 * Validate the store catalog against the packages it pins (RFC §8.4).
 *
 * The catalog parses as schema version 2 without warnings, every review date
 * has passed, every repo link points into the pinned repository, and an entry
 * whose pin is new or changed against the base catalog carries a new review
 * record. For every entry, the pinned commit:
 * - is fetched over HTTPS from an allowlisted host and is on a branch of its
 *   repository (a commit reachable only from a fork or a pull request ref is
 *   refused, though the host serves it by hash);
 * - declares a valid manifest whose id, display name, version, permissions,
 *   and resources match the entry;
 * - locks its dependencies: a version 3 package-lock.json whose root lists
 *   package.json's dependencies and whose packages resolve from the npm
 *   registry with sha512 integrity;
 * - contains its files as plain files: no submodules, symbolic links, Git LFS
 *   pointers or filters, or paths that differ only in case;
 * - has no file that refers to an `@earendil-works/` module.
 *
 * It reads packages as data and never runs their code: git fetches and checks
 * out the pinned commit with hooks, filters, credential helpers, and system
 * and global configuration off, and nothing is installed.
 *
 * Usage: node --conditions=volt-source scripts/validate-store-catalog.mjs [--catalog <path>] [--base-ref <rev>]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readPackageManifest } from "../packages/coding-agent/src/core/extensions/manifest.ts";
import {
	getCatalogPackagePin,
	STORE_CATALOG_GIT_HOSTS,
	validateStoreCatalog,
} from "../packages/coding-agent/src/store/catalog.ts";

export const CATALOG_PATH = "site/public/store/catalog.json";
const FORBIDDEN_MODULE_PREFIX = "@earendil-works/";
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/";
const NPM_REGISTRY = "https://registry.npmjs.org/";
const GIT_TIMEOUT_MS = 120_000;
const RESOURCE_KEYS = ["skills", "prompts", "themes"];
// Git options for untrusted repositories: HTTPS only, no hooks, no credential helpers.
const GIT_SAFE_CONFIG = [
	"-c",
	"protocol.allow=never",
	"-c",
	"protocol.https.allow=always",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"credential.helper=",
];
// No system or global configuration (so no filter drivers, LFS, or URL rewrites), no prompts, no lazy fetches.
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_LFS_SKIP_SMUDGE: "1",
	GIT_TERMINAL_PROMPT: "0",
	GIT_NO_LAZY_FETCH: "1",
};

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Text for the CI log with control and bidirectional characters escaped, so package data cannot forge log lines. */
export function escapeForLog(text) {
	return String(text).replace(
		/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function git(args, options = {}) {
	return execFileSync("git", [...GIT_SAFE_CONFIG, ...args], {
		encoding: options.encoding ?? "utf8",
		env: GIT_ENV,
		maxBuffer: 512 * 1024 * 1024,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
		...(options.input !== undefined ? { input: options.input } : {}),
	});
}

/** The latest review date accepted: tomorrow in UTC, so a reviewer ahead of UTC can date a review today. */
function latestReviewDate() {
	return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The base catalog's entries by id, read leniently: the base may predate this schema or be absent. */
function readBaseEntries(baseRaw) {
	const entries = new Map();
	if (baseRaw === undefined) return entries;
	let base;
	try {
		base = JSON.parse(baseRaw);
	} catch {
		return entries;
	}
	if (!isRecord(base) || !Array.isArray(base.packages)) return entries;
	for (const entry of base.packages) {
		if (isRecord(entry) && typeof entry.id === "string") entries.set(entry.id, entry);
	}
	return entries;
}

/** Whether `link` is the repository at `pin` or a page inside it, after URL normalization. */
function linksIntoRepository(link, pin) {
	const url = new URL(link);
	const path = url.pathname.toLowerCase().replace(/\/+$/, "");
	const repository = `/${pin.path.toLowerCase()}`;
	return url.host === pin.host && (path === repository || path.startsWith(`${repository}/`));
}

/**
 * Check the catalog itself: it parses without warnings, every review date has
 * passed, every repo link points into its repository, and an entry whose pin
 * is new or changed against the base carries a new review record: dated no
 * earlier than the entry's previous review, with notes no earlier review has.
 */
export function checkCatalog(raw, baseRaw, latestDate = latestReviewDate()) {
	const problems = [];
	let catalog;
	try {
		const result = validateStoreCatalog(JSON.parse(raw));
		catalog = result.catalog;
		problems.push(...result.warnings);
	} catch (error) {
		problems.push(error instanceof Error ? error.message : String(error));
		return { catalog: undefined, changed: new Set(), problems };
	}
	const baseEntries = readBaseEntries(baseRaw);
	const baseNotes = new Set(
		[...baseEntries.values()].map((entry) => (isRecord(entry.review) ? entry.review.notes : undefined)),
	);
	const changed = new Set();
	for (const entry of catalog.packages) {
		if (entry.review.date > latestDate) {
			problems.push(`${entry.id}: review.date ${entry.review.date} is in the future`);
		}
		const pin = getCatalogPackagePin(entry);
		if (!linksIntoRepository(entry.repo, pin)) {
			problems.push(`${entry.id}: repo ${entry.repo} is not a link into ${pin.repo}`);
		}
		const base = baseEntries.get(entry.id);
		if (base?.source === entry.source) continue;
		changed.add(entry.id);
		if (baseNotes.has(entry.review.notes)) {
			problems.push(`${entry.id}: the pin changed, but its review notes repeat an earlier review's; review the new commit`);
		}
		const baseDate = isRecord(base?.review) ? base.review.date : undefined;
		if (typeof baseDate === "string" && entry.review.date < baseDate) {
			problems.push(
				`${entry.id}: the pin changed, but review.date ${entry.review.date} is older than the previous review (${baseDate})`,
			);
		}
	}
	return { catalog, changed, problems };
}

function sameSet(left, right) {
	const a = [...new Set(left)].sort();
	const b = [...new Set(right)].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameRecord(left, right) {
	const a = Object.entries(left ?? {}).sort(([x], [y]) => x.localeCompare(y));
	const b = Object.entries(right ?? {}).sort(([x], [y]) => x.localeCompare(y));
	return JSON.stringify(a) === JSON.stringify(b);
}

/** What could make a checkout differ from the reviewed tree, or differ between machines. */
function checkoutHazards(files) {
	const problems = [];
	const seen = new Map();
	for (const file of files) {
		const folded = file.path.toLowerCase();
		if (seen.has(folded)) {
			problems.push(`${file.path} and ${seen.get(folded)} differ only in case`);
		}
		seen.set(folded, file.path);
		if (file.mode === "160000") {
			problems.push(`${file.path} is a submodule; store packages contain their files`);
			continue;
		}
		if (file.mode === "120000") {
			problems.push(`${file.path} is a symbolic link; store packages contain plain files`);
			continue;
		}
		const name = basename(file.path);
		if (name === ".lfsconfig" || file.content.subarray(0, LFS_POINTER_PREFIX.length).toString() === LFS_POINTER_PREFIX) {
			problems.push(`${file.path} uses Git LFS; store packages contain their files`);
		}
		if (name === ".gitattributes" && /\bfilter=/.test(file.content.toString("utf8"))) {
			problems.push(`${file.path} assigns a filter; a checkout must not depend on local filters`);
		}
	}
	return problems;
}

/** Problems with how the package locks its dependencies; none when it has none. */
function checkLockfile(packageJson, files) {
	if (Object.keys({ ...packageJson.dependencies, ...packageJson.optionalDependencies }).length === 0) return [];
	const lockfile = files.find((file) => file.path === "package-lock.json");
	if (lockfile === undefined) {
		return ["package.json has dependencies but no package-lock.json; lock them at the pinned commit"];
	}
	let lock;
	try {
		lock = JSON.parse(lockfile.content.toString("utf8"));
	} catch {
		return ["package-lock.json is not JSON"];
	}
	const problems = [];
	if (lock.lockfileVersion !== 3) problems.push("package-lock.json must be lockfileVersion 3");
	const packages = isRecord(lock.packages) ? lock.packages : {};
	const root = isRecord(packages[""]) ? packages[""] : {};
	if (
		!sameRecord(root.dependencies, packageJson.dependencies) ||
		!sameRecord(root.optionalDependencies, packageJson.optionalDependencies)
	) {
		problems.push("package-lock.json does not lock package.json's dependencies; refresh it");
	}
	for (const [path, entry] of Object.entries(packages)) {
		if (path === "") continue;
		if (!isRecord(entry) || typeof entry.resolved !== "string" || !entry.resolved.startsWith(NPM_REGISTRY)) {
			problems.push(`package-lock.json ${path} does not resolve from ${NPM_REGISTRY}`);
		} else if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
			problems.push(`package-lock.json ${path} has no sha512 integrity`);
		}
	}
	return problems;
}

/**
 * Check one fetched package against its catalog entry. `pkg` is
 * `{ dir, files: [{ path, mode, content }] }`: the pinned commit checked out at
 * `dir`, and every entry of its tree with the blob contents.
 */
export function checkPackage(entry, pkg) {
	const hazards = checkoutHazards(pkg.files);
	if (hazards.length > 0) return hazards;
	const problems = pkg.files
		.filter((file) => file.content.includes(FORBIDDEN_MODULE_PREFIX))
		.map((file) => `${file.path} refers to ${FORBIDDEN_MODULE_PREFIX}*; use the @hansjm10/* modules Volt serves`);
	let declared;
	try {
		declared = readPackageManifest(pkg.dir);
	} catch (error) {
		problems.push(`invalid manifest: ${error instanceof Error ? error.message : String(error)}`);
		return problems;
	}
	if (declared === undefined) {
		problems.push(`package.json declares no extension; store packages declare one with a "volt" manifest`);
		return problems;
	}
	const { manifest, version } = declared;
	if (manifest.id !== entry.id) problems.push(`manifest id ${manifest.id} is not the catalog id ${entry.id}`);
	if (manifest.displayName !== entry.name) {
		problems.push(`manifest displayName "${manifest.displayName}" is not the catalog name "${entry.name}"`);
	}
	if (version !== entry.version) problems.push(`package version ${version} is not the catalog version ${entry.version}`);
	const permissions = manifest.permissions ?? [];
	if (!sameSet(permissions, entry.permissions)) {
		problems.push(
			`manifest permissions [${permissions.join(", ")}] are not the catalog permissions [${entry.permissions.join(", ")}]`,
		);
	}
	const packageJson = JSON.parse(readFileSync(join(pkg.dir, "package.json"), "utf8"));
	const resources = ["extensions", ...RESOURCE_KEYS.filter((key) => packageJson.volt[key] !== undefined)];
	if (!sameSet(resources, entry.resources)) {
		problems.push(`package resources [${resources.join(", ")}] are not the catalog resources [${entry.resources.join(", ")}]`);
	}
	problems.push(...checkLockfile(packageJson, pkg.files));
	return problems;
}

/** Fetch the pinned commit into `dir` and read its tree. */
export function fetchPinnedPackage(pin, dir) {
	if (!STORE_CATALOG_GIT_HOSTS.includes(pin.host)) throw new Error(`host ${pin.host} is not allowlisted`);
	git(["init", "--quiet", dir]);
	git(["-C", dir, "fetch", "--quiet", "--depth=1", "--no-tags", pin.repo, pin.commit]);
	const tree = git(["-C", dir, "ls-tree", "-r", "-z", "--full-tree", pin.commit])
		.split("\0")
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			const [mode, type, oid] = line.slice(0, tab).split(" ");
			return { mode, type, oid, path: line.slice(tab + 1) };
		});
	const blobs = tree.filter((entry) => entry.type === "blob");
	const contents = new Map();
	if (blobs.length > 0) {
		const output = git(["-C", dir, "cat-file", "--batch"], {
			input: Buffer.from(`${blobs.map((blob) => blob.oid).join("\n")}\n`),
			encoding: "buffer",
		});
		let offset = 0;
		for (const blob of blobs) {
			const headerEnd = output.indexOf(0x0a, offset);
			const size = Number(output.subarray(offset, headerEnd).toString("utf8").split(" ")[2]);
			contents.set(blob.path, output.subarray(headerEnd + 1, headerEnd + 1 + size));
			offset = headerEnd + 1 + size + 1;
		}
	}
	const files = tree.map((entry) => ({
		path: entry.path,
		mode: entry.mode,
		content: contents.get(entry.path) ?? Buffer.alloc(0),
	}));
	// Check out only a tree of plain files, so the manifest is read from what was scanned.
	if (checkoutHazards(files).length === 0) git(["-C", dir, "checkout", "--quiet", "--detach", pin.commit]);
	return { dir, files };
}

/** Whether the pinned commit is on a branch of its repository: a branch tip, or an ancestor of one. */
export function isOnBranch(pin, dir) {
	if (!STORE_CATALOG_GIT_HOSTS.includes(pin.host)) throw new Error(`host ${pin.host} is not allowlisted`);
	const heads = git(["ls-remote", "--heads", pin.repo]);
	if (heads.split("\n").some((line) => line.split("\t")[0] === pin.commit)) return true;
	// Fetch every branch's commits (no trees or blobs) and look for one that contains the pin.
	git(["init", "--quiet", "--bare", dir]);
	git(["-C", dir, "config", "remote.src.url", pin.repo]);
	git(["-C", dir, "config", "remote.src.promisor", "true"]);
	git(["-C", dir, "config", "remote.src.partialclonefilter", "tree:0"]);
	git(["-C", dir, "fetch", "--quiet", "--filter=tree:0", "--no-tags", "src", "+refs/heads/*:refs/remotes/src/*"]);
	try {
		git(["-C", dir, "cat-file", "-e", `${pin.commit}^{commit}`]);
	} catch {
		return false;
	}
	return git(["-C", dir, "for-each-ref", "--contains", pin.commit, "refs/remotes/src"]).trim() !== "";
}

/** The catalog at `baseRef`; undefined when that commit has none. Throws when `baseRef` names no commit. */
function readBaseCatalog(baseRef) {
	if (baseRef === undefined) return undefined;
	execFileSync("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { stdio: "ignore" });
	try {
		return execFileSync("git", ["show", `${baseRef}:${CATALOG_PATH}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

function parseArgs(argv) {
	const options = { catalog: CATALOG_PATH, baseRef: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = argv[index + 1];
		if ((arg === "--catalog" || arg === "--base-ref") && value !== undefined) {
			if (arg === "--catalog") options.catalog = value;
			else options.baseRef = value;
			index++;
		} else {
			throw new Error(`Usage: validate-store-catalog.mjs [--catalog <path>] [--base-ref <rev>] (unexpected ${arg})`);
		}
	}
	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const { catalog, changed, problems } = checkCatalog(readFileSync(options.catalog, "utf8"), readBaseCatalog(options.baseRef));
	for (const problem of problems) console.log(escapeForLog(`FAIL catalog: ${problem}`));
	let failures = problems.length;
	for (const entry of catalog?.packages ?? []) {
		const workDir = mkdtempSync(join(tmpdir(), "volt-store-catalog-"));
		const entryProblems = [];
		try {
			const pin = getCatalogPackagePin(entry);
			if (!isOnBranch(pin, join(workDir, "branches"))) {
				entryProblems.push(`${pin.commit} is not on a branch of ${pin.repo}`);
			}
			entryProblems.push(...checkPackage(entry, fetchPinnedPackage(pin, join(workDir, "package"))));
		} catch (error) {
			entryProblems.push(error instanceof Error ? error.message.trim() : String(error));
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
		const label = `${entry.id} ${entry.version} @ ${entry.review.commit.slice(0, 12)}${changed.has(entry.id) ? " (new pin)" : ""}`;
		if (entryProblems.length === 0) {
			console.log(
				escapeForLog(`ok   ${label}: [${entry.permissions.join(", ")}] reviewed by ${entry.review.reviewer} on ${entry.review.date}`),
			);
		}
		for (const problem of entryProblems) console.log(escapeForLog(`FAIL ${label}: ${problem}`));
		failures += entryProblems.length;
	}
	console.log(failures === 0 ? "Store catalog: PASS" : `Store catalog: ${failures} problem(s)`);
	process.exitCode = failures === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main();
}
