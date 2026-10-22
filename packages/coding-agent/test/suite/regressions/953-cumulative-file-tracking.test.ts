import { fauxAssistantMessage, type ToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { CompactionDetails } from "../../../src/core/compaction/compaction.ts";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

function call(id: string, name: "read" | "edit" | "write", path: string): ToolCall {
	return { type: "toolCall", id, name, arguments: { path } };
}

describe("regression #953: file tracking stays cumulative across extension summaries", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		// Cleanup asserts that the fold of the session's log equals the session's view.
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps files from before an extension compaction, and a branch summary's files, in the next compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) =>
				seed
					.user("read a")
					.assistant("", { toolCalls: [call("read-a", "read", "a.ts")] })
					.toolResult("read-a", "a")
					.assistant("read a")
					.user("second", { id: "second" })
					.assistant("two")
					// An extension's compaction: its details are opaque, and it kept the branch from "second".
					.compaction({ firstKeptEntryId: "second", details: { owner: "extension" }, fromHook: true })
					.branchSummary("left a branch", { readFiles: ["c.ts"], modifiedFiles: ["d.ts"] })
					.user("read b")
					.assistant("", { toolCalls: [call("read-b", "read", "b.ts")] })
					.toolResult("read-b", "b")
					.assistant("read b")
					.user("third")
					.assistant("three"),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("built-in checkpoint")]);

		const result = await harness.session.compact();

		const details = result.details as CompactionDetails;
		expect(details.readFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(details.modifiedFiles).toEqual(["d.ts"]);
		expect(result.summary).toContain("<modified-files>\nd.ts\n</modified-files>");
		expect(result.summary).toContain("<read-files>\na.ts\nb.ts\nc.ts\n</read-files>");
	});

	it.each([
		["built-in", false],
		["extension", true],
	] as const)("records the whole abandoned branch's files on a %s branch summary", async (_label, fromExtension) => {
		const extension: ExtensionFactory = (volt) => {
			volt.on("session_before_tree", () =>
				fromExtension ? { summary: { summary: "extension summary", details: { owner: "extension" } } } : undefined,
			);
		};
		const harness = await createHarness({
			// A 64-token summarization budget: the oldest tool calls do not fit the summary request.
			settings: { branchSummary: { reserveTokens: 128_000 - 64 } },
			extensionFactories: [extension],
			seed: (seed) =>
				seed
					.user("start")
					.assistant("ready", { id: "target" })
					.user("explore")
					.assistant("", { toolCalls: [call("read-x", "read", "x.ts"), call("edit-y", "edit", "y.ts")] })
					.toolResult("read-x", "x")
					.toolResult("edit-y", "edited")
					.assistant("explored")
					// A summary of a branch left earlier, nested in the branch this navigation leaves.
					.branchSummary("nested", { readFiles: ["nested.ts"], modifiedFiles: ["nested-edit.ts"] })
					.user("z".repeat(2_000))
					.assistant("done"),
		});
		harnesses.push(harness);
		harness.faux.setSimpleResponses([fauxAssistantMessage("built-in summary")]);

		const navigation = await harness.session.navigateTree("target", { summarize: true });

		expect(navigation.summaryEntry).toMatchObject({
			readFiles: ["nested.ts", "x.ts"],
			modifiedFiles: ["nested-edit.ts", "y.ts"],
			...(fromExtension ? { details: { owner: "extension" }, fromHook: true } : {}),
		});
		if (fromExtension) return;
		expect(navigation.summaryEntry).not.toHaveProperty("details");
		expect(navigation.summaryEntry?.summary).toContain("<read-files>\nnested.ts\nx.ts\n</read-files>");
		expect(navigation.summaryEntry?.summary).toContain("<modified-files>\nnested-edit.ts\ny.ts\n</modified-files>");
	});
});
