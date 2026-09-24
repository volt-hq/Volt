import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@hansjm10/volt-ai";
import { Container } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import * as captureSink from "../../../src/core/tool-progress-capture.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("regression #352: active debug capture", () => {
	const harnesses: Harness[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
		vi.restoreAllMocks();
	});

	it("captures unfinished faux arguments through the real debug handler without steering or cancelling", async () => {
		let executions = 0;
		const tool: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Test tool",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		const value = "雪".repeat(1800);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxThinking("hidden-only-reasoning"), fauxToolCall("probe", { value }, { id: "live-call" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("complete"),
		]);
		let captured = false;
		let snapshot: ReturnType<typeof harness.session.getToolProgressDiagnostics> | undefined;
		const showError = vi.fn();
		const context = {
			isInitialized: true,
			session: harness.session,
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			showError,
		};
		const handleDebug = Reflect.get(InteractiveMode.prototype, "handleDebugCommand") as (
			this: typeof context,
		) => Promise<void>;
		let debugCapture: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (captured || event.type !== "message_update" || event.assistantMessageEvent.type !== "toolcall_delta")
				return;
			captured = true;
			snapshot = harness.session.getToolProgressDiagnostics();
			debugCapture = handleDebug.call(context);
		});
		await harness.session.prompt("prepare then execute");
		await debugCapture;
		expect(captured).toBe(true);
		expect(showError).not.toHaveBeenCalled();
		expect(snapshot?.calls[0]).toMatchObject({
			callId: "live-call",
			phase: "preparing",
			executionStarted: false,
			argumentEvents: 1,
		});
		expect(snapshot?.queue.available).toBe(true);
		expect(executions).toBe(1);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(
			harness
				.eventsOfType("message_end")
				.filter((event) => event.message.role === "assistant")
				.every((event) => event.message.role === "assistant" && event.message.stopReason !== "aborted"),
		).toBe(true);
		const saved = readFileSync(join(harness.tempDir, "debug", "tool-progress-latest.json"), "utf8");
		expect(saved).not.toContain("hidden-only-reasoning");
		expect(JSON.parse(saved)).toMatchObject({ reason: "manual", calls: [{ phase: "preparing" }] });
		const final = harness.session.getToolProgressDiagnostics().calls[0];
		expect(final).toMatchObject({
			phase: "completed",
			argumentBytes: Buffer.byteLength(JSON.stringify({ value })),
			sampleTruncated: true,
		});
	});

	it("automatically captures a generation safeguard and remains usable for the next prompt", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([
			{
				...fauxAssistantMessage(
					fauxToolCall("edit", { path: "never.ts", newText: "not applied" }, { id: "guarded" }),
					{ stopReason: "error", errorMessage: "Tool argument safeguard stopped generation" },
				),
				diagnostics: [
					{
						type: "tool_argument_generation_limit",
						timestamp: Date.now(),
						details: { bytes: 1024, events: 10, elapsedMs: 5000 },
					},
				],
			},
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("hit a safeguard");
		await harness.session.waitForToolProgressDiagnostics();
		const capture = JSON.parse(readFileSync(join(harness.tempDir, "debug", "tool-progress-latest.json"), "utf8"));
		expect(capture).toMatchObject({
			reason: "safeguard",
			calls: [{ phase: "not_started", executionStarted: false }],
		});
		expect(harness.eventsOfType("tool_execution_start")).toEqual([]);
		await harness.session.prompt("continue");
		expect(harness.session.getToolProgressDiagnostics().calls).toEqual([]);
	});

	it("capture failures are reported locally while faux generation continues", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("complete")]);
		const showError = vi.fn();
		const capture = vi.spyOn(harness.session, "captureToolProgressDiagnostics").mockImplementation(() => {
			throw new Error("disk full");
		});
		const context = { session: harness.session, showError, isInitialized: true };
		const handleDebug = Reflect.get(InteractiveMode.prototype, "handleDebugCommand") as (
			this: typeof context,
		) => Promise<void>;
		harness.session.subscribe((event) => {
			if (event.type === "message_update") void handleDebug.call(context);
		});
		await harness.session.prompt("continue despite capture error");
		expect(showError).toHaveBeenCalledWith("Failed to write debug log: disk full");
		capture.mockRestore();
		expect(harness.session.isStreaming).toBe(false);
	});

	it("records an interrupted execution with its authoritative keyboard abort source", async () => {
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for abort",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) =>
				new Promise((_resolve, reject) => {
					markStarted();
					signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
				}),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}, { id: "executing" }), { stopReason: "toolUse" }),
		]);
		const prompt = harness.session.prompt("execute and interrupt");
		await started;
		await harness.session.abort("keyboard_interrupt");
		await prompt;
		expect(harness.session.getToolProgressDiagnostics()).toMatchObject({
			runtimeAbort: { source: "keyboard_interrupt" },
			calls: [{ callId: "executing", phase: "interrupted", executionStarted: true }],
		});
	});

	it("labels synthetic disposal cleanup as never-started and releases live samples", async () => {
		const harness = await createHarness({ tokensPerSecond: 100 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("edit", { path: "never.ts", oldText: "before", newText: "after" }, { id: "dispose-call" }),
				{ stopReason: "toolUse" },
			),
		]);
		let disposed = false;
		harness.session.subscribe((event) => {
			if (!disposed && event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta") {
				disposed = true;
				harness.session.dispose();
			}
		});
		await harness.session.prompt("dispose during preparation");
		await harness.session.waitForClosed();
		const results = harness.sessionManager
			.buildSessionContext()
			.messages.filter((message) => message.role === "toolResult");
		expect(results).toMatchObject([
			{ toolCallId: "dispose-call", details: { execution: { state: "not_started", synthetic: true } } },
		]);
		expect(harness.session.getToolProgressDiagnostics().calls).toEqual([]);
	});

	it("keeps faux execution, cancellation and timers responsive while the capture writer is stalled", async () => {
		let releaseWrite = () => {};
		const blockedWrite = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const writer = vi.spyOn(captureSink, "writeToolProgressCapture").mockImplementation(async () => blockedWrite);
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "wait",
			parameters: Type.Object({}),
			execute: async (_id, _args, signal) =>
				new Promise((_resolve, reject) => {
					markStarted();
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })]);
		let capture: Promise<string> | undefined;
		harness.session.subscribe((event) => {
			if (!capture && event.type === "message_update") capture = harness.session.captureToolProgressDiagnostics();
		});
		try {
			const prompt = harness.session.prompt("keep running");
			await started;
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
			expect(writer).toHaveBeenCalledTimes(1);
			await harness.session.abort("keyboard_interrupt");
			await prompt;
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			releaseWrite();
			await capture;
		}
	});
});
