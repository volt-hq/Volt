import { fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #25 trailing tool-result compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("advances beyond the previous boundary while preserving the latest tool batch", async () => {
		const toolCall = fauxToolCall("read", { path: "large.txt" });
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 10 } },
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", (event) => ({
						compaction: {
							summary: "updated summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
			seed: (log) =>
				log
					.user("research the issue")
					.assistant("older retained work", { id: "previous-boundary" })
					.compaction({
						summary: "previous summary",
						firstKeptEntryId: "previous-boundary",
						tokensBefore: 250_000,
					})
					.assistant("", { id: "recent-assistant", toolCalls: [toolCall] })
					.toolResult(toolCall.id, "x".repeat(100)),
		});
		harnesses.push(harness);
		const previousBoundaryId = "previous-boundary";
		const recentAssistantId = "recent-assistant";

		const result = await harness.session.compact();

		expect(result.firstKeptEntryId).toBe(recentAssistantId);
		expect(result.firstKeptEntryId).not.toBe(previousBoundaryId);
		expect(result.estimatedTokensAfter).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.estimatedTokensAfter).toBe(
			result.estimatedTokensAfter,
		);
		expect(harness.session.messages.at(-2)?.role).toBe("assistant");
		expect(harness.session.messages.at(-1)?.role).toBe("toolResult");
	});
});
