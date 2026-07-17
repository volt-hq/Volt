import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AssistantMessageInit, AssistantStreamFragment } from "../src/stream/fragments.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "../src/types.ts";
import type { AssistantMessageDiagnostic } from "../src/utils/diagnostics.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

type SnapshotEvent = Extract<AssistantMessageEvent, { snapshot: AssistantMessage }>;
type EventOfType<T extends AssistantMessageEvent["type"]> = Extract<AssistantMessageEvent, { type: T }>;

interface NormalizedRun {
	events: AssistantMessageEvent[];
	result: AssistantMessage;
}

function createUsage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		...overrides,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			...overrides.cost,
		},
	};
}

function startFragment(overrides: Partial<AssistantMessageInit> = {}): AssistantStreamFragment {
	return {
		type: "start",
		init: {
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			timestamp: 123,
			...overrides,
		},
	};
}

async function normalize(fragments: readonly AssistantStreamFragment[]): Promise<NormalizedRun> {
	const normalizer = new AssistantStreamNormalizer();
	for (const fragment of fragments) {
		normalizer.push(fragment);
	}
	normalizer.end();

	const events: AssistantMessageEvent[] = [];
	for await (const event of normalizer.stream) {
		events.push(event);
	}
	return { events, result: await normalizer.stream.result() };
}

function getEvent<T extends AssistantMessageEvent["type"]>(
	events: readonly AssistantMessageEvent[],
	type: T,
	occurrence = 0,
): EventOfType<T> {
	const event = events.filter((candidate) => candidate.type === type)[occurrence];
	if (!event || event.type !== type) {
		throw new Error(`Expected ${type} event at occurrence ${occurrence}`);
	}
	return event as EventOfType<T>;
}

function getSnapshotEvent(
	events: readonly AssistantMessageEvent[],
	predicate: (event: SnapshotEvent) => boolean,
): SnapshotEvent {
	const event = events.find(
		(candidate): candidate is SnapshotEvent => "snapshot" in candidate && predicate(candidate),
	);
	if (!event) {
		throw new Error("Expected matching snapshot event");
	}
	return event;
}

function expectContiguousSeq(events: readonly AssistantMessageEvent[]): void {
	expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Expected record");
	}
	return value as Record<string, unknown>;
}

describe("AssistantStreamNormalizer", () => {
	it("assigns contiguous seq values and keeps retained snapshots immutable", async () => {
		const { events, result } = await normalize([
			startFragment(),
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "A" },
			{ type: "text_delta", contentIndex: 0, delta: "B" },
			{ type: "done", reason: "stop" },
		]);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
			"done",
		]);
		expectContiguousSeq(events);

		const firstDelta = getEvent(events, "text_delta", 0);
		const secondDelta = getEvent(events, "text_delta", 1);
		const firstBlock = firstDelta.snapshot.content[0];
		const secondBlock = secondDelta.snapshot.content[0];
		expect(firstBlock).toEqual({ type: "text", text: "A" });
		expect(secondBlock).toEqual({ type: "text", text: "AB" });
		expect(firstDelta.snapshot).not.toBe(secondDelta.snapshot);
		expect(Object.isFrozen(firstDelta)).toBe(true);
		expect(Object.isFrozen(firstDelta.snapshot)).toBe(true);
		expect(Object.isFrozen(firstDelta.snapshot.content)).toBe(true);
		expect(Object.isFrozen(firstBlock)).toBe(true);
		expect(Object.isFrozen(firstDelta.toolState)).toBe(true);

		expect(() => {
			firstDelta.seq = 99;
		}).toThrow();
		expect(() => {
			firstDelta.snapshot.content.push({ type: "text", text: "mutated" });
		}).toThrow();
		if (!firstBlock || firstBlock.type !== "text") {
			throw new Error("Expected text block");
		}
		expect(() => {
			firstBlock.text = "mutated";
		}).toThrow();

		expect(firstDelta.snapshot.content[0]).toEqual({ type: "text", text: "A" });
		expect(result.content[0]).toEqual({ type: "text", text: "AB" });
	});

	it("folds meta patches silently and freezes newly introduced metadata", async () => {
		const firstDiagnostic = {
			type: "transport_fallback",
			timestamp: 10,
			details: { attempt: 1, nested: { source: "websocket" } },
		} satisfies AssistantMessageDiagnostic;
		const secondDiagnostic = {
			type: "provider_notice",
			timestamp: 11,
			details: { code: "retry" },
		} satisfies AssistantMessageDiagnostic;
		const { events } = await normalize([
			startFragment({ usage: createUsage({ input: 1 }) }),
			{
				type: "meta",
				patch: {
					responseId: "response-1",
					responseModel: "resolved-model",
					usage: { input: 7, cost: { input: 0.1 } },
					diagnostics: [firstDiagnostic],
				},
			},
			{ type: "text_start", contentIndex: 0 },
			{
				type: "meta",
				patch: {
					usage: { output: 3, totalTokens: 10, cost: { output: 0.2, total: 0.3 } },
					diagnostics: [secondDiagnostic],
				},
			},
			{ type: "text_delta", contentIndex: 0, delta: "ok" },
			{ type: "done", reason: "stop" },
		]);

		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expectContiguousSeq(events);
		const start = getEvent(events, "start");
		const textStart = getEvent(events, "text_start");
		const textDelta = getEvent(events, "text_delta");
		expect(start.snapshot.responseId).toBeUndefined();
		expect(start.snapshot.usage.input).toBe(1);
		expect(textStart.snapshot).toMatchObject({
			responseId: "response-1",
			responseModel: "resolved-model",
			usage: { input: 7, output: 0, cost: { input: 0.1, output: 0 } },
		});
		expect(textDelta.snapshot.usage).toMatchObject({
			input: 7,
			output: 3,
			totalTokens: 10,
			cost: { input: 0.1, output: 0.2, total: 0.3 },
		});
		expect(textDelta.snapshot.diagnostics?.map((diagnostic) => diagnostic.type)).toEqual([
			"transport_fallback",
			"provider_notice",
		]);
		expect(Object.isFrozen(textDelta.snapshot.usage)).toBe(true);
		expect(Object.isFrozen(textDelta.snapshot.usage.cost)).toBe(true);
		expect(Object.isFrozen(textDelta.snapshot.diagnostics)).toBe(true);
		const frozenDetails = requireRecord(textDelta.snapshot.diagnostics?.[0]?.details);
		expect(Object.isFrozen(frozenDetails)).toBe(true);
		expect(Object.isFrozen(requireRecord(frozenDetails.nested))).toBe(true);
	});

	it("treats text, thinking, and tool-call end payloads as authoritative replacements", async () => {
		const authoritativeToolCall = {
			type: "toolCall",
			id: "tool-final",
			name: "write",
			arguments: { path: "final.md", options: { overwrite: true } },
			thoughtSignature: "opaque-tool-signature",
		} as const;
		const { events, result } = await normalize([
			startFragment(),
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "draft text" },
			{ type: "text_end", contentIndex: 0, content: "final text", textSignature: "text-signature" },
			{ type: "thinking_start", contentIndex: 1 },
			{ type: "thinking_delta", contentIndex: 1, delta: "draft thought" },
			{
				type: "thinking_end",
				contentIndex: 1,
				content: "final thought",
				thinkingSignature: "thinking-signature",
				redacted: true,
			},
			{ type: "toolcall_start", contentIndex: 2, id: "tool-draft", name: "read" },
			{ type: "toolcall_delta", contentIndex: 2, argsTextDelta: '{"path":"draft.md"}' },
			{ type: "toolcall_end", contentIndex: 2, toolCall: authoritativeToolCall },
			{ type: "done", reason: "toolUse" },
		]);

		const textEnd = getEvent(events, "text_end");
		const thinkingEnd = getEvent(events, "thinking_end");
		const toolEnd = getEvent(events, "toolcall_end");
		expect(textEnd.content).toBe("final text");
		expect(textEnd.snapshot.content[0]).toEqual({
			type: "text",
			text: "final text",
			textSignature: "text-signature",
		});
		expect(thinkingEnd.content).toBe("final thought");
		expect(thinkingEnd.snapshot.content[1]).toEqual({
			type: "thinking",
			thinking: "final thought",
			thinkingSignature: "thinking-signature",
			redacted: true,
		});
		expect(toolEnd.toolCall).toEqual(authoritativeToolCall);
		expect(toolEnd.snapshot.content[2]).toBe(toolEnd.toolCall);
		expect(result.content).toEqual(
			textEnd.snapshot.content.slice(0, 1).concat([thinkingEnd.snapshot.content[1]!, toolEnd.toolCall]),
		);
		const toolArguments = requireRecord(toolEnd.toolCall.arguments);
		expect(Object.isFrozen(toolEnd.toolCall)).toBe(true);
		expect(Object.isFrozen(toolArguments)).toBe(true);
		expect(Object.isFrozen(requireRecord(toolArguments.options))).toBe(true);
	});

	it("synthesizes starts for orphan text, thinking, and tool-call deltas", async () => {
		const { events } = await normalize([
			startFragment(),
			{ type: "text_delta", contentIndex: 0, delta: "text" },
			{ type: "text_end", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 1, delta: "thought", signatureDelta: "sig" },
			{ type: "thinking_end", contentIndex: 1 },
			{
				type: "toolcall_delta",
				contentIndex: 2,
				argsTextDelta: '{"path":"notes.md"}',
				id: "tool-1",
				name: "write",
			},
			{ type: "toolcall_end", contentIndex: 2 },
			{ type: "done", reason: "toolUse" },
		]);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expectContiguousSeq(events);
		const toolDelta = getEvent(events, "toolcall_delta");
		expect(toolDelta.snapshot.content[2]).toEqual({
			type: "toolCall",
			id: "tool-1",
			name: "write",
			arguments: { path: "notes.md" },
		});
	});

	it("drops fragments for closed blocks and records privacy-safe diagnostics", async () => {
		const secret = "/Users/alice/private/secret.txt";
		const { events, result } = await normalize([
			startFragment(),
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "safe" },
			{ type: "text_end", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: secret },
			{ type: "done", reason: "stop" },
		]);

		expect(events.filter((event) => event.type === "text_delta")).toHaveLength(1);
		expectContiguousSeq(events);
		expect(result.content[0]).toEqual({ type: "text", text: "safe" });
		const diagnostic = result.diagnostics?.find(
			(candidate) => candidate.type === "assistant_stream_contract_violation",
		);
		expect(diagnostic).toMatchObject({
			type: "assistant_stream_contract_violation",
			details: { code: "fragment_after_block_end", contentIndex: 0, blockKind: "text" },
		});
		expect(JSON.stringify(result.diagnostics)).not.toContain(secret);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it("drops duplicate starts without replacing the original message", async () => {
		const duplicateSecret = "duplicate-secret-model";
		const { events, result } = await normalize([
			startFragment({ model: "original-model", timestamp: 10 }),
			startFragment({ model: duplicateSecret, timestamp: 999, responseId: "duplicate-response" }),
			{ type: "text_start", contentIndex: 0 },
			{ type: "done", reason: "stop" },
		]);

		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expectContiguousSeq(events);
		expect(result.model).toBe("original-model");
		expect(result.timestamp).toBe(10);
		expect(result.responseId).toBeUndefined();
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				type: "assistant_stream_contract_violation",
				details: { code: "duplicate_start" },
			}),
		]);
		expect(JSON.stringify(result.diagnostics)).not.toContain(duplicateSecret);
	});

	it("auto-closes every open block before a success terminal and ignores later fragments", async () => {
		const { events, result } = await normalize([
			startFragment(),
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "answer" },
			{ type: "thinking_start", contentIndex: 1 },
			{ type: "thinking_delta", contentIndex: 1, delta: "plan" },
			{ type: "toolcall_start", contentIndex: 2, id: "tool-1", name: "write" },
			{ type: "toolcall_delta", contentIndex: 2, argsTextDelta: '{"path":"notes.md"}' },
			{ type: "done", reason: "toolUse" },
			{ type: "text_delta", contentIndex: 0, delta: "ignored-after-terminal" },
		]);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"text_start",
			"text_delta",
			"thinking_start",
			"thinking_delta",
			"toolcall_start",
			"toolcall_delta",
			"text_end",
			"thinking_end",
			"toolcall_end",
			"done",
		]);
		expectContiguousSeq(events);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "thinking", thinking: "plan" },
			{ type: "toolCall", id: "tool-1", name: "write", arguments: { path: "notes.md" } },
		]);
		expect(JSON.stringify(result)).not.toContain("ignored-after-terminal");
	});

	it("synthesizes an error terminal when the fragment source ends without one", async () => {
		const { events, result } = await normalize([
			startFragment(),
			{ type: "thinking_start", contentIndex: 0 },
			{ type: "thinking_delta", contentIndex: 0, delta: "unfinished", signatureDelta: "partial-signature" },
		]);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"error",
		]);
		expectContiguousSeq(events);
		const error = getEvent(events, "error");
		expect(error.reason).toBe("error");
		expect(error.error).toBe(result);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Assistant stream ended without a terminal fragment",
			content: [{ type: "thinking", thinking: "unfinished", thinkingSignature: "partial-signature" }],
		});
	});

	it("tracks concurrent tool calls independently and drains toolState by cardinality", async () => {
		const { events } = await normalize([
			startFragment(),
			{ type: "toolcall_start", contentIndex: 0, id: "tool-a", name: "a" },
			{ type: "toolcall_start", contentIndex: 1, id: "tool-b", name: "b" },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"b":' },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"a":1}' },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "2}" },
			{ type: "toolcall_end", contentIndex: 1 },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);

		const completedBDelta = getSnapshotEvent(
			events,
			(event) => event.type === "toolcall_delta" && event.contentIndex === 1 && event.argsTextDelta === "2}",
		);
		expect(completedBDelta.toolState).toEqual([
			{ contentIndex: 0, argsText: '{"a":1}' },
			{ contentIndex: 1, argsText: '{"b":2}' },
		]);
		expect(Object.isFrozen(completedBDelta.toolState)).toBe(true);
		expect(completedBDelta.toolState.every((state) => Object.isFrozen(state))).toBe(true);

		const endB = getSnapshotEvent(events, (event) => event.type === "toolcall_end" && event.contentIndex === 1);
		const endA = getSnapshotEvent(events, (event) => event.type === "toolcall_end" && event.contentIndex === 0);
		expect(endB.toolState).toEqual([{ contentIndex: 0, argsText: '{"a":1}' }]);
		expect(endA.toolState).toEqual([]);
		expect(endB.snapshot.content[1]).toEqual({
			type: "toolCall",
			id: "tool-b",
			name: "b",
			arguments: { b: 2 },
		});
		expect(endA.snapshot.content[0]).toEqual({
			type: "toolCall",
			id: "tool-a",
			name: "a",
			arguments: { a: 1 },
		});
	});

	it("patches tool-call identity when it arrives after the start fragment", async () => {
		const { events, result } = await normalize([
			startFragment(),
			{ type: "toolcall_start", contentIndex: 0 },
			{
				type: "toolcall_delta",
				contentIndex: 0,
				argsTextDelta: '{"path":',
				id: "late-id",
				name: "late-name",
			},
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '"notes.md"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);

		const start = getEvent(events, "toolcall_start");
		const identityDelta = getEvent(events, "toolcall_delta", 0);
		const laterDelta = getEvent(events, "toolcall_delta", 1);
		expect(start).toMatchObject({ id: "", name: "" });
		expect(start.snapshot.content[0]).toMatchObject({ id: "", name: "" });
		expect(identityDelta).toMatchObject({ id: "late-id", name: "late-name" });
		expect(identityDelta.snapshot.content[0]).toMatchObject({ id: "late-id", name: "late-name" });
		expect(laterDelta).not.toHaveProperty("id");
		expect(laterDelta.snapshot.content[0]).toMatchObject({ id: "late-id", name: "late-name" });
		expect(result.content[0]).toEqual({
			type: "toolCall",
			id: "late-id",
			name: "late-name",
			arguments: { path: "notes.md" },
		});
	});

	it("accumulates streamed thinking signatures across deltas", async () => {
		const { events, result } = await normalize([
			startFragment(),
			{ type: "thinking_start", contentIndex: 0, thinkingSignature: "seed:" },
			{ type: "thinking_delta", contentIndex: 0, delta: "first", signatureDelta: "one:" },
			{ type: "thinking_delta", contentIndex: 0, delta: " second", signatureDelta: "two" },
			{ type: "thinking_end", contentIndex: 0 },
			{ type: "done", reason: "stop" },
		]);

		const firstDelta = getEvent(events, "thinking_delta", 0);
		const secondDelta = getEvent(events, "thinking_delta", 1);
		expect(firstDelta.snapshot.content[0]).toEqual({
			type: "thinking",
			thinking: "first",
			thinkingSignature: "seed:one:",
		});
		expect(secondDelta.snapshot.content[0]).toEqual({
			type: "thinking",
			thinking: "first second",
			thinkingSignature: "seed:one:two",
		});
		expect(result.content[0]).toEqual(secondDelta.snapshot.content[0]);
	});

	it("preserves open thinking signatures and tool arguments on abort", async () => {
		const abortDiagnostic = {
			type: "abort_context",
			timestamp: 20,
			details: { source: "user" },
		} satisfies AssistantMessageDiagnostic;
		const { events, result } = await normalize([
			startFragment(),
			{ type: "thinking_start", contentIndex: 0, thinkingSignature: "signature:" },
			{ type: "thinking_delta", contentIndex: 0, delta: "partial plan", signatureDelta: "tail" },
			{ type: "toolcall_start", contentIndex: 1, id: "tool-1", name: "write" },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"path":"notes.md","count":2}' },
			{
				type: "error",
				reason: "aborted",
				errorMessage: "Request was aborted",
				diagnostics: [abortDiagnostic],
				usage: createUsage({ input: 4, output: 2, totalTokens: 6 }),
			},
		]);

		expect(events.slice(-3).map((event) => event.type)).toEqual(["thinking_end", "toolcall_end", "error"]);
		expectContiguousSeq(events);
		const error = getEvent(events, "error");
		expect(error.reason).toBe("aborted");
		expect(error.error).toBe(result);
		expect(result).toMatchObject({
			stopReason: "aborted",
			errorMessage: "Request was aborted",
			usage: { input: 4, output: 2, totalTokens: 6 },
			content: [
				{ type: "thinking", thinking: "partial plan", thinkingSignature: "signature:tail" },
				{
					type: "toolCall",
					id: "tool-1",
					name: "write",
					arguments: { path: "notes.md", count: 2 },
				},
			],
		});
		expect(result.diagnostics).toEqual([abortDiagnostic]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.content)).toBe(true);
	});
});

type GeneratedTerminal = "done" | "error" | "missing";

interface GeneratedFragmentStreamInput {
	terminal: GeneratedTerminal;
	orphanText: string;
	extraText: string[];
	thinkingDeltas: { delta: string; signatureDelta: string }[];
	toolTwoValue: string;
	toolThreeValue: string;
	toolFourValue: string;
	toolTwoSplitSeed: number;
	toolThreeSplitSeed: number;
	overrideDraft: string;
	overrideFinal: string;
	redactedThinking: string;
	metaInput: number;
}

interface GeneratedFragmentStream {
	fragments: AssistantStreamFragment[];
	expectedContent: AssistantMessage["content"];
	input: GeneratedFragmentStreamInput;
}

const generatedFragmentStreamInputArbitrary: fc.Arbitrary<GeneratedFragmentStreamInput> = fc.record({
	terminal: fc.constantFrom("done", "error", "missing"),
	orphanText: fc.string({ maxLength: 12 }),
	extraText: fc.array(fc.string({ maxLength: 10 }), { maxLength: 5 }),
	thinkingDeltas: fc.array(
		fc.record({
			delta: fc.string({ maxLength: 10 }),
			signatureDelta: fc.string({ maxLength: 8 }),
		}),
		{ minLength: 1, maxLength: 5 },
	),
	toolTwoValue: fc.string({ maxLength: 14 }),
	toolThreeValue: fc.string({ maxLength: 14 }),
	toolFourValue: fc.string({ maxLength: 14 }),
	toolTwoSplitSeed: fc.nat(),
	toolThreeSplitSeed: fc.nat(),
	overrideDraft: fc.string({ maxLength: 12 }),
	overrideFinal: fc.string({ maxLength: 12 }),
	redactedThinking: fc.string({ maxLength: 12 }),
	metaInput: fc.integer({ min: 0, max: 10_000 }),
});

const DROPPED_FRAGMENT_SECRET = "/generated/private/fragment-secret";

function splitAtSeed(value: string, seed: number): [string, string] {
	const split = seed % (value.length + 1);
	return [value.slice(0, split), value.slice(split)];
}

function buildGeneratedFragmentStream(input: GeneratedFragmentStreamInput): GeneratedFragmentStream {
	const thinkingText = input.thinkingDeltas.map((entry) => entry.delta).join("");
	const thinkingSignature = input.thinkingDeltas.map((entry) => entry.signatureDelta).join("");
	const toolTwoArgumentsText = JSON.stringify({ value: input.toolTwoValue, source: "orphan" });
	const toolThreeArgumentsText = JSON.stringify({ value: input.toolThreeValue, source: "patched" });
	const toolFourArgumentsText = JSON.stringify({ value: input.toolFourValue, source: "unpatched" });
	const [toolTwoFirst, toolTwoSecond] = splitAtSeed(toolTwoArgumentsText, input.toolTwoSplitSeed);
	const [toolThreeFirst, toolThreeSecond] = splitAtSeed(toolThreeArgumentsText, input.toolThreeSplitSeed);
	const authoritativeToolTwo = Object.freeze({
		type: "toolCall" as const,
		id: "authoritative-id",
		name: "authoritative-name",
		arguments: { authoritative: input.toolTwoValue },
		thoughtSignature: "authoritative-tool-signature",
	});
	const fragments: AssistantStreamFragment[] = [
		startFragment({ model: "original-model", timestamp: 100 }),
		startFragment({ model: DROPPED_FRAGMENT_SECRET, timestamp: 999 }),
		{
			type: "meta",
			patch: {
				responseId: `response-${input.metaInput}`,
				usage: { input: input.metaInput },
				diagnostics: [
					{
						type: "generated_meta",
						timestamp: 1,
						details: { phase: "first", nested: { input: input.metaInput } },
					},
				],
			},
		},
		// Orphan deltas synthesize dense starts for all three block kinds.
		{ type: "text_delta", contentIndex: 0, delta: input.orphanText },
		{ type: "text_delta", contentIndex: 0, delta: "" },
		...input.extraText.map((delta): AssistantStreamFragment => ({ type: "text_delta", contentIndex: 0, delta })),
		{
			type: "thinking_delta",
			contentIndex: 1,
			delta: input.thinkingDeltas[0]?.delta ?? "",
			signatureDelta: input.thinkingDeltas[0]?.signatureDelta ?? "",
		},
		...input.thinkingDeltas.slice(1).map(
			({ delta, signatureDelta }): AssistantStreamFragment => ({
				type: "thinking_delta",
				contentIndex: 1,
				delta,
				signatureDelta,
			}),
		),
		{
			type: "toolcall_delta",
			contentIndex: 2,
			argsTextDelta: toolTwoFirst,
			id: "orphan-id",
			name: "orphan-name",
		},
		{ type: "toolcall_delta", contentIndex: 2, argsTextDelta: toolTwoSecond },
		// One empty identity is patched by a later delta; the next is never patched.
		{ type: "toolcall_start", contentIndex: 3 },
		{ type: "toolcall_delta", contentIndex: 3, argsTextDelta: "" },
		{
			type: "toolcall_delta",
			contentIndex: 3,
			argsTextDelta: toolThreeFirst,
			id: "late-id",
			name: "late-name",
		},
		{ type: "toolcall_delta", contentIndex: 3, argsTextDelta: toolThreeSecond },
		{ type: "toolcall_start", contentIndex: 4 },
		{ type: "toolcall_delta", contentIndex: 4, argsTextDelta: toolFourArgumentsText },
		{ type: "text_start", contentIndex: 5 },
		{ type: "text_delta", contentIndex: 5, delta: input.overrideDraft },
		{
			type: "thinking_start",
			contentIndex: 6,
			content: input.redactedThinking,
			thinkingSignature: "redacted-thinking-signature",
			redacted: true,
		},
		{
			type: "meta",
			patch: {
				responseModel: "resolved-generated-model",
				usage: { output: 2, totalTokens: input.metaInput + 2 },
				diagnostics: [{ type: "generated_meta", timestamp: 2, details: { phase: "second" } }],
			},
		},
		{ type: "text_delta", contentIndex: 5, delta: "" },
		// Close concurrent calls out of index order while other blocks remain open.
		{ type: "toolcall_end", contentIndex: 4 },
		{ type: "toolcall_end", contentIndex: 2, toolCall: authoritativeToolTwo },
		{
			type: "text_end",
			contentIndex: 5,
			content: `authoritative:${input.overrideFinal}`,
			textSignature: "authoritative-text-signature",
		},
		// A closed-block fragment is diagnosed and its raw payload is never retained.
		{ type: "text_delta", contentIndex: 5, delta: DROPPED_FRAGMENT_SECRET },
	];

	if (input.terminal === "done") {
		fragments.push({ type: "done", reason: "toolUse" });
	} else if (input.terminal === "error") {
		fragments.push({
			type: "error",
			reason: "aborted",
			errorMessage: "generated abort",
			diagnostics: [{ type: "generated_abort", timestamp: 3, details: { source: "property" } }],
		});
	}
	if (input.terminal !== "missing") {
		fragments.push(
			{ type: "text_delta", contentIndex: 0, delta: DROPPED_FRAGMENT_SECRET },
			startFragment({ model: DROPPED_FRAGMENT_SECRET }),
		);
	}

	return {
		input,
		fragments,
		expectedContent: [
			{ type: "text", text: input.orphanText + input.extraText.join("") },
			{ type: "thinking", thinking: thinkingText, thinkingSignature },
			authoritativeToolTwo,
			{
				type: "toolCall",
				id: "late-id",
				name: "late-name",
				arguments: { value: input.toolThreeValue, source: "patched" },
			},
			{
				type: "toolCall",
				id: "",
				name: "",
				arguments: { value: input.toolFourValue, source: "unpatched" },
			},
			{
				type: "text",
				text: `authoritative:${input.overrideFinal}`,
				textSignature: "authoritative-text-signature",
			},
			{
				type: "thinking",
				thinking: input.redactedThinking,
				thinkingSignature: "redacted-thinking-signature",
				redacted: true,
			},
		],
	};
}

function expectDeeplyFrozen(value: unknown, seen = new Set<object>()): void {
	if (typeof value !== "object" || value === null || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const nested of Object.values(value)) expectDeeplyFrozen(nested, seen);
}

function requireContentBlock(message: AssistantMessage, contentIndex: number): AssistantMessage["content"][number] {
	const block = message.content[contentIndex];
	if (!block) throw new Error(`Expected content block ${contentIndex}`);
	return block;
}

function expectGeneratedContentAndToolStateInvariants(events: readonly AssistantMessageEvent[]): void {
	expectContiguousSeq(events);
	const openArgs = new Map<number, string>();
	let previousSnapshot: AssistantMessage | undefined;

	for (const event of events) {
		if (!("snapshot" in event)) continue;
		expectDeeplyFrozen(event);
		const contentIndex = "contentIndex" in event ? event.contentIndex : undefined;

		if (previousSnapshot) {
			expect(event.snapshot).not.toBe(previousSnapshot);
			expect(event.snapshot.content).not.toBe(previousSnapshot.content);
			for (
				let index = 0;
				index < Math.min(previousSnapshot.content.length, event.snapshot.content.length);
				index += 1
			) {
				if (index !== contentIndex) expect(event.snapshot.content[index]).toBe(previousSnapshot.content[index]);
			}

			if (event.type === "text_delta") {
				const before = requireContentBlock(previousSnapshot, event.contentIndex);
				const after = requireContentBlock(event.snapshot, event.contentIndex);
				if (before.type !== "text" || after.type !== "text") throw new Error("Expected text blocks");
				expect(after.text).toBe(before.text + event.delta);
			} else if (event.type === "thinking_delta") {
				const before = requireContentBlock(previousSnapshot, event.contentIndex);
				const after = requireContentBlock(event.snapshot, event.contentIndex);
				if (before.type !== "thinking" || after.type !== "thinking") {
					throw new Error("Expected thinking blocks");
				}
				expect(after.thinking).toBe(before.thinking + event.delta);
			}
		}

		switch (event.type) {
			case "toolcall_start": {
				openArgs.set(event.contentIndex, "");
				const block = requireContentBlock(event.snapshot, event.contentIndex);
				if (block.type !== "toolCall") throw new Error("Expected tool-call block");
				expect(block).toMatchObject({ id: event.id, name: event.name, arguments: {} });
				break;
			}
			case "toolcall_delta": {
				const previous = openArgs.get(event.contentIndex);
				if (previous === undefined) throw new Error("Expected open raw tool arguments");
				const next = previous + event.argsTextDelta;
				openArgs.set(event.contentIndex, next);
				const block = requireContentBlock(event.snapshot, event.contentIndex);
				if (block.type !== "toolCall") throw new Error("Expected tool-call block");
				expect(block.arguments).toEqual(parseStreamingJson(next));
				expectDeeplyFrozen(block.arguments);
				break;
			}
			case "toolcall_end": {
				openArgs.delete(event.contentIndex);
				expect(requireContentBlock(event.snapshot, event.contentIndex)).toBe(event.toolCall);
				break;
			}
			case "text_end": {
				const block = requireContentBlock(event.snapshot, event.contentIndex);
				if (block.type !== "text") throw new Error("Expected text block");
				expect(block.text).toBe(event.content);
				break;
			}
			case "thinking_start":
			case "thinking_end": {
				const block = requireContentBlock(event.snapshot, event.contentIndex);
				if (block.type !== "thinking") throw new Error("Expected thinking block");
				if (event.type === "thinking_end") expect(block.thinking).toBe(event.content);
				expect(event.redacted).toBe(block.redacted);
				break;
			}
		}

		const expectedToolState = [...openArgs.entries()]
			.sort(([left], [right]) => left - right)
			.map(([contentIndex, argsText]) => ({ contentIndex, argsText }));
		expect(event.toolState).toEqual(expectedToolState);
		expect(Object.isFrozen(event.toolState)).toBe(true);
		previousSnapshot = event.snapshot;
	}
}

function expectGeneratedMalformedRecovery(
	generated: GeneratedFragmentStream,
	events: readonly AssistantMessageEvent[],
	result: AssistantMessage,
): void {
	expect(events.filter((event) => event.type === "start")).toHaveLength(1);
	expect(events.at(-1)?.type).toBe(generated.input.terminal === "done" ? "done" : "error");
	expect(events.filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
	expect(result.content).toEqual(generated.expectedContent);
	expect(result.model).toBe("original-model");
	expect(result.responseId).toBe(`response-${generated.input.metaInput}`);
	expect(result.responseModel).toBe("resolved-generated-model");
	expect(result.usage).toMatchObject({
		input: generated.input.metaInput,
		output: 2,
		totalTokens: generated.input.metaInput + 2,
	});

	const contractCodes = (result.diagnostics ?? [])
		.filter((diagnostic) => diagnostic.type === "assistant_stream_contract_violation")
		.map((diagnostic) => requireRecord(diagnostic.details).code);
	expect(contractCodes).toContain("duplicate_start");
	expect(contractCodes).toContain("fragment_after_block_end");
	expect(JSON.stringify(events)).not.toContain(DROPPED_FRAGMENT_SECRET);
	expect(JSON.stringify(result)).not.toContain(DROPPED_FRAGMENT_SECRET);

	if (generated.input.terminal === "done") {
		expect(result.stopReason).toBe("toolUse");
	} else if (generated.input.terminal === "error") {
		expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "generated abort" });
	} else {
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Assistant stream ended without a terminal fragment",
		});
	}

	expect(events.filter((event) => event.type === "toolcall_end").map((event) => event.contentIndex)).toEqual([
		4, 2, 3,
	]);
	expect(events.filter((event) => event.type === "text_end").map((event) => event.contentIndex)).toEqual([5, 0]);
	expect(events.filter((event) => event.type === "thinking_end").map((event) => event.contentIndex)).toEqual([1, 6]);

	const patchedStart = events.find((event) => event.type === "toolcall_start" && event.contentIndex === 3);
	const patchedDelta = events.find(
		(event) => event.type === "toolcall_delta" && event.contentIndex === 3 && event.id === "late-id",
	);
	const unpatchedEnd = events.find((event) => event.type === "toolcall_end" && event.contentIndex === 4);
	expect(patchedStart).toMatchObject({ id: "", name: "" });
	expect(patchedDelta).toMatchObject({ id: "late-id", name: "late-name" });
	expect(unpatchedEnd).toMatchObject({ toolCall: { id: "", name: "" } });

	const terminal = events.at(-1);
	if (!terminal || (terminal.type !== "done" && terminal.type !== "error")) {
		throw new Error("Expected terminal event");
	}
	expect(terminal.type === "done" ? terminal.message : terminal.error).toBe(result);
	expectDeeplyFrozen(result);
}

describe("AssistantStreamNormalizer generated fragment-stream invariants", () => {
	it("keeps seq, delta content, authoritative ends, and raw tool state mutually consistent", async () => {
		await fc.assert(
			fc.asyncProperty(generatedFragmentStreamInputArbitrary, async (input) => {
				const generated = buildGeneratedFragmentStream(input);
				const { events } = await normalize(generated.fragments);
				expectGeneratedContentAndToolStateInvariants(events);
			}),
			{ numRuns: 100 },
		);
	});

	it("freezes retained graphs while structurally sharing every unchanged content block", async () => {
		await fc.assert(
			fc.asyncProperty(generatedFragmentStreamInputArbitrary, async (input) => {
				const generated = buildGeneratedFragmentStream(input);
				const { events, result } = await normalize(generated.fragments);
				expectGeneratedContentAndToolStateInvariants(events);
				expectDeeplyFrozen(result);
			}),
			{ numRuns: 75 },
		);
	});

	it("deterministically absorbs generated orphan, duplicate, missing-end, and post-terminal cases", async () => {
		await fc.assert(
			fc.asyncProperty(generatedFragmentStreamInputArbitrary, async (input) => {
				const generated = buildGeneratedFragmentStream(input);
				const { events, result } = await normalize(generated.fragments);
				expectGeneratedMalformedRecovery(generated, events, result);
			}),
			{ numRuns: 100 },
		);
	});
});
