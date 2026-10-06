/**
 * The TUI's session commands as its protocol client's intents and queries
 * (architecture rewrite §10, Phase 6 slice 8): `/clear`, `/resume` and its
 * picker, `/fork`, `/clone`, `/tree`, `/name`, `/session`, `/copy`,
 * `/export`, `/import`, `/compact`, and `/reload`; and the session control
 * of extension commands, which fills the editor through `set_editor_text`
 * and asks again for a session whose folder is gone.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type FauxResponseFactory, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionDefinition } from "../../src/core/extensions/index.ts";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { forkableMessages } from "../../src/modes/interactive/client/session-commands.ts";
import type * as WorktreeControl from "../../src/modes/interactive/worktree-control.ts";
import type * as Clipboard from "../../src/utils/clipboard.ts";
import { copyToClipboard } from "../../src/utils/clipboard.ts";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions, type TuiModeFixture } from "./tui-harness.ts";

/** The daemon's worktree control as `/worktree` sees it: one worktree it creates, and the sessions bound to it. */
const worktrees = vi.hoisted(() => ({
	path: "",
	bound: [] as Array<{ worktreeId: string; sessionId: string }>,
}));

vi.mock("../../src/modes/interactive/worktree-control.ts", async (importOriginal) => ({
	...(await importOriginal<typeof WorktreeControl>()),
	openDaemonWorktreeControl: vi.fn(async () => ({
		ok: true,
		control: {
			workspaceName: "project",
			workspacePath: "/workspace/project",
			listWorktrees: async () => [],
			createWorktree: async (name?: string) => ({
				ok: true,
				worktree: {
					id: name ?? "wt-1",
					path: worktrees.path,
					branch: `volt/${name ?? "wt-1"}`,
					baseRef: "origin/main",
				},
			}),
			bindSession: async (worktreeId: string, sessionId: string) => {
				worktrees.bound.push({ worktreeId, sessionId });
				return true;
			},
			close: async () => {},
		},
	})),
}));

vi.mock("../../src/utils/clipboard.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Clipboard>()),
	copyToClipboard: vi.fn(async () => {}),
}));

type ModeAccess = {
	editor: { setText(text: string): void; getText(): string };
};

const SETTINGS = {
	theme: "dark",
	quietStartup: true,
	lsp: { enabled: false },
	compaction: { enabled: false },
	retry: { enabled: false },
};
const ENTER = "\r";
const ESCAPE = "\x1b";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_D = "\x04";

const harnesses: TuiHarness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function start(
	options: TuiHarnessOptions & { tuiMode?: "regular" | "fullscreen" } = {},
): Promise<{ harness: TuiHarness; tui: TuiModeFixture; access: ModeAccess; session: AgentSession }> {
	const { tuiMode, globalSettings, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: { ...SETTINGS, ...globalSettings }, ...harnessOptions });
	harnesses.push(harness);
	const tui = await harness.startMode({ tuiMode: tuiMode ?? "regular", columns: 110, rows: 40 });
	return { harness, tui, access: tui.mode as unknown as ModeAccess, session: harness.startup.session };
}

function submit(tui: TuiModeFixture, text: string): void {
	tui.terminal.sendInput(text);
	tui.terminal.sendInput(ENTER);
}

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

/** A faux response that waits until released, or stopped. */
function held(text: string): { step: FauxResponseFactory; started: Promise<void>; release(): void } {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		step: (_context, options) =>
			new Promise((resolve, reject) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				void released.promise.then(() => resolve(fauxAssistantMessage(text)));
			}),
		started: started.promise,
		release: () => released.resolve(),
	};
}

/** The text of the user messages of the conversation the store shows, every branch. */
function userTexts(tui: TuiModeFixture): string[] {
	return forkableMessages(tui.store.state).map((message) => message.text);
}

/** Store a session of `cwd` in the TUI's session directory, with one user message and a name. */
async function storeSession(harness: TuiHarness, cwd: string, name: string): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, harness.sessionDir);
	await manager.logWriter.appendMessage({ role: "user", content: `${name} question`, timestamp: Date.now() });
	await manager.logWriter.appendSessionInfo(name);
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("The session is not stored");
	await manager.closePersistence();
	return ref;
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-tui-sessions-"));
	directories.push(directory);
	return directory;
}

describe("the TUI's session commands as intents", () => {
	it.each(["regular", "fullscreen"] as const)(
		"starts a new session with /clear, stopping the running turn first (%s)",
		async (tuiMode) => {
			const { harness, tui } = await start({ tuiMode });
			const reply = held("never finished");
			harness.faux.setResponses([reply.step]);
			const stopReasons: string[] = [];
			tui.store.subscribe((change) => {
				if (change.type !== "entries") return;
				for (const entry of change.entries) {
					const message = entry.type === "message" ? entry.payload?.message : undefined;
					if (message?.role === "assistant") stopReasons.push(message.stopReason);
				}
			});
			submit(tui, "work on it");
			await reply.started;
			await vi.waitFor(() => expect(tui.store.phase?.operation).toBe("turn"));
			const before = tui.store.conversation;

			submit(tui, "/clear");
			await waitForScreen(tui, "New session started");
			expect(tui.store.conversation).not.toBe(before);
			expect(harness.tuiHost.conversation.id).toBe(tui.store.conversation);
			// The turn stopped, and its message committed, before the client moved.
			expect(stopReasons).toEqual(["aborted"]);
			expect(tui.store.transcript()).toEqual([]);
		},
	);

	it("lists, searches, renames, and resumes sessions from /resume, and deletes this folder's", async () => {
		const { harness, tui } = await start();
		const kept = await storeSession(harness, harness.startup.cwd, "kept session");
		const doomed = await storeSession(harness, harness.startup.cwd, "doomed session");

		submit(tui, "/resume");
		await waitForScreen(tui, "Resume Session (Current Folder)", "kept session", "doomed session");

		// Search, then delete the one match.
		tui.terminal.sendInput("doomed");
		await vi.waitFor(async () => expect(await screen(tui)).not.toContain("kept session"));
		tui.terminal.sendInput(CTRL_D);
		await waitForScreen(tui, "Delete session?");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Session deleted");
		const listed = await tui.store.client.query("sessions");
		expect(listed.sessions.map((session) => session.sessionId)).not.toContain(doomed.sessionId);

		// Rename the other one, then resume it.
		for (let index = 0; index < "doomed".length; index++) tui.terminal.sendInput("\x7f");
		tui.terminal.sendInput("kept");
		await vi.waitFor(async () => expect(await screen(tui)).not.toContain("(no messages)"));
		tui.terminal.sendInput("\x1b[114;5u");
		await waitForScreen(tui, "Rename Session");
		// To the end of the name the input holds, then add to it.
		tui.terminal.sendInput("\x05");
		tui.terminal.sendInput(" renamed");
		tui.terminal.sendInput(ENTER);
		// The list shows again once the rename is saved and the search ran again.
		await vi.waitFor(
			async () => {
				const shown = await screen(tui);
				expect(shown).not.toContain("Rename Session");
				expect(shown).toContain("› kept session renamed");
			},
			{ timeout: 10_000 },
		);
		tui.terminal.sendInput(ENTER);

		await vi.waitFor(() => expect(tui.store.conversation).toBe(kept.sessionId));
		await waitForScreen(tui, "Resumed session", "kept session question");
		expect(tui.store.state.name).toBe("kept session renamed");
	});

	it("refuses in the All scope to delete another folder's session, which the host does not delete", async () => {
		const { harness, tui } = await start();
		const elsewhere = await storeSession(harness, temporaryDirectory(), "elsewhere session");

		submit(tui, "/resume");
		await waitForScreen(tui, "Resume Session (Current Folder)");
		tui.terminal.sendInput(TAB);
		await waitForScreen(tui, "Resume Session (All)", "elsewhere session");
		tui.terminal.sendInput("elsewhere");
		await vi.waitFor(async () => expect(await screen(tui)).not.toContain("(no messages)"));
		tui.terminal.sendInput(CTRL_D);
		await waitForScreen(tui, "Only sessions of this folder can be deleted here");
		expect(await screen(tui)).not.toContain("Delete session?");

		// The host refuses it too.
		await expect(tui.store.client.intent("delete_session", { sessionId: elsewhere.sessionId })).rejects.toThrow(
			"Session not found in current workspace",
		);
	});

	it("asks to continue in the current folder when a resumed session's folder is gone", async () => {
		const { harness, tui } = await start();
		const gone = temporaryDirectory();
		const target = await storeSession(harness, gone, "homeless session");
		rmSync(gone, { recursive: true, force: true });

		submit(tui, "/resume");
		await waitForScreen(tui, "Resume Session (Current Folder)");
		tui.terminal.sendInput(TAB);
		await waitForScreen(tui, "homeless session");
		tui.terminal.sendInput("homeless");
		await vi.waitFor(async () => expect(await screen(tui)).not.toContain("(no messages)"));
		tui.terminal.sendInput(ENTER);

		await waitForScreen(tui, "Session cwd not found", gone, "continue in current cwd");
		tui.terminal.sendInput(ENTER);
		await vi.waitFor(() => expect(tui.store.conversation).toBe(target.sessionId));
		await waitForScreen(tui, "Resumed session in current cwd");
		expect((await tui.store.client.query("conversation_info")).cwd).toBe(harness.startup.cwd);
	});

	it("forks before a user message with its text in the editor, and clones the session", async () => {
		const { tui, access } = await start({ responses: ["first reply", "second reply"] });
		await tui.store.client.promptAndWait("first question", { timeoutMs: 10_000 });
		await tui.store.client.promptAndWait("second question", { timeoutMs: 10_000 });
		const source = tui.store.conversation;

		submit(tui, "/fork");
		await waitForScreen(tui, "Fork from Message", "second question");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Forked to new session");
		const fork = tui.store.conversation;
		expect(fork).not.toBe(source);
		expect(access.editor.getText()).toBe("second question");
		expect(userTexts(tui)).toEqual(["first question"]);
		expect(tui.store.state.forkedFrom).toMatchObject({ sessionId: source });

		access.editor.setText("");
		submit(tui, "/clone");
		await waitForScreen(tui, "Cloned to new session");
		expect(tui.store.conversation).not.toBe(fork);
		expect(userTexts(tui)).toEqual(["first question"]);
		expect(access.editor.getText()).toBe("");
	});

	it("moves the branch with /tree, labels an entry, and stops a branch summary with Escape", async () => {
		const { harness, tui, access } = await start({ responses: ["first reply", "second reply"] });
		await tui.store.client.promptAndWait("first question", { timeoutMs: 10_000 });
		await tui.store.client.promptAndWait("second question", { timeoutMs: 10_000 });

		// Label the leaf: the last assistant message.
		submit(tui, "/tree");
		await waitForScreen(tui, "Session Tree", "assistant: second reply");
		tui.terminal.sendInput("L");
		await waitForScreen(tui, "Label (empty to remove)");
		tui.terminal.sendInput("checkpoint");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "[checkpoint] assistant: second reply");
		await vi.waitFor(() =>
			expect([...tui.store.state.labels.values()].map((label) => label.label)).toEqual(["checkpoint"]),
		);

		// Summarize the branch it leaves, then stop the summary.
		const summary = held("The branch, summarized.");
		harness.faux.setSimpleResponses([summary.step]);
		tui.terminal.sendInput(UP);
		tui.terminal.sendInput(UP);
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Summarize branch?");
		tui.terminal.sendInput(DOWN);
		tui.terminal.sendInput(ENTER);
		await summary.started;
		await vi.waitFor(() => expect(tui.store.phase?.operation).toBe("navigation"));
		await waitForScreen(tui, "Summarizing branch...");
		const leaf = tui.store.state.leafId;
		tui.terminal.sendInput(ESCAPE);
		// The tree shows again on the entry picked; the branch stayed.
		await waitForScreen(tui, "Session Tree", "› • assistant: first reply");
		await vi.waitFor(() => expect(tui.store.phase?.operation ?? null).toBeNull());
		expect(tui.store.state.leafId).toBe(leaf);
		summary.release();

		// Without a summary, the branch moves; the user message it moved before goes to the empty editor.
		tui.terminal.sendInput(DOWN);
		await waitForScreen(tui, "› • user: second question");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Summarize branch?");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Navigated to selected point");
		expect(access.editor.getText()).toBe("second question");
		const moved = tui.store.state.byId.get(tui.store.state.leafId ?? "");
		expect(moved?.type === "message" ? moved.payload?.message.role : undefined).toBe("assistant");
		expect(tui.store.transcript().filter((entry) => entry.type === "message")).toHaveLength(2);
	});

	it("names the session, shows its info, and copies the last answer", async () => {
		const { tui } = await start({ responses: ["the answer to copy"] });
		await tui.store.client.promptAndWait("a question", { timeoutMs: 10_000 });

		submit(tui, "/name");
		await waitForScreen(tui, "Usage: /name <name>");
		submit(tui, "/name  My session ");
		await waitForScreen(tui, "Session name set: My session");
		await vi.waitFor(() => expect(tui.store.state.name).toBe("My session"));

		submit(tui, "/session");
		const shown = await waitForScreen(tui, "Session Info", "Name: My session", `ID: ${tui.store.conversation}`);
		expect(shown).toContain("User: 1");
		expect(shown).toContain("Assistant: 1");
		expect(shown).toContain("Total: 2");

		submit(tui, "/copy");
		await waitForScreen(tui, "Copied last agent message to clipboard");
		expect(copyToClipboard).toHaveBeenCalledWith("the answer to copy");
	});

	it("exports the session as JSONL and HTML, and imports the JSONL as a new session", async () => {
		const { harness, tui } = await start({ responses: ["exported reply"] });
		await tui.store.client.promptAndWait("exported question", { timeoutMs: 10_000 });
		const source = tui.store.conversation;
		const jsonl = join(harness.tempDir, "export", "branch.jsonl");
		const html = join(harness.tempDir, "export", "page.html");
		mkdirSync(join(harness.tempDir, "export"));

		submit(tui, `/export ${jsonl}`);
		await waitForScreen(tui, "Session exported to:", "branch.jsonl");
		submit(tui, `/export "${html}"`);
		await waitForScreen(tui, "page.html");

		submit(tui, `/import ${jsonl}`);
		await waitForScreen(tui, "Import session", "Replace current session with");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Session imported from:");
		expect(tui.store.conversation).not.toBe(source);
		expect(userTexts(tui)).toEqual(["exported question"]);

		submit(tui, `/import ${join(harness.tempDir, "missing.jsonl")}`);
		await waitForScreen(tui, "Import session");
		tui.terminal.sendInput(ENTER);
		await waitForScreen(tui, "Failed to import session: File not found");
	});

	it("compacts with /compact; input and the queue's withdrawal sent meanwhile do not wait for it", async () => {
		const { harness, tui, access } = await start({ responses: ["one", "two"] });
		await tui.store.client.promptAndWait("first", { timeoutMs: 10_000 });
		await tui.store.client.promptAndWait("second", { timeoutMs: 10_000 });
		const summary = held("The conversation so far.");
		harness.faux.setResponses([summary.step, fauxAssistantMessage("after the compaction")]);

		submit(tui, "/compact focus on tests");
		await summary.started;
		await vi.waitFor(() => expect(tui.store.phase?.operation).toBe("compaction"));
		submit(tui, "sent while compacting");
		await waitForScreen(tui, "Queued message for after compaction", "Steering: sent while compacting");

		// The compaction runs beside the client's other intents: taking the queue back answers at once.
		const withdrawn = await tui.store.client.intent("withdraw_queued");
		expect(withdrawn.result?.messages.map((message) => message.text)).toEqual(["sent while compacting"]);
		expect(tui.store.phase?.operation).toBe("compaction");
		access.editor.setText("");
		submit(tui, "after all");

		summary.release();
		await vi.waitFor(() => expect(tui.store.state.entries.some((entry) => entry.type === "compaction")).toBe(true));
		await tui.store.client.waitForIdle(10_000);
		expect(userTexts(tui).at(-1)).toBe("after all");
	});

	it("opens a session in a daemon worktree with /worktree, then binds it to the worktree", async () => {
		const { harness, tui } = await start();
		worktrees.path = temporaryDirectory();
		worktrees.bound.length = 0;
		const source = tui.store.conversation;

		submit(tui, "/worktree new feature");
		await waitForScreen(tui, "New session in worktree feature (branch volt/feature)");
		expect(tui.store.conversation).not.toBe(source);
		const info = await tui.store.client.query("conversation_info");
		expect(info.cwd).toBe(worktrees.path);
		// Stored where the session it left is.
		expect(resolve(info.sessionDir)).toBe(resolve(harness.sessionDir));
		expect(worktrees.bound).toEqual([{ worktreeId: "feature", sessionId: tui.store.conversation }]);
	});

	it("reloads, then shows the errors the reloaded setup reports", async () => {
		const { harness, tui } = await start();
		writeFileSync(join(harness.tempDir, "models.json"), "{ not json");

		submit(tui, "/reload");
		await waitForScreen(tui, "Reloaded keybindings, extensions, skills, prompts, themes", "models.json error:");
	});
});

describe("extension commands' session control", () => {
	/** An extension whose commands fork before, and navigate to before, the branch's last user message. */
	function sessionControl(target?: () => SessionReference): ExtensionDefinition {
		const lastUserEntry = (entries: ReadonlyArray<{ id: string; type: string; message?: { role: string } }>) =>
			entries.filter((entry) => entry.type === "message" && entry.message?.role === "user").at(-1)?.id;
		return {
			manifest: { id: "session-control", displayName: "Session control" },
			factory: (volt) => {
				volt.registerCommand("xfork", {
					description: "Fork before the last user message",
					handler: async (_args, ctx) => {
						const entryId = lastUserEntry(ctx.sessionManager.getBranch());
						if (entryId) await ctx.fork(entryId);
					},
				});
				volt.registerCommand("xtree", {
					description: "Navigate to before the last user message",
					handler: async (_args, ctx) => {
						const entryId = lastUserEntry(ctx.sessionManager.getBranch());
						if (entryId) await ctx.navigateTree(entryId);
					},
				});
				volt.registerCommand("xswitch", {
					description: "Switch to the target session",
					handler: async (_args, ctx) => {
						if (target) await ctx.switchSession(target());
					},
				});
			},
		};
	}

	it.each(["regular", "fullscreen"] as const)(
		"fills the editor after ctx.fork(), and an empty one after ctx.navigateTree() (%s)",
		async (tuiMode) => {
			const { tui, access } = await start({
				tuiMode,
				responses: ["first reply", "second reply", "third reply"],
				extensions: [sessionControl()],
			});
			await tui.store.client.promptAndWait("first question", { timeoutMs: 10_000 });
			await tui.store.client.promptAndWait("second question", { timeoutMs: 10_000 });
			const source = tui.store.conversation;

			submit(tui, "/xfork");
			await vi.waitFor(() => expect(tui.store.conversation).not.toBe(source));
			await vi.waitFor(() => expect(access.editor.getText()).toBe("second question"));
			expect(userTexts(tui)).toEqual(["first question"]);

			// A draft stays: the navigation fills only an empty editor.
			access.editor.setText("my draft");
			await tui.store.client.intent("extension.command.session-control.xtree");
			await vi.waitFor(() => expect(userTexts(tui)).toEqual(["first question"]));
			await vi.waitFor(() => expect(tui.store.transcript()).toHaveLength(0));
			expect(access.editor.getText()).toBe("my draft");

			await tui.store.client.promptAndWait("again", { timeoutMs: 10_000 });
			access.editor.setText("");
			submit(tui, "/xtree");
			await vi.waitFor(() => expect(access.editor.getText()).toBe("again"));
		},
	);

	it("asks again when ctx.switchSession() names a session whose folder is gone", async () => {
		let target: SessionReference | undefined;
		const { harness, tui } = await start({
			extensions: [
				sessionControl(() => {
					if (!target) throw new Error("No target");
					return target;
				}),
			],
		});
		const gone = temporaryDirectory();
		target = await storeSession(harness, gone, "homeless session");
		rmSync(gone, { recursive: true, force: true });

		submit(tui, "/xswitch");
		await waitForScreen(tui, "Session cwd not found", gone, "continue in current cwd");
		tui.terminal.sendInput(ENTER);
		await vi.waitFor(() => expect(tui.store.conversation).toBe(target?.sessionId));
		expect(userTexts(tui)).toEqual(["homeless session question"]);
	});
});
