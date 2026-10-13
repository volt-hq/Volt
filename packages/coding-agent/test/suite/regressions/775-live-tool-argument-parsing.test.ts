import type * as VoltAi from "@hansjm10/volt-ai";
import { type AssistantMessage, parseStreamingJson } from "@hansjm10/volt-ai";
import { emptyLiveFold, foldLiveFrame, type LiveFoldState, type LiveItem } from "@hansjm10/volt-protocol";
import { describe, expect, it, vi } from "vitest";
import { LiveState } from "../../../src/core/host/live-state.ts";

vi.mock("@hansjm10/volt-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof VoltAi>();
	return { ...actual, parseStreamingJson: vi.fn(actual.parseStreamingJson) };
});

function startMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
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

function delta(event: Extract<LiveItem, { type: "assistant_delta" }>["event"]): LiveItem {
	return { type: "assistant_delta", event };
}

/** A host live state that has started streaming a tool call, and the fold of a client attached to it. */
function streamingCall(id: string, name: string): { live: LiveState; client: () => LiveFoldState } {
	const live = new LiveState();
	let client = emptyLiveFold();
	live.attach("client", {
		acceptsHostRequest: () => false,
		apply: (update) => {
			client = foldLiveFrame(client, update);
		},
	});
	live.stream([{ type: "assistant_start", message: startMessage() }]);
	live.stream([delta({ type: "toolcall_start", contentIndex: 0, id, name })]);
	return { live, client: () => client };
}

function firstBlock(state: LiveFoldState) {
	return state.assistant?.message.content[0];
}

describe("live tool call arguments (#775)", () => {
	it("folds a tool call's argument deltas without parsing the text, on the host and on its clients", () => {
		const text = JSON.stringify({ path: "notes.txt", content: "a line of the file\n".repeat(1_000) });
		const { live, client } = streamingCall("call-775", "write");
		vi.mocked(parseStreamingJson).mockClear();

		for (let at = 0; at < text.length; at += 16) {
			live.stream([delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: text.slice(at, at + 16) })]);
		}

		expect(parseStreamingJson).not.toHaveBeenCalled();
		const hostCall = firstBlock(live.snapshot());
		const clientCall = firstBlock(client());
		expect(hostCall).toEqual({ type: "toolCall", id: "call-775", name: "write", arguments: JSON.parse(text) });
		expect(clientCall).toEqual(hostCall);
		// Each fold parses the whole text once, when its arguments are first read.
		expect(parseStreamingJson).toHaveBeenCalledTimes(2);
		expect(firstBlock(live.snapshot())).toEqual(hostCall);
		expect(parseStreamingJson).toHaveBeenCalledTimes(2);
	});

	it("gives the arguments as the text streamed so far parses, on the host and on its clients", () => {
		const text = JSON.stringify({
			path: "src/a.ts",
			edits: [
				{ oldText: "a", newText: "b" },
				{ oldText: "c\n", newText: "d" },
			],
		});
		const { live, client } = streamingCall("", "");

		for (let end = 1; end <= text.length; end++) {
			// The first delta names the call, as some providers do.
			const naming = end === 1 ? { id: "call-775", name: "edit" } : {};
			live.stream([delta({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: text[end - 1]!, ...naming })]);
			const expected = {
				type: "toolCall",
				id: "call-775",
				name: "edit",
				arguments: parseStreamingJson(text.slice(0, end)),
			};
			expect(firstBlock(live.snapshot())).toEqual(expected);
			expect(firstBlock(client())).toEqual(expected);
		}
	});
});
