import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

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
	if (!isRecord(message)) {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function getNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = record[key];
	if (!isRecord(value)) {
		throw new Error(`Expected ${key} to be a record`);
	}
	return value;
}

async function startRpcModeForHarness(harness: Harness): Promise<RpcHarness> {
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
	const runtimeHost = {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
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

const activeHarnesses: Harness[] = [];

afterEach(() => {
	for (const harness of activeHarnesses.splice(0)) {
		harness.cleanup();
	}
});

describe("RPC assistant formatting", () => {
	test("streams and persists raw assistant Markdown text for final surfaces", async () => {
		const harness = await createHarness();
		activeHarnesses.push(harness);
		const formattedText = ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join(
			"\n",
		);
		harness.setResponses([fauxAssistantMessage(formattedText)]);
		const rpc = await startRpcModeForHarness(harness);

		rpc.send({ id: "prompt-1", type: "prompt", message: "formatting" });
		await vi.waitFor(() =>
			expect(
				rpc.writes.some(
					(record) => record.type === "message_end" && getMessageText(record.message) === formattedText,
				),
			).toBe(true),
		);

		const updates = rpc.writes.filter((record) => record.type === "message_update");
		const textDeltas = updates
			.map((record) => getNestedRecord(record, "assistantMessageEvent"))
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta);
		expect(textDeltas.join("")).toBe(formattedText);

		const textEnd = updates.find((record) => getNestedRecord(record, "assistantMessageEvent").type === "text_end");
		if (!textEnd) {
			throw new Error("Expected text_end event");
		}
		const textEndEvent = getNestedRecord(textEnd, "assistantMessageEvent");
		expect(textEndEvent.content).toBe(formattedText);
		expect(textEndEvent.message).toBe(formattedText);
		expect(getMessageText(textEndEvent.partial)).toBe(formattedText);
		expect(getMessageText(textEnd.message)).toBe(formattedText);

		rpc.send({ id: "transcript-1", type: "get_transcript", limit: 10 });
		await vi.waitFor(() =>
			expect(
				rpc.writes.some(
					(record) =>
						record.type === "response" &&
						record.command === "get_transcript" &&
						getTranscriptAssistantText(record) === formattedText,
				),
			).toBe(true),
		);

		rpc.close();
		await expect(rpc.modePromise).resolves.toBeUndefined();
	});
});

function getTranscriptAssistantText(response: Record<string, unknown>): string | undefined {
	const data = response.data;
	if (!isRecord(data) || !Array.isArray(data.items)) {
		return undefined;
	}
	const item = data.items.find((entry) => isRecord(entry) && entry.role === "assistant");
	return isRecord(item) && typeof item.text === "string" ? item.text : undefined;
}
