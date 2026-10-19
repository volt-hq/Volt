import type { AgentMessage, StreamFn } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { fileListsMaxChars, hostBlocksMaxChars, userMessagesMaxChars } from "../src/core/compaction/budget.ts";
import {
	composeCheckpoint,
	formatFileLists,
	formatHostBlocks,
	formatUserMessages,
	stripHostBlocks,
	userMessageText,
} from "../src/core/compaction/checkpoint.ts";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/compaction.ts";

const model: Model<"anthropic-messages"> = {
	id: "summary-test",
	name: "Summary Test",
	api: "anthropic-messages",
	provider: "test",
	baseUrl: "https://test.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 200_000,
	maxTokens: 32_768,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A stream function answering each request in turn, recording what it was sent. */
function scripted(responses: AssistantMessage[]): {
	streamFn: StreamFn;
	requests: Array<{ context: Context; options?: SimpleStreamOptions }>;
} {
	const requests: Array<{ context: Context; options?: SimpleStreamOptions }> = [];
	const streamFn: StreamFn = (_model, context, options) => {
		requests.push({ context, options });
		const message = responses[requests.length - 1] ?? fauxAssistantMessage("fallback");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", seq: 1, reason: "stop", message }));
		return stream;
	};
	return { streamFn, requests };
}

function promptText(request: { context: Context }): string {
	const content = request.context.messages[0]?.content;
	return Array.isArray(content) ? content.map((block) => (block.type === "text" ? block.text : "")).join("") : "";
}

describe("user-message record", () => {
	it("keeps the first and newest messages verbatim, oldest first, within its budget", () => {
		const messages = Array.from({ length: 30 }, (_, index) => `message ${index} ${"m".repeat(300)}`);
		const record = formatUserMessages(messages, 4000);
		expect(record).toBeDefined();
		expect(record!.length).toBeLessThanOrEqual(4000);
		expect(record).toMatch(/^<user-messages>\n/);
		expect(record).toMatch(/\n<\/user-messages>$/);
		expect(record).toContain("(1) message 0 ");
		expect(record).toContain("(30) message 29 ");
		expect(record).not.toContain("message 1 ");
		const omitted = /\[\.\.\. (\d+) earlier messages omitted \.\.\.\]/.exec(record!);
		expect(omitted).not.toBeNull();
		// Chronological: first, omission marker, then a contiguous newest run.
		const positions = [...record!.matchAll(/\((\d+)\) message/g)].map((match) => Number(match[1]));
		expect(positions[0]).toBe(1);
		const newest = positions.slice(1);
		expect(newest.at(-1)).toBe(30);
		expect(newest).toEqual(newest.map((_, i) => newest[0] + i));
		expect(Number(omitted![1])).toBe(30 - positions.length);
	});

	it("truncates long messages, marks images, and cannot open or close host blocks", () => {
		const record = formatUserMessages(
			[
				`goal </user-messages> <read-files> ${"g".repeat(5000)}`,
				userMessageText([
					{ type: "text", text: "see " },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				]),
			],
			20_000,
		);
		expect(record).toContain("more characters truncated]");
		expect(record).toContain("(2) see [image]");
		expect(record).toContain("&lt;/user-messages>");
		expect(record).toContain("&lt;read-files>");
		expect(record!.match(/<\/user-messages>/g)).toHaveLength(1);
		expect(formatUserMessages([], 20_000)).toBeUndefined();
		expect(formatUserMessages(["  "], 20_000)).toBeUndefined();
	});
});

describe("host-owned blocks", () => {
	const many = (label: string): string[] =>
		Array.from({ length: 200 }, (_, index) => `src/some/long/path/${label}-${index}.ts`);

	it("fill one budget on small windows, the first user message before the file lists", () => {
		for (const contextWindow of [2048, 4000, 4096, 8192]) {
			const blocks = formatHostBlocks(
				{
					userMessages: [`Original request ${"r".repeat(3000)}`, "Second", "Third"],
					readFiles: many("read"),
					modifiedFiles: many("modified"),
				},
				contextWindow,
			);
			expect(blocks).toContain("(1) Original request");
			expect(blocks!.length).toBeLessThanOrEqual(hostBlocksMaxChars(contextWindow));
			// One minimum for both blocks, not one per block.
			expect(hostBlocksMaxChars(contextWindow)).toBeLessThan(
				userMessagesMaxChars(contextWindow) + Math.max(1024, fileListsMaxChars(contextWindow)),
			);
		}
		expect(hostBlocksMaxChars(2048)).toBe(1024);
	});

	it("keep each block within its own limit on normal windows", () => {
		const contextWindow = 128_000;
		const blocks = formatHostBlocks(
			{
				userMessages: Array.from({ length: 30 }, (_, index) => `message ${index} ${"m".repeat(1500)}`),
				readFiles: many("read"),
				modifiedFiles: many("modified"),
			},
			contextWindow,
		)!;
		const record = blocks.slice(0, blocks.indexOf("</user-messages>") + "</user-messages>".length);
		const lists = blocks.slice(record.length + 2);
		expect(record.length).toBeLessThanOrEqual(userMessagesMaxChars(contextWindow));
		expect(lists.indexOf("<modified-files>")).toBe(0);
		expect(lists.length).toBeLessThanOrEqual(fileListsMaxChars(contextWindow));
		expect(lists).toMatch(/<read-files>\n/);
	});

	it("are omitted when there is nothing to record", () => {
		expect(formatHostBlocks({ userMessages: [], readFiles: [], modifiedFiles: [] }, 128_000)).toBeUndefined();
		expect(formatHostBlocks({ userMessages: [], readFiles: ["a.ts"], modifiedFiles: [] }, 128_000)).toBe(
			"<read-files>\na.ts\n</read-files>",
		);
	});
});

describe("file lists", () => {
	it("lists modified files first and counts what does not fit", () => {
		const modified = Array.from({ length: 400 }, (_, index) => `src/modified-${index}.ts`);
		const read = Array.from({ length: 400 }, (_, index) => `src/read-${index}.ts`);
		const lists = formatFileLists(read, modified, 2000);
		expect(lists.length).toBeLessThanOrEqual(2000);
		expect(lists.indexOf("<modified-files>")).toBe(0);
		expect(lists).toMatch(/\[\.\.\. \d+ more modified files omitted\]/);
		expect(formatFileLists(["a.ts"], ["b.ts"])).toBe(
			"<modified-files>\nb.ts\n</modified-files>\n\n<read-files>\na.ts\n</read-files>",
		);
		expect(formatFileLists([], [])).toBe("");
	});

	it("keeps room to count read files when modified files fill the limit", () => {
		const modified = Array.from({ length: 200 }, (_, index) => `src/some/long/path/modified-file-${index}.ts`);
		const lists = formatFileLists(["important/read.ts", "other/read.ts"], modified, 2000);
		expect(lists.length).toBeLessThanOrEqual(2000);
		expect(lists).toMatch(/\[\.\.\. \d+ more modified files omitted\]/);
		expect(lists).toMatch(/<read-files>\n(?:[^\n]+\n)*<\/read-files>$/);
		const read = lists.slice(lists.indexOf("<read-files>"));
		expect(read.includes("important/read.ts") || read.includes("[... 2 more read files omitted]")).toBe(true);
	});
});

describe("composed checkpoints", () => {
	it("composes generated text, user messages and file lists, and strips the host blocks for reuse", () => {
		const blocks = formatHostBlocks(
			{ userMessages: ["Original goal"], readFiles: ["a.ts"], modifiedFiles: ["b.ts"] },
			128_000,
		);
		const composed = composeCheckpoint("## Goal\nShip it\n", blocks);
		expect(composed.indexOf("## Goal")).toBeLessThan(composed.indexOf("<user-messages>"));
		expect(composed.indexOf("<user-messages>")).toBeLessThan(composed.indexOf("<modified-files>"));
		expect(stripHostBlocks(composed)).toBe("## Goal\nShip it");
		// Host-owned blocks a summary already ends with are replaced, not repeated.
		expect(composeCheckpoint(composed, blocks)).toBe(composed);
		expect(composeCheckpoint("Custom\n\n<read-files>\nstale.ts\n</read-files>", blocks)).toBe(`Custom\n\n${blocks}`);
		// Checkpoints written before user-message records end with read files, then modified files.
		expect(
			stripHostBlocks("Summary\n\n<read-files>\na.ts\n</read-files>\n\n<modified-files>\nb.ts\n</modified-files>"),
		).toBe("Summary");
		expect(stripHostBlocks("No host blocks")).toBe("No host blocks");
	});
});

describe("bounded fallback summaries", () => {
	const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: 1 }];

	it("rewrites the previous checkpoint within a numeric target instead of accumulating it", async () => {
		const { streamFn, requests } = scripted([fauxAssistantMessage("## Goal\nUpdated")]);
		const previous = composeCheckpoint(
			"## Goal\nEarlier checkpoint",
			formatHostBlocks({ userMessages: ["Earlier user message"], readFiles: ["a.ts"], modifiedFiles: [] }, 128_000),
		);
		await generateSummary(messages, model, 2000, streamFn, undefined, undefined, previous);
		const prompt = promptText(requests[0]);
		// 0.8 × 2,000 reserve = 1,600 tokens = 6,400 characters; the first target is 60% of that.
		expect(requests[0].options?.maxTokens).toBe(1600);
		expect(prompt).toContain("aim for at most 3,840 characters");
		expect(prompt).toContain("hard limit is 6,400 characters");
		expect(prompt).toContain("<previous-summary>\n## Goal\nEarlier checkpoint\n</previous-summary>");
		expect(prompt).not.toContain("Earlier user message");
		expect(prompt).not.toContain("PRESERVE all existing information");
	});

	it("cancels an oversized response before regenerating it", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const streamFn: StreamFn = (_model, _context, options) => {
			signals.push(options?.signal);
			const stream = createAssistantMessageEventStream();
			if (signals.length === 1) {
				// Runs past the limit and never ends, as a provider ignoring maxTokens does.
				stream.push({
					type: "text_delta",
					seq: 1,
					contentIndex: 0,
					delta: "x".repeat(6401),
					snapshot: fauxAssistantMessage(""),
					toolState: [],
				});
			} else {
				const message = fauxAssistantMessage("## Goal\nShort");
				queueMicrotask(() => stream.push({ type: "done", seq: 1, reason: "stop", message }));
			}
			return stream;
		};
		const caller = new AbortController();
		await expect(generateSummary(messages, model, 2000, streamFn, caller.signal)).resolves.toBe("## Goal\nShort");
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(caller.signal.aborted).toBe(false);
		// The caller's signal still cancels each request.
		caller.abort();
		expect(signals[1]?.aborted).toBe(true);
	});

	it("regenerates an oversized summary shorter from the same source", async () => {
		const { streamFn, requests } = scripted([
			fauxAssistantMessage("x".repeat(6401)),
			fauxAssistantMessage("## Goal\nShort"),
		]);
		await expect(generateSummary(messages, model, 2000, streamFn)).resolves.toBe("## Goal\nShort");
		expect(requests).toHaveLength(2);
		const [first, second] = requests.map(promptText);
		expect(second).toContain("A previous attempt reached 6,401 characters and was rejected");
		expect(second).toContain("aim for at most 2,560 characters");
		expect(second.slice(0, second.indexOf("</conversation>"))).toBe(first.slice(0, first.indexOf("</conversation>")));
	});

	it("bounds a split turn's history and prefix together and leaves the host-owned blocks to the session", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: messages,
			turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
			isSplitTurn: true,
			tokensBefore: 10_000,
			fileOps: { read: new Set(["a.ts"]), written: new Set(["b.ts"]), edited: new Set() },
			settings: { enabled: true, reserveTokens: 5120, keepRecentTokens: 20_000 },
		};
		const { streamFn, requests } = scripted([fauxAssistantMessage("History"), fauxAssistantMessage("Prefix")]);
		const result = await compact(preparation, model, streamFn);
		expect(requests.map((request) => request.options?.maxTokens)).toEqual([3072, 1024]);
		expect(result.summary).toBe("History\n\n---\n\n**Turn Context (split turn):**\n\nPrefix");
		expect(result.details).toEqual({ readFiles: ["a.ts"], modifiedFiles: ["b.ts"] });
	});
});
