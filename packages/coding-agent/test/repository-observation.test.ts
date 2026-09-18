import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as readFileOperations from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { createReadTool, type ReadOperations } from "../src/core/tools/read.ts";
import { withRepositoryObservation } from "../src/core/tools/repository-observation.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, GREP_MAX_LINE_LENGTH } from "../src/core/tools/truncate.ts";
import { spawnProcess } from "../src/utils/child-process.ts";
import { ensureTool, getToolPath } from "../src/utils/tools-manager.ts";

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof readFileOperations>();
	return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: vi.fn(), getToolPath: vi.fn() }));
vi.mock("../src/utils/child-process.ts", () => ({ spawnProcess: vi.fn() }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class SearchProcess extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;
	readonly kill = vi.fn(() => {
		this.killed = true;
		return true;
	});

	close(code: number | null = 0) {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code);
	}
}

function prepareProcess(onStart?: (child: SearchProcess) => void) {
	const started = deferred<SearchProcess>();
	vi.mocked(spawnProcess).mockImplementation(() => {
		const child = new SearchProcess();
		started.resolve(child);
		if (onStart) queueMicrotask(() => onStart(child));
		return child as unknown as ReturnType<typeof spawnProcess>;
	});
	return started.promise;
}

function matchEvent(path: string, line: number, text: string): string {
	return `${JSON.stringify({ type: "match", data: { path: { text: path }, line_number: line, lines: { text } } })}\n`;
}

async function expectPending(promise: Promise<unknown>) {
	const settled = vi.fn();
	void promise.then(settled, settled);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(settled).not.toHaveBeenCalled();
}

describe("private repository observations", () => {
	let cwd: string;

	beforeEach(async () => {
		vi.resetAllMocks();
		cwd = await mkdtemp(join(tmpdir(), "volt-repository-observation-"));
		vi.mocked(ensureTool).mockResolvedValue("/installed/tool");
		vi.mocked(getToolPath).mockReturnValue("/installed/tool");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(cwd, { recursive: true, force: true });
	});

	it("retains ordinary read results while capturing raw selected text, canonical identity, and a whole-buffer revision", async () => {
		const path = join(cwd, "source.txt");
		const bytes = Buffer.from("one\r\ntwo\r\nthree\r\nfour\n");
		await writeFile(path, bytes);
		const tool = createReadTool(cwd);
		const args = { path: "source.txt", offset: 2, limit: 2 };
		const foreground = await tool.execute("foreground", args);
		const managed = await withRepositoryObservation(() => tool.execute("managed", args));

		expect(managed.result).toEqual(foreground);
		expect(foreground).toEqual({
			content: [{ type: "text", text: "two\r\nthree\r\n\n[2 more lines in file. Use offset=4 to continue.]" }],
		});
		expect(managed.observation).toEqual({
			kind: "read",
			path: await realpath(path),
			text: "two\r\nthree\r",
			startLine: 2,
			endLine: 3,
			revision: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
			truncated: true,
		});
		expect("observation" in managed.result).toBe(false);
	});

	it("changes revision when unread portions change, and source identity when an equal-content symlink retargets", async () => {
		const a = join(cwd, "a.txt");
		const b = join(cwd, "b.txt");
		const link = join(cwd, "link.txt");
		await writeFile(a, "same\nbefore");
		await symlink(a, link);
		const tool = createReadTool(cwd);
		const run = () => withRepositoryObservation(() => tool.execute("read", { path: link, limit: 1 }));
		const before = (await run()).observation;
		await writeFile(a, "same\nafter");
		const after = (await run()).observation;
		if (before?.kind !== "read" || after?.kind !== "read") throw new Error("Expected read observations");
		expect(before.text).toBe(after.text);
		expect(before.revision).not.toBe(after.revision);
		await writeFile(b, "same\nafter");
		await unlink(link);
		await symlink(b, link);
		const retargeted = (await run()).observation;
		if (retargeted?.kind !== "read") throw new Error("Expected read observation");
		expect(retargeted.revision).toBe(after.revision);
		expect(retargeted.path).toBe(await realpath(b));
		expect(retargeted.path).not.toBe(after.path);
		await unlink(b);
		await expect(run()).rejects.toThrow(/ENOENT/);
	});

	it("hashes the actual read buffer rather than rereading a source changed before settlement", async () => {
		const path = join(cwd, "changing.txt");
		await writeFile(path, "observed bytes");
		const { readFile } = await vi.importActual<typeof readFileOperations>("fs/promises");
		const spy = vi.mocked(readFileOperations.readFile).mockImplementationOnce(async (source) => {
			const bytes = await readFile(source);
			await writeFile(path, "later bytes");
			return bytes;
		});
		const { observation } = await withRepositoryObservation(() => createReadTool(cwd).execute("read", { path }));
		expect(spy).toHaveBeenCalledOnce();
		expect(observation).toMatchObject({
			text: "observed bytes",
			revision: `sha256:${createHash("sha256").update("observed bytes").digest("hex")}`,
		});
		expect(await readFile(path, "utf8")).toBe("later bytes");
	});

	it("withholds unverifiable source identity when a symlink retargets during the native read", async () => {
		const a = join(cwd, "a.txt");
		const b = join(cwd, "b.txt");
		const link = join(cwd, "link.txt");
		await writeFile(a, "a");
		await writeFile(b, "b");
		await symlink(a, link);
		const canonicalA = await realpath(a);
		const { readFile } = await vi.importActual<typeof readFileOperations>("fs/promises");
		vi.mocked(readFileOperations.readFile).mockImplementationOnce(async (source) => {
			expect(source).toBe(canonicalA);
			await unlink(link);
			await symlink(b, link);
			return readFile(source);
		});
		expect(await withRepositoryObservation(() => createReadTool(cwd).execute("read", { path: link }))).toEqual({
			result: { content: [{ type: "text", text: "a" }] },
		});
	});

	it("retains native path normalization and empty/trailing-newline ranges", async () => {
		await writeFile(join(cwd, "cafe\u0301.txt"), "a\nb\n");
		const tool = createReadTool(cwd);
		const { observation } = await withRepositoryObservation(() =>
			tool.execute("read", { path: "@café.txt", offset: 2 }),
		);
		expect(observation).toMatchObject({ kind: "read", text: "b\n", startLine: 2, endLine: 2, truncated: false });
		await writeFile(join(cwd, "empty.txt"), "");
		const empty = await withRepositoryObservation(() => tool.execute("read", { path: "empty.txt" }));
		expect(empty.observation).toMatchObject({ text: "", startLine: 1, endLine: 0, truncated: false });
	});

	it("bounds raw read JSON including escaping and metadata, without notices or partial lines", async () => {
		const lines = Array.from({ length: 2500 }, () => '"\\'.repeat(20));
		await writeFile(join(cwd, "large.txt"), lines.join("\n"));
		const tool = createReadTool(cwd);
		const args = { path: "large.txt" };
		const { result, observation } = await withRepositoryObservation(() => tool.execute("managed", args));
		expect(result).toEqual(await tool.execute("foreground", args));
		if (observation?.kind !== "read") throw new Error("Expected read observation");
		expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(observation.endLine).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
		expect(observation.text).toBe(lines.slice(0, observation.endLine).join("\n"));
		expect(observation.truncated).toBe(true);
	});

	it("reports a bounded empty range when the first raw line exceeds the limit", async () => {
		await writeFile(join(cwd, "long.txt"), "x".repeat(DEFAULT_MAX_BYTES + 1));
		const { observation } = await withRepositoryObservation(() =>
			createReadTool(cwd).execute("read", { path: "long.txt" }),
		);
		expect(observation).toMatchObject({ text: "", startLine: 1, endLine: 0, truncated: true });
	});

	it.each([
		[
			"image",
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==",
				"base64",
			),
		],
		["binary", Buffer.from([0, 1, 2, 3])],
		["invalid UTF-8", Buffer.from([0xff, 0xfe, 0xfd])],
	] as const)("rejects %s in managed reads without changing foreground support", async (_name, buffer) => {
		await writeFile(join(cwd, "input.dat"), buffer);
		const tool = createReadTool(cwd, { autoResizeImages: false });
		const args = { path: "input.dat" };
		await expect(withRepositoryObservation(() => tool.execute("managed", args))).rejects.toMatchObject({
			status: "unsupported",
			reason: "non_text_input",
		});
		const result = await tool.execute("foreground", args);
		if (_name === "image") expect(result.content.some((block) => block.type === "image")).toBe(true);
		else expect(result.content).toEqual([{ type: "text", text: buffer.toString("utf8") }]);
	});

	it("does not manufacture local identity or fallback reads for custom read operations", async () => {
		await writeFile(join(cwd, "local.txt"), "local data must not become remote evidence");
		const readFile = vi.fn(async () => Buffer.from("remote data"));
		const tool = createReadTool(cwd, { operations: { access: async () => {}, readFile } });
		const managed = await withRepositoryObservation(() => tool.execute("managed", { path: "local.txt" }));
		expect(managed).toEqual({ result: { content: [{ type: "text", text: "remote data" }] } });
		expect(readFile).toHaveBeenCalledExactlyOnceWith(join(cwd, "local.txt"));
	});

	it("isolates overlapping and nested scopes, and leaves non-producing runs without an observation", async () => {
		await writeFile(join(cwd, "a"), "alpha");
		await writeFile(join(cwd, "b"), "beta");
		const tool = createReadTool(cwd);
		const [a, b] = await Promise.all([
			withRepositoryObservation(() => tool.execute("a", { path: "a" })),
			withRepositoryObservation(() => tool.execute("b", { path: "b" })),
		]);
		expect(a.observation).toMatchObject({ kind: "read", text: "alpha" });
		expect(b.observation).toMatchObject({ kind: "read", text: "beta" });
		const outer = await withRepositoryObservation(async () => {
			await tool.execute("outer", { path: "a" });
			return withRepositoryObservation(() => tool.execute("inner", { path: "b" }));
		});
		expect(outer.observation).toMatchObject({ text: "alpha" });
		expect(outer.result.observation).toMatchObject({ text: "beta" });
		expect(await withRepositoryObservation(async () => 42)).toEqual({ result: 42 });
	});

	it.for(["a item.ts", "a:3: item.ts"])(
		"captures native fd paths before formatting and preserves foreground results for %j",
		async (fileName, context) => {
			if (process.platform === "win32" && fileName.includes(":")) {
				context.skip("Colons are not supported in Windows filenames");
			}
			prepareProcess((child) => {
				child.stdout.write(`${join(cwd, fileName)}\n${join(cwd, "b.ts")}\n`);
				child.close();
			});
			const tool = createFindTool(cwd);
			const managed = await withRepositoryObservation(() => tool.execute("managed", { pattern: "*.ts" }));
			expect(ensureTool).not.toHaveBeenCalled();
			expect(getToolPath).toHaveBeenCalledExactlyOnceWith("fd");
			const foreground = await tool.execute("foreground", { pattern: "*.ts" });
			expect(managed.result).toEqual(foreground);
			expect(foreground).toEqual({ content: [{ type: "text", text: `${fileName}\nb.ts` }] });
			expect(managed.observation).toEqual({
				kind: "find",
				paths: [join(cwd, fileName), join(cwd, "b.ts")],
				truncated: false,
			});
			expect(ensureTool).toHaveBeenCalledExactlyOnceWith("fd", true);
		},
	);

	it.each(["find", "grep", "grep-file"] as const)("returns reusable paths for nested-root %s", async (kind) => {
		const directory = join(cwd, "nested");
		const source = join(directory, "source.txt");
		await mkdir(directory);
		await writeFile(source, "nested content");
		await writeFile(join(cwd, "source.txt"), "wrong root");
		prepareProcess((child) => {
			child.stdout.write(kind === "find" ? `${source}\n` : matchEvent(source, 1, "nested content"));
			child.close();
		});
		const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
		const { observation } = await withRepositoryObservation(() =>
			tool.execute("search", {
				pattern: kind === "find" ? "*.txt" : "nested",
				path: kind === "grep-file" ? "nested/source.txt" : "nested",
			}),
		);
		const found =
			observation?.kind === "find"
				? observation.paths[0]
				: observation?.kind === "grep"
					? observation.matches[0]?.path
					: undefined;
		expect(found).toBe(source);
		const read = await withRepositoryObservation(() => createReadTool(cwd).execute("read", { path: found! }));
		expect(read.observation).toMatchObject({ text: "nested content" });
	});

	it("captures custom find producer paths directly, including embedded newlines", async () => {
		const paths = [join(cwd, "first\nsecond.ts"), join(cwd, "third.ts")];
		const tool = createFindTool(cwd, { operations: { exists: () => true, glob: () => paths } });
		const managed = await withRepositoryObservation(() => tool.execute("managed", { pattern: "*" }));
		expect(managed.observation).toEqual({ kind: "find", paths, truncated: false });
		expect(spawnProcess).not.toHaveBeenCalled();
		expect(ensureTool).not.toHaveBeenCalled();
		paths[0] = "changed";
		expect(managed.observation).toMatchObject({ paths: [join(cwd, "first\nsecond.ts"), join(cwd, "third.ts")] });
	});

	it.each(["lines", "bytes"] as const)(
		"bounds find structured JSON by %s and retains partial coverage",
		async (bound) => {
			const paths = Array.from({ length: 2500 }, (_, i) =>
				join(cwd, bound === "lines" ? `${i}` : `${i}${'"'.repeat(200)}`),
			);
			const tool = createFindTool(cwd, { operations: { exists: () => true, glob: () => paths } });
			const { observation } = await withRepositoryObservation(() =>
				tool.execute("find", { pattern: "*", limit: 5000 }),
			);
			if (observation?.kind !== "find") throw new Error("Expected find observation");
			expect(observation.paths.length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
			expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			expect(observation.truncated).toBe(true);
		},
	);

	it("counts embedded and trailing path newlines against the structured line budget", async () => {
		const paths = Array.from({ length: 2000 }, (_, i) => join(cwd, `${i}${"\n".repeat(99)}`));
		const tool = createFindTool(cwd, { operations: { exists: () => true, glob: () => paths } });
		const { observation } = await withRepositoryObservation(() =>
			tool.execute("find", { pattern: "*", limit: 3000 }),
		);
		if (observation?.kind !== "find") throw new Error("Expected find observation");
		expect(observation.paths.length).toBe(20);
		expect(observation.truncated).toBe(true);
	});

	it("preserves partial fd coverage on a nonzero exit and when result limits are reached", async () => {
		prepareProcess((child) => {
			child.stdout.write(`${join(cwd, "a.txt")}\n`);
			child.close(2);
		});
		const tool = createFindTool(cwd);
		const partial = await withRepositoryObservation(() => tool.execute("find", { pattern: "*" }));
		expect(partial.observation).toEqual({ kind: "find", paths: [join(cwd, "a.txt")], truncated: true });
		const limited = await withRepositoryObservation(() => tool.execute("find", { pattern: "*", limit: 1 }));
		expect(limited.observation).toMatchObject({ truncated: true });
		expect(limited.result.details?.resultLimitReached).toBe(1);
	});

	it("captures ripgrep JSON producers, not rendered path/line-looking text", async () => {
		prepareProcess((child) => {
			child.stdout.write(matchEvent(join(cwd, "a:12: source.ts"), 7, "literal:42: [No matches found]\r\n"));
			child.close();
		});
		const tool = createGrepTool(cwd);
		const managed = await withRepositoryObservation(() => tool.execute("managed", { pattern: "literal" }));
		expect(ensureTool).not.toHaveBeenCalled();
		expect(getToolPath).toHaveBeenCalledExactlyOnceWith("rg");
		expect(managed.result).toEqual(await tool.execute("foreground", { pattern: "literal" }));
		expect(managed.observation).toEqual({
			kind: "grep",
			matches: [{ path: join(cwd, "a:12: source.ts"), line: 7, text: "literal:42: [No matches found]" }],
			truncated: false,
		});
	});

	it("captures only matching lines from the context producer, not its rendered context or stale rg text", async () => {
		await writeFile(join(cwd, "source.ts"), "before\ncurrent match\nafter\n");
		prepareProcess((child) => {
			child.stdout.write(matchEvent(join(cwd, "source.ts"), 2, "earlier rg text\n"));
			child.close();
		});
		const tool = createGrepTool(cwd);
		const args = { pattern: "match", context: 1 };
		const managed = await withRepositoryObservation(() => tool.execute("managed", args));
		expect(managed.result).toEqual(await tool.execute("foreground", args));
		expect(managed.observation).toEqual({
			kind: "grep",
			matches: [{ path: join(cwd, "source.ts"), line: 2, text: "current match" }],
			truncated: false,
		});
	});

	it.for(["source.ts", "source\nname.ts"])(
		"does not capture matches excluded by native context-output truncation in %j",
		async (fileName, context) => {
			if (process.platform === "win32" && fileName.includes("\n")) {
				context.skip("Newlines are not supported in Windows filenames");
			}
			await writeFile(join(cwd, fileName), Array.from({ length: 200 }, () => "x".repeat(500)).join("\n"));
			prepareProcess((child) => {
				child.stdout.write(matchEvent(join(cwd, fileName), 150, "x".repeat(500)));
				child.close();
			});
			const { observation } = await withRepositoryObservation(() =>
				createGrepTool(cwd).execute("grep", { pattern: "x", context: 200 }),
			);
			expect(observation).toEqual({ kind: "grep", matches: [], truncated: true });
		},
	);

	it("bounds grep excerpts and JSON without embedding truncation notices", async () => {
		prepareProcess((child) => {
			for (let i = 0; i < 150; i++) child.stdout.write(matchEvent(join(cwd, "a.ts"), i + 1, '"'.repeat(700)));
			child.close();
		});
		const { observation } = await withRepositoryObservation(() =>
			createGrepTool(cwd).execute("grep", { pattern: ".", limit: 200 }),
		);
		if (observation?.kind !== "grep") throw new Error("Expected grep observation");
		expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(observation.matches.length).toBeGreaterThan(0);
		expect(observation.matches.every((match) => match.text === '"'.repeat(GREP_MAX_LINE_LENGTH))).toBe(true);
		expect(observation.truncated).toBe(true);
	});

	it.each(["find", "grep"] as const)("returns structured empty %s results", async (kind) => {
		prepareProcess((child) => child.close(kind === "grep" ? 1 : 0));
		const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
		const { observation } = await withRepositoryObservation(() => tool.execute("empty", { pattern: "missing" }));
		expect(observation).toEqual(
			kind === "find" ? { kind, paths: [], truncated: false } : { kind, matches: [], truncated: false },
		);
	});

	it.each(["find", "grep"] as const)("never downloads missing tools for managed %s", async (kind) => {
		vi.mocked(getToolPath).mockReturnValue(null);
		const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
		await expect(withRepositoryObservation(() => tool.execute("missing", { pattern: "*" }))).rejects.toMatchObject({
			status: "unavailable",
			reason: "backend_unavailable",
		});
		expect(ensureTool).not.toHaveBeenCalled();
		expect(spawnProcess).not.toHaveBeenCalled();
	});

	it.each(["access", "detectImageMimeType", "readFile"] as const)(
		"drains read %s before rejecting cancellation",
		async (stage) => {
			const entered = deferred<void>();
			const released = deferred<void>();
			const ops: ReadOperations = {
				access: vi.fn(async () => {}),
				detectImageMimeType: vi.fn(async () => null),
				readFile: vi.fn(async () => Buffer.from("text")),
			};
			const wait = async () => {
				entered.resolve();
				await released.promise;
			};
			if (stage === "access") ops.access = wait;
			if (stage === "detectImageMimeType")
				ops.detectImageMimeType = async () => {
					await wait();
					return null;
				};
			if (stage === "readFile")
				ops.readFile = async () => {
					await wait();
					return Buffer.from("text");
				};
			const controller = new AbortController();
			const pending = withRepositoryObservation(() =>
				createReadTool(cwd, { operations: ops }).execute("read", { path: "remote" }, controller.signal),
			);
			await entered.promise;
			controller.abort();
			await expectPending(pending);
			released.resolve();
			await expect(pending).rejects.toThrow("Operation aborted");
			if (stage !== "readFile") expect(ops.readFile).not.toHaveBeenCalled();
		},
	);

	it.each(["exists", "glob"] as const)("drains custom find %s before rejecting cancellation", async (stage) => {
		const entered = deferred<void>();
		const released = deferred<void>();
		const wait = async () => {
			entered.resolve();
			await released.promise;
		};
		const glob = vi.fn(async () => {
			if (stage === "glob") await wait();
			return [join(cwd, "file")];
		});
		const tool = createFindTool(cwd, {
			operations: {
				exists: async () => {
					if (stage === "exists") await wait();
					return true;
				},
				glob,
			},
		});
		const controller = new AbortController();
		const pending = withRepositoryObservation(() => tool.execute("find", { pattern: "*" }, controller.signal));
		await entered.promise;
		controller.abort();
		await expectPending(pending);
		released.resolve();
		await expect(pending).rejects.toThrow("Operation aborted");
		if (stage === "exists") expect(glob).not.toHaveBeenCalled();
	});

	it.each(["find", "grep"] as const)(
		"holds aborted %s ownership until child close, including an intervening error",
		async (kind) => {
			const started = prepareProcess();
			const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
			const controller = new AbortController();
			const pending = withRepositoryObservation(() => tool.execute("search", { pattern: "*" }, controller.signal));
			const child = await started;
			controller.abort();
			expect(child.kill).toHaveBeenCalledOnce();
			child.emit("error", new Error("child still draining"));
			await expectPending(pending);
			child.close(null);
			await expect(pending).rejects.toThrow("Operation aborted");
		},
	);

	it.each(["find", "grep"] as const)("also drains %s child errors without an abort", async (kind) => {
		const started = prepareProcess();
		const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
		const pending = withRepositoryObservation(() => tool.execute("search", { pattern: "*" }));
		const child = await started;
		child.emit("error", new Error("failed producer"));
		await expectPending(pending);
		child.close(2);
		await expect(pending).rejects.toThrow("failed producer");
	});

	it.each(["find", "grep"] as const)(
		"keeps ownership if %s kill reports an error before child close",
		async (kind) => {
			const started = prepareProcess();
			const tool = kind === "find" ? createFindTool(cwd) : createGrepTool(cwd);
			const controller = new AbortController();
			const pending = withRepositoryObservation(() => tool.execute("search", { pattern: "*" }, controller.signal));
			const child = await started;
			child.kill.mockImplementation(() => {
				child.emit("error", new Error("kill denied"));
				return false;
			});
			controller.abort();
			expect(child.kill).toHaveBeenCalledOnce();
			await expectPending(pending);
			child.close(0);
			await expect(pending).rejects.toThrow("Operation aborted");
		},
	);

	it("waits for the grep child after killing it at the match limit", async () => {
		const started = prepareProcess();
		const pending = withRepositoryObservation(() => createGrepTool(cwd).execute("grep", { pattern: "x", limit: 1 }));
		const child = await started;
		child.stdout.write(matchEvent(join(cwd, "a.txt"), 1, "x\n"));
		expect(child.kill).toHaveBeenCalledOnce();
		await expectPending(pending);
		child.close(null);
		expect((await pending).observation).toEqual({
			kind: "grep",
			matches: [{ path: join(cwd, "a.txt"), line: 1, text: "x" }],
			truncated: true,
		});
	});

	it.each(["isDirectory", "readFile"] as const)(
		"drains grep %s and rechecks cancellation before further work",
		async (stage) => {
			const entered = deferred<void>();
			const released = deferred<void>();
			const wait = async () => {
				entered.resolve();
				await released.promise;
			};
			prepareProcess((child) => {
				child.stdout.write(matchEvent(join(cwd, "a"), 1, "x\n"));
				child.close();
			});
			const tool = createGrepTool(cwd, {
				operations: {
					isDirectory: async () => {
						if (stage === "isDirectory") await wait();
						return true;
					},
					readFile: async () => {
						if (stage === "readFile") await wait();
						return "x\ncontext";
					},
				},
			});
			const controller = new AbortController();
			const pending = withRepositoryObservation(() =>
				tool.execute("grep", { pattern: "x", context: 1 }, controller.signal),
			);
			await entered.promise;
			controller.abort();
			await expectPending(pending);
			released.resolve();
			await expect(pending).rejects.toThrow("Operation aborted");
			if (stage === "isDirectory") expect(spawnProcess).not.toHaveBeenCalled();
		},
	);

	it.each(["read", "find", "grep"] as const)("starts no work for already-aborted %s", async (kind) => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			withRepositoryObservation(() => {
				if (kind === "read") return createReadTool(cwd).execute("aborted", { path: "missing" }, controller.signal);
				if (kind === "find") return createFindTool(cwd).execute("aborted", { pattern: "*" }, controller.signal);
				return createGrepTool(cwd).execute("aborted", { pattern: "*" }, controller.signal);
			}),
		).rejects.toThrow("Operation aborted");
		expect(ensureTool).not.toHaveBeenCalled();
		expect(getToolPath).not.toHaveBeenCalled();
		expect(spawnProcess).not.toHaveBeenCalled();
	});
});
