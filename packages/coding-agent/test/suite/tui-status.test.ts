/**
 * The TUI's status from its store (architecture rewrite §10, Phase 6 slice
 * 6): the footer, the working, retry, and compaction indicators, the
 * turn-done alert, and the plan come from the client fold and the live lane;
 * the host's notices and its extensions' errors show as they arrive; the work
 * inspector reads the conversation's work and opens the conversations it
 * links, closed ones and their own children included; extension panels take
 * the keyboard from an empty editor and send their actions as intents.
 */

import { join } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { PlanningState } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionDefinition } from "../../src/core/extensions/index.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import type { SubagentDefinition } from "../../src/core/subagents/index.ts";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions, type TuiModeFixture } from "./tui-harness.ts";

type ModeAccess = {
	editor: { setText(text: string): void; getText(): string };
	handleCompactCommand(customInstructions?: string): Promise<void>;
	showWorkInspector(workId?: string): void;
	closeFinishedPlan(): Promise<void>;
};

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };
const ESCAPE = "\x1b";
const ENTER = "\r";
const TAB = "\t";

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function start(
	options: TuiHarnessOptions & { tuiMode?: "regular" | "fullscreen"; columns?: number } = {},
): Promise<{ harness: TuiHarness; tui: TuiModeFixture; access: ModeAccess; session: AgentSession }> {
	const { tuiMode, columns, globalSettings, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: { ...SETTINGS, ...globalSettings }, ...harnessOptions });
	harnesses.push(harness);
	const tui = await harness.startMode({ tuiMode: tuiMode ?? "regular", columns: columns ?? 110, rows: 40 });
	return { harness, tui, access: tui.mode as unknown as ModeAccess, session: harness.startup.session };
}

/** The screen once the TUI rendered what it holds now. */
async function screen(tui: TuiModeFixture): Promise<string> {
	tui.ui.requestRender();
	await tui.terminal.waitForRender();
	return tui.screen();
}

async function waitForScreen(tui: TuiModeFixture, ...texts: string[]): Promise<string> {
	let shown = "";
	await vi.waitFor(
		async () => {
			shown = await screen(tui);
			for (const text of texts) expect(shown).toContain(text);
		},
		{ timeout: 10_000 },
	);
	return shown;
}

async function waitForScreenWithout(tui: TuiModeFixture, ...texts: string[]): Promise<string> {
	let shown = "";
	await vi.waitFor(
		async () => {
			shown = await screen(tui);
			for (const text of texts) expect(shown).not.toContain(text);
		},
		{ timeout: 10_000 },
	);
	return shown;
}

/** A faux response that waits until released. */
function held(text: string): { step: FauxResponseFactory; started: Promise<void>; release(): void } {
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

describe("the TUI's status from its store", () => {
	it("shows the footer from the client fold, the live lane, and the catalogs", async () => {
		vi.stubEnv("VOLT_ASCII", "1");
		const { harness, tui, session } = await start({
			extensions: [
				{
					manifest: { id: "status-ext", displayName: "Status" },
					factory: (volt) => {
						volt.on("session_start", (_event, ctx) => ctx.ui.setStatus("build", "build passing"));
					},
				},
			],
		});
		await session.prompt("hello");
		await tui.store.client.intent("set_session_name", { name: "Footer test" });

		const shown = await waitForScreen(tui, "faux-1", "Footer test", "build passing", "context");
		expect(shown).not.toContain("[phone");

		// Paired devices attached to the conversation show from its live `presence`.
		harness.startup.liveState.set("presence", { kind: "presence", remote: 2 });
		await waitForScreen(tui, "[phone 2]");
		harness.startup.liveState.set("presence", { kind: "presence", remote: 0 });
		await waitForScreenWithout(tui, "[phone");
	});

	it.each(["regular", "fullscreen"] as const)(
		"times a run in the working indicator until it settles, then rings the terminal (%s)",
		async (tuiMode) => {
			const { harness, tui, session } = await start({
				tuiMode,
				globalSettings: { terminal: { turnDoneAlert: "bell" } },
			});
			const alert = vi.spyOn(tui.terminal, "alert");
			const reply = held("finished the work");
			harness.faux.setResponses([reply.step]);

			const run = session.prompt("work for a while");
			await reply.started;
			await waitForScreen(tui, "Working... (", "to interrupt)");
			expect(alert).not.toHaveBeenCalled();

			reply.release();
			await run;
			await waitForScreen(tui, "finished the work");
			await waitForScreenWithout(tui, "Working...");
			await vi.waitFor(() => expect(alert).toHaveBeenCalledOnce());
		},
	);

	it("counts down to a retry's attempt, and Escape stops the retry", async () => {
		const { harness, tui, session } = await start({
			globalSettings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 30_000 } },
		});
		harness.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
			}),
			fauxAssistantMessage("recovered"),
		]);

		const run = session.prompt("try it");
		await waitForScreen(tui, "Retrying (1/3) in", "to cancel)");
		expect(tui.store.phase?.retry).toMatchObject({ attempt: 1, maxAttempts: 3, error: "overloaded_error" });

		tui.terminal.sendInput(ESCAPE);
		await run;
		await waitForScreenWithout(tui, "Retrying (");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("shows a running compaction, and the host's notice when Escape cancelled it", async () => {
		const { harness, tui, access, session } = await start({ responses: ["first reply", "second reply"] });
		await session.prompt("first prompt");
		await session.prompt("second prompt");
		const summary = held("The conversation so far, summarized.");
		harness.faux.setResponses([summary.step]);

		const compacting = access.handleCompactCommand();
		await summary.started;
		await waitForScreen(tui, "Compacting context...");

		tui.terminal.sendInput(ESCAPE);
		summary.release();
		await compacting;
		await session.waitForIdle();
		await waitForScreen(tui, "Error: Compaction cancelled");
		await waitForScreenWithout(tui, "Compacting context...");
	});

	it("shows an extension's runtime error with its stack", async () => {
		const failing: ExtensionDefinition = {
			manifest: { id: "failing-ext", displayName: "Failing" },
			factory: (volt) => {
				volt.on("agent_start", () => {
					throw new Error("the handler broke");
				});
			},
		};
		const { tui, session } = await start({ extensions: [failing] });
		await session.prompt("trigger it");

		const shown = await waitForScreen(tui, 'Extension "failing-ext" error: agent_start: the handler broke');
		expect(shown).toMatch(/\n\s+at /);
	});

	it("shows the plan from the client fold, announces its completion, and closes it through an intent", async () => {
		const { tui, access, session } = await start();
		const execution = {
			id: "execution-1",
			approvedRevision: 1,
			strategy: "retain_context" as const,
			sourceSessionId: session.sessionId,
			targetSessionId: session.sessionId,
		};
		const plan = (phase: "active" | "completed"): PlanningState => ({
			mode: "build",
			plan: {
				id: "plan-status",
				revision: phase === "active" ? 1 : 2,
				phase,
				title: "Status from the store",
				summary: "The plan pane reads the client fold.",
				steps: [{ id: "step-1", text: "Read the plan", status: phase === "active" ? "in_progress" : "completed" }],
				execution,
			},
		});

		await session.sessionWriter.appendPlanningState(plan("active"));
		await waitForScreen(tui, "PLAN EXECUTING", "Read the plan");
		await session.sessionWriter.appendPlanningState(plan("completed"));
		await waitForScreen(tui, "Plan complete · /plan-close");

		await access.closeFinishedPlan();
		await vi.waitFor(() => expect(tui.store.state.planning?.plan ?? null).toBeNull());
		await waitForScreen(tui, "Plan closed");
	});
});

function scout(): SubagentDefinition {
	const filePath = join("/tmp", "tui-status-agents", "scout.md");
	return {
		name: "scout",
		description: "scout description",
		systemPrompt: "scout system prompt",
		allowedSubagents: ["scout"],
		source: "project",
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			baseDir: join(filePath, ".."),
		}),
		filePath,
	};
}

/** The confirmation token the subagent tool's preflight returned last in `context`. */
function confirmation(context: Parameters<FauxResponseFactory>[0]): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const token = /"confirm": "([^"]+)"/.exec(text)?.[1];
		if (token) return token;
	}
	throw new Error("Expected a subagent spawn confirmation in the preflight result");
}

describe("the work inspector from the store", () => {
	it("opens a subagent's closed conversation, and from its work the closed grandchild", async () => {
		const { harness, tui, access } = await start({ subagents: [scout()], whenUnattached: "keep" });
		const spawn = { agent: "scout", task: "dig deeper" };
		harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", spawn), { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage(fauxToolCall("subagent", { ...spawn, confirm: confirmation(context) }), {
					stopReason: "toolUse",
				}),
			fauxAssistantMessage("grand result"),
			fauxAssistantMessage("child result"),
		]);
		const started = await tui.store.client.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		const { workId } = started.result as { workId: string };
		await vi.waitFor(() => expect(tui.store.state.work.get(workId)?.outcome).toBe("completed"), {
			timeout: 10_000,
		});

		access.showWorkInspector();
		await waitForScreen(tui, "─ Work ", "✓ completed", "subagent");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, workId);
		// The child closed: it opens read-only from its log, with its own work.
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "closed, read-only", "child result", "its work (1)");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "─ Work · ", "dig deeper");
		tui.terminal.sendInput(ENTER);
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "closed, read-only", "grand result");

		// Back up: the grandchild, its parent's work, the child, the item, the list.
		for (let index = 0; index < 5; index++) tui.terminal.sendInput(ESCAPE);
		await waitForScreen(tui, "─ Work ", "inspect auth");
		tui.terminal.sendInput(ESCAPE);
		await waitForScreenWithout(tui, "─ Work ");
	});
});

describe("extension panels from the store", () => {
	it.each(["regular", "fullscreen"] as const)(
		"take the keyboard from an empty editor with Tab and send their actions as intents (%s)",
		async (tuiMode) => {
			const pressed: string[] = [];
			const panel: ExtensionDefinition = {
				manifest: { id: "panel-ext", displayName: "Panel" },
				factory: (volt) => {
					volt.registerIntent("go", { label: "Go", handler: () => void pressed.push("go") });
					volt.registerIntent("stop", { label: "Stop", handler: () => void pressed.push("stop") });
					volt.on("session_start", (_event, ctx) => {
						ctx.ui.setPanel("ops", {
							title: "Operations",
							placement: "sidebar",
							node: {
								type: "actions",
								key: "ops",
								actions: [
									{ id: "go", label: "Go now", intent: { type: "extension.intent.panel-ext.go" } },
									{ id: "stop", label: "Stop it", intent: { type: "extension.intent.panel-ext.stop" } },
								],
							},
						});
					});
				},
			};
			const { tui, access } = await start({ tuiMode, columns: 120, extensions: [panel] });
			await waitForScreen(tui, "Operations", "Go now", "Stop it");
			const editor = tui.ui.getFocusedComponent();

			// With text in the editor, Tab stays with the editor.
			access.editor.setText("draft");
			tui.terminal.sendInput(TAB);
			expect(tui.ui.getFocusedComponent()).toBe(editor);
			access.editor.setText("");

			tui.terminal.sendInput(TAB);
			expect(tui.ui.getFocusedComponent()).not.toBe(editor);
			tui.terminal.sendInput(ENTER);
			await vi.waitFor(() => expect(pressed).toEqual(["go"]));
			tui.terminal.sendInput("\x1b[C");
			tui.terminal.sendInput(ENTER);
			await vi.waitFor(() => expect(pressed).toEqual(["go", "stop"]));

			// Past the last action, the keyboard goes back to the editor.
			tui.terminal.sendInput(TAB);
			expect(tui.ui.getFocusedComponent()).toBe(editor);
			tui.terminal.sendInput(TAB);
			expect(tui.ui.getFocusedComponent()).not.toBe(editor);
			tui.terminal.sendInput(ESCAPE);
			expect(tui.ui.getFocusedComponent()).toBe(editor);
		},
	);
});
