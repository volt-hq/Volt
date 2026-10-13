import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const MUTATED = "MUTATED-BY-HANDLER";

/** Rewrite a committed entry's summary, details, and id fields in place. */
function mutateEntry(entry: { id: string; parentId: string | null; summary: string; details?: unknown }): void {
	entry.summary = MUTATED;
	entry.parentId = MUTATED;
	if (typeof entry.details === "object" && entry.details !== null) Object.assign(entry.details, { marker: MUTATED });
	Object.assign(entry, { marker: MUTATED });
}

describe("regression #853: session_compact and session_tree handlers get their own entry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		// Cleanup asserts that the fold of the session's log equals the session's view.
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createPromptedHarness(
		extensionFactories: ExtensionFactory[],
	): Promise<{ harness: Harness; errors: ExtensionError[] }> {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } }, extensionFactories });
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		return { harness, errors };
	}

	it("keeps a session_compact handler's change from the session's entry and later handlers", async () => {
		const seen: string[] = [];
		const observe: ExtensionFactory = (volt) => {
			volt.on("session_compact", (event) => {
				seen.push(JSON.stringify(event.compactionEntry));
			});
		};
		const mutate: ExtensionFactory = (volt) => {
			volt.on("session_compact", (event) => {
				mutateEntry(event.compactionEntry);
			});
			// A later handler in the same extension gets its own copy too.
			volt.on("session_compact", (event) => {
				seen.push(JSON.stringify(event.compactionEntry));
			});
		};
		const { harness, errors } = await createPromptedHarness([observe, mutate, observe]);
		harness.setResponses([fauxAssistantMessage("compaction summary")]);

		const result = await harness.session.compact();

		expect(errors).toEqual([]);
		expect(seen).toHaveLength(3);
		expect(seen[0]).toContain("compaction summary");
		expect(seen[0]).not.toContain(MUTATED);
		expect(seen.slice(1)).toEqual([seen[0], seen[0]]);
		const committed = harness.sessionManager.getBranch().findLast((entry) => entry.type === "compaction");
		expect(JSON.stringify(committed)).toBe(seen[0]);
		expect(committed?.type === "compaction" && committed.summary).toBe(result.summary);
	});

	it("keeps a session_tree handler's change from the session's entry, the navigation result, and later handlers", async () => {
		const seen: { summaryEntry: string | undefined; hasSummaryEntry: boolean }[] = [];
		const record = (event: { summaryEntry?: object }) => {
			seen.push({
				summaryEntry: event.summaryEntry === undefined ? undefined : JSON.stringify(event.summaryEntry),
				hasSummaryEntry: "summaryEntry" in event,
			});
		};
		const observe: ExtensionFactory = (volt) => {
			volt.on("session_tree", record);
		};
		const mutate: ExtensionFactory = (volt) => {
			volt.on("session_tree", (event) => {
				if (event.summaryEntry) mutateEntry(event.summaryEntry);
			});
			volt.on("session_tree", record);
		};
		const { harness, errors } = await createPromptedHarness([observe, mutate, observe]);
		const [first, second] = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		// Branch summaries are auxiliary completions (no tools), served from the faux simple queue.
		harness.faux.setSimpleResponses([fauxAssistantMessage("branch summary")]);

		const navigation = await harness.session.navigateTree(second!.id, { summarize: true });

		expect(errors).toEqual([]);
		expect(navigation.cancelled).toBe(false);
		const summaryEntry = navigation.summaryEntry;
		expect(summaryEntry?.summary).toContain("branch summary");
		expect(seen).toHaveLength(3);
		const original = JSON.stringify(summaryEntry);
		expect(original).not.toContain(MUTATED);
		expect(seen).toEqual([
			{ summaryEntry: original, hasSummaryEntry: true },
			{ summaryEntry: original, hasSummaryEntry: true },
			{ summaryEntry: original, hasSummaryEntry: true },
		]);
		expect(JSON.stringify(harness.sessionManager.getEntry(summaryEntry!.id))).toBe(original);

		// A navigation without a summary reaches every handler without one.
		seen.length = 0;
		const plain = await harness.session.navigateTree(first!.id);

		expect(errors).toEqual([]);
		expect(plain).toMatchObject({ cancelled: false, summaryEntry: undefined });
		expect(seen).toEqual([
			{ summaryEntry: undefined, hasSummaryEntry: false },
			{ summaryEntry: undefined, hasSummaryEntry: false },
			{ summaryEntry: undefined, hasSummaryEntry: false },
		]);
	});
});
