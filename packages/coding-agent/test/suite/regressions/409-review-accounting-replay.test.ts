import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@hansjm10/volt-ai";
import { Container, setKeybindings, Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import { appendReviewRunDurably, type ReviewRunRecord } from "../../../src/core/review-state.ts";
import { ReviewUsageCollector } from "../../../src/core/review-usage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

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

/** The transcript the TUI renders for `harness`'s session after it opened. */
function render(harness: Harness): string {
	const chatContainer = new Container();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		conversation: { session: harness.session, services: { agentDir: harness.tempDir } },
		ui: { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() },
		chatContainer,
		editor: new Text("editor"),
		footer: { invalidate: vi.fn() },
		pendingTools: new Map(),
		liveBackgroundJobTools: new Map(),
		toolOutputExpanded: false,
		updateEditorBorderColor: vi.fn(),
	}) as InteractiveMode;
	mode.renderInitialMessages();
	return chatContainer.render(120).lines.map(stripAnsi).join("\n");
}

describe("#409 review accounting replay", () => {
	it.each(["failed", "cancelled"] as const)(
		"replays a %s run's final accounting once after reopening",
		async (status) => {
			const cwd = mkdtempSync(join(tmpdir(), "volt-review-replay-"));
			cleanups.push(() => rm(cwd, { recursive: true, force: true }));
			const manager = await SessionManager.create(cwd, join(cwd, "sessions"));
			const first = await createHarness({ sessionManager: manager });
			await first.session.sessionWriter.appendCustomMessageEntry("test", "Original conversation", true);
			const collector = new ReviewUsageCollector();
			const request = await collector.start(
				{ passId: 1, phase: "discovery", purpose: "findings", round: 1, attempt: 1, kind: "turn" },
				first.getModel(),
			);
			await request.observe(usage, 1, true, true);
			await appendReviewRunDurably(first.session.sessionWriter, run(status, await collector.finish()));
			const ref = manager.getSessionRef()!;
			await first.cleanupAsync();

			const reopened = await SessionManager.open(ref);
			const second = await createHarness({ sessionManager: reopened });
			cleanups.push(() => second.cleanupAsync());
			setKeybindings(KeybindingsManager.create());
			initTheme("dark", true);
			const rendered = render(second);
			expect(rendered).toContain("Original conversation");
			expect(rendered.match(/Tokens: 10 input/g)).toHaveLength(1);
			expect(rendered.match(/Model-priced estimate: \$0\.100000 USD/g)).toHaveLength(1);
			expect(rendered).toContain("Initial review accounting: complete.");
			expect(rendered).not.toContain("(unfinished)");
			// The accounting is display-only: no model-facing message carries it.
			const messages = reopened.getConversationState().context.messages;
			expect(JSON.stringify(convertToLlm([...messages]))).not.toContain("estimatedCost");
		},
	);
});
