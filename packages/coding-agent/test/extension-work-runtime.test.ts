import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionWorkBoundary,
	ExtensionWorkExecutionResult,
	ExtensionWorkManagerOptions,
} from "../src/core/extensions/work-host.ts";
import { ExtensionWorkManager, withoutExtensionWork } from "../src/core/extensions/work-runtime.ts";
import type {
	ExtensionWorkContext,
	ExtensionWorkTaskContext,
	ExtensionWorkTaskHandle,
} from "../src/core/extensions/work-types.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const managers: ExtensionWorkManager[] = [];
const implementation = {};
function readResult(revision = "v1"): ExtensionWorkExecutionResult {
	return {
		status: "ok",
		implementation,
		observation: {
			kind: "read",
			path: "/repo/file.ts",
			text: "source",
			startLine: 1,
			endLine: 1,
			revision,
			truncated: false,
		},
	};
}
function boundary(key = "input-1", revision = 1): ExtensionWorkBoundary {
	return {
		key,
		attemptId: `attempt-${revision}`,
		cause: "input",
		allowNewWork: true,
		snapshot: {
			branchId: "branch",
			revision,
			cwd: "/repo",
			mode: "build",
			inputs: [{ text: "look at file.ts", kind: "prompt" }],
			services: ["readText", "findPaths", "searchText"],
		},
	};
}
function setup(options: Partial<ExtensionWorkManagerOptions> = {}) {
	const execute = vi.fn<ExtensionWorkManagerOptions["execute"]>(async () => readResult());
	const manager = new ExtensionWorkManager({
		execute,
		isCurrent: () => true,
		onBoundary: () => {},
		onOperation: () => {},
		...options,
	});
	managers.push(manager);
	manager.boundary(boundary());
	return { manager, execute };
}
function context(manager: ExtensionWorkManager, owner = "one"): ExtensionWorkContext {
	const value = manager.getContext(owner);
	if (!value) throw new Error("Missing work context");
	return value;
}
function start(
	work: ExtensionWorkContext,
	callback: (task: ExtensionWorkTaskContext) => Promise<void>,
	key = "test",
): ExtensionWorkTaskHandle {
	const result = work.tasks.start({ key, label: "Test" }, callback);
	if (result.status !== "started") throw new Error(`Unexpected admission: ${result.status}`);
	return result.task;
}
async function contribute(manager: ExtensionWorkManager, owner = "one", key = "source") {
	const task = start(
		context(manager, owner),
		async (ctx) => {
			const result = await ctx.repository.readText({ path: "file.ts" });
			if (result.status !== "ok") throw new Error(result.status);
			expect(
				ctx.context.put({ key, text: result.text, dependency: "sources", evidenceIds: [result.evidence.id] }),
			).toEqual({ status: "accepted" });
		},
		key,
	);
	await task.wait();
	expect(task.status().state).toBe("completed");
}

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	vi.useRealTimers();
});

describe("extension managed work", () => {
	it("owns snapshots and invalidates retained facades without reviving a retired scope", async () => {
		const { manager } = setup();
		const work = context(manager);
		work.snapshot.inputs[0].text = "mutated";
		expect(context(manager).snapshot.inputs[0].text).toBe("look at file.ts");
		manager.invalidate();
		expect(work.tasks.start({ key: "late", label: "Late" }, async () => {})).toEqual({
			status: "invalidated",
			reason: "scope_invalidated",
		});
		manager.boundary(boundary());
		expect(manager.getContext("one")).toBeUndefined();
		manager.boundary(boundary("input-2"));
		expect(context(manager).snapshot.scopeId).not.toBe(work.snapshot.scopeId);
	});

	it("collects real evidence after the producing task completes and rejects changed sources", async () => {
		const { manager, execute } = setup();
		await contribute(manager);
		expect(await manager.collect(1, () => true)).toContain('"/repo/file.ts":1-1');
		expect(execute).toHaveBeenCalledTimes(2);
		expect(manager.getStatus("one").contributions[0].status).toBe("admitted");
		execute.mockResolvedValue(readResult("v2"));
		expect(await manager.collect(1, () => true)).toBeUndefined();
		expect(manager.getStatus("one").contributions[0].reason).toBe("source_unverified");
	});

	it.each(["remove", "replace"] as const)("honors contribution %s while validation awaits", async (action) => {
		vi.useFakeTimers();
		const { manager, execute } = setup();
		await contribute(manager);
		const entered = deferred<void>();
		const release = deferred<ExtensionWorkExecutionResult>();
		execute.mockImplementationOnce(async () => {
			entered.resolve();
			return release.promise;
		});
		const collecting = manager.collect(1, () => true);
		await entered.promise;
		await start(context(manager), async (task) => {
			if (action === "remove") task.context.remove("source");
			else task.context.put({ key: "source", text: "replacement" });
		}).wait();
		release.resolve(readResult());
		expect(await collecting).toBeUndefined();
		const next = await manager.collect(1, () => true);
		if (action === "replace") expect(next).toContain("replacement");
		else expect(next).toBeUndefined();
	});

	it("deduplicates live keys and bounds admission without a pending queue", async () => {
		const gate = deferred<void>();
		const { manager } = setup({ limits: { perRuntimeTasks: 1 } });
		const work = context(manager);
		const task = start(work, async () => gate.promise);
		const duplicate = work.tasks.start({ key: "test", label: "Duplicate" }, async () => {});
		expect(duplicate.status).toBe("already_running");
		if (duplicate.status === "already_running") expect(duplicate.task.id).toBe(task.id);
		expect(work.tasks.start({ key: "other", label: "Other" }, async () => {})).toEqual({
			status: "limit_exceeded",
			reason: "task_capacity",
		});
		gate.resolve();
		await task.wait();
	});

	it("retains capacity until fire-and-forget operations actually drain", async () => {
		const entered = deferred<void>();
		const release = deferred<ExtensionWorkExecutionResult>();
		const returned = deferred<void>();
		const { manager } = setup({
			limits: { perRuntimeTasks: 1 },
			execute: async () => {
				entered.resolve();
				return release.promise;
			},
		});
		const work = context(manager);
		let retained: ExtensionWorkTaskContext | undefined;
		const task = start(work, async (ctx) => {
			retained = ctx;
			void ctx.repository.readText({ path: "file.ts" });
			await entered.promise;
			returned.resolve();
		});
		await returned.promise;
		await Promise.resolve();
		expect(task.status().state).toBe("draining");
		expect(work.tasks.start({ key: "other", label: "Other" }, async () => {})).toMatchObject({
			status: "limit_exceeded",
		});
		expect(await retained!.repository.readText({ path: "late.ts" })).toMatchObject({ status: "cancelled" });
		release.resolve(readResult());
		await task.wait();
		expect(task.status().state).toBe("completed");
	});

	it("rejects recursive task starts and managed calls throughout policy async lineage", async () => {
		const { manager, execute } = setup();
		const work = context(manager);
		const task = start(work, async (ctx) => {
			expect(work.tasks.start({ key: "nested", label: "Nested" }, async () => {})).toMatchObject({
				status: "denied",
			});
			await withoutExtensionWork(async () => {
				await Promise.resolve();
				expect(await ctx.repository.readText({ path: "secret" })).toEqual({
					status: "denied",
					reason: "recursive_work",
				});
				expect(manager.getContext("one")).toBeUndefined();
			});
		});
		await task.wait();
		expect(execute).not.toHaveBeenCalled();
	});

	it("fences task deadlines without declaring an unresponsive callback settled", async () => {
		vi.useFakeTimers();
		const release = deferred<void>();
		const { manager } = setup({ limits: { taskTimeoutMs: 5, perRuntimeTasks: 1 } });
		const work = context(manager);
		let signal: AbortSignal | undefined;
		const task = start(work, async (ctx) => {
			signal = ctx.signal;
			await release.promise;
		});
		await vi.advanceTimersByTimeAsync(5);
		expect(signal?.aborted).toBe(true);
		expect(task.status().state).toBe("cancelling");
		expect(task.status().endedAt).toBeUndefined();
		expect(work.tasks.start({ key: "next", label: "Next" }, async () => {})).toMatchObject({
			status: "limit_exceeded",
		});
		release.resolve();
		expect((await task.wait()).state).toBe("cancelled");
	});

	it("omits late validation but retains host cleanup ownership until it drains", async () => {
		vi.useFakeTimers();
		const { manager, execute } = setup();
		await contribute(manager);
		const release = deferred<ExtensionWorkExecutionResult>();
		execute.mockImplementation(async () => release.promise);
		const collecting = manager.collect(1, () => true);
		await vi.advanceTimersByTimeAsync(25);
		expect(await collecting).toBeUndefined();
		expect(await manager.collect(1, () => true)).toBeUndefined();
		let closed = false;
		const closing = manager.close().then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		release.resolve(readResult());
		await closing;
		expect(closed).toBe(true);
	});

	it("enforces the collection deadline even when timer delivery is delayed", async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			const { manager, execute } = setup();
			for (const key of ["one", "two", "three"]) await contribute(manager, "one", key);
			execute.mockClear();
			execute.mockImplementation(async () => {
				clock.mockReturnValue(26);
				return readResult();
			});
			expect(await manager.collect(1, () => true)).toBeUndefined();
			expect(execute).toHaveBeenCalledTimes(2);
			expect(manager.getStatus("one").contributions.every((item) => item.reason === "source_unverified")).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});

	it("uses registration/key order, isolates ownership, and invalidates snapshot suggestions", async () => {
		const { manager } = setup();
		const one = context(manager, "one");
		const two = context(manager, "two");
		await start(two, async (task) => {
			task.context.put({ key: "second", text: "second suggestion" });
		}).wait();
		await start(one, async (task) => {
			task.context.put({ key: "first", text: "first suggestion" });
		}).wait();
		const suffix = await manager.collect(1, () => true);
		expect(suffix!.indexOf("first suggestion")).toBeLessThan(suffix!.indexOf("second suggestion"));
		manager.boundary(boundary("input-1", 2));
		expect(await manager.collect(2, () => true)).toBeUndefined();
		expect(manager.getStatus("one").contributions[0].reason).toBe("snapshot_changed");
		await start(context(manager), async (task) => {
			expect(task.context.put({ key: "forged", text: "source", evidenceIds: ["invented"] })).toMatchObject({
				status: "denied",
			});
		}).wait();
	});

	it("does not await unfinished preparation or read when context headroom is absent", async () => {
		const release = deferred<void>();
		const { manager, execute } = setup();
		const task = start(context(manager), async () => release.promise);
		expect(await manager.collect(1, () => true)).toBeUndefined();
		release.resolve();
		await task.wait();
		await contribute(manager);
		execute.mockClear();
		expect(await manager.collect(1, () => true, 0)).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();
	});

	it("charges shared operation budgets and rejects host limit expansion", async () => {
		const { manager, execute } = setup({ limits: { scopeOperations: 1 } });
		await contribute(manager);
		expect(await manager.collect(1, () => true)).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(
			() =>
				new ExtensionWorkManager({
					execute,
					isCurrent: () => true,
					onBoundary: () => {},
					onOperation: () => {},
					limits: { perRuntimeTasks: 100 },
				}),
		).toThrow("Invalid extension work limit");
	});

	it("revokes returned task contexts and guards against late contributions", async () => {
		const { manager } = setup();
		let retained: ExtensionWorkTaskContext | undefined;
		await start(context(manager), async (task) => {
			retained = task;
		}).wait();
		expect(retained!.context.put({ key: "late", text: "late" })).toMatchObject({ status: "cancelled" });
		const execute = vi.fn();
		manager.boundary({ ...boundary("input-1", 2), allowNewWork: false });
		expect(context(manager).tasks.start({ key: "late", label: "Late" }, execute)).toEqual({
			status: "denied",
			reason: "final_response",
		});
		expect(execute).not.toHaveBeenCalled();
	});
});
