import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type Usage } from "@hansjm10/volt-ai";
import { Container, setKeybindings, Text, type TUI } from "@hansjm10/volt-tui";
import { describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { ReviewWorkflowResult } from "../../../src/core/review.ts";
import { listReviewRuns } from "../../../src/core/review-state.ts";
import { ReviewWorkflowManager } from "../../../src/core/review-workflows.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { BorderedLoader } from "../../../src/modes/interactive/components/bordered-loader.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createHarness } from "../harness.ts";

const usage: Usage = {
	availability: "complete",
	input: 10,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	totalTokens: 19,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
};

describe("#409 interactive terminal review accounting", () => {
	it.each(["failed", "cancelled"] as const)(
		"shows final accounting once after a %s review clears transient usage",
		async (status) => {
			const cwd = mkdtempSync(join(tmpdir(), "volt-review-accounting-ui-"));
			const manager = await SessionManager.create(cwd, join(cwd, "sessions"));
			const h = await createHarness({
				sessionManager: manager,
				settings: { retry: { enabled: false }, compaction: { enabled: false }, lsp: { enabled: false } },
			});
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
				setKeybindings(KeybindingsManager.create());
				initTheme("dark", true);
				const chatContainer = new Container();
				const editor = new Text("editor");
				const editorContainer = new Container();
				editorContainer.addChild(editor);
				const footer = { setTransientUsage: vi.fn(), invalidate: vi.fn() };
				const newSession = vi.fn();
				const context = Object.assign(Object.create(InteractiveMode.prototype), {
					runtimeHost: {
						session: h.session,
						services: { agentDir: h.tempDir },
						newSession,
						reviewWorkflows: new ReviewWorkflowManager(),
					},
					ui: {
						terminal: { rows: 24, columns: 120 },
						requestRender: vi.fn(),
						setFocus: vi.fn(),
					} as unknown as TUI,
					chatContainer,
					editor,
					editorContainer,
					footer,
					pendingMessagesContainer: new Container(),
					pendingTools: new Map(),
					liveBackgroundJobTools: new Map(),
					toolOutputExpanded: false,
					updateEditorBorderColor: vi.fn(),
					refreshPlanningUi: vi.fn(),
					createInlineSessionRenderer: () => {
						const transient = new Text("Transient review output");
						chatContainer.addChild(transient);
						return {
							onSessionEvent: vi.fn(),
							dispose: () => chatContainer.removeChild(transient),
						};
					},
				}) as InteractiveMode;
				manager.appendCustomMessageEntry("test", "Original conversation", true);
				context.renderInitialMessages();
				h.setResponses([
					fauxAssistantMessage(
						fauxToolCall("report_review_candidates", {
							summary: "No candidates",
							candidates: [],
							limitations: [],
						}),
						{ stopReason: "toolUse", usage },
					),
					() => {
						if (status === "cancelled") {
							const loader = editorContainer.children[0];
							expect(loader).toBeInstanceOf(BorderedLoader);
							(loader as BorderedLoader).handleInput("\u001b");
						}
						return fauxAssistantMessage("Provider failure", {
							stopReason: "error",
							errorMessage: "request failed",
							usage: { ...usage, availability: "partial" },
						});
					},
				]);
				const run = Reflect.get(InteractiveMode.prototype, "runInteractiveReviewWorkflow") as (
					this: InteractiveMode,
					target: { kind: "uncommitted" },
					options: { tools: string[]; requireConfirmation: boolean; requireProjectTrust: boolean },
				) => Promise<ReviewWorkflowResult>;
				await run.call(
					context,
					{ kind: "uncommitted" },
					{
						tools: [],
						requireConfirmation: false,
						requireProjectTrust: false,
					},
				);

				const record = listReviewRuns(manager).runs[0];
				expect(record?.status).toBe(status);
				expect(record?.usage?.summary.tokens?.input).toBeGreaterThanOrEqual(10);
				expect(h.faux.state.callCount).toBe(2);
				expect(newSession).not.toHaveBeenCalled();
				expect(footer.setTransientUsage.mock.calls.some(([value]) => value !== undefined)).toBe(true);
				expect(footer.setTransientUsage).toHaveBeenLastCalledWith(undefined);
				expect(editorContainer.children).toEqual([editor]);
				const rendered = chatContainer.render(120).lines.map(stripAnsi).join("\n");
				expect(rendered).toContain("Original conversation");
				expect(rendered).not.toContain("Transient review output");
				expect(rendered.match(/Tokens: \d+ input/g)).toHaveLength(1);
				expect(rendered).toContain(`Tokens: ${record.usage?.summary.tokens?.input} input`);
				expect(rendered.match(/Model-priced estimate: \$/g)).toHaveLength(1);
				const terminalStatus = status === "failed" ? "Review failed:" : "Review cancelled";
				expect(rendered).toContain(terminalStatus);
				expect(rendered.indexOf(terminalStatus)).toBeGreaterThan(rendered.indexOf("Tokens:"));
				expect(
					manager
						.getEntries()
						.filter(
							(entry) =>
								entry.type === "custom_message" && entry.content === `Review ${record.runId}: ${status}.`,
						),
				).toHaveLength(1);
			} finally {
				await h.cleanupAsync();
				await rm(cwd, { recursive: true, force: true });
			}
		},
	);
});
