import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ExtensionServicesManager } from "../src/core/extensions/services-runtime.ts";
import type { ExtensionServicesContext, ExtensionServicesTaskHandle } from "../src/core/extensions/services-types.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

async function setup(factories: ExtensionFactory[]) {
	const runtime = createExtensionRuntime();
	const bus = createEventBus();
	const extensions = await Promise.all(
		factories.map((factory, index) => loadExtensionFromFactory(factory, "/repo", bus, runtime, `<test:${index}>`)),
	);
	const session = SessionManager.inMemory("/repo");
	const runner = new ExtensionRunner(
		extensions,
		runtime,
		"/repo",
		session,
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
	const work = new ExtensionServicesManager({
		isCurrent: () => true,
		execute: async () => ({ status: "unavailable", reason: "test" }),
		onBoundary: (event) => runner.emitRequestBoundary(event),
		onOperation: (event) => runner.emitExtensionOperation(event),
	});
	runner.bindServices(work);
	cleanup.push(async () => {
		runner.invalidate();
		await work.close();
		await session.closePersistence();
	});
	const boundary = () =>
		work.boundary({
			key: "input",
			attemptId: "attempt",
			cause: "input",
			allowNewWork: true,
			snapshot: {
				branchId: "branch",
				revision: 1,
				cwd: "/repo",
				mode: "build",
				inputs: [{ text: "request", kind: "prompt" }],
				services: ["readText"],
				skills: [],
				skillsTruncated: false,
			},
		});
	return { runner, work, boundary };
}

describe("extension services API binding", () => {
	it("binds isolated extension ownership and exposes bounded status through the extension API", async () => {
		let first!: ExtensionAPI;
		let second!: ExtensionAPI;
		const handles: ExtensionServicesTaskHandle[] = [];
		const make: ExtensionFactory = (api) => {
			api.on("request_boundary", (_event, ctx) => {
				const admitted = ctx.services!.tasks.start({ key: "same", label: "Test" }, async (task) => {
					task.context.put({ key: "same", text: "suggestion" });
				});
				if (admitted.status === "started") handles.push(admitted.task);
			});
		};
		const { boundary } = await setup([
			(api) => {
				first = api;
				make(api);
			},
			(api) => {
				second = api;
				make(api);
			},
		]);
		boundary();
		await Promise.all(handles.map((handle) => handle.wait()));
		expect(handles).toHaveLength(2);
		expect(first.getServicesStatus().tasks).toHaveLength(1);
		expect(second.getServicesStatus().tasks).toHaveLength(1);
		expect(first.getServicesStatus().tasks[0].id).not.toBe(second.getServicesStatus().tasks[0].id);
	});

	it("does not await boundary callbacks and contains asynchronous observer errors", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { runner, boundary } = await setup([
			(api) => {
				api.on("request_boundary", async () => {
					await pending;
					throw new Error("sensitive detail");
				});
			},
		]);
		const report = vi.fn();
		runner.onError(report);
		boundary();
		expect(report).not.toHaveBeenCalled();
		release();
		await pending;
		await Promise.resolve();
		expect(report).toHaveBeenCalledWith({
			extensionPath: "<extension-services>",
			event: "request_boundary",
			error: "Extension services observer failed",
		});
	});

	it("supplies fixed managed policy signals, forbids work, and fails result reducers closed only in strict mode", async () => {
		const signal = new AbortController().signal;
		const { runner, boundary } = await setup([
			(api) => {
				api.on("tool_result", (_event, ctx) => {
					expect(ctx.services).toBeUndefined();
					if (ctx.signal) expect(ctx.signal).toBe(signal);
					throw new Error("private policy exception");
				});
			},
		]);
		boundary();
		const report = vi.fn();
		runner.onError(report);
		const event = {
			type: "tool_result" as const,
			toolName: "read",
			toolCallId: "call",
			input: { path: "x" },
			content: [{ type: "text" as const, text: "secret" }],
			isError: false,
		};
		await expect(runner.emitToolResult(event, { signal, strict: true })).rejects.toThrow("private policy exception");
		expect(report).not.toHaveBeenCalled();
		await expect(runner.emitToolResult(event)).resolves.toBeUndefined();
		expect(report).toHaveBeenCalledOnce();
	});

	it("prevents async operation-observer feedback through a captured facade", async () => {
		let captured!: ExtensionServicesContext;
		let finished!: () => void;
		const observed = new Promise<void>((resolve) => {
			finished = resolve;
		});
		const { boundary } = await setup([
			(api) => {
				api.on("request_boundary", (_event, ctx) => {
					ctx.services!.tasks.start({ key: "read", label: "Read" }, async (task) => {
						await task.repository.readText({ path: "x" });
					});
				});
			},
			(api) => {
				api.on("request_boundary", (_event, ctx) => {
					captured = ctx.services!;
				});
				api.on("extension_operation", async (_event, ctx) => {
					await Promise.resolve();
					expect(ctx.services).toBeUndefined();
					expect(captured.tasks.start({ key: "loop", label: "Loop" }, async () => {})).toMatchObject({
						status: "denied",
					});
					finished();
				});
			},
		]);
		boundary();
		await observed;
	});
});
