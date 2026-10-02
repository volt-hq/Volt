import type { StreamFn } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, streamSimple } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../../../src/core/compaction/branch-summarization.ts";
import { generateSummary } from "../../../src/core/compaction/compaction.ts";
import { createHarness } from "../harness.ts";

describe("summary stream draining (#354)", () => {
	it.each([
		{ branch: true, asynchronous: false },
		{ branch: true, asynchronous: true },
		{ branch: false, asynchronous: false },
		{ branch: false, asynchronous: true },
	])("preserves a long injected summary (branch: $branch, async: $asynchronous)", async ({ branch, asynchronous }) => {
		const harness = await createHarness();
		try {
			// Over 1,024 deltas even at the harness faux provider's largest 20-character
			// chunk. Keeping this stream's events until result() used to overflow.
			const summary = "Summary λ🌲\n".repeat(4096);
			harness.faux.setSimpleResponses([fauxAssistantMessage(summary)]);
			const message = { role: "user" as const, content: "Summarize this branch", timestamp: 0 };
			harness.sessionManager.appendMessage(message);
			const entries = harness.sessionManager.getBranch();
			const model = harness.getModel();
			const signal = new AbortController().signal;
			const headers = { "x-summary-request": "preserved" };
			const env = { SUMMARY_TEST_VALUE: "preserved" };
			const streamFn = vi.fn<StreamFn>((selectedModel, context, options) => {
				const response = streamSimple(selectedModel, context, options);
				return asynchronous ? Promise.resolve(response) : response;
			});
			if (branch) {
				const result = await generateBranchSummary(entries, {
					model,
					signal,
					headers,
					env,
					apiKey: "faux-injected-key",
					streamFn,
				});
				expect(result.error).toBeUndefined();
				expect(result.aborted).toBeUndefined();
				expect(result.summary).toContain(summary);
			} else {
				await expect(
					generateSummary(
						[message],
						model,
						16384,
						"faux-injected-key",
						headers,
						signal,
						undefined,
						undefined,
						undefined,
						streamFn,
						env,
					),
				).resolves.toBe(summary);
			}
			expect(streamFn).toHaveBeenCalledTimes(1);
			expect(streamFn.mock.calls[0]?.[0]).toBe(model);
			expect(streamFn.mock.calls[0]?.[1]).toMatchObject({ messages: [{ role: "user" }] });
			expect(streamFn.mock.calls[0]?.[2]).toMatchObject({
				signal,
				headers,
				env,
				apiKey: "faux-injected-key",
				maxTokens: expect.any(Number),
			});
			expect(harness.faux.state.simpleCallCount).toBe(1);
			expect(harness.sessionManager.getBranch()).toEqual(entries);
			expect(harness.events).toEqual([]);
		} finally {
			await harness.cleanupAsync();
		}
	});
});
