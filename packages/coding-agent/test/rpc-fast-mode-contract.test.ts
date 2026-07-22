import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { RpcUiActionStateChangedEventSchema } from "../src/core/rpc/schema/events.ts";
import { RpcServerEventSchema } from "../src/core/rpc/schema/index.ts";
import type { RpcUiActionStateChangedEvent } from "../src/core/rpc/types.ts";

describe("ui_action_state_changed RPC contract", () => {
	it("accepts typed bounded action-state events in the server union", () => {
		const event: RpcUiActionStateChangedEvent = {
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: { type: "boolean", value: true, label: "Fast: thinking off" },
		};

		expect(Compile(RpcUiActionStateChangedEventSchema).Errors(event)).toEqual([]);
		expect(Compile(RpcServerEventSchema).Errors(event)).toEqual([]);

		const deliveredEvent: RpcUiActionStateChangedEvent = {
			...event,
			delivery: { subscriptionId: "sub-1", cursor: 12 },
		};
		expect(Compile(RpcUiActionStateChangedEventSchema).Errors(deliveredEvent)).toEqual([]);
		expect(Compile(RpcServerEventSchema).Errors(deliveredEvent)).toEqual([]);

		const pickerEvent: RpcUiActionStateChangedEvent = {
			type: "ui_action_state_changed",
			action: "model.reasoning_effort",
			state: {
				type: "enum",
				value: "high",
				label: "High",
				options: [
					{ value: "low", label: "Low" },
					{ value: "high", label: "High", description: "Use more reasoning" },
				],
			},
		};
		expect(Compile(RpcUiActionStateChangedEventSchema).Errors(pickerEvent)).toEqual([]);
		expect(Compile(RpcServerEventSchema).Errors(pickerEvent)).toEqual([]);
	});

	it("rejects unbounded action-state payloads", () => {
		const event = {
			type: "ui_action_state_changed",
			action: "thinking.fast_mode",
			state: { type: "boolean", value: true, label: "x".repeat(10_000) },
		};

		expect(Compile(RpcUiActionStateChangedEventSchema).Check(event)).toBe(false);
		expect(
			Compile(RpcUiActionStateChangedEventSchema).Check({
				...event,
				action: "x".repeat(1_000),
				state: { type: "string", value: "x".repeat(1_000) },
			}),
		).toBe(false);
	});
});
