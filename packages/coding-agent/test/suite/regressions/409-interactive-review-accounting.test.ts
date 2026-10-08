/**
 * #409: a review that fails or is cancelled in the terminal shows its final
 * accounting once. The review runs as the conversation's detached `review`
 * work through the TUI's protocol client: `/review` starts it and opens the
 * job list on it, the list's cancel key cancels it with `cancel_work`, and
 * its end shows as its work's end does.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Usage } from "@hansjm10/volt-ai";
import type { Container } from "@hansjm10/volt-tui";
import { describe, expect, it, vi } from "vitest";
import { listReviewRuns } from "../../../src/core/review-state.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTuiHarness, waitForScreen } from "../tui-harness.ts";

const usage: Usage = {
	availability: "complete",
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

const cleanups: Array<() => Promise<void>> = [];

describe("#409 interactive terminal review accounting", () => {
	it.each(["failed", "cancelled"] as const)("shows final accounting once after a %s review", async (status) => {
		const root = mkdtempSync(join(tmpdir(), "volt-review-accounting-ui-"));
		const cwd = join(root, "workspace");
		mkdirSync(cwd);
		try {
			for (const args of [
				["init", "--initial-branch=main"],
				["config", "user.email", "review@example.test"],
				["config", "user.name", "Review Test"],
			]) {
				const result = spawnSync("git", args, { cwd, encoding: "utf8" });
				if (result.status !== 0) throw new Error(result.stderr);
			}
			writeFileSync(join(cwd, "file.ts"), "export const value = 1;\n");
			for (const args of [
				["add", "file.ts"],
				["commit", "-m", "initial"],
			]) {
				const result = spawnSync("git", args, { cwd, encoding: "utf8" });
				if (result.status !== 0) throw new Error(result.stderr);
			}
			writeFileSync(join(cwd, "file.ts"), "export const value = 2;\n");
			// The session database lives outside the workspace, so it is no part of the review snapshot.
			const h = await createTuiHarness({
				startup: { cwd },
				globalSettings: {
					theme: "dark",
					quietStartup: true,
					retry: { enabled: false },
					compaction: { enabled: false },
					lsp: { enabled: false },
				},
			});
			cleanups.push(() => h.cleanup());
			const session = h.startup.session;
			const manager = session.sessionManager;
			await session.sessionWriter.appendCustomMessageEntry("test", "Original conversation", true);
			const tui = await h.startMode({ columns: 120, rows: 40 });
			const access = tui.mode as unknown as {
				chatContainer: Container;
				editorContainer: Container;
				editor: unknown;
				dismissWorkInspector?: () => void;
			};
			const { chatContainer, editorContainer, editor } = access;
			// A review that opens no session opens nothing on the TUI's host.
			const open = vi.spyOn(h.host, "open");
			// The verification pass fails, or waits until Escape cancels the review.
			const verification = Promise.withResolvers<void>();
			h.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("report_review_candidates", {
						summary: "No candidates",
						candidates: [],
						limitations: [],
					}),
					{ stopReason: "toolUse", usage },
				),
				(_context: unknown, options: { signal?: AbortSignal } | undefined) => {
					verification.resolve();
					if (status === "failed") {
						return fauxAssistantMessage("Provider failure", {
							stopReason: "error",
							error: { kind: "unknown", retryable: false, message: "request failed" },
							usage: { ...usage, availability: "partial" },
						});
					}
					return new Promise<AssistantMessage>((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				},
			]);
			// The command returns once the review started, with the job list on it.
			await tui.submit("/review uncommitted");
			await verification.promise;
			if (status === "cancelled") {
				await waitForScreen(tui, "Review uncommitted changes");
				// Ctrl+K asks, and Enter confirms.
				tui.terminal.sendInput("\u000b");
				await waitForScreen(tui, "Cancel this work?");
				tui.terminal.sendInput("\r");
			}
			const terminalStatus =
				status === "failed" ? "Review uncommitted changes failed:" : "Review uncommitted changes cancelled";
			await vi.waitFor(() => expect(listReviewRuns(manager).runs[0]?.status).toBe(status));
			// The list covers the chat: close it to read how the review ended and what it cost.
			access.dismissWorkInspector?.();
			await waitForScreen(tui, terminalStatus, "Model-priced estimate: $");

			const record = listReviewRuns(manager).runs[0];
			const rendered = chatContainer.render(120).lines.map(stripAnsi).join("\n");
			expect(record?.status, rendered).toBe(status);
			expect(record?.usage?.summary.tokens?.input).toBeGreaterThanOrEqual(10);
			// The review ran as the conversation's work and ended as its run did.
			expect(session.work.get(record.runId)).toMatchObject({ kind: "review", outcome: status });
			expect(
				manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "volt.review.usage"),
			).toBe(false);
			expect(h.faux.state.callCount).toBe(2);
			expect(open).not.toHaveBeenCalled();
			expect(editorContainer.children).toEqual([editor]);
			expect(rendered).toContain("Original conversation");
			expect(rendered.match(/Tokens: \d+ input/g)).toHaveLength(1);
			expect(rendered).toContain(`Tokens: ${record.usage?.summary.tokens?.input} input`);
			expect(rendered.match(/Model-priced estimate: \$/g)).toHaveLength(1);
			expect(rendered).toContain(terminalStatus);
			expect(rendered.indexOf(terminalStatus)).toBeGreaterThan(rendered.indexOf("Tokens:"));
			expect(
				manager
					.getEntries()
					.filter(
						(entry) => entry.type === "custom_message" && entry.content === `Review ${record.runId}: ${status}.`,
					),
			).toHaveLength(1);
		} finally {
			for (const cleanup of cleanups.splice(0)) await cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});
});
