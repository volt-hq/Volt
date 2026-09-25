import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackgroundJobDiagnosticEvent, BackgroundJobDiagnostics } from "../src/core/background-job-diagnostics.ts";

interface RecordData extends BackgroundJobDiagnosticEvent {
	schemaVersion: number;
	timestamp: string;
	monotonicMs: number;
	sequence: number;
	runtimeId: string;
	sessionId: string;
	parentSessionId?: string;
	droppedEvents: number;
}

function records(content: string): RecordData[] {
	return content
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as RecordData);
}

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function diskWriter(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content, { flag: "wx", mode: 0o600 });
}

function ownedName(index: number): string {
	return `background-jobs-v1_2026-01-01T00-00-00-000Z_12345678-1234-4234-8234-123456789abc_${String(index).padStart(8, "0")}.jsonl`;
}

let directory: string;
const collectors: BackgroundJobDiagnostics[] = [];
let unexpectedWarnings = 0;

function collector(options: Partial<ConstructorParameters<typeof BackgroundJobDiagnostics>[0]> = {}) {
	const instance = new BackgroundJobDiagnostics({
		agentDir: directory,
		sessionId: () => "session-1",
		warn: () => {
			unexpectedWarnings++;
		},
		...options,
	});
	collectors.push(instance);
	return instance;
}

beforeEach(async () => {
	unexpectedWarnings = 0;
	directory = await mkdtemp(join(tmpdir(), "volt-background-diagnostics-"));
	vi.stubEnv("VOLT_BACKGROUND_JOB_DIAGNOSTICS", "1");
});

afterEach(async () => {
	await Promise.all(collectors.splice(0).map((instance) => instance.close()));
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(directory, { recursive: true, force: true });
	expect(unexpectedWarnings).toBe(0);
});

describe("background job metadata diagnostics", () => {
	it.each([undefined, "", "0", "false", "yes", " true "])(
		"does nothing when not explicitly enabled (%s)",
		async (setting) => {
			vi.stubEnv("VOLT_BACKGROUND_JOB_DIAGNOSTICS", setting);
			const writer = vi.fn(async () => {});
			const identity = vi.fn(() => "session-1");
			const instance = collector({ writer, sessionId: identity });
			instance.record({ kind: "run_start" });
			instance.flush();
			await instance.close();
			expect(instance.enabled).toBe(false);
			expect(identity).not.toHaveBeenCalled();
			expect(writer).not.toHaveBeenCalled();
			expect(await readdir(directory)).toEqual([]);
		},
	);

	it.each(["1", "true", "TRUE", "TrUe"])("accepts the explicit enable value %s", async (setting) => {
		vi.stubEnv("VOLT_BACKGROUND_JOB_DIAGNOSTICS", setting);
		const writer = vi.fn(async () => {});
		const instance = collector({ writer });
		expect(instance.enabled).toBe(true);
		instance.record({ kind: "run_start" });
		await instance.close();
		expect(writer).toHaveBeenCalledTimes(1);
	});

	it("copies metadata only, owns record identity, and captures session lineage at record time", async () => {
		const content: string[] = [];
		let sessionId = "session-1";
		let parentSessionId: string | undefined;
		const instance = collector({
			sessionId: () => sessionId,
			parentSessionId: () => parentSessionId,
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		const event = {
			kind: "request_end" as const,
			runId: "run-1",
			requestId: "request-1",
			toolCallId: "call-1",
			jobId: "job-1",
			waitId: "wait-1",
			jobIds: ["job-1"],
			toolName: "bash",
			provider: "openai",
			model: "vendor/model-v1:latest",
			status: "completed" as const,
			mode: "all" as const,
			reason: "terminal" as const,
			action: "wait" as const,
			outputBytes: 12,
			outputRevision: 2,
			isError: false,
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, payload: "secret-nested" },
			prompt: "secret-prompt",
			command: "secret-command",
			arguments: { text: "secret-arguments" },
			reasoning: "secret-reasoning",
			output: "secret-output",
			credentials: "secret-credentials",
			path: "secret-path",
			runtimeId: "spoofed",
			sequence: 999,
			timestamp: "spoofed",
			sessionId: "spoofed",
			schemaVersion: 999,
			toJSON: () => ({ prompt: "secret-toJSON" }),
		};
		instance.record(event);
		event.jobIds.push("mutated");
		event.usage.input = 99;
		sessionId = "session-2";
		parentSessionId = "session-1";
		instance.record({ kind: "run_end" });
		expect(content).toEqual([]);
		await instance.close();
		const [first, second] = records(content.join(""));
		expect(first).toMatchObject({
			schemaVersion: 1,
			sequence: 1,
			runtimeId: instance.runtimeId,
			sessionId: "session-1",
			droppedEvents: 0,
			kind: "request_end",
			jobIds: ["job-1"],
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 },
		});
		expect(first).not.toHaveProperty("parentSessionId");
		expect(first?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
		expect(first?.monotonicMs).toBeGreaterThanOrEqual(0);
		expect(second).toMatchObject({ sequence: 2, sessionId: "session-2", parentSessionId: "session-1" });
		expect(second!.monotonicMs).toBeGreaterThanOrEqual(first!.monotonicMs);
		expect(content.join("")).not.toMatch(/secret-|spoofed|mutated/);
		expect(Object.keys(first!).sort()).toEqual(
			[
				"kind",
				"runId",
				"requestId",
				"toolCallId",
				"jobId",
				"waitId",
				"jobIds",
				"toolName",
				"provider",
				"model",
				"status",
				"mode",
				"reason",
				"action",
				"outputBytes",
				"outputRevision",
				"isError",
				"usage",
				"schemaVersion",
				"timestamp",
				"monotonicMs",
				"sequence",
				"runtimeId",
				"sessionId",
				"droppedEvents",
			].sort(),
		);
	});

	it("keeps opaque Responses tool IDs correlatable without retaining their provider item payload", async () => {
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		const toolCallId = `call-1|${"opaque+provider/payload=".repeat(30)}`;
		instance.record({ kind: "tool_start", toolCallId });
		instance.record({ kind: "job_start", jobId: "job-1", toolCallId });
		instance.record({ kind: "tool_end", toolCallId });
		await instance.close();
		const captured = records(content.join(""));
		expect(captured).toHaveLength(3);
		expect(new Set(captured.map((record) => record.toolCallId)).size).toBe(1);
		expect(captured[0]?.toolCallId).toMatch(/^sha256:[a-f0-9]{64}$/);
		expect(content.join("")).not.toContain("opaque");
	});

	it("copies array members without caller serialization hooks or iterators", async () => {
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		const jobIds = ["job-1"];
		Object.defineProperty(jobIds, Symbol.iterator, {
			value: function* () {
				yield "secret-iterator";
			},
		});
		Object.defineProperty(jobIds, "toJSON", { value: () => ["secret-toJSON"] });
		instance.record({ kind: "wait_start", waitId: "wait-1", jobIds });
		await instance.close();
		expect(records(content[0]!)[0]?.jobIds).toEqual(["job-1"]);
		expect(content[0]).not.toContain("secret-");
	});

	it("bounds batches containing near-limit accepted records", async () => {
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		for (let index = 0; index < 128; index++) {
			instance.record({
				kind: "wait_start",
				waitId: `wait-${index}`,
				jobIds: Array.from({ length: 27 }, () => "x".repeat(128)),
			});
		}
		await instance.close();
		expect(records(content.join(""))).toHaveLength(128);
		for (const batch of content) {
			expect(Buffer.byteLength(batch)).toBeLessThan(256 * 1024);
			expect(records(batch).length).toBeLessThanOrEqual(64);
			for (const line of batch.trim().split("\n")) {
				expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(4 * 1024);
				expect(Buffer.byteLength(line)).toBeGreaterThan(3500);
			}
		}
	});

	it("drops oversized or invalid metadata and exposes sequence gaps and cumulative losses", async () => {
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		instance.record({ kind: "run_start" });
		instance.record({ kind: "wait_start", jobIds: Array.from({ length: 64 }, () => "x".repeat(128)) });
		instance.record({ kind: "tool_start", toolName: "private command with spaces" });
		instance.record({ kind: "job_read", outputBytes: -1 });
		instance.record({ kind: "job_read", outputRevision: Number.NaN });
		instance.record({ kind: "job_start", jobId: "/private/path" });
		instance.record({ kind: "tool_end", status: "secret-status" } as unknown as BackgroundJobDiagnosticEvent);
		instance.record({ kind: "secret-kind" } as unknown as BackgroundJobDiagnosticEvent);
		instance.record({ kind: "run_end" });
		await instance.close();
		const captured = records(content.join(""));
		expect(captured.map((record) => record.sequence)).toEqual([1, 9]);
		expect(captured[1]?.droppedEvents).toBe(7);
		for (const text of content) {
			expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024);
			for (const line of text.trim().split("\n")) expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(4 * 1024);
		}
	});

	it("retains a trailing drop count on the last buffered record without inventing lifecycle events", async () => {
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
			},
		});
		instance.record({ kind: "job_start", jobId: "job-1" });
		instance.record({ kind: "tool_start", toolName: "x".repeat(10000) });
		await instance.close();
		expect(records(content[0]!)).toMatchObject([{ kind: "job_start", sequence: 1, droppedEvents: 1 }]);
	});

	it("keeps one active and one bounded pending batch under pressure", async () => {
		const hold = gate();
		const content: string[] = [];
		const paths: string[] = [];
		let active = 0;
		let maximumActive = 0;
		const writer = vi.fn(async (path: string, text: string) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			paths.push(path);
			content.push(text);
			await hold.promise;
			active--;
		});
		const instance = collector({ writer });
		for (let index = 0; index < 200; index++)
			instance.record({ kind: "job_read", jobId: "job-1", outputRevision: index });
		expect(writer).not.toHaveBeenCalled();
		await Promise.resolve();
		expect(writer).toHaveBeenCalledTimes(1);
		const immutableFirst = content[0];
		hold.resolve();
		await vi.waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
		instance.record({ kind: "run_end" });
		await instance.close();
		expect(maximumActive).toBe(1);
		expect(content[0]).toBe(immutableFirst);
		expect(content.map((text) => records(text).length)).toEqual([64, 64, 1]);
		expect(records(content[1]!)[63]).toMatchObject({ sequence: 128, droppedEvents: 72 });
		expect(records(content[2]!)[0]).toMatchObject({ sequence: 201, droppedEvents: 72 });
		expect(new Set(paths).size).toBe(3);
	});

	it("flushes dirty batches every 30 seconds and clears timers on close", async () => {
		vi.useFakeTimers();
		const writer = vi.fn(async () => {});
		const instance = collector({ writer });
		await vi.advanceTimersByTimeAsync(30_000);
		expect(writer).not.toHaveBeenCalled();
		instance.record({ kind: "run_start" });
		await vi.advanceTimersByTimeAsync(29_999);
		expect(writer).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(writer).toHaveBeenCalledTimes(1);
		await instance.close();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(writer).toHaveBeenCalledTimes(1);
	});

	it("performs no filesystem work until an asynchronous flush", async () => {
		const instance = collector({ writer: diskWriter });
		instance.record({ kind: "run_start" });
		expect(existsSync(join(directory, "background-job-diagnostics"))).toBe(false);
		instance.flush();
		expect(existsSync(join(directory, "background-job-diagnostics"))).toBe(false);
		await instance.close();
		expect(await readdir(join(directory, "background-job-diagnostics"))).toHaveLength(1);
	});

	it("uses the private atomic platform sink for completed JSONL batches", async () => {
		const warn = vi.fn();
		const instance = collector({ warn });
		instance.record({ kind: "run_end" });
		await instance.close();
		expect(warn).not.toHaveBeenCalled();
		const target = join(directory, "background-job-diagnostics");
		const names = await readdir(target);
		expect(names).toHaveLength(1);
		expect(names[0]).toMatch(/^background-jobs-v1_.*\.jsonl$/);
		expect(records(await readFile(join(target, names[0]!), "utf8"))[0]?.kind).toBe("run_end");
		if (process.platform !== "win32") {
			expect((await lstat(target)).mode & 0o777).toBe(0o700);
			expect((await lstat(join(target, names[0]!))).mode & 0o777).toBe(0o600);
		}
	}, 15_000);

	it("disables capture on a private-directory failure without exposing the error", async () => {
		const target = join(directory, "outside");
		await mkdir(target);
		await symlink(
			target,
			join(directory, "background-job-diagnostics"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const warn = vi.fn();
		const instance = collector({ warn });
		instance.record({ kind: "run_end" });
		await instance.close();
		expect(instance.enabled).toBe(false);
		expect(warn).toHaveBeenCalledExactlyOnceWith();
		expect(await readdir(target)).toEqual([]);
	}, 15_000);

	it("disables and warns once on a writer failure, discarding pending work", async () => {
		const writer = vi.fn(async () => {
			throw new Error("secret path and credentials");
		});
		const warn = vi.fn(() => {
			throw new Error("warning sink failed");
		});
		const instance = collector({ writer, warn });
		instance.record({ kind: "run_end" });
		instance.record({ kind: "job_start", jobId: "pending" });
		await instance.close();
		instance.record({ kind: "run_end" });
		instance.flush();
		await instance.close();
		expect(instance.enabled).toBe(false);
		expect(writer).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledExactlyOnceWith();
	});

	it("bounds close to ten seconds and never starts the pending write after a timeout", async () => {
		vi.useFakeTimers();
		const hold = gate();
		const writer = vi.fn(async () => hold.promise);
		const warn = vi.fn();
		const instance = collector({ writer, warn });
		instance.record({ kind: "run_end" });
		instance.record({ kind: "job_start", jobId: "pending" });
		const close = instance.close();
		expect(instance.close()).toBe(close);
		let closed = false;
		void close.then(() => {
			closed = true;
		});
		await vi.advanceTimersByTimeAsync(9_999);
		expect(closed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await close;
		expect(closed).toBe(true);
		expect(warn).toHaveBeenCalledExactlyOnceWith();
		expect(vi.getTimerCount()).toBe(0);
		hold.resolve();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(writer).toHaveBeenCalledTimes(1);
	});

	it("drains active and pending batches on close and ignores later events", async () => {
		const hold = gate();
		const content: string[] = [];
		const instance = collector({
			writer: async (_path, text) => {
				content.push(text);
				await hold.promise;
			},
		});
		instance.record({ kind: "run_end" });
		instance.record({ kind: "job_end", jobId: "pending" });
		const close = instance.close();
		instance.record({ kind: "job_start", jobId: "too-late" });
		hold.resolve();
		await close;
		expect(content).toHaveLength(2);
		expect(content.join("")).not.toContain("too-late");
	});

	it("writes distinct immutable batches for concurrent runtimes in the same directory", async () => {
		const first = collector({ writer: diskWriter });
		const second = collector({ writer: diskWriter });
		first.record({ kind: "run_end" });
		second.record({ kind: "run_end" });
		await Promise.all([first.close(), second.close()]);
		const target = join(directory, "background-job-diagnostics");
		const names = await readdir(target);
		expect(names).toHaveLength(2);
		expect(first.runtimeId).not.toBe(second.runtimeId);
		const captured = await Promise.all(
			names.map(async (name) => records(await readFile(join(target, name), "utf8"))[0]),
		);
		expect(new Set(captured.map((record) => record?.runtimeId))).toEqual(
			new Set([first.runtimeId, second.runtimeId]),
		);
	});

	it("retains the newest 200 completed files without deleting foreign files, directories, or links", async () => {
		const target = join(directory, "background-job-diagnostics");
		await mkdir(target);
		const oldTime = new Date("2026-01-01T00:00:00Z");
		await Promise.all(
			Array.from({ length: 202 }, async (_, index) => {
				const path = join(target, ownedName(index));
				await writeFile(path, "{}\n");
				await utimes(path, oldTime, new Date(oldTime.getTime() + index));
			}),
		);
		const foreign = ["notes.jsonl", `${ownedName(1000)}.${randomUUID()}.tmp`];
		for (const name of foreign) await writeFile(join(target, name), "keep");
		await mkdir(join(target, ownedName(2000)));
		const outside = join(directory, "linked-target");
		await mkdir(outside);
		await symlink(outside, join(target, ownedName(3000)), process.platform === "win32" ? "junction" : "dir");
		const first = collector({ writer: diskWriter });
		const second = collector({ writer: diskWriter });
		first.record({ kind: "run_end" });
		second.record({ kind: "run_end" });
		await Promise.all([first.close(), second.close()]);
		const entries = await readdir(target, { withFileTypes: true });
		expect(entries.filter((entry) => entry.isFile() && !foreign.includes(entry.name))).toHaveLength(200);
		for (let index = 0; index < 4; index++) expect(existsSync(join(target, ownedName(index)))).toBe(false);
		for (const name of foreign) expect(await readFile(join(target, name), "utf8")).toBe("keep");
		expect((await lstat(join(target, ownedName(2000)))).isDirectory()).toBe(true);
		expect((await lstat(join(target, ownedName(3000)))).isSymbolicLink()).toBe(true);
	});

	it("enforces the 50 MiB completed-file limit", async () => {
		const target = join(directory, "background-job-diagnostics");
		await mkdir(target);
		const huge = join(target, ownedName(0));
		const file = await open(huge, "wx");
		await file.truncate(51 * 1024 * 1024);
		await file.close();
		await utimes(huge, new Date(0), new Date(0));
		const instance = collector({ writer: diskWriter });
		instance.record({ kind: "run_end" });
		await instance.close();
		expect(existsSync(huge)).toBe(false);
		expect((await readdir(target)).map((name) => basename(name))).toHaveLength(1);
	});
});
