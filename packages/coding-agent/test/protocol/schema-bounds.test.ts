/**
 * Byte and item budgets the protocol schemas only annotate
 * (`x-volt-max-utf8-bytes`, `x-volt-max-items`): JSON Schema cannot express
 * them, so the intent and query registries and the connection's frame
 * admission check them after the schema check.
 */

import {
	type HostFrame,
	RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN,
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
} from "@hansjm10/volt-protocol";
import * as fc from "fast-check";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type IntentContext,
	IntentRejectedError,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../src/core/protocol/intents/index.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { QueryRejectedError, queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { formatSchemaBoundError } from "../../src/core/protocol/schema-errors.ts";
import { serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/protocol/transport/index.ts";
import { isValidClientMessageId } from "../../src/core/session-manager.ts";
import { createHostHarness } from "../suite/host-harness.ts";

/** An identifier one byte past the limit, made of two-byte characters so its length in characters stays under it. */
const LONG_ID = `${"é".repeat(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES / 2)}x`;
const LOCAL: IntentContext = { services: {}, profile: LOCAL_INTENT_PROFILE };

function rejection(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("Expected a rejection");
}

describe("annotated budgets", () => {
	it("names the first string past its UTF-8 budget and the first array past its item budget", () => {
		const schema = Type.Object({
			id: Type.String({ "x-volt-max-utf8-bytes": 4 }),
			list: Type.Optional(Type.Array(Type.String({ "x-volt-max-utf8-bytes": 2 }), { "x-volt-max-items": 2 })),
			either: Type.Optional(
				Type.Union([Type.Number(), Type.Object({ name: Type.String({ "x-volt-max-utf8-bytes": 1 }) })]),
			),
		});
		expect(formatSchemaBoundError(schema, { id: "abcd" })).toBeUndefined();
		expect(formatSchemaBoundError(schema, { id: "ééé" })).toBe('"id" exceeds the 4-byte UTF-8 limit');
		expect(formatSchemaBoundError(schema, { id: "a", list: ["a", "bb", "c"] })).toBe(
			'"list" exceeds the 2-item limit',
		);
		expect(formatSchemaBoundError(schema, { id: "a", list: ["a", "é!"] })).toBe(
			'"list[1]" exceeds the 2-byte UTF-8 limit',
		);
		expect(formatSchemaBoundError(schema, { id: "a", either: 7 })).toBeUndefined();
		expect(formatSchemaBoundError(schema, { id: "a", either: { name: "ab" } })).toBe(
			'"either.name" exceeds the 1-byte UTF-8 limit',
		);
	});
});

describe("intent and query admission", () => {
	it("rejects an identifier past 256 UTF-8 bytes as invalid input, and admits one at the limit", () => {
		const error = rejection(() =>
			intentRegistry.prepareFrame(LOCAL, "review_cancel_workflow", { workflowId: LONG_ID }),
		);
		expect(error).toBeInstanceOf(IntentRejectedError);
		expect(error).toMatchObject({
			code: "invalid_input",
			message: `Invalid review_cancel_workflow input: "workflowId" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		});
		const atLimit = "é".repeat(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES / 2);
		// Admitted past the budget check; a conversation-scope intent then needs a conversation.
		expect(
			rejection(() => intentRegistry.prepareFrame(LOCAL, "review_cancel_workflow", { workflowId: atLimit })),
		).toMatchObject({
			code: "unavailable",
		});
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(LOCAL, "review_record_finding_outcome", {
					runId: "run",
					findingId: LONG_ID,
					status: "accepted",
				}),
			),
		).toMatchObject({ code: "invalid_input", message: expect.stringContaining('"findingId" exceeds') });
	});

	it("bounds conversation input: the message's UTF-8 bytes and the image count", () => {
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(LOCAL, "prompt", {
					message: "m".repeat(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES + 1),
				}),
			),
		).toMatchObject({
			code: "invalid_input",
			message: `Invalid prompt input: "message" exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		});
		const image = { type: "image", mimeType: "image/png", data: "a" };
		expect(
			rejection(() =>
				intentRegistry.prepareFrame(LOCAL, "steer", {
					message: "m",
					images: Array.from({ length: RPC_CONVERSATION_INPUT_MAX_IMAGES + 1 }, () => image),
				}),
			),
		).toMatchObject({
			code: "invalid_input",
			message: `Invalid steer input: "images" exceeds the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-item limit`,
		});
	});

	it("rejects query parameters past their budgets", async () => {
		const error = await queryRegistry.runFrame(LOCAL, "review.general", { runId: LONG_ID }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(QueryRejectedError);
		expect(error).toMatchObject({
			code: "invalid_input",
			message: `Invalid review.general parameters: "runId" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		});
	});
});

describe("frame admission", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it.each([
		["an intent id", { type: "abort", intentId: LONG_ID }],
		["a query id", { type: "query", queryId: LONG_ID, query: "settings" }],
		["a subscription id", { type: "subscribe", subscriptionId: LONG_ID, conversation: "c", after: "snapshot" }],
	])("ends the connection on a frame whose %s is past 256 UTF-8 bytes", async (_label, frame) => {
		const harness = await createHostHarness();
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, { host: harness.host, conversation });
		cleanups.push(async () => {
			await pair.client.close();
			await connection.closed.catch(() => undefined);
		});
		const frames: HostFrame[] = [];
		pair.client.onValue?.((value) => {
			frames.push(value as HostFrame);
		});
		pair.client.write({
			type: "hello",
			protocol: 1,
			client: { name: "test", version: "1" },
			accepts: { hostRequests: [] },
		});
		await connection.ready;
		pair.client.write(frame);
		await connection.closed.catch(() => undefined);
		expect(frames.at(-1)).toEqual({ type: "fatal", code: "invalid_frame", message: `Invalid ${frame.type} frame` });
	});
});

describe("client message identities", () => {
	it("match the schema pattern exactly when the host's grammar accepts them", () => {
		const schemaPattern = new RegExp(RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN);
		const candidates = fc.oneof(
			fc.string({ maxLength: 300 }),
			fc.string({ unit: "binary", maxLength: 300 }),
			fc.stringMatching(/^[A-Za-z0-9._:-]{0,300}$/),
			fc.stringMatching(/^[A-Za-z0-9._:-]{0,40}$/).map((suffix) => `local-queue:${suffix}`),
		);
		fc.assert(
			fc.property(candidates, (value) => {
				expect(schemaPattern.test(value)).toBe(isValidClientMessageId(value));
			}),
		);
	});
});
