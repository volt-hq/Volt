/**
 * A tree navigation runs as conversation activity (architecture rewrite
 * Phase 6): like `bash` and `compact`, `navigate_tree` runs beside the
 * client's intent lane, so the input, the queue's withdrawal, and the
 * queries a client sends while it summarizes the branch it leaves answer at
 * once instead of waiting for the summary.
 */

import type { AssistantMessage } from "@hansjm10/volt-ai";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient } from "../../src/client/protocol-client.ts";
import { createHostHarness } from "../suite/host-harness.ts";

/** A summary response held until released. */
function held(text: string): {
	step: () => Promise<AssistantMessage>;
	started: Promise<void>;
	release(): void;
} {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		step: async () => {
			started.resolve();
			await released.promise;
			return fauxAssistantMessage(text);
		},
		started: started.promise,
		release: () => released.resolve(),
	};
}

describe("navigate_tree on the activity lane", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("answers input, the queue's withdrawal, and queries sent while a branch summary runs", async () => {
		const harness = await createHostHarness({ responses: ["first reply", "second reply"] });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const client = await createLoopbackClient(harness.host, conversation);
		cleanups.push(() => client.stop());
		await client.promptAndWait("first question");
		await client.promptAndWait("second question");
		const target = client.state.entries.find(
			(entry) => entry.type === "message" && entry.view?.role === "assistant" && entry.view.text === "first reply",
		);
		if (target === undefined) throw new Error("No first reply");

		const summary = held("The branch, summarized.");
		harness.faux.setSimpleResponses([summary.step]);
		const navigating = client.intent(
			"navigate_tree",
			{ entryId: target.id, summarize: true },
			{ expectedOrdinal: client.state.ordinal },
		);
		await summary.started;
		await vi.waitFor(() => expect(client.phase?.operation).toBe("navigation"));

		// Each answers while the summary still runs: none waits behind navigate_tree.
		await client.intent("steer", { message: "sent while summarizing" });
		await vi.waitFor(() =>
			expect(client.state.queue.map((input) => input.message)).toContain("sent while summarizing"),
		);
		const withdrawn = await client.intent("withdraw_queued");
		expect(withdrawn.result?.messages.map((message) => message.text)).toEqual(["sent while summarizing"]);
		await expect(client.query("settings")).resolves.toMatchObject({ autoCompaction: expect.any(Boolean) });
		expect(client.phase?.operation).toBe("navigation");

		summary.release();
		const navigated = await navigating;
		expect(navigated.result).toMatchObject({ cancelled: false });
		await vi.waitFor(() => expect(client.state.entries.some((entry) => entry.type === "branch_summary")).toBe(true));
	});
});
