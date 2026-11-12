import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ReviewSnapshot,
	type ReviewSnapshotSearchMatch,
	type ReviewSnapshotSearchOptions,
	resolveReviewSnapshot,
} from "../src/core/review-snapshot.ts";

import { createByteReviewRepository, BYTE_REVIEW_PATHS as P } from "./utilities/byte-review-repository.ts";

const OPTIONS = { maxCommitRefBytes: 1_024, maxPullRequestNumber: 2_147_483_647 };

function run(cwd: string, command: string, ...args: string[]): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function git(cwd: string, ...args: string[]): string {
	return run(cwd, "git", ...args);
}

function gitWithInput(cwd: string, input: string | Buffer, ...args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		input,
		maxBuffer: 32 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

function writeFixture(repository: string, path: string, content: string | Buffer): void {
	mkdirSync(dirname(join(repository, path)), { recursive: true });
	writeFileSync(join(repository, path), content);
}

async function resolveSnapshot(
	repository: string,
	limits?: NonNullable<Parameters<typeof resolveReviewSnapshot>[2]["limits"]>,
	target: Parameters<typeof resolveReviewSnapshot>[0] = { kind: "uncommitted" },
): Promise<ReviewSnapshot> {
	const result = await resolveReviewSnapshot(target, repository, limits ? { ...OPTIONS, limits } : OPTIONS);
	if ("error" in result) throw new Error(result.error);
	return result;
}

function locations(matches: ReviewSnapshotSearchMatch[]): string[] {
	return matches.map((match) => `${match.path}:${match.line}`);
}

/**
 * Put a `git` ahead of the real one on `PATH` that logs its arguments and, for `git grep`, obeys the mode file:
 * `fail-once` fails that one command, and `delay` waits before running it. It logs `term` when it is asked to stop.
 */
function installGitShim(directory: string, realGit: string, modeFile: string, logFile: string): void {
	const source = join(directory, "fake-git.mjs");
	writeFileSync(
		source,
		`import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, "args " + JSON.stringify(args) + "\\n");
const mode = existsSync(${JSON.stringify(modeFile)}) ? readFileSync(${JSON.stringify(modeFile)}, "utf8").trim() : "";
let terminating = false;
process.on("SIGTERM", () => {
	if (terminating) return;
	terminating = true;
	appendFileSync(${JSON.stringify(logFile)}, "term\\n");
	setTimeout(() => {
		appendFileSync(${JSON.stringify(logFile)}, "term-done\\n");
		process.exit(143);
	}, 100);
});
if (args[0] === "grep" && mode === "fail-once") {
	rmSync(${JSON.stringify(modeFile)}, { force: true });
	process.stderr.write("injected grep failure\\n");
	process.exit(2);
}
if (args[0] === "grep" && mode === "delay") await delay(500);
if (!terminating) {
	const child = spawn(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
	child.once("error", (error) => {
		process.stderr.write(error.message + "\\n");
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		// Git stopped by a signal means this process is being stopped too: let its own handler log that and exit.
		if (signal) setTimeout(() => process.exit(1), 2000);
		else process.exit(code ?? 1);
	});
}
`,
	);
	if (process.platform === "win32") {
		writeFileSync(
			join(directory, "git.cmd"),
			`@echo off\r\n"${process.execPath}" "${source}" %*\r\nexit /b %errorlevel%\r\n`,
		);
		return;
	}
	const executable = join(directory, "git");
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${source}" "$@"\n`);
	chmodSync(executable, 0o755);
}

function readShimArgs(logFile: string): string[][] {
	if (!existsSync(logFile)) return [];
	return readFileSync(logFile, "utf8")
		.split("\n")
		.filter((line) => line.startsWith("args "))
		.map((line) => JSON.parse(line.slice(5)) as unknown)
		.filter((value): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

async function waitForShimArgs(logFile: string, predicate: (args: string[]) => boolean): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (readShimArgs(logFile).some(predicate)) return;
		await delay(10);
	}
	throw new Error("Timed out waiting for the Git shim command.");
}

function grepPattern(args: string[]): string | undefined {
	if (args[0] !== "grep") return undefined;
	const patternIndex = args.indexOf("-e");
	return patternIndex < 0 ? undefined : args[patternIndex + 1];
}

describe("review snapshot search", () => {
	const directories: string[] = [];
	const snapshots: ReviewSnapshot[] = [];
	const initialPath = process.env.PATH;
	const initialGitLiteralPathspecs = process.env.GIT_LITERAL_PATHSPECS;
	const initialTmpdir = process.env.TMPDIR;
	const initialTemp = process.env.TEMP;
	const initialTmp = process.env.TMP;

	afterEach(async () => {
		for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (initialPath === undefined) delete process.env.PATH;
		else process.env.PATH = initialPath;
		if (initialGitLiteralPathspecs === undefined) delete process.env.GIT_LITERAL_PATHSPECS;
		else process.env.GIT_LITERAL_PATHSPECS = initialGitLiteralPathspecs;
		if (initialTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = initialTmpdir;
		if (initialTemp === undefined) delete process.env.TEMP;
		else process.env.TEMP = initialTemp;
		if (initialTmp === undefined) delete process.env.TMP;
		else process.env.TMP = initialTmp;
	});

	function createRepository(): string {
		const repository = join(tmpdir(), `volt-review-search-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(repository, { recursive: true });
		directories.push(repository);
		git(repository, "init", "--initial-branch=main");
		git(repository, "config", "user.email", "review@example.com");
		git(repository, "config", "user.name", "Review Test");
		git(repository, "config", "commit.gpgsign", "false");
		return repository;
	}

	/**
	 * A snapshot of uncommitted changes: `files` committed as the base, then `tracked.txt` changed in the worktree, so
	 * the files are in both trees.
	 */
	async function snapshotOf(
		files: Record<string, string | Buffer>,
		limits?: Parameters<typeof resolveSnapshot>[1],
	): Promise<{ repository: string; snapshot: ReviewSnapshot }> {
		const repository = createRepository();
		for (const [path, content] of Object.entries(files)) writeFixture(repository, path, content);
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "base");
		writeFixture(repository, "tracked.txt", "after\n");
		const snapshot = await resolveSnapshot(repository, limits);
		snapshots.push(snapshot);
		return { repository, snapshot };
	}

	/** Route `git` through the shim from here on; the snapshot must already be resolved. */
	function useGitShim(repository: string): { mode: string; log: string } {
		const realGit =
			process.platform === "win32"
				? run(repository, "where.exe", "git").split(/\r?\n/u)[0]
				: run(repository, "which", "git");
		if (!realGit) throw new Error("Could not locate Git.");
		const bin = join(repository, "shim-bin");
		mkdirSync(bin);
		const mode = join(repository, "shim-mode");
		const log = join(repository, "shim.log");
		installGitShim(bin, realGit, mode, log);
		process.env.PATH = `${bin}${delimiter}${initialPath ?? ""}`;
		return { mode, log };
	}

	function head(
		snapshot: ReviewSnapshot,
		query: string,
		options: Partial<ReviewSnapshotSearchOptions> = {},
	): ReturnType<ReviewSnapshot["search"]> {
		return snapshot.search({ revision: "head", query, limit: 100, ...options });
	}

	it("finds literal text in the head and base trees", async () => {
		const repository = createRepository();
		writeFixture(repository, "notes.txt", "alpha\nbeta needle\ngamma\nneedle delta\n");
		writeFixture(repository, "tracked.txt", "before base-only needle\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "base");
		writeFixture(repository, "tracked.txt", "after head-only needle\n");
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		await expect(head(snapshot, "head-only")).resolves.toEqual({
			matches: [{ path: "tracked.txt", line: 1, text: "after head-only needle" }],
			complete: true,
		});
		await expect(snapshot.search({ revision: "base", query: "base-only", limit: 100 })).resolves.toEqual({
			matches: [{ path: "tracked.txt", line: 1, text: "before base-only needle" }],
			complete: true,
		});
		await expect(head(snapshot, "base-only")).resolves.toEqual({ matches: [], complete: true });
		await expect(head(snapshot, "needle", { prefix: "notes.txt" })).resolves.toEqual({
			matches: [
				{ path: "notes.txt", line: 2, text: "beta needle" },
				{ path: "notes.txt", line: 4, text: "needle delta" },
			],
			complete: true,
		});
	});

	it("reads regular-expression characters and a leading dash literally", async () => {
		const { snapshot } = await snapshotOf({ "meta.txt": "a.b*c[ one\naxbxc[ two\n--verbose three\n-> four\n" });

		expect(locations((await head(snapshot, "a.b*c[")).matches)).toEqual(["meta.txt:1"]);
		expect(locations((await head(snapshot, "--verbose")).matches)).toEqual(["meta.txt:3"]);
		expect(locations((await head(snapshot, "->")).matches)).toEqual(["meta.txt:4"]);
	});

	it("scopes a search to a directory or a single file", async () => {
		const { snapshot } = await snapshotOf({
			"scope/a.txt": "needle a\n",
			"scope/nested/b.txt": "needle b\n",
			"scope-other/c.txt": "needle c\n",
			"top.txt": "needle top\n",
		});

		expect(locations((await head(snapshot, "needle", { prefix: "scope" })).matches)).toEqual([
			"scope/a.txt:1",
			"scope/nested/b.txt:1",
		]);
		expect(locations((await head(snapshot, "needle", { prefix: "scope/a.txt" })).matches)).toEqual(["scope/a.txt:1"]);
		await expect(head(snapshot, "needle", { prefix: "missing" })).resolves.toEqual({ matches: [], complete: true });
		expect((await head(snapshot, "needle")).matches).toHaveLength(4);
	});

	it("returns the first 500 characters of a long line", async () => {
		const { snapshot } = await snapshotOf({
			"long.txt": `${"needle ".padEnd(3 * 1024 * 1024, "x")}\n`,
			"wide.txt": `${"é".repeat(2_000)} wide-needle\n`,
		});

		const long = await head(snapshot, "needle", { prefix: "long.txt" });
		expect(long.matches).toEqual([{ path: "long.txt", line: 1, text: "needle ".padEnd(500, "x") }]);
		const wide = await head(snapshot, "wide-needle");
		expect(wide.matches).toEqual([{ path: "wide.txt", line: 1, text: "é".repeat(500) }]);
	});

	it("pages by offset through every match once, in Git's order", async () => {
		const { snapshot } = await snapshotOf({
			"B/x.txt": "needle 1\nneedle 2\n",
			"Z.txt": "needle 3\n",
			"a-b.txt": "needle 4\nother\nneedle 5\n",
			"a.txt": "needle 6\nneedle 7\n",
			"a/x.txt": "needle 8\nneedle 9\n",
		});
		// Git lists a tree by the bytes of its paths, so capitals come first and `a-b.txt` and `a.txt` before `a/`.
		const expected = [
			"B/x.txt:1",
			"B/x.txt:2",
			"Z.txt:1",
			"a-b.txt:1",
			"a-b.txt:3",
			"a.txt:1",
			"a.txt:2",
			"a/x.txt:1",
			"a/x.txt:2",
		];
		const whole = await head(snapshot, "needle");
		expect(whole.complete).toBe(true);
		expect(locations(whole.matches)).toEqual(expected);

		const paged: ReviewSnapshotSearchMatch[] = [];
		const completes: boolean[] = [];
		for (let offset = 0; completes.at(-1) !== true; ) {
			const page = await head(snapshot, "needle", { offset, limit: 2 });
			expect(page.matches.length).toBeGreaterThan(0);
			expect(page.matches.length).toBeLessThanOrEqual(2);
			paged.push(...page.matches);
			completes.push(page.complete);
			offset += page.matches.length;
		}
		expect(paged).toEqual(whole.matches);
		expect(completes).toEqual([false, false, false, false, true]);
		// A page that ends exactly at the last match knows nothing follows it.
		await expect(head(snapshot, "needle", { offset: 6, limit: 3 })).resolves.toMatchObject({ complete: true });
		await expect(head(snapshot, "needle", { offset: 9 })).resolves.toEqual({ matches: [], complete: true });
	});

	it("stops Git once a page is full", async () => {
		// Far more output than a pipe holds, so Git is still writing when the page fills.
		const { repository, snapshot } = await snapshotOf({ "dense.txt": "x needle\n".repeat(100_000) });
		const { log } = useGitShim(repository);

		const page = await head(snapshot, "needle", { limit: 100 });
		expect(page.complete).toBe(false);
		expect(page.matches).toEqual(
			Array.from({ length: 100 }, (_, index) => ({ path: "dense.txt", line: index + 1, text: "x needle" })),
		);
		expect(readShimArgs(log).filter((args) => grepPattern(args) === "needle")).toHaveLength(1);
		// Windows ends the process without a signal the shim could log.
		if (process.platform !== "win32") expect(readFileSync(log, "utf8")).toContain("term\n");

		const next = await head(snapshot, "needle", { offset: 100, limit: 2 });
		expect(locations(next.matches)).toEqual(["dense.txt:101", "dense.txt:102"]);
	});

	it("reads a file as binary by a NUL in its first 8,000 bytes, as Git does", async () => {
		const early = Buffer.alloc(8_000, 0x78);
		early.write("needle early\n", 0, "utf8");
		early[7_999] = 0;
		const { snapshot } = await snapshotOf({
			"early.bin": early,
			"late.txt": Buffer.concat([Buffer.from("needle late\n"), Buffer.alloc(7_988, 0x78), Buffer.from("\0tail\n")]),
		});

		// The first NUL of `late.txt` is at byte 8,000, one past what Git inspects.
		expect(locations((await head(snapshot, "needle")).matches)).toEqual(["late.txt:1"]);
		const earlyFile = await snapshot.readFile("head", "early.bin");
		const lateFile = await snapshot.readFile("head", "late.txt");
		expect(earlyFile).toMatchObject({ available: true, binary: true });
		expect(lateFile).toMatchObject({ available: true, binary: false });
	});

	it("searches text files that .gitattributes marks as binary or not for diffing", async () => {
		const { snapshot } = await snapshotOf({
			".gitattributes": "*.generated -diff\n*.forced binary\n",
			"binary.generated": Buffer.from([0, 1, 2, 3]),
			"text.forced": "forced attribute needle\n",
			"text.generated": "generated attribute needle\n",
		});

		expect(locations((await head(snapshot, "attribute needle")).matches)).toEqual([
			"text.forced:1",
			"text.generated:1",
		]);
	});

	it("searches a tree of large binary files whatever the snapshot's read limits", async () => {
		const binary = Buffer.alloc(20 * 1_024, 0x78);
		binary[0] = 0;
		const files: Record<string, string | Buffer> = { "notes.txt": "café needle\n" };
		for (let index = 0; index < 5; index++) {
			const content = Buffer.from(binary);
			content.write(String(index), content.length - 1, "utf8");
			files[`assets/${index}.bin`] = content;
		}
		// 100 KiB of binaries against a 64 KiB metadata limit: no search reads them into this process.
		const { snapshot } = await snapshotOf(files, { maxMetadataBytes: 64 * 1_024 });

		for (const query of ["é", "needle", "absent"]) {
			const result = await head(snapshot, query);
			expect(result.complete).toBe(true);
			expect(locations(result.matches)).toEqual(query === "absent" ? [] : ["notes.txt:1"]);
		}
	});

	it("searches a text file larger than the snapshot's blob read limit", async () => {
		const { snapshot } = await snapshotOf({ "large.txt": `${"x".repeat(200)}\nbig needle\n` }, { maxBlobBytes: 64 });

		expect(await snapshot.readFile("head", "large.txt")).toMatchObject({ available: false, reason: "oversized" });
		expect((await head(snapshot, "big needle")).matches).toEqual([
			{ path: "large.txt", line: 2, text: "big needle" },
		]);
	});

	it("keeps one output shape whatever Git is configured to do", async () => {
		const repository = createRepository();
		writeFixture(repository, "dir/config.txt", "a.b config needle\naxb config needle\n");
		writeFixture(repository, "tracked.txt", "before\n");
		git(repository, "add", "-A", "--", ".");
		git(repository, "commit", "-m", "base");
		writeFixture(repository, "tracked.txt", "after\n");
		git(repository, "config", "color.grep", "always");
		git(repository, "config", "grep.column", "true");
		git(repository, "config", "grep.lineNumber", "false");
		git(repository, "config", "grep.patternType", "perl");
		git(repository, "config", "submodule.recurse", "true");
		process.env.GIT_LITERAL_PATHSPECS = "1";
		const snapshot = await resolveSnapshot(repository);
		snapshots.push(snapshot);

		const expected = {
			matches: [{ path: "dir/config.txt", line: 1, text: "a.b config needle" }],
			complete: true,
		};
		await expect(head(snapshot, "a.b config")).resolves.toEqual(expected);
		await expect(head(snapshot, "a.b config", { prefix: "dir" })).resolves.toEqual(expected);
	});

	it("returns matches under paths that are not UTF-8, hold a line feed, or are very long", async () => {
		const repository = createRepository();
		const blob = (content: string): string => gitWithInput(repository, content, "hash-object", "-w", "--stdin");
		const entry = (oid: string, path: string | Buffer): Buffer =>
			Buffer.concat([Buffer.from(`100644 blob ${oid}\t`, "utf8"), Buffer.from(path), Buffer.from([0])]);
		const longPath = `${"p".repeat(24 * 1024)}.txt`;
		const tree = (marker: string): string =>
			gitWithInput(
				repository,
				Buffer.concat([
					entry(
						blob("odd needle 1\n"),
						Buffer.concat([Buffer.from("invalid-"), Buffer.from([0xff]), Buffer.from(".txt")]),
					),
					entry(blob("odd needle 2\n"), "line\nbreak.txt"),
					entry(blob("odd needle 3\n"), longPath),
					entry(blob(marker), "tracked.txt"),
				]),
				"mktree",
				"-z",
			);
		const baseCommit = git(repository, "commit-tree", tree("before\n"), "-m", "odd paths base");
		const headCommit = git(repository, "commit-tree", tree("after\n"), "-p", baseCommit, "-m", "odd paths head");
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha: headCommit });
		snapshots.push(snapshot);

		await expect(head(snapshot, "odd needle")).resolves.toEqual({
			matches: [
				{ path: "invalid-%FF.txt", line: 1, text: "odd needle 1" },
				{ path: "line%0Abreak.txt", line: 1, text: "odd needle 2" },
				{ path: longPath, line: 1, text: "odd needle 3" },
			],
			complete: true,
		});
	});

	it("reuses byte-path inventory and search references for exact, directory, and paginated scopes", async () => {
		const repository = createRepository();
		const sha = createByteReviewRepository(repository);
		const snapshot = await resolveSnapshot(repository, undefined, { kind: "commit", sha });
		snapshots.push(snapshot);
		for (const revision of ["base", "head"] as const) {
			const whole = await snapshot.search({ revision, query: "needle", limit: 100 });
			expect(whole.complete).toBe(true);
			for (const entry of await snapshot.listFiles({ revision })) {
				const scoped = await snapshot.search({ revision, query: "needle", prefix: entry.path, limit: 100 });
				expect(scoped).toEqual({
					matches: whole.matches.filter((match) => match.path === entry.path),
					complete: true,
				});
			}
			for (const prefix of [P.directory, P.fe, P.ff, P.replacement, P.literal]) {
				const expected = whole.matches.filter(
					(match) => match.path === prefix || match.path.startsWith(`${prefix}/`),
				);
				const paged: ReviewSnapshotSearchMatch[] = [];
				let complete = false;
				while (!complete) {
					const page = await snapshot.search({
						revision,
						query: "needle",
						prefix,
						offset: paged.length,
						limit: 1,
					});
					paged.push(...page.matches);
					complete = page.complete;
					expect(page.complete || page.matches.length === 1).toBe(true);
				}
				expect(paged).toEqual(expected);
			}
			expect(whole.matches.some((match) => match.path === P.link || match.path === P.module)).toBe(false);
		}
	});

	it("answers a query no line can contain without running Git, and refuses a query or page it cannot run", async () => {
		const { repository, snapshot } = await snapshotOf({ "multiline.txt": "alpha\nbeta\n" });
		const { log } = useGitShim(repository);

		await expect(head(snapshot, "alpha\nbeta")).resolves.toEqual({ matches: [], complete: true });
		await expect(head(snapshot, "")).rejects.toThrow(/must not be empty/);
		await expect(head(snapshot, "alpha\0beta")).rejects.toThrow(/must not contain a NUL/);
		for (const page of [{ offset: -1 }, { offset: 1.5 }, { limit: 0 }, { limit: Number.NaN }]) {
			await expect(head(snapshot, "alpha", page)).rejects.toThrow(/outside its supported range/);
		}
		expect(readShimArgs(log).filter((args) => args[0] === "grep")).toEqual([]);
	});

	it("folds ASCII case only when asked", async () => {
		const { snapshot } = await snapshotOf({ "case.txt": "Needle one\nNEEDLE two\nneedle three\n" });

		expect(locations((await head(snapshot, "needle")).matches)).toEqual(["case.txt:3"]);
		expect(locations((await head(snapshot, "needle", { ignoreCase: true })).matches)).toEqual([
			"case.txt:1",
			"case.txt:2",
			"case.txt:3",
		]);
		expect(locations((await head(snapshot, "NEEDLE T", { ignoreCase: true })).matches)).toEqual([
			"case.txt:2",
			"case.txt:3",
		]);
	});

	it("matches text outside ASCII exactly, with or without case folding", async () => {
		const { snapshot } = await snapshotOf({ "accent.txt": "café ÉTÉ needle\n路径 needle\n" });

		for (const ignoreCase of [false, true]) {
			expect(locations((await head(snapshot, "café", { ignoreCase })).matches)).toEqual(["accent.txt:1"]);
			expect(locations((await head(snapshot, "ÉTÉ", { ignoreCase })).matches)).toEqual(["accent.txt:1"]);
			expect(locations((await head(snapshot, "路径", { ignoreCase })).matches)).toEqual(["accent.txt:2"]);
		}
		expect((await head(snapshot, "été")).matches).toEqual([]);
	});

	// Git folds these only in a UTF-8 locale, and macOS has no `C.UTF-8` locale to give it.
	it.skipIf(process.platform === "darwin")("folds the case of letters outside ASCII", async () => {
		const { snapshot } = await snapshotOf({ "accent.txt": "café ÉTÉ needle\n" });

		expect(locations((await head(snapshot, "été", { ignoreCase: true })).matches)).toEqual(["accent.txt:1"]);
		expect(locations((await head(snapshot, "CAFÉ", { ignoreCase: true })).matches)).toEqual(["accent.txt:1"]);
	});

	it("reports a Git failure and succeeds on a retry", async () => {
		const { repository, snapshot } = await snapshotOf({ "notes.txt": "retry needle\n" });
		const { mode } = useGitShim(repository);

		writeFileSync(mode, "fail-once");
		await expect(head(snapshot, "retry needle")).rejects.toThrow(/git grep failed: injected grep failure/);
		await expect(head(snapshot, "retry needle")).resolves.toEqual({
			matches: [{ path: "notes.txt", line: 1, text: "retry needle" }],
			complete: true,
		});
	});

	it("stops Git when the caller aborts", async () => {
		const { repository, snapshot } = await snapshotOf({ "notes.txt": "abort needle\n" });
		const { mode, log } = useGitShim(repository);

		writeFileSync(mode, "delay");
		const controller = new AbortController();
		const aborted = head(snapshot, "abort needle", { signal: controller.signal });
		await waitForShimArgs(log, (args) => grepPattern(args) === "abort needle");
		controller.abort();
		await expect(aborted).rejects.toThrow(/Review snapshot search was aborted/);
		if (process.platform !== "win32") expect(readFileSync(log, "utf8")).toContain("term\n");

		const alreadyAborted = head(snapshot, "abort needle", { signal: controller.signal });
		await expect(alreadyAborted).rejects.toThrow(/Review snapshot search was aborted/);
		rmSync(mode, { force: true });
		expect(locations((await head(snapshot, "abort needle")).matches)).toEqual(["notes.txt:1"]);
	});

	it("stops running searches when disposed, and then removes its temporary directory", async () => {
		const snapshotTemporaryRoot = mkdtempSync(join(tmpdir(), "volt-review-search-owned-"));
		directories.push(snapshotTemporaryRoot);
		process.env.TMPDIR = snapshotTemporaryRoot;
		process.env.TEMP = snapshotTemporaryRoot;
		process.env.TMP = snapshotTemporaryRoot;
		const { repository, snapshot } = await snapshotOf({ "notes.txt": "dispose needle\n" });
		const snapshotTemporaryDirectories = readdirSync(snapshotTemporaryRoot)
			.filter((entry) => entry.startsWith("volt-review-snapshot-"))
			.map((entry) => join(snapshotTemporaryRoot, entry));
		expect(snapshotTemporaryDirectories).toHaveLength(1);
		const snapshotTemporaryDirectory = snapshotTemporaryDirectories[0];
		if (!snapshotTemporaryDirectory) throw new Error("Expected one owned review snapshot directory.");
		const { mode, log } = useGitShim(repository);

		writeFileSync(mode, "delay");
		const active = head(snapshot, "dispose needle");
		await waitForShimArgs(log, (args) => grepPattern(args) === "dispose needle");
		const disposal = snapshot.dispose();
		await expect(active).rejects.toThrow(/Review snapshot search was aborted/);
		await disposal;
		expect(existsSync(snapshotTemporaryDirectory)).toBe(false);
		await expect(head(snapshot, "dispose needle")).rejects.toThrow(/no longer available/);
	});
});
