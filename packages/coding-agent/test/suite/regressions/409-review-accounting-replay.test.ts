import type { Usage } from "@hansjm10/volt-ai";
import type { Container } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { appendReviewRunDurably, type ReviewRunRecord } from "../../../src/core/review-state.ts";
import { ReviewUsageCollector } from "../../../src/core/review-usage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTuiHarness } from "../tui-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const usage: Usage = {
	availability: "complete",
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

function run(status: "failed" | "cancelled", accounting: ReviewRunRecord["usage"]): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review:replayed",
		workflowAction: "review.uncommitted",
		status,
		startedAt: 1,
		endedAt: 2,
		...(accounting === undefined ? {} : { usage: accounting }),
		target: {
			description: "Test",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
	};
}

describe("#409 review accounting replay", () => {
	it.each(["failed", "cancelled"] as const)(
		"replays a %s run's final accounting once after reopening",
		async (status) => {
			const harness = await createTuiHarness({ globalSettings: { theme: "dark", quietStartup: true } });
			cleanups.push(() => harness.cleanup());
			const tui = await harness.startMode({ columns: 120, rows: 40 });
			// A stored session that ran the review: its log holds the run and its final accounting.
			const manager = await SessionManager.create(harness.startup.cwd, harness.sessionDir);
			await manager.logWriter.appendCustomMessageEntry("test", "Original conversation", true);
			const collector = new ReviewUsageCollector();
			const request = await collector.start(
				{ passId: 1, phase: "discovery", purpose: "findings", round: 1, attempt: 1, kind: "turn" },
				harness.faux.getModel(),
			);
			await request.observe(usage, 1, true, true);
			await appendReviewRunDurably(manager.logWriter, run(status, await collector.finish()));
			const ref = manager.getSessionRef();
			if (!ref) throw new Error("The session is not stored");
			await manager.closePersistence();

			await expect(tui.resume(ref)).resolves.toMatchObject({ cancelled: false });

			const chat = (tui.mode as unknown as { chatContainer: Container }).chatContainer;
			const rendered = chat.render(120).lines.map(stripAnsi).join("\n");
			expect(rendered).toContain("Original conversation");
			expect(rendered.match(/Tokens: 10 input/g)).toHaveLength(1);
			expect(rendered.match(/Model-priced estimate: \$0\.100000 USD/g)).toHaveLength(1);
			expect(rendered).toContain("Initial review accounting: complete.");
			expect(rendered).not.toContain("(unfinished)");
			// The accounting is display-only: no model-facing message carries it.
			const messages = harness.connector.conversation.session.sessionManager.getConversationState().context.messages;
			expect(JSON.stringify(convertToLlm([...messages]))).not.toContain("estimatedCost");
		},
	);
});
