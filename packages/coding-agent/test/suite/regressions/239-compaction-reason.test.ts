import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import type { SeedLogBuild } from "../../utilities/seed-log.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

interface RecordedCompactionEvent {
	type: "session_before_compact" | "session_compact";
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
}

function recordingExtension(recorded: RecordedCompactionEvent[]): ExtensionFactory {
	return (volt) => {
		volt.on("session_before_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
			return {
				compaction: {
					summary: "summary from extension",
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			};
		});
		volt.on("session_compact", async (event) => {
			recorded.push({ type: event.type, reason: event.reason, willRetry: event.willRetry });
		});
	};
}

async function createCompactionHarness(recorded: RecordedCompactionEvent[]): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [recordingExtension(recorded)],
	});
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	return harness;
}

async function createThresholdHarness(recorded: RecordedCompactionEvent[], tools?: AgentTool[]): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
		settings: { compaction: { reserveTokens: 15_000, keepRecentTokens: 1 } },
		...(tools === undefined ? {} : { tools }),
		extensionFactories: [recordingExtension(recorded)],
	});
}

/**
 * A saved branch whose last response decides compaction before the next
 * prompt. The 20k window with a 10k reserve compacts over 10k tokens, above
 * what the small requests that follow report.
 */
async function createSavedBranchHarness(recorded: RecordedCompactionEvent[], seed: SeedLogBuild): Promise<Harness> {
	return createHarness({
		models: [{ id: "faux-1", contextWindow: 20_000, maxTokens: 100 }],
		settings: { compaction: { reserveTokens: 10_000, keepRecentTokens: 1 } },
		seed,
		extensionFactories: [recordingExtension(recorded)],
	});
}

/** Saved usage over the saved-branch threshold and under its window. */
const SAVED_USAGE = { input: 12_000, totalTokens: 12_000 };

/** Record each request's context and answer with `text`. */
function recordRequest(requests: Context[], text: string) {
	return (context: Context) => {
		requests.push(context);
		return fauxAssistantMessage(text);
	};
}

function expectCompactionEvents(
	harness: Harness,
	recorded: RecordedCompactionEvent[],
	reason: RecordedCompactionEvent["reason"],
	willRetry: boolean,
): void {
	expect(recorded).toEqual([
		{ type: "session_before_compact", reason, willRetry },
		{ type: "session_compact", reason, willRetry },
	]);
	const completionEvents = harness.eventsOfType("compaction_end");
	expect(completionEvents).toHaveLength(1);
	expect(completionEvents[0]).toMatchObject({ reason, aborted: false, willRetry });
}

const LARGE_PROMPT = "x".repeat(30_000);

describe("regression #239: compaction reason on extension events", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reports manual reason for compact()", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createCompactionHarness(recorded);
		harnesses.push(harness);

		await harness.session.compact();

		expectCompactionEvents(harness, recorded, "manual", false);
	});

	it("reports threshold reason for pre-prompt compaction after an aborted response", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createSavedBranchHarness(recorded, (seed) =>
			seed.user("first").assistant("partial", { stopReason: "aborted", usage: SAVED_USAGE }),
		);
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([recordRequest(requests, "answer")]);

		await harness.session.prompt("second");

		expectCompactionEvents(harness, recorded, "threshold", false);
		expect(requests).toHaveLength(1);
		expect(getMessageText(requests[0]?.messages[0])).toContain("summary from extension");
		expect(getMessageText(requests[0]?.messages.at(-1))).toBe("second");
	});

	it("reports overflow reason and willRetry for pre-prompt overflow recovery", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createSavedBranchHarness(recorded, (seed) =>
			seed.user("first").assistant("", {
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
			}),
		);
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([recordRequest(requests, "recovered"), recordRequest(requests, "answer")]);

		await harness.session.prompt("second");

		expectCompactionEvents(harness, recorded, "overflow", true);
		// The overflowed request is retried after compaction without its error, before the prompt is delivered.
		expect(requests).toHaveLength(2);
		expect(requests[0]?.messages.map((message) => message.role)).not.toContain("assistant");
		expect(JSON.stringify(requests[0]?.messages)).not.toContain("second");
		expect(getMessageText(requests[1]?.messages.at(-1))).toBe("second");
	});

	it("reports pre-prompt threshold continuation of an empty length-limited response as a retry", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createSavedBranchHarness(recorded, (seed) =>
			seed.user("first").assistant("", { stopReason: "length", usage: SAVED_USAGE }),
		);
		harnesses.push(harness);
		const requests: Context[] = [];
		harness.setResponses([recordRequest(requests, "continued after compaction"), recordRequest(requests, "answer")]);

		await harness.session.prompt("second");

		expectCompactionEvents(harness, recorded, "threshold", true);
		// The truncated request is retried without its truncated response, before the prompt is delivered.
		expect(requests).toHaveLength(2);
		expect(requests[0]?.messages.map((message) => message.role)).not.toContain("assistant");
		expect(JSON.stringify(requests[0]?.messages)).not.toContain("second");
		expect(getMessageText(requests[1]?.messages.at(-1))).toBe("second");
	});

	it("reports retry metadata when an empty length-limited response continues after compaction", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createThresholdHarness(recorded);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "length" }),
			fauxAssistantMessage("continued after compaction"),
		]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
		expectCompactionEvents(harness, recorded, "threshold", true);
	});

	it("reports no retry when a length-limited response has visible output", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		const harness = await createThresholdHarness(recorded);
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(harness.faux.state.callCount).toBe(1);
		expectCompactionEvents(harness, recorded, "threshold", false);
	});

	it("reports retry metadata when proactive threshold compaction resumes a tool turn", async () => {
		const recorded: RecordedCompactionEvent[] = [];
		let toolRunCount = 0;
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Return a test value",
			parameters: Type.Object({}),
			execute: async () => {
				toolRunCount += 1;
				return { content: [{ type: "text", text: "tool result" }], details: {} };
			},
		};
		const harness = await createThresholdHarness(recorded, [echoTool]);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("continued after proactive compaction"),
		]);

		await harness.session.prompt(LARGE_PROMPT);

		expect(toolRunCount).toBe(1);
		expect(harness.faux.state.callCount).toBe(2);
		expectCompactionEvents(harness, recorded, "threshold", true);
	});
});
