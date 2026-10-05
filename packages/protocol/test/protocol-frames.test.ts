import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { clientFold, clientSnapshot } from "../src/client-fold.ts";
import { ClientFrameSchema, HostFrameSchema, RESERVED_FRAME_TYPES } from "../src/frames.ts";
import { BUILTIN_INTENT_NAMES, DYNAMIC_INTENT_PATTERN, INTENT_SCHEMAS } from "../src/intents.ts";
import { LiveKeySchema } from "../src/live.ts";
import { QUERY_NAMES } from "../src/queries.ts";

const client = (frame: unknown) => Check(ClientFrameSchema, frame);
const host = (frame: unknown) => Check(HostFrameSchema, frame);

describe("client frames", () => {
	it("open a connection with hello", () => {
		const hello = {
			type: "hello",
			protocol: 1,
			client: { name: "volt-app", version: "1.0.0" },
			accepts: { hostRequests: ["confirm", "approval"] },
		};
		expect(client(hello)).toBe(true);
		expect(client({ ...hello, protocol: 2 })).toBe(false);
		expect(client({ ...hello, accepts: { hostRequests: ["terminal"] } })).toBe(false);
		expect(client({ ...hello, accepts: { hostRequests: ["confirm", "confirm"] } })).toBe(false);
	});

	it("subscribe after a position or from a snapshot", () => {
		const subscribe = { type: "subscribe", subscriptionId: "s1", conversation: "session-1" };
		expect(client({ ...subscribe, after: 0 })).toBe(true);
		expect(client({ ...subscribe, after: 17, live: false })).toBe(true);
		expect(client({ ...subscribe, after: "snapshot" })).toBe(true);
		expect(client({ ...subscribe, after: -1 })).toBe(false);
		expect(client({ ...subscribe, after: "latest" })).toBe(false);
		expect(client({ type: "unsubscribe", subscriptionId: "s1" })).toBe(true);
	});

	it("send intents named by type, with input intents keyed by client message id", () => {
		expect(client({ type: "prompt", intentId: "c-1", input: { message: "hi", streamingBehavior: "steer" } })).toBe(
			true,
		);
		expect(client({ type: "prompt", intentId: "local-queue:1", input: { message: "hi" } })).toBe(false);
		expect(client({ type: "prompt", intentId: "c-1" })).toBe(false);
		expect(client({ type: "abort", intentId: "i-1" })).toBe(true);
		expect(client({ type: "abort", intentId: "i-1", input: {} })).toBe(true);
		expect(client({ type: "abort", intentId: "i-1", input: { force: true } })).toBe(false);
		expect(client({ type: "fork", intentId: "i-2", expectedOrdinal: 12, input: { entryId: "e4" } })).toBe(true);
		expect(client({ type: "mcp.auth_start_device", intentId: "i-3", input: { server: "github" } })).toBe(true);
		expect(client({ type: "teleport", intentId: "i-4" })).toBe(false);
	});

	it("send dynamic intents by id prefix", () => {
		expect(client({ type: "extension.command.ec_ab_1", intentId: "i-1", input: { arguments: "x" } })).toBe(true);
		expect(
			client({ type: "prompt.template.pt_ab_1", intentId: "i-1", input: { streamingBehavior: "followUp" } }),
		).toBe(true);
		expect(client({ type: "skill.sk_ab_1", intentId: "i-1" })).toBe(true);
		expect(client({ type: "extension.foo", intentId: "i-1" })).toBe(false);
		expect(client({ type: "skill.sk_ab_1", intentId: "i-1", input: { args: {} } })).toBe(false);
	});

	it("send queries with their parameters", () => {
		const query = { type: "query", queryId: "q1" };
		expect(client({ ...query, query: "history", params: { before: 10, limit: 50 } })).toBe(true);
		expect(client({ ...query, query: "history" })).toBe(false);
		expect(client({ ...query, query: "history", params: { before: 10, limit: 500 } })).toBe(false);
		expect(client({ ...query, query: "models" })).toBe(true);
		expect(
			client({ ...query, query: "content", conversation: "session-1", params: { entryId: "e3", part: 1 } }),
		).toBe(true);
		expect(client({ ...query, query: "get_state" })).toBe(false);
	});

	it("answer host requests", () => {
		const response = (value: unknown) => client({ type: "host_response", requestId: "r1", response: value });
		expect(response({ value: "a" })).toBe(true);
		expect(response({ confirmed: false })).toBe(true);
		expect(response({ values: { name: "x", count: 2, ok: true } })).toBe(true);
		expect(response({ decision: "approved" })).toBe(true);
		expect(response({ cancelled: true })).toBe(true);
		expect(response({ value: "a", cancelled: true })).toBe(false);
		expect(response({ decision: "unavailable" })).toBe(false);
	});

	it("reserve frame names: no intent is named like a frame", () => {
		const dynamic = new RegExp(DYNAMIC_INTENT_PATTERN);
		for (const name of RESERVED_FRAME_TYPES) {
			expect(BUILTIN_INTENT_NAMES).not.toContain(name);
			expect(dynamic.test(name)).toBe(false);
			expect(client({ type: name, intentId: "i-1" })).toBe(false);
		}
		expect(new Set(BUILTIN_INTENT_NAMES).size).toBe(Object.keys(INTENT_SCHEMAS).length);
		expect(QUERY_NAMES).toContain("history");
	});
});

describe("host frames", () => {
	it("welcome a client and stream a snapshot, entries, and heads", () => {
		expect(
			host({
				type: "welcome",
				protocol: 1,
				connectionId: "c1",
				profile: "remote",
				server: { name: "volt", version: "0.3.0" },
			}),
		).toBe(true);
		const entry = {
			ordinal: 3,
			id: "e3",
			parentId: null,
			type: "message",
			timestamp: "2026-01-01T00:00:03.000Z",
			view: { role: "user", text: "hi", truncated: false, clientMessageId: "c-1" },
		} as const;
		expect(host({ type: "entry", subscriptionId: "s1", entry })).toBe(true);
		expect(host({ type: "entry", subscriptionId: "s1", entry: { ...entry, type: "test_product" } })).toBe(false);
		expect(host({ type: "entry", subscriptionId: "s1", entry: { ...entry, visibility: "public" } })).toBe(false);
		expect(host({ type: "head", subscriptionId: "s1", ordinal: 9 })).toBe(true);
		const state = clientSnapshot(clientFold([entry]));
		expect(host({ type: "snapshot", subscriptionId: "s1", conversation: "session-1", ordinal: 3, state })).toBe(true);
	});

	it("carry live items scoped by basedOn and seq", () => {
		const live = { type: "live", subscriptionId: "s1", basedOn: 12, seq: 1, reset: true };
		expect(
			host({
				...live,
				items: [
					{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: "h" } },
					{ type: "tool", op: "update", toolCallId: "t1", toolName: "bash", partial: { content: [] } },
					{ type: "set", key: "phase", value: { kind: "phase", busy: true, operation: "turn" } },
					{
						type: "set",
						key: "host_request/r1",
						value: {
							kind: "host_request",
							requestId: "r1",
							request: { kind: "confirm", title: "Delete?", message: "Really?" },
						},
					},
					{ type: "clear", key: "ext_status/build" },
					{ type: "notice", level: "error", message: "boom" },
					{ type: "directive", directive: "set_editor_text", text: "draft" },
				],
			}),
		).toBe(true);
		expect(host({ ...live, seq: 0, items: [] })).toBe(false);
		expect(host({ ...live, items: [{ type: "clear", key: "phase/extra" }] })).toBe(false);
		expect(host({ ...live, items: [{ type: "clear", key: "host_request/" }] })).toBe(false);
	});

	it("answer intents and queries and end subscriptions", () => {
		expect(host({ type: "accepted", intentId: "i1", ordinals: [4, 5], result: { cancelled: true } })).toBe(true);
		expect(host({ type: "accepted", intentId: "i1", ordinals: [0] })).toBe(false);
		expect(
			host({
				type: "rejected",
				intentId: "i1",
				reason: { code: "not_allowed", message: "no", requiredCapability: "host.manage.v1" },
			}),
		).toBe(true);
		expect(
			host({ type: "rejected", intentId: "i1", reason: { code: "stale_conversation_authority", message: "" } }),
		).toBe(false);
		expect(host({ type: "result", queryId: "q1", data: { models: [] } })).toBe(true);
		expect(host({ type: "query_error", queryId: "q1", reason: { code: "unknown_query", message: "?" } })).toBe(true);
		expect(host({ type: "ended", subscriptionId: "s1", reason: "moved", target: "session-2" })).toBe(true);
		expect(host({ type: "ended", subscriptionId: "s1", reason: "moved" })).toBe(false);
		expect(host({ type: "ended", subscriptionId: "s1", reason: "lost" })).toBe(true);
		expect(host({ type: "changed", catalog: "settings" })).toBe(true);
		expect(host({ type: "fatal", code: "revoked" })).toBe(true);
		expect(host({ type: "fatal", code: "overflow" })).toBe(false);
	});

	it("name live values by family", () => {
		for (const key of ["phase", "intents", "work/w1", "workflow/w1", "ext_widget/a/b"]) {
			expect(Check(LiveKeySchema, key), key).toBe(true);
		}
		for (const key of ["", "phase/", "workflow", "jobs", "subagent/sub-1", "unknown/x", "ext_status/\u0007"]) {
			expect(Check(LiveKeySchema, key), key).toBe(false);
		}
	});
});
