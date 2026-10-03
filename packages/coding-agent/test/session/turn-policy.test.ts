import type { AgentLoopNextAction, AgentLoopNextActionContext } from "@hansjm10/volt-agent-core";
import { describe, expect, it } from "vitest";
import {
	type NextActionPolicy,
	reduceNextAction,
	reduceToolCall,
	type ToolCallPolicy,
} from "../../src/core/session/turn-policy.ts";

const signal = new AbortController().signal;

function nextActionContext(defaultAction: AgentLoopNextAction = { type: "stop" }): AgentLoopNextActionContext {
	return {
		context: { systemPrompt: "system", messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		newMessages: [],
		requestAuthority: "provider",
		defaultAction,
	};
}

const notice: AgentLoopNextAction = {
	type: "request",
	reason: "delivery",
	deliveries: [
		{
			deliveryId: "notice",
			messages: [{ role: "custom", customType: "notice", content: "done", display: true, timestamp: 1 }],
		},
	],
};

interface ToolCall {
	readonly type: "tool_call";
	readonly toolName: string;
	readonly input: Record<string, unknown>;
}

const call: ToolCall = { type: "tool_call", toolName: "write", input: { path: "a.txt" } };

describe("turn policy composition", () => {
	it("runs next-action policies in order, each seeing the action so far as its default", async () => {
		const seen: AgentLoopNextAction[] = [];
		const policies: NextActionPolicy[] = [
			(context) => {
				seen.push(context.defaultAction);
				return notice;
			},
			(context) => {
				seen.push(context.defaultAction);
				return undefined;
			},
			async (context) => {
				seen.push(context.defaultAction);
				return { type: "pause" };
			},
		];
		expect(await reduceNextAction(nextActionContext(), policies, signal)).toEqual({ type: "pause" });
		expect(seen).toEqual([{ type: "stop" }, notice, notice]);
	});

	it("resolves undefined when no policy replaces the suggested action", async () => {
		expect(await reduceNextAction(nextActionContext(), [], signal)).toBeUndefined();
		expect(await reduceNextAction(nextActionContext(), [() => undefined, async () => undefined], signal)).toBe(
			undefined,
		);
		// Returning the suggestion itself still replaces it.
		expect(await reduceNextAction(nextActionContext(), [(context) => context.defaultAction], signal)).toEqual({
			type: "stop",
		});
	});

	it("isolates policies from the loop's context and from each other's results", async () => {
		const context = nextActionContext();
		const returned: AgentLoopNextAction = structuredClone(notice);
		const result = await reduceNextAction(
			context,
			[
				(owned) => {
					owned.context.messages.length = 0;
					return returned;
				},
				(owned) => {
					if (owned.defaultAction.type === "request") owned.defaultAction.deliveries?.splice(0);
					return undefined;
				},
			],
			signal,
		);
		// A synchronous result is copied before any later policy runs or mutates its own value.
		if (returned.type === "request") returned.reason = "continuation";
		expect(result).toEqual(notice);
		expect(context.context.messages).toHaveLength(1);
		expect(context.defaultAction).toEqual({ type: "stop" });
	});

	it("passes the signal and propagates a policy failure", async () => {
		const received: AbortSignal[] = [];
		await reduceNextAction(
			nextActionContext(),
			[
				(_context, policySignal) => {
					received.push(policySignal);
					return undefined;
				},
			],
			signal,
		);
		expect(received).toEqual([signal]);
		await expect(
			reduceNextAction(
				nextActionContext(),
				[
					() => {
						throw new Error("policy failed");
					},
				],
				signal,
			),
		).rejects.toThrow("policy failed");
	});

	it("reads policies lazily, so one removed before its turn does not run", async () => {
		const live = new Set<NextActionPolicy>();
		const late: NextActionPolicy = () => notice;
		live.add(() => {
			live.delete(late);
			return undefined;
		});
		live.add(late);
		expect(await reduceNextAction(nextActionContext(), live, signal)).toBeUndefined();
	});

	it("runs every tool-call policy, accumulating a final block and the latest reason", async () => {
		const seen: unknown[] = [];
		const policies: ToolCallPolicy<ToolCall>[] = [
			(event) => {
				seen.push(event);
				return { block: true, reason: "read-only profile" };
			},
			async (event) => {
				seen.push(event);
				return { block: false };
			},
			(event) => {
				seen.push(event);
				return { reason: "explained later" };
			},
		];
		expect(await reduceToolCall(call, policies)).toEqual({ block: true, reason: "explained later" });
		expect(seen).toEqual([
			call,
			{ ...call, block: true, reason: "read-only profile" },
			{ ...call, block: true, reason: "read-only profile" },
		]);
	});

	it("hands each tool-call policy its own copy of the call", async () => {
		const result = await reduceToolCall(call, [
			(event) => {
				event.input.path = "changed.txt";
				return undefined;
			},
			(event) => ({ reason: String(event.input.path) }),
		]);
		expect(result).toEqual({ reason: "a.txt" });
		expect(call.input.path).toBe("a.txt");
		expect(await reduceToolCall(call, [])).toEqual({});
	});
});
