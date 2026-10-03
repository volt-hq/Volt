import { applyReplayPolicy, type Message } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildContext } from "../../src/conversation/context.ts";
import { fold, restore, snapshot } from "../../src/conversation/fold.ts";
import { convertToLlm } from "../../src/conversation/messages.ts";
import type { AgentMessage } from "../../src/types.ts";
import { buildLog, logArbitrary } from "./log-generators.ts";

const PROPERTY_SEED = 5_850_103;

/** The runtime's conversion: drops the client input identity a user message carries. */
function convertWithoutClientIdentity(messages: AgentMessage[]): Message[] {
	return convertToLlm(messages).map((message) => {
		if (message.role !== "user" || !("clientMessageId" in message)) return message;
		const { clientMessageId: _clientMessageId, ...userMessage } = message;
		return userMessage;
	});
}

describe("buildContext", () => {
	it("is a pure function of the fold", async () => {
		await fc.assert(
			fc.asyncProperty(logArbitrary, fc.boolean(), async (entries, transform) => {
				const state = fold(entries);
				const before = structuredClone(state);
				const options = {
					convertToLlm: convertWithoutClientIdentity,
					...(transform
						? {
								transformContext: (messages: AgentMessage[]) => {
									for (const message of messages) message.timestamp = 0;
									return messages.reverse();
								},
							}
						: {}),
				};
				const first = await buildContext(state, options);
				expect(state).toEqual(before);
				expect(await buildContext(state, options)).toEqual(first);
				expect(await buildContext(restore(JSON.parse(JSON.stringify(snapshot(state)))), options)).toEqual(first);
				if (!transform) {
					expect(first).toEqual(applyReplayPolicy(convertWithoutClientIdentity([...state.context.messages])));
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 150 },
		);
	});

	it("drops errored turns, synthesizes missing tool results, and passes the signal to transformContext", async () => {
		const entries = buildLog([
			{ kind: "user", text: "go", array: false },
			{ kind: "assistant", text: "", toolCalls: 1, stopReason: "toolUse", model: 0, invalidArguments: false },
			{ kind: "user", text: "again", array: false },
			{ kind: "assistant", text: "", toolCalls: 1, stopReason: "error", model: 0, invalidArguments: true },
		]);
		const signal = AbortSignal.timeout(10_000);
		let received: AbortSignal | undefined;
		const messages = await buildContext(fold(entries), {
			convertToLlm: convertWithoutClientIdentity,
			signal,
			transformContext: (messages, transformSignal) => {
				received = transformSignal;
				return messages;
			},
		});
		expect(received).toBe(signal);
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user", "user"]);
		expect(messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1", isError: true });
		expect(messages[4]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: expect.stringContaining("none of its tool calls were executed") }],
		});
	});
});
