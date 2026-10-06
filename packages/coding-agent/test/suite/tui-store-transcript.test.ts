/**
 * The TUI as a protocol client (architecture rewrite §10, Phase 6 slice 5):
 * InteractiveMode connects over loopback, and its transcript draws the
 * store: the client fold of the projected log, the live lane, and the
 * presentations the host computed. Moves and loss follow the subscription's
 * `ended` frames.
 */

import {
	type AssistantMessage,
	createProviderError,
	fauxAssistantMessage,
	fauxToolCall,
	type Usage,
} from "@hansjm10/volt-ai";
import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { type TuiStore, transcriptOf } from "../../src/modes/interactive/client/tui-store.ts";
import { loseLog } from "../lost-conversation-lock.ts";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions, type TuiModeFixture } from "./tui-harness.ts";

type ModeAccess = {
	store: TuiStore;
	editor: { setText(text: string): void; getText(): string };
	sessionRenderSuspension: unknown;
	handleClearCommand(): Promise<void>;
	handleCompactCommand(customInstructions?: string): Promise<void>;
	toggleThinkingBlockVisibility(): void;
	handleFatalRuntimeError(prefix: string, error: unknown, options?: { unsentDraft?: string }): Promise<void>;
};

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };

const USAGE: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(session: AgentSession, content: AssistantMessage["content"], rest: Partial<AssistantMessage> = {}) {
	const model = session.model;
	if (!model) throw new Error("The session has no model");
	return {
		role: "assistant" as const,
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: USAGE,
		stopReason: "stop" as const,
		timestamp: Date.now(),
		...rest,
	};
}

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function start(
	options: TuiHarnessOptions & {
		tuiMode?: "regular" | "fullscreen";
		before?: (session: AgentSession) => Promise<void>;
	} = {},
): Promise<{ harness: TuiHarness; tui: TuiModeFixture; access: ModeAccess; session: AgentSession }> {
	const { tuiMode, before, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: SETTINGS, ...harnessOptions });
	harnesses.push(harness);
	await before?.(harness.startup.session);
	const tui = await harness.startMode({ tuiMode: tuiMode ?? "regular", columns: 100, rows: 40 });
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
		{ timeout: 5_000 },
	);
	return shown;
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

describe("the TUI's transcript from its store", () => {
	it("draws the conversation's log at startup from the snapshot: messages, and calls as the host presented them", async () => {
		const { tui } = await start({
			before: async (session) => {
				const writer = session.sessionWriter;
				await writer.appendMessage({ role: "user", content: "list the files", timestamp: Date.now() });
				await writer.appendMessage(
					assistant(
						session,
						[{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la" } }],
						{
							stopReason: "toolUse",
						},
					),
				);
				await writer.appendMessage({
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "file-a\nfile-b" }],
					isError: false,
					timestamp: Date.now(),
				});
				await writer.appendMessage(assistant(session, [{ type: "text", text: "Two files." }]));
			},
		});

		const shown = await waitForScreen(tui, "list the files", "ls -la", "[success]", "file-b", "Two files.");
		expect(occurrences(shown, "ls -la")).toBe(1);
		expect(tui.store.transcript().map((entry) => entry.type)).toEqual(["message", "message", "message", "message"]);
	});

	it.each(["regular", "fullscreen"] as const)(
		"streams a call in %s: the live presentation while it runs, then its committed result",
		async (tuiMode) => {
			const { harness, tui, session } = await start({ tuiMode });
			harness.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'first\\n'; sleep 1; printf 'second\\n'" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("finished"),
			]);

			const run = session.prompt("run it");
			await waitForScreen(tui, "run it", "[running]", "first");
			await run;
			await session.waitForIdle();
			const shown = await waitForScreen(tui, "[success]", "second", "finished");
			expect(shown).not.toContain("[running]");
			expect(occurrences(shown, "sleep 1")).toBe(1);
		},
	);

	it("shows why an aborted turn's calls never ran, and a failed turn's error", async () => {
		const { tui, session } = await start();
		await session.sessionWriter.appendMessage({ role: "user", content: "try it", timestamp: Date.now() });
		await session.sessionWriter.appendMessage(
			assistant(
				session,
				[
					{ type: "text", text: "Starting." },
					{ type: "toolCall", id: "call-aborted", name: "read", arguments: { path: "a.txt" } },
				],
				{ stopReason: "aborted" },
			),
		);
		await waitForScreen(tui, "Starting.", "[failure]", "Operation aborted");

		await session.sessionWriter.appendMessage(
			assistant(session, [{ type: "text", text: "Partial." }], {
				stopReason: "error",
				error: createProviderError("server", "the provider failed"),
			}),
		);
		await waitForScreen(tui, "Partial.", "[failure] the provider failed");
	});

	it("draws the transcript afresh from a compaction, its summary also where the conversation goes on", async () => {
		const { harness, tui, access, session } = await start({ responses: ["first reply", "second reply"] });
		await session.prompt("first prompt");
		await session.prompt("second prompt");
		await waitForScreen(tui, "first prompt", "second reply");
		harness.faux.setResponses([fauxAssistantMessage("The conversation so far, summarized.")]);

		await access.handleCompactCommand();
		await session.waitForIdle();

		const transcript = tui.store.transcript();
		expect(transcript[0]?.type).toBe("compaction");
		const shown = await waitForScreen(tui, "[compaction]");
		expect(occurrences(shown, "[compaction]")).toBe(2);
		expect(shown.indexOf("[compaction]")).toBeLessThan(shown.lastIndexOf("[compaction]"));
	});

	it("draws the branch the leaf moved to afresh", async () => {
		const { tui, session } = await start({ responses: ["first reply", "second reply"] });
		await session.prompt("first prompt");
		await session.prompt("second prompt");
		await waitForScreen(tui, "second prompt", "second reply");
		const firstReply = session.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((block) => block.type === "text" && block.text === "first reply"),
			);
		if (!firstReply) throw new Error("No first reply");

		await session.navigateTree(firstReply.id);

		await vi.waitFor(async () => {
			const shown = await screen(tui);
			expect(shown).toContain("first reply");
			expect(shown).not.toContain("second prompt");
		});
	});

	it("keeps each row and redraws it once the thinking blocks are hidden", async () => {
		const { tui, access, session } = await start();
		await session.sessionWriter.appendMessage({ role: "user", content: "think", timestamp: Date.now() });
		await session.sessionWriter.appendMessage(
			assistant(session, [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: "The answer." },
			]),
		);
		await waitForScreen(tui, "private reasoning", "The answer.");

		access.toggleThinkingBlockVisibility();

		const shown = await waitForScreen(tui, "Thinking...", "The answer.");
		expect(shown).not.toContain("private reasoning");
	});

	it("presents a custom message as the host does: generically once its extension is disabled", async () => {
		const { tui, session } = await start({
			extensions: [
				{
					manifest: { id: "presenting", displayName: "Presenting" },
					factory: (volt) => {
						volt.registerMessagePresenter("presented-note", () => ({
							body: [{ type: "text", text: "presented by the extension" }],
						}));
					},
				},
			],
		});
		await session.sessionWriter.appendCustomMessageEntry("presented-note", "plain note", true);
		await waitForScreen(tui, "presented by the extension");

		await tui.store.client.intent("set_extension_enabled", { id: "presenting", enabled: false, scope: "global" });
		await session.extensionRegistry.settled();

		await vi.waitFor(async () => {
			const shown = await screen(tui);
			expect(shown).not.toContain("presented by the extension");
			expect(shown).toContain("plain note");
		});
	});
});

describe("the TUI follows its client's subscription", () => {
	it.each(["regular", "fullscreen"] as const)(
		"shows the conversation /new moved it to, from that conversation's snapshot (%s)",
		async (tuiMode) => {
			const { harness, tui, access, session } = await start({ tuiMode });
			await session.prompt("a prompt in the first conversation");
			await waitForScreen(tui, "a prompt in the first conversation");

			// Rendering waits while the client moves, and resumes once the conversation it moved to shows.
			const renderer = (tui.mode as unknown as { renderer: { suspendRendering(): unknown } }).renderer;
			const suspend = vi.spyOn(renderer, "suspendRendering");
			await access.handleClearCommand();
			expect(suspend).toHaveBeenCalledOnce();

			const target = harness.tuiHost.conversation;
			expect(target.id).not.toBe(harness.startup.id);
			expect(tui.store.conversation).toBe(target.id);
			expect(harness.startup.closed).toBe(true);
			expect(access.sessionRenderSuspension).toBeUndefined();
			const shown = await waitForScreen(tui, "New session started");
			expect(shown).not.toContain("a prompt in the first conversation");

			// The TUI goes on in the conversation it moved to.
			harness.faux.setResponses([fauxAssistantMessage("reply in the new conversation")]);
			await target.session.prompt("a prompt in the new conversation");
			await waitForScreen(tui, "a prompt in the new conversation", "reply in the new conversation");
		},
	);

	it("ends when its conversation loses its log, with the host's reason and the unsent draft", async () => {
		const { harness, access } = await start();
		const fatal = vi.fn(async (_prefix: string, _error: unknown, _options?: { unsentDraft?: string }) => {});
		access.handleFatalRuntimeError = fatal;
		access.editor.setText("unsent draft");

		await loseLog(harness.startup.session.sessionWriter);

		await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce(), { timeout: 5_000 });
		const [prefix, error, options] = fatal.mock.calls[0] ?? [];
		expect(prefix).toBe("Volt stopped this session because its saved state could not be confirmed");
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("/resume");
		expect((error as Error).message).not.toContain("Its log could not be confirmed");
		expect(options).toEqual({ unsentDraft: "unsent draft" });
		expect(harness.startup.closed).toBe(true);
	});
});

describe("transcriptOf", () => {
	const entry = (id: string, parentId: string | null, type: ProjectedEntry["type"] = "message"): ProjectedEntry =>
		({ ordinal: 1, id, parentId, type, timestamp: new Date(0).toISOString() }) as ProjectedEntry;

	it("is the branch's transcript entries without a compaction", () => {
		const branch = [entry("a", null), entry("model", "a", "model_change"), entry("b", "model")];
		expect(transcriptOf(branch).map((item) => item.id)).toEqual(["a", "b"]);
	});

	it("starts from the newest compaction: it, the entries it kept, then the entries after it", () => {
		const compaction = {
			...entry("c", "d", "compaction"),
			payload: { summary: "s", firstKeptEntryId: "c1", tokensBefore: 1 },
		} as ProjectedEntry;
		const branch = [
			entry("a", null),
			entry("b", "a"),
			entry("c1", "b"),
			entry("d", "c1"),
			compaction,
			entry("e", "c"),
		];
		expect(transcriptOf(branch).map((item) => item.id)).toEqual(["c", "c1", "d", "e"]);
	});
});
