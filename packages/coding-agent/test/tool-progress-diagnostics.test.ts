import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent } from "@hansjm10/volt-ai";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TOOL_PROGRESS_MAX_CALLS,
	TOOL_PROGRESS_SAMPLE_BYTES,
	ToolProgressDiagnostics,
} from "../src/core/tool-progress-diagnostics.ts";

describe("bounded tool diagnostics", () => {
	const directories: string[] = [];
	function setup() {
		const directory = mkdtempSync(join(tmpdir(), "volt-progress-"));
		directories.push(directory);
		const collector = new ToolProgressDiagnostics(directory, () => "test-session");
		const message = fauxAssistantMessage([]);
		collector.observe({ type: "agent_start" });
		collector.observe({ type: "message_start", message });
		const update = (event: AssistantMessageEvent) =>
			collector.observe({ type: "message_update", message, assistantMessageEvent: event });
		const start = (id = "call", index = 0) =>
			update({
				type: "toolcall_start",
				id,
				name: "edit",
				contentIndex: index,
				seq: 0,
				snapshot: message,
				toolState: [],
			});
		const delta = (text: string, index = 0) =>
			update({
				type: "toolcall_delta",
				argsTextDelta: text,
				contentIndex: index,
				seq: 1,
				snapshot: message,
				toolState: [],
			});
		return { collector, start, delta, update, directory, message };
	}
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it.each(["message_end", "agent_end"] as const)("releases the live queue reader after %s", (terminal) => {
		const { collector, message } = setup();
		const metrics = {
			queuedEvents: 3,
			peakQueuedEvents: 5,
			queuedBytes: 100,
			peakQueuedBytes: 200,
			waitingConsumers: 0,
		};
		const reader = vi.fn(() => ({ ...metrics }));
		collector.setQueueMetricsReader(reader);
		expect(collector.snapshot().queue).toEqual({ available: true, ...metrics });
		collector.observe(terminal === "message_end" ? { type: terminal, message } : { type: terminal, messages: [] });
		const completed = collector.snapshot().queue;
		metrics.queuedEvents = 0;
		metrics.queuedBytes = 0;
		expect(collector.snapshot().queue).toEqual(completed);
		expect(reader).toHaveBeenCalledTimes(2);
		collector.dispose();
		expect(collector.snapshot().queue).toEqual({ available: false });
	});

	it("caps retained arguments and calls while preserving UTF-8 byte counts", () => {
		const { collector, start, delta } = setup();
		start();
		delta("\ud83d");
		delta("\ude00");
		expect(collector.snapshot().calls[0]?.argumentBytes).toBe(4);
		expect(collector.snapshot().calls[0]?.rawArgumentSample).toBe("😀");
		for (let index = 1; index < 100; index++) {
			start(`call-${index}`, index);
			delta("雪".repeat(10_000), index);
		}
		const snapshot = collector.snapshot();
		expect(snapshot.calls).toHaveLength(TOOL_PROGRESS_MAX_CALLS);
		expect(snapshot.omittedCalls).toBe(100 - TOOL_PROGRESS_MAX_CALLS);
		for (const call of snapshot.calls) {
			expect(call.argumentBytes).toBe(30_000);
			expect(Buffer.byteLength(call.rawArgumentSample)).toBeLessThanOrEqual(TOOL_PROGRESS_SAMPLE_BYTES);
			expect(call.sampleTruncated).toBe(true);
		}
		collector.dispose();
		expect(collector.snapshot().calls).toEqual([]);
	});

	it.each([
		{ label: "three-byte character", padding: 4094, chunks: ["雪", "Y"], suffix: "" },
		{ label: "four-byte character", padding: 4094, chunks: ["😀", "Y"], suffix: "" },
		{ label: "split pair exceeding capacity", padding: 4094, chunks: ["\ud83d", "", "\ude00", "Y"], suffix: "" },
		{ label: "split pair growing past a full sample", padding: 4093, chunks: ["\ud83d", "\ude00", "Y"], suffix: "" },
		{ label: "split pair fitting exactly", padding: 4092, chunks: ["\ud83d", "", "\ude00", "Y"], suffix: "😀" },
	])("retains a true argument prefix at the byte cap: $label", ({ padding, chunks, suffix }) => {
		const { collector, start, delta } = setup();
		const prefix = "x".repeat(padding);
		start();
		delta(prefix);
		for (const chunk of chunks) delta(chunk);
		const call = collector.snapshot().calls[0]!;
		expect(call.rawArgumentSample).toBe(prefix + suffix);
		expect(Buffer.byteLength(call.rawArgumentSample)).toBeLessThanOrEqual(TOOL_PROGRESS_SAMPLE_BYTES);
		expect(call.argumentBytes).toBe(Buffer.byteLength(prefix + chunks.join("")));
		expect(call.sampleTruncated).toBe(true);
	});

	it.each([
		'{"path":"x","apiKey":"credential-value"}',
		'{"path":"x","api\\u004bey":"credential-value"}',
		'{"command":"export API_KEY=credential-value; echo ok"}',
		'{"command":"export GITHUB_TOKEN=credential-value; echo ok"}',
		'{"command":"export AWS_SECRET_ACCESS_KEY=credential-value; echo ok"}',
		'{"command":"export TOKEN=credential-value; echo ok"}',
		'{"command":"curl -H \\"Authorization: Bearer credential-value\\""}',
		'{"headers":{"custom":"credential-value"}}',
		'{"newText":"const password = credential-value"}',
	])("redacts recognizable credentials across chunks: %s", async (raw) => {
		const { collector, start, delta } = setup();
		start();
		for (const character of raw) delta(character);
		const path = await collector.capture();
		const saved = readFileSync(path, "utf8");
		expect(saved).not.toContain("credential-value");
		expect(saved).toContain("[redacted]");
		expect(JSON.parse(saved).calls[0].sampleRedacted).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
		}
	});

	it("automatically saves bounded guard metadata and never-started phase without hidden content", async () => {
		const { collector, start, delta, directory, message } = setup();
		start();
		delta('{"path":"x","newText":"unfinished');
		collector.observe({
			type: "message_end",
			message: {
				...message,
				stopReason: "error",
				content: [{ type: "thinking", thinking: "hidden-thought-secret" }],
				errorMessage: "provider-secret",
				diagnostics: [
					{
						type: "tool_argument_generation_limit",
						timestamp: 123,
						details: {
							bytes: 12345,
							source: "guard",
							code: "invalid_configuration",
							headers: { Authorization: "provider-secret" },
						},
					},
					{ type: "runtime_abort", timestamp: 124, details: { source: "keyboard_interrupt" } },
				],
			},
		});
		await collector.waitForCapture();
		const saved = readFileSync(join(directory, "debug", "tool-progress-latest.json"), "utf8");
		expect(saved).not.toContain("hidden-thought-secret");
		expect(saved).not.toContain("provider-secret");
		expect(JSON.parse(saved)).toMatchObject({
			reason: "safeguard",
			calls: [{ phase: "not_started", argumentBytes: 33 }],
			diagnostics: [
				{ type: "tool_argument_generation_limit", details: { bytes: 12345, code: "invalid_configuration" } },
				{ type: "runtime_abort", details: { source: "keyboard_interrupt" } },
			],
		});
	});

	it("uses a fixed atomic private target and refuses a linked capture directory", async () => {
		const { collector, directory } = setup();
		const target = join(directory, "target");
		writeFileSync(target, "preserve");
		const path = await collector.capture();
		rmSync(path);
		symlinkSync(target, path);
		expect(await collector.capture()).toBe(path);
		expect(readFileSync(target, "utf8")).toBe("preserve");
		rmSync(join(directory, "debug"), { recursive: true });
		symlinkSync(directory, join(directory, "debug"), "dir");
		await expect(collector.capture()).rejects.toThrow(
			process.platform === "win32"
				? "Could not retain private Windows review diagnostics."
				: "non-directory private path",
		);
		expect(existsSync(join(directory, "tool-progress-latest.json"))).toBe(false);
		expect(readFileSync(target, "utf8")).toBe("preserve");
	});

	it("preserves late identities and separately tracks interleaved provisional calls", () => {
		const { collector, start, update, message } = setup();
		start("", 0);
		start("", 1);
		for (const [index, id, text] of [
			[0, "first", '{"path":"first"}'],
			[1, "second", '{"path":"second"}'],
		] as const) {
			update({
				type: "toolcall_delta",
				contentIndex: index,
				id,
				name: "edit",
				argsTextDelta: "",
				seq: 1,
				snapshot: message,
				toolState: [],
			});
			update({
				type: "toolcall_delta",
				contentIndex: index,
				argsTextDelta: text,
				seq: 2,
				snapshot: message,
				toolState: [],
			});
			update({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: { type: "toolCall", id, name: "edit", arguments: {} },
				seq: 3,
				snapshot: message,
				toolState: [],
			});
		}
		collector.observe({ type: "tool_execution_start", toolCallId: "second", toolName: "edit", args: {} });
		expect(collector.snapshot().calls).toMatchObject([
			{ callId: "first", contentIndex: 0, phase: "ready", rawArgumentSample: '{"path":"first"}', argumentBytes: 16 },
			{
				callId: "second",
				contentIndex: 1,
				phase: "executing",
				rawArgumentSample: '{"path":"second"}',
				argumentBytes: 17,
			},
		]);
		expect(collector.executionState("first")).toBe("not_started");
		expect(collector.executionState("second")).toBe("interrupted");
	});

	it("retains historical measurements but uses the new message's identity when IDs repeat", () => {
		const { collector, start, delta, message } = setup();
		start("reused");
		delta("first");
		collector.observe({ type: "message_start", message });
		start("reused");
		delta("second");
		collector.observe({ type: "tool_execution_start", toolCallId: "reused", toolName: "edit", args: {} });
		expect(collector.snapshot().calls).toMatchObject([
			{ rawArgumentSample: "first", executionStarted: false },
			{ rawArgumentSample: "second", executionStarted: true },
		]);
		start("reused", 1);
		expect(collector.executionState("reused")).toBe("unknown");
	});

	it.each([
		'{"command":"export API_\\u004bEY=c46b9802347c590bc553f31bb120c901; echo ok"}',
		...["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY"].map(
			(kind) => JSON.stringify({ content: `-----BEGIN ${kind}-----\nc46b9802347c590bc553f31bb120c901` }),
		),
	])("redacts decoded shell credentials and unfinished PEM envelopes: %s", async (raw) => {
		const { collector, start, delta } = setup();
		start();
		for (const character of raw) delta(character);
		const saved = readFileSync(await collector.capture(), "utf8");
		expect(saved).not.toContain("c46b9802347c590bc553f31bb120c901");
		expect(saved).toContain("[redacted]");
	});
});
