import type { AssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame, LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

type AssistantDelta = Extract<LiveItem, { type: "assistant_delta" }>;

const STREAMED_TEXT = ["Delta frames flatten the quadratic streaming cost.", "Each token ships once, not O(n) times."]
	.join("\n")
	.repeat(3);

function messageText(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function liveItems(frames: HostFrame[]): LiveItem[] {
	return frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

function partialAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("issue #44: streaming assistant messages ship as deltas", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness({ responses: [STREAMED_TEXT], whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function connect(
		harness: HostHarness,
		conversation: HostedConversation,
	): Promise<{ client: LoopbackClient; frames: HostFrame[] }> {
		const frames: HostFrame[] = [];
		const client = await createLoopbackClient(harness.host, conversation, {
			anchor: false,
			onFrame: (frame) => frames.push(frame),
		});
		cleanups.push(() => client.stop());
		return { client, frames };
	}

	test("assistant deltas are slim: the message starts once and each token ships once", async () => {
		const { harness, conversation } = await setup();
		const { client, frames } = await connect(harness, conversation);

		await client.promptAndWait("stream please", { timeoutMs: 10_000 });

		const items = liveItems(frames);
		const starts = items.filter((item) => item.type === "assistant_start");
		expect(starts).toHaveLength(1);

		const deltas = items.filter((item): item is AssistantDelta => item.type === "assistant_delta");
		expect(deltas.length).toBeGreaterThan(1);
		for (const { event } of deltas) {
			// Only the start carries a message; deltas carry no accumulation, snapshot, or tool state.
			for (const field of ["message", "partial", "snapshot", "toolState", "seq"]) {
				expect(field in event).toBe(false);
			}
		}

		// The deltas alone reconstruct the full text.
		const concatenated = deltas.flatMap(({ event }) => (event.type === "text_delta" ? [event.delta] : [])).join("");
		expect(concatenated).toBe(STREAMED_TEXT);
		// text_end carries the authoritative block text once.
		const textEnd = deltas.find(({ event }) => event.type === "text_end");
		expect(textEnd?.event.type === "text_end" ? textEnd.event.content : undefined).toBe(STREAMED_TEXT);

		// The committed entry carries the full message.
		const assistant = client.state.entries.find(
			(entry) => entry.type === "message" && entry.view?.role === "assistant",
		);
		expect(assistant?.type === "message" ? assistant.view?.text : undefined).toBe(STREAMED_TEXT);
	});

	test("a client that joins mid-stream gets the message so far in its live reset, then deltas", async () => {
		const { harness, conversation } = await setup();
		const live = conversation.liveState;
		live.stream([{ type: "assistant_start", message: partialAssistant("") }]);
		live.stream([{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } }]);
		live.stream([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: "He" } }]);

		const { client, frames } = await connect(harness, conversation);
		const reset = frames.find((frame) => frame.type === "live" && frame.reset === true);
		if (reset?.type !== "live") throw new Error("Expected a live reset");
		const joined = reset.items.find((item) => item.type === "assistant_start");
		expect(joined?.type === "assistant_start" ? messageText(joined.message) : undefined).toBe("He");
		expect(messageText(client.live.assistant?.message)).toBe("He");

		const from = frames.length;
		live.stream([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: "llo" } }]);
		await vi.waitFor(() => expect(messageText(client.live.assistant?.message)).toBe("Hello"));
		const after = liveItems(frames.slice(from));
		expect(after).toEqual([
			{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: "llo" } },
		]);
	});

	test("protocol clients reconstruct the full message from deltas", async () => {
		const { harness, conversation } = await setup();
		const { client } = await connect(harness, conversation);
		const observed: string[] = [];
		client.onChange(() => {
			const assistant = client.live.assistant;
			if (assistant) observed.push(messageText(assistant.message));
		});

		await client.promptAndWait("stream please", { timeoutMs: 10_000 });

		expect(observed.length).toBeGreaterThan(1);
		for (const text of observed) expect(STREAMED_TEXT.startsWith(text)).toBe(true);
		expect(observed.at(-1)).toBe(STREAMED_TEXT);
		// The committed entry ended the stream.
		expect(client.live.assistant).toBeUndefined();
	});
});
