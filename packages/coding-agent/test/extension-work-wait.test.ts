import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionWorkBoundary,
	ExtensionWorkExecutionResult,
	ExtensionWorkManagerOptions,
} from "../src/core/extensions/work-host.ts";
import { ExtensionWorkManager, withoutExtensionWork } from "../src/core/extensions/work-runtime.ts";
import type {
	ExtensionWorkContext,
	ExtensionWorkTaskHandle,
	RequestBoundaryEvent,
} from "../src/core/extensions/work-types.ts";

const managers: ExtensionWorkManager[] = [];
const release: Array<() => void> = [];
afterEach(async () => {
	for (const done of release.splice(0)) done();
	for (const manager of managers.splice(0)) await manager.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	release.push(resolve);
	return { promise, resolve };
}
function boundary(key = "request"): ExtensionWorkBoundary {
	return {
		key,
		attemptId: "attempt",
		cause: "input",
		allowNewWork: true,
		snapshot: {
			branchId: "branch",
			revision: 1,
			cwd: "/repo",
			mode: "build",
			inputs: [],
			services: [],
			skills: [],
			skillsTruncated: false,
		},
	};
}
function setup(
	onBoundary: (work: ExtensionWorkContext, event: RequestBoundaryEvent) => void,
	wait?: number,
	execute: ExtensionWorkManagerOptions["execute"] = async () => ({ status: "unavailable", reason: "test" }),
) {
	const manager = new ExtensionWorkManager({
		limits: wait === undefined ? {} : { firstRequestWaitMs: wait },
		isCurrent: () => true,
		execute,
		onOperation: () => {},
		onBoundary: (event) => onBoundary(manager.getContext("one")!, event),
	});
	managers.push(manager);
	return manager;
}

async function prepareCollection(wait: number) {
	const gate = deferred();
	const validation = vi.fn<(signal: AbortSignal) => Promise<void>>(() => gate.promise);
	const result: ExtensionWorkExecutionResult = {
		status: "ok",
		implementation: {},
		observation: {
			kind: "read",
			path: "/repo/file.ts",
			text: "prepared source",
			startLine: 1,
			endLine: 1,
			revision: "v1",
			truncated: false,
		},
	};
	const manager = setup(
		(work) => work.context.requestWait(wait),
		wait,
		async ({ origin, signal }) => {
			if (origin.ownerKind === "validation") await validation(signal);
			return result;
		},
	);
	manager.boundary(boundary());
	const admission = manager.getContext("one")!.tasks.start({ key: "source", label: "Source" }, async (task) => {
		const read = await task.repository.readText({ path: "file.ts" });
		if (read.status !== "ok") throw new Error(read.status);
		expect(
			task.context.put({ key: "source", text: read.text, dependency: "sources", evidenceIds: [read.evidence.id] }),
		).toEqual({ status: "accepted" });
	});
	if (admission.status !== "started") throw new Error(admission.status);
	expect((await admission.task.wait()).state).toBe("completed");
	return { manager, validation, gate };
}

describe("bounded first-request preparation wait", () => {
	it("defaults to ready-only despite extension requests", async () => {
		const gate = deferred();
		const manager = setup((work, event) => {
			expect(event.waitAvailableMs).toBe(0);
			expect(work.context.requestWait(100)).toBe(0);
			work.tasks.start({ key: "slow", label: "slow" }, () => gate.promise);
		});
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true)).toBeUndefined();
	});

	it("shares a maximum, not a sum, and grants no renewed allowance", async () => {
		vi.useFakeTimers();
		const gate = deferred();
		let retained!: ExtensionWorkContext;
		const manager = setup((work, event) => {
			retained = work;
			if (!event.first) {
				expect(work.context.requestWait(100)).toBe(0);
				return;
			}
			expect(work.context.requestWait(40)).toBe(40);
			expect(manager.getContext("two")!.context.requestWait(60)).toBe(60);
			work.tasks.start({ key: "slow", label: "slow" }, () => gate.promise);
		}, 100);
		manager.boundary(boundary());
		expect(retained.context.requestWait(100)).toBe(0);
		let settled = false;
		const collecting = manager
			.collect(1, () => true)
			.then(() => {
				settled = true;
			});
		await vi.advanceTimersByTimeAsync(59);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await collecting;
		expect(settled).toBe(true);
		manager.boundary({ ...boundary(), cause: "retry" });
		expect(await manager.collect(1, () => true)).toBeUndefined();
	});

	it("clamps requests and collects completed preparation without spending the remaining wait", async () => {
		vi.useFakeTimers();
		let handle: ExtensionWorkTaskHandle | undefined;
		const manager = setup((work) => {
			expect(work.context.requestWait(500)).toBe(25);
			const admission = work.tasks.start({ key: "ready", label: "ready" }, async (task) => {
				task.context.put({ key: "context", text: "prepared before inference" });
			});
			if (admission.status === "started") handle = admission.task;
		}, 25);
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true)).toContain("prepared before inference");
		expect(handle?.status().state).toBe("completed");
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([0, 100])("retains the process collection ceiling with a %i ms preparation allowance", async (wait) => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(0);
		const runtimes = [];
		for (let i = 0; i < 5; i++) runtimes.push(await prepareCollection(wait));

		const collecting = runtimes.map(({ manager }) => manager.collect(1, () => true));
		await vi.advanceTimersByTimeAsync(0);
		expect(runtimes.map(({ validation }) => validation.mock.calls.length)).toEqual([1, 1, 1, 1, 0]);
		expect(await collecting[4]).toBeUndefined();
		expect(runtimes[4].manager.getStatus("one").contributions).toEqual([{ key: "source", status: "ready" }]);

		// Timeouts abort validation, but cannot release capacity before the operations drain.
		await vi.advanceTimersByTimeAsync(25);
		expect(await Promise.all(collecting)).toEqual(Array(5).fill(undefined));
		for (const { validation } of runtimes.slice(0, 4)) expect(validation.mock.calls[0][0].aborted).toBe(true);
		expect(await runtimes[4].manager.collect(1, () => true)).toBeUndefined();
		expect(runtimes[4].validation).not.toHaveBeenCalled();

		runtimes[0].gate.resolve();
		await runtimes[0].manager.drain();
		runtimes[4].gate.resolve();
		expect(await runtimes[4].manager.collect(1, () => true)).toContain("prepared source");
		expect(runtimes[4].validation).toHaveBeenCalledTimes(1);
	});

	it("does not replace a same-runtime collection acquired during preparation waiting", async () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(0);
		const { manager, validation, gate } = await prepareCollection(100);
		const waiting = manager.collect(1, () => true);
		const overtaking = manager.collect(1, () => true);
		await vi.advanceTimersByTimeAsync(0);
		expect(validation).toHaveBeenCalledTimes(1);
		expect(await waiting).toBeUndefined();

		manager.invalidate();
		expect(validation.mock.calls[0][0].aborted).toBe(true);
		let drained = false;
		const draining = manager.drain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		gate.resolve();
		expect(await overtaking).toBeUndefined();
		await draining;
		expect(drained).toBe(true);
	});

	it("consumes the allowance even when the first request has no context headroom", async () => {
		const gate = deferred();
		const manager = setup((work) => {
			work.context.requestWait(100);
			work.tasks.start({ key: "slow", label: "slow" }, () => gate.promise);
		}, 100);
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true, 0)).toBeUndefined();
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true)).toBeUndefined();
	});

	it("revocation releases the foreground wait without joining an unresponsive callback", async () => {
		const gate = deferred();
		const manager = setup((work) => {
			work.context.requestWait(100);
			work.tasks.start({ key: "slow", label: "slow" }, () => gate.promise);
		}, 100);
		manager.boundary(boundary());
		const collecting = manager.collect(1, () => true);
		manager.invalidate();
		expect(await collecting).toBeUndefined();
	});

	it("excludes contributions completed past the deadline even if timers have not fired", async () => {
		vi.useFakeTimers();
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		const manager = setup((work, event) => {
			if (!event.first) return;
			work.context.requestWait(100);
			work.tasks.start({ key: "late", label: "late" }, async (task) => {
				clock.mockReturnValue(101);
				task.context.put({ key: "context", text: "late context" });
			});
		}, 100);
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true)).toBeUndefined();
		manager.boundary(boundary());
		expect(await manager.collect(1, () => true)).toContain("late context");
	});

	it("rejects asynchronous and policy-lineage wait requests", async () => {
		const observed = deferred();
		const manager = setup((work) => {
			expect(withoutExtensionWork(() => work.context.requestWait(100))).toBe(0);
			void Promise.resolve().then(() => {
				expect(work.context.requestWait(100)).toBe(0);
				observed.resolve();
			});
		}, 100);
		manager.boundary(boundary());
		await observed.promise;
		expect(await manager.collect(1, () => true)).toBeUndefined();
	});

	it("rejects host ceilings above 100 ms and does not grant waits for final responses", async () => {
		expect(() => setup(() => {}, 101)).toThrow("Invalid extension work limit");
		const manager = setup((work, event) => {
			expect(event.waitAvailableMs).toBe(0);
			expect(work.context.requestWait(1)).toBe(0);
		}, 100);
		manager.boundary({ ...boundary(), allowNewWork: false });
		expect(await manager.collect(1, () => true)).toBeUndefined();
	});
});
