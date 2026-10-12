import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory, SessionEntry } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const MUTATED = "MUTATED-BY-HANDLER";

/** Rewrite the text of every user message in `messages`, in place. */
function mutateUserText(messages: readonly AgentMessage[]): void {
	for (const message of messages) {
		if (message.role !== "user" || typeof message.content === "string") continue;
		for (const block of message.content) if (block.type === "text") block.text = MUTATED;
	}
}

function entryMessages(entries: readonly SessionEntry[]): AgentMessage[] {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

/** Answer a summary request with `text`, recording the request's messages. */
function recordSummaryRequest(requests: string[], text: string) {
	return (context: Context) => {
		requests.push(JSON.stringify(context.messages));
		return fauxAssistantMessage(text);
	};
}

describe("regression #849: session_before_compact and session_before_tree handlers get their own preparation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createPromptedHarness(extensionFactories: ExtensionFactory[]): Promise<Harness> {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } }, extensionFactories });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first-original");
		await harness.session.prompt("second-original");
		return harness;
	}

	it("keeps a session_before_compact handler's changes from the default compaction and later handlers", async () => {
		const seen: { text: string; readFiles: string[]; branchText: string; fileOpsAreSets: boolean }[] = [];
		const observe: ExtensionFactory = (volt) => {
			volt.on("session_before_compact", (event) => {
				const { preparation } = event;
				seen.push({
					text: JSON.stringify(preparation.messagesToSummarize),
					readFiles: [...preparation.fileOps.read],
					branchText: JSON.stringify(event.branchEntries),
					fileOpsAreSets: preparation.fileOps.read instanceof Set && preparation.fileOps.edited instanceof Set,
				});
			});
		};
		const mutate: ExtensionFactory = (volt) => {
			volt.on("session_before_compact", (event) => {
				mutateUserText(event.preparation.messagesToSummarize);
				mutateUserText(entryMessages(event.branchEntries));
				event.preparation.fileOps.read.add("/mutated-by-handler.ts");
				event.preparation.firstKeptEntryId = "mutated-entry-id";
				return undefined;
			});
		};
		// Observed before and after the mutating extension: neither sees its change.
		const harness = await createPromptedHarness([observe, mutate, observe]);
		const entriesBefore = JSON.stringify(harness.sessionManager.getEntries());
		const requests: string[] = [];
		harness.setResponses([recordSummaryRequest(requests, "summary")]);

		const result = await harness.session.compact();

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("first-original");
		expect(requests[0]).not.toContain(MUTATED);
		expect(result.summary).not.toContain("/mutated-by-handler.ts");
		expect(result.firstKeptEntryId).not.toBe("mutated-entry-id");
		expect(seen).toHaveLength(2);
		for (const observed of seen) {
			expect(observed.text).toContain("first-original");
			expect(observed.text).not.toContain(MUTATED);
			expect(observed.branchText).not.toContain(MUTATED);
			expect(observed.readFiles).not.toContain("/mutated-by-handler.ts");
			expect(observed.fileOpsAreSets).toBe(true);
		}
		// The session's own entries are untouched.
		expect(JSON.stringify(harness.sessionManager.getEntries().slice(0, -1))).toBe(entriesBefore);
	});

	it("keeps a session_before_tree handler's changes from the branch summary and later handlers", async () => {
		const seen: string[] = [];
		const observe: ExtensionFactory = (volt) => {
			volt.on("session_before_tree", (event) => {
				seen.push(JSON.stringify(event.preparation.entriesToSummarize));
			});
		};
		const mutate: ExtensionFactory = (volt) => {
			volt.on("session_before_tree", (event) => {
				mutateUserText(entryMessages(event.preparation.entriesToSummarize));
				event.preparation.entriesToSummarize.length = 0;
				return undefined;
			});
		};
		const harness = await createPromptedHarness([observe, mutate, observe]);
		const entriesBefore = JSON.stringify(harness.sessionManager.getEntries());
		const target = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		const requests: string[] = [];
		// Branch summaries are auxiliary completions (no tools), served from the faux simple queue.
		harness.faux.setSimpleResponses([recordSummaryRequest(requests, "branch summary")]);

		const navigation = await harness.session.navigateTree(target!.id, { summarize: true });

		expect(navigation.cancelled).toBe(false);
		expect(navigation.summaryEntry?.summary).toContain("branch summary");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("second-original");
		expect(requests[0]).not.toContain(MUTATED);
		expect(seen).toHaveLength(2);
		for (const observed of seen) {
			expect(observed).toContain("second-original");
			expect(observed).not.toContain(MUTATED);
		}
		// The session's own entries are untouched.
		const entriesAfter = harness.sessionManager.getEntries();
		expect(JSON.stringify(entriesAfter.slice(0, JSON.parse(entriesBefore).length))).toBe(entriesBefore);
	});
});
