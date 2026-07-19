import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { RpcCloseHandler, RpcTransport } from "../../../src/core/rpc/transport.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../../../src/core/rpc/types.ts";
import type { SubagentEvent, SubagentHandle, SubagentResult } from "../../../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../../../src/core/tools/index.ts";
import { createInProcessRpcClient } from "../../../src/modes/rpc/in-process-rpc-client.ts";
import type { RpcClientEvent } from "../../../src/modes/rpc/rpc-client-base.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

interface RpcHarness {
	close(): void;
	modePromise: Promise<void>;
	send(message: object): void;
	writes: Record<string, unknown>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getMessageText(message: unknown): string {
	if (!isRecord(message) || !Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

function getAssistantMessageEvent(frame: Record<string, unknown>): Record<string, unknown> {
	const event = frame.assistantMessageEvent;
	if (!isRecord(event)) {
		throw new Error("Expected assistantMessageEvent to be a record");
	}
	return event;
}

function createFakeRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		switchSessionById: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		startRecoveredClientInputs: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
		async runWithStableSession<T>(operation: (stableSession: AgentSession) => Promise<T> | T): Promise<T> {
			return operation(harness.session);
		},
	} as unknown as AgentSessionRuntime;
}

function createFakeSubagentScaffold(): {
	emit: (event: SubagentEvent) => void;
	handle: SubagentHandle;
	manager: SubagentToolManager;
} {
	const listeners = new Set<(event: SubagentEvent) => void>();
	const handle: SubagentHandle = {
		id: "sa_child",
		sessionId: "child-session",
		prompt: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
		getState: async () => ({}) as RpcSessionState,
		getTranscript: async () => ({}) as RpcTranscriptResponse,
		getSessionStats: async () => {
			throw new Error("not used");
		},
		waitForEnd: () => new Promise<SubagentResult>(() => {}),
		dispose: vi.fn(async () => undefined),
		onEvent: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const manager = {
		getDefinition: () => {
			throw new Error("not used");
		},
		startByName: vi.fn(async () => handle),
	} as unknown as SubagentToolManager;
	return {
		emit(event) {
			for (const listener of listeners) {
				listener(event);
			}
		},
		handle,
		manager,
	};
}

async function startRpcModeForHarness(
	harness: Harness,
	runtimeHost: AgentSessionRuntime = createFakeRuntimeHost(harness),
): Promise<RpcHarness> {
	let lineHandler: ((line: string) => void) | undefined;
	let closeHandler: RpcCloseHandler | undefined;
	const writes: Record<string, unknown>[] = [];
	const transport: RpcTransport = {
		write: vi.fn((value) => {
			if (!isRecord(value)) {
				throw new Error("Expected RPC write to be an object");
			}
			writes.push(value);
		}),
		onLine: vi.fn((handler) => {
			lineHandler = handler;
			return vi.fn();
		}),
		onClose: vi.fn((handler) => {
			closeHandler = handler;
			return vi.fn();
		}),
		waitForBackpressure: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const modePromise = runRpcMode(runtimeHost, {
		disposeRuntimeOnClose: false,
		onReady: resolveReady,
		transport,
	});
	await ready;
	await vi.waitFor(() => expect(lineHandler).toBeDefined());

	return {
		close() {
			closeHandler?.();
		},
		modePromise,
		send(message: object) {
			if (!lineHandler) {
				throw new Error("RPC line handler was not registered");
			}
			lineHandler(JSON.stringify(message));
		},
		writes,
	};
}

async function promptAndWaitForMessageEnd(rpc: RpcHarness, text: string): Promise<void> {
	rpc.send({
		id: "prompt-1",
		type: "prompt",
		clientMessageId: "client-prompt-1",
		message: "stream please",
	});
	await vi.waitFor(() =>
		expect(
			rpc.writes.some((record) => record.type === "message_end" && getMessageText(record.message) === text),
		).toBe(true),
	);
}

function getMessageUpdateFrames(writes: Record<string, unknown>[]): Record<string, unknown>[] {
	return writes.filter((record) => record.type === "message_update");
}

const activeHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of activeHarnesses.splice(0)) {
		harness.cleanup();
	}
});

const STREAMED_TEXT = ["Delta frames flatten the quadratic streaming cost.", "Each token ships once, not O(n) times."]
	.join("\n")
	.repeat(3);

describe("issue #44: delta-based message_update RPC frames", () => {
	test("message_update frames are delta-only: no accumulated message, snapshot, or tool state", async () => {
		const harness = await createHarness();
		activeHarnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(STREAMED_TEXT)]);
		const rpc = await startRpcModeForHarness(harness);

		await promptAndWaitForMessageEnd(rpc, STREAMED_TEXT);

		const updates = getMessageUpdateFrames(rpc.writes);
		expect(updates.length).toBeGreaterThan(1);
		for (const update of updates) {
			// message_start already delivered the accumulator base on this stream.
			expect("message" in update).toBe(false);
			expect(isRecord(update.stream)).toBe(true);
			const event = getAssistantMessageEvent(update);
			expect("seq" in event).toBe(false);
			expect("snapshot" in event).toBe(false);
			expect("toolState" in event).toBe(false);
		}

		// The deltas alone reconstruct the full text.
		const concatenated = updates
			.map((update) => getAssistantMessageEvent(update))
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta)
			.join("");
		expect(concatenated).toBe(STREAMED_TEXT);

		// text_end carries the authoritative block text without a duplicate visible-text shim.
		const textEnd = updates
			.map((update) => getAssistantMessageEvent(update))
			.find((event) => event.type === "text_end");
		expect(textEnd?.content).toBe(STREAMED_TEXT);
		expect("message" in (textEnd ?? {})).toBe(false);

		// Boundary frames keep full messages.
		const assistantStarts = rpc.writes.filter(
			(record) => record.type === "message_start" && isRecord(record.message) && record.message.role === "assistant",
		);
		expect(assistantStarts.length).toBe(1);
		expect(isRecord(assistantStarts[0]?.stream)).toBe(true);
		const assistantEnds = rpc.writes.filter(
			(record) => record.type === "message_end" && isRecord(record.message) && record.message.role === "assistant",
		);
		expect(assistantEnds.some((record) => getMessageText(record.message) === STREAMED_TEXT)).toBe(true);
		expect(assistantEnds.every((record) => isRecord(record.stream))).toBe(true);

		rpc.close();
		await expect(rpc.modePromise).resolves.toBeUndefined();
	});

	test("first message_update without a prior message_start carries a full snapshot", async () => {
		// Drive the subagent_event fan-out with a controlled handle: the child
		// emits message_update without any message_start on this stream, so the
		// first frame must include the accumulator base and later frames must be
		// delta-only.
		const { emit, manager } = createFakeSubagentScaffold();
		const harness = await createHarness();
		activeHarnesses.push(harness);
		const session = harness.session as unknown as { getSubagentToolManager?: () => SubagentToolManager };
		session.getSubagentToolManager = () => manager;
		const rpc = await startRpcModeForHarness(harness);

		rpc.send({ id: "start-1", type: "subagent_start", agent: "scout", prompt: "inspect" });
		await vi.waitFor(() =>
			expect(rpc.writes.some((record) => record.type === "response" && record.command === "subagent_start")).toBe(
				true,
			),
		);

		const firstPartial = fauxAssistantMessage("He");
		const secondPartial = fauxAssistantMessage("Hello");
		emit({
			type: "message_update",
			message: firstPartial,
			assistantMessageEvent: {
				type: "text_delta",
				seq: 1,
				contentIndex: 0,
				delta: "He",
				snapshot: firstPartial,
				toolState: [],
			},
		});
		emit({
			type: "message_update",
			message: secondPartial,
			assistantMessageEvent: {
				type: "text_delta",
				seq: 2,
				contentIndex: 0,
				delta: "llo",
				snapshot: secondPartial,
				toolState: [],
			},
		});

		await vi.waitFor(() => expect(rpc.writes.filter((record) => record.type === "subagent_event").length).toBe(2));
		const [first, second] = rpc.writes.filter((record) => record.type === "subagent_event");
		const firstEvent = first.event;
		const secondEvent = second.event;
		if (!isRecord(firstEvent) || !isRecord(secondEvent)) {
			throw new Error("Expected subagent_event frames to carry event records");
		}
		// Snapshot frame: no message_start was seen on this stream.
		expect(isRecord(firstEvent.message)).toBe(true);
		expect(getMessageText(firstEvent.message)).toBe("He");
		expect("snapshot" in getAssistantMessageEvent(firstEvent)).toBe(false);
		expect("toolState" in getAssistantMessageEvent(firstEvent)).toBe(false);
		// Delta-only afterwards.
		expect("message" in secondEvent).toBe(false);
		expect("snapshot" in getAssistantMessageEvent(secondEvent)).toBe(false);
		expect("toolState" in getAssistantMessageEvent(secondEvent)).toBe(false);

		rpc.close();
		await rpc.modePromise.catch(() => undefined);
	});

	test("host-side subagent disposal emits a terminal subagent_disposed frame", async () => {
		const { emit, handle, manager } = createFakeSubagentScaffold();
		const harness = await createHarness();
		activeHarnesses.push(harness);
		const session = harness.session as unknown as { getSubagentToolManager?: () => SubagentToolManager };
		session.getSubagentToolManager = () => manager;
		const runtimeHost = createFakeRuntimeHost(harness);
		(runtimeHost as { newSession: () => Promise<{ cancelled: boolean }> }).newSession = vi.fn(async () => ({
			cancelled: false,
		}));
		const rpc = await startRpcModeForHarness(harness, runtimeHost);

		rpc.send({ id: "start-1", type: "subagent_start", agent: "scout", prompt: "inspect" });
		await vi.waitFor(() =>
			expect(rpc.writes.some((record) => record.type === "response" && record.command === "subagent_start")).toBe(
				true,
			),
		);

		// Leave the child mid-message so a connected client holds a delta
		// accumulator for this subagent stream.
		const snapshot = fauxAssistantMessage("He");
		emit({
			type: "message_update",
			message: snapshot,
			assistantMessageEvent: {
				type: "text_delta",
				seq: 1,
				contentIndex: 0,
				delta: "He",
				snapshot,
				toolState: [],
			},
		});

		// new_session rebinds the RPC session and disposes all active subagents
		// host-side. No subagent_end fires on this path; the dedicated terminal
		// frame is the only signal that lets clients drop the accumulator.
		rpc.send({ id: "new-1", type: "new_session" });
		await vi.waitFor(() =>
			expect(rpc.writes.some((record) => record.type === "response" && record.command === "new_session")).toBe(true),
		);

		const disposedIndex = rpc.writes.findIndex((record) => record.type === "subagent_disposed");
		const responseIndex = rpc.writes.findIndex(
			(record) => record.type === "response" && record.command === "new_session",
		);
		expect(disposedIndex).toBeGreaterThan(-1);
		expect(rpc.writes[disposedIndex].subagentId).toBe("sa_child");
		// The terminal frame precedes the command response on the same ordered
		// transport, so clients clear state before the command resolves.
		expect(disposedIndex).toBeLessThan(responseIndex);
		expect(rpc.writes.some((record) => record.type === "subagent_end")).toBe(false);
		expect(handle.dispose).toHaveBeenCalled();

		rpc.close();
		await rpc.modePromise.catch(() => undefined);
	});

	test("RPC clients reconstruct full messages from delta frames", async () => {
		const harness = await createHarness();
		activeHarnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(STREAMED_TEXT)]);

		const events: RpcClientEvent[] = [];
		const client = await createInProcessRpcClient(createFakeRuntimeHost(harness), {
			disposeRuntimeOnClose: false,
			onEvent: (event) => {
				events.push(event);
			},
		});
		try {
			await client.promptAndWait("stream please");

			const updates = events.filter(
				(event): event is Extract<RpcClientEvent, { type: "message_update" }> => event.type === "message_update",
			);
			expect(updates.length).toBeGreaterThan(1);
			for (const update of updates) {
				// Every decoded update exposes the full accumulated message plus the
				// immutable normalizer snapshot and resumable tool state.
				expect(isRecord(update.message)).toBe(true);
				expect(update.message.role).toBe("assistant");
				expect(STREAMED_TEXT.startsWith(getMessageText(update.message))).toBe(true);
				const assistantMessageEvent = update.assistantMessageEvent as unknown as Record<string, unknown>;
				expect(assistantMessageEvent.snapshot).toBe(update.message);
				expect(Array.isArray(assistantMessageEvent.toolState)).toBe(true);
				expect("partial" in assistantMessageEvent).toBe(false);
			}
			const textEndUpdate = updates.find((update) => update.assistantMessageEvent.type === "text_end");
			expect(getMessageText(textEndUpdate?.message)).toBe(STREAMED_TEXT);
		} finally {
			await client.stop();
		}
	});
});
