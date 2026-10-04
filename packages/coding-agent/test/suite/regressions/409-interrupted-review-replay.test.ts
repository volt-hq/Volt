import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@hansjm10/volt-ai";
import { Container, setKeybindings, Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { convertToLlm } from "../../../src/core/messages.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	appendReviewUsageCheckpoint,
	MAX_HYDRATED_REVIEW_RUNS,
	REVIEW_USAGE_CUSTOM_ENTRY_TYPE,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { ReviewUsageCollector } from "../../../src/core/review-usage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { SessionWriter } from "../../../src/core/session-writer.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function unfinished(runId = "review:interrupted"): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "unfinished",
		startedAt: 1,
		target: {
			description: "Test",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
	};
}

const usage: Usage = {
	availability: "partial",
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "volt-review-replay-"));
	cleanups.push(() => rm(cwd, { recursive: true, force: true }));
	let manager = await SessionManager.create(cwd, join(cwd, "sessions"));
	// The live harness over `manager`; none while the manager is detached from any session.
	let h: Harness | undefined = await createHarness({ sessionManager: manager });
	const live = (): Harness => {
		if (!h) throw new Error("The session is detached");
		return h;
	};
	cleanups.push(async () => {
		if (h) await h.cleanupAsync();
		else await manager.closePersistence();
	});
	/** The open session's writer, or the manager's log writer while it is detached. */
	const writer = (): SessionWriter => h?.session.sessionWriter ?? manager.logWriter;
	await writer().appendCustomMessageEntry("test", "Original conversation", true);
	const record = unfinished();
	await appendReviewRunDurably(writer(), record);
	const noticeId = manager.getLeafId()!;
	const collector = new ReviewUsageCollector(async (checkpoint) => {
		await appendReviewUsageCheckpoint(writer(), record.runId, checkpoint);
	});
	setKeybindings(KeybindingsManager.create());
	initTheme("dark", true);
	return {
		manager,
		writer,
		record,
		noticeId,
		collector,
		async start() {
			return collector.start(
				{ passId: 1, phase: "discovery", purpose: "findings", round: 1, attempt: 1, kind: "turn" },
				live().getModel(),
			);
		},
		/** Close the session and reopen its manager without one, for structural writes a live session refuses. */
		async detach() {
			const ref = manager.getSessionRef()!;
			await live().cleanupAsync();
			h = undefined;
			manager = await SessionManager.open(ref);
			return manager;
		},
		async reopen() {
			const ref = manager.getSessionRef()!;
			if (h) await h.cleanupAsync();
			else await manager.closePersistence();
			manager = await SessionManager.open(ref);
			h = await createHarness({ sessionManager: manager });
			return manager;
		},
		navigate(targetId: string) {
			return live().session.navigateTree(targetId);
		},
		render(expanded = false) {
			const chatContainer = new Container();
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				conversation: { session: live().session, services: { agentDir: live().tempDir } },
				ui: { terminal: { rows: 24, columns: 120 }, requestRender: vi.fn() },
				chatContainer,
				editor: new Text("editor"),
				footer: { invalidate: vi.fn() },
				pendingTools: new Map(),
				liveBackgroundJobTools: new Map(),
				toolOutputExpanded: expanded,
				updateEditorBorderColor: vi.fn(),
			}) as InteractiveMode;
			mode.renderInitialMessages();
			return chatContainer.render(120).lines.map(stripAnsi).join("\n");
		},
	};
}

describe("#409 interrupted review accounting replay", () => {
	it.each([false, true])("renders recovered subtotals after reopening (expanded=%s)", async (expanded) => {
		const f = await fixture();
		const request = await f.start();
		const stale = f.collector.snapshot();
		await request.observe(usage, 1, false, false);
		await appendReviewUsageCheckpoint(f.writer(), f.record.runId, stale);
		await f.writer().appendCustomEntry(REVIEW_USAGE_CUSTOM_ENTRY_TYPE, {
			runId: f.record.runId,
			usage: { ...f.collector.snapshot(), revision: 999, summary: { status: "partial" } },
		});
		// Transcript hydration must not be limited to the recent-run listing window.
		for (let index = 0; index < MAX_HYDRATED_REVIEW_RUNS; index++) {
			await appendReviewRun(f.writer(), { ...unfinished(`newer-${index}`), startedAt: index + 2 });
		}
		const reopened = await f.reopen();
		const before = reopened.getEntries();
		const messages = reopened.getConversationState().context.messages;
		const rendered = f.render(expanded);
		expect(rendered).toContain("Original conversation");
		expect(rendered).toContain("Initial review accounting: partial (unfinished).");
		expect(rendered).toContain("1 host request attempts; 0 assistant turns; 1 pending; 0 unavailable.");
		expect(rendered).toContain("Tokens: 10 input, 2 output, 3 cache read, 4 cache write.");
		expect(rendered).toContain("Model-priced estimate: $0.100000 USD (partial subtotal).");
		expect(rendered.includes("Pass 1:")).toBe(expanded);
		expect(reopened.getEntries()).toEqual(before);
		expect(reopened.getConversationState().context.messages).toEqual(messages);
		expect(JSON.stringify(convertToLlm([...messages]))).not.toContain("estimatedCost");
	});

	it("keeps accounting unavailable when no checkpoint was persisted", async () => {
		const f = await fixture();
		await f.reopen();
		expect(f.render()).toContain("Initial review accounting: unavailable.");
		expect(f.render()).not.toContain("Tokens:");
	});

	it("uses only checkpoints for the notice's run on the selected branch", async () => {
		const f = await fixture();
		const request = await f.start();
		await request.observe(usage, 1, false, false);
		const checkpointId = f.manager.getLeafId()!;
		const detached = await f.detach();
		await detached.logWriter.branch(f.noticeId);
		await appendReviewRun(detached.logWriter, unfinished("another-run"));
		await appendReviewUsageCheckpoint(detached.logWriter, "another-run", f.collector.snapshot());
		await f.reopen();
		expect(f.render()).toContain("Initial review accounting: unavailable.");
		expect(f.render()).not.toContain("Tokens:");
		await f.navigate(checkpointId);
		expect(f.render()).toContain("Tokens: 10 input");
	});

	it.each(["failed", "cancelled"] as const)("does not duplicate final accounting for a %s run", async (status) => {
		const f = await fixture();
		const request = await f.start();
		await request.observe({ ...usage, availability: "complete" }, 1, true, true);
		await appendReviewRunDurably(f.writer(), {
			...f.record,
			status,
			endedAt: 2,
			usage: await f.collector.finish(),
		});
		await f.reopen();
		const rendered = f.render();
		expect(rendered.match(/Tokens: 10 input/g)).toHaveLength(1);
		expect(rendered.match(/Model-priced estimate: \$0\.100000 USD/g)).toHaveLength(1);
		expect(rendered).toContain("Initial review accounting: complete.");
		expect(rendered).not.toContain("partial (unfinished)");
	});
});
