import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CatalogNameSchema, ClientFrameSchema, HostFrameSchema } from "../src/frames.ts";
import {
	BUILTIN_INTENT_NAMES,
	INTENT_NAME_MAX_CHARS,
	IntentCategorySchema,
	IntentNameSchema,
	IntentSourceSchema,
} from "../src/intents.ts";

describe("wire frames", () => {
	it("ends a phone stream with protocol frames: ended{moved, target} or fatal, never remote_terminal", () => {
		expect(
			Check(HostFrameSchema, {
				type: "ended",
				subscriptionId: "s",
				reason: "moved",
				target: "01a1056a-0cdd-7381-b91a-6ef0dfbfdd1f",
			}),
		).toBe(true);
		expect(Check(HostFrameSchema, { type: "ended", subscriptionId: "s", reason: "closed" })).toBe(true);
		for (const code of ["revoked", "workspace_unregistered", "frame_too_large", "host_shutdown"]) {
			expect(Check(HostFrameSchema, { type: "fatal", code }), code).toBe(true);
		}
		expect(Check(CatalogNameSchema, "host")).toBe(true);
		const terminal = {
			type: "remote_terminal",
			reason: "conversation_moved",
			workspace: "volt",
			sessionId: "s-1",
			targetSessionId: "s-2",
		};
		expect(Check(HostFrameSchema, terminal)).toBe(false);
	});

	it("admits codes, catalogs, and intent names a newer host adds to its open positions", () => {
		expect(
			Check(HostFrameSchema, {
				type: "rejected",
				intentId: "i",
				reason: { code: "future_rejection", message: "m" },
			}),
		).toBe(true);
		expect(
			Check(HostFrameSchema, { type: "query_error", queryId: "q", reason: { code: "future_error", message: "m" } }),
		).toBe(true);
		expect(Check(HostFrameSchema, { type: "fatal", code: "future_fatal" })).toBe(true);
		expect(Check(HostFrameSchema, { type: "changed", catalog: "future_catalog" })).toBe(true);
		expect(Check(IntentCategorySchema, "future_category")).toBe(true);
		expect(Check(IntentSourceSchema, "future_source")).toBe(true);

		for (const name of [...BUILTIN_INTENT_NAMES, "future_intent", "future.set_thing", "skill.review-code"]) {
			expect(Check(IntentNameSchema, name), name).toBe(true);
		}
		for (const name of [
			"",
			"Future",
			"1intent",
			"future-intent",
			"future.",
			`a${"b".repeat(INTENT_NAME_MAX_CHARS)}`,
		]) {
			expect(Check(IntentNameSchema, name), name).toBe(false);
		}

		// Closed positions stay closed.
		expect(Check(HostFrameSchema, { type: "ended", subscriptionId: "s", reason: "future_reason" })).toBe(false);
	});

	it("admits a hello naming host request kinds this host does not know, within bounds", () => {
		const hello = (hostRequests: string[]) => ({
			type: "hello",
			protocol: 1,
			client: { name: "phone", version: "2" },
			accepts: { hostRequests },
		});
		expect(Check(ClientFrameSchema, hello(["confirm", "future_kind"]))).toBe(true);
		expect(Check(ClientFrameSchema, hello([""]))).toBe(false);
		expect(Check(ClientFrameSchema, hello(["x".repeat(65)]))).toBe(false);
		expect(Check(ClientFrameSchema, hello(["confirm", "confirm"]))).toBe(false);
		expect(Check(ClientFrameSchema, hello(Array.from({ length: 65 }, (_, index) => `kind_${index}`)))).toBe(false);
	});

	it("rejects the removed RPC commands, control messages, and events", () => {
		for (const command of [
			{ type: "get_state", id: "1" },
			{ type: "get_transcript", id: "1" },
			{ type: "get_ui_actions", id: "1" },
			{ type: "invoke_ui_action", id: "req-1", action: "agent.mode", args: { mode: "plan" } },
			{ type: "cycle_model", id: "1" },
			{ type: "extension_ui_response", id: "u1", cancelled: true },
			{ type: "host_action_response", id: "h1", decision: "approved" },
		]) {
			expect(Check(ClientFrameSchema, command), command.type).toBe(false);
		}
		for (const event of [
			{ type: "conversation_bootstrap" },
			{ type: "models_changed" },
			{ type: "ui_action_state_changed", action: "thinking.fast_mode", state: { type: "boolean", value: true } },
			{ type: "transcript_entry", final: true },
			{ type: "response", command: "abort", success: true },
		]) {
			expect(Check(HostFrameSchema, event), event.type).toBe(false);
		}
	});
});
