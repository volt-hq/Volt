/**
 * The TUI's input as its protocol client's intents (architecture rewrite §10,
 * Phase 6 slice 7): prompts, steering, and follow-ups by the run phase, the
 * host's queue and taking it back, Esc, user shell commands on the host with
 * the live `bash` value, the model, thinking, and mode keys, and the slash
 * menu, shortcuts, and completion triggers from the intents catalog.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { AutocompleteProvider } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ExtensionFactory } from "../../src/core/extensions/index.ts";
import { queuedInput } from "../../src/modes/interactive/client/input.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { lastAssistantText } from "../utilities/session-reads.ts";
import { createTuiHarness, type TuiHarness, type TuiHarnessOptions, type TuiModeFixture } from "./tui-harness.ts";

type ModeAccess = {
	editor: CustomEditor;
	defaultEditor: CustomEditor;
	inputDiagnostics: readonly { message: string }[];
	sendInitialMessages(messages: readonly { text: string }[]): Promise<void>;
};

const SETTINGS = {
	theme: "dark",
	quietStartup: true,
	lsp: { enabled: false },
	compaction: { enabled: false },
	retry: { enabled: false },
};

const ESC = "\x1b";
const ALT_ENTER = "\x1b\r";
const ALT_UP = "\x1b[1;3A";
const CTRL_P = "\x10";
const SHIFT_TAB = "\x1b[Z";
const CTRL_SHIFT_T = "\x1b[116;6u";
const CTRL_SHIFT_U = "\x1b[117;6u";

/** A 1x1 PNG image. */
const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function start(
	options: TuiHarnessOptions & { tuiMode?: "regular" | "fullscreen"; connect?: boolean } = {},
): Promise<{ harness: TuiHarness; tui: TuiModeFixture; access: ModeAccess; session: AgentSession }> {
	const { tuiMode, connect, ...harnessOptions } = options;
	const harness = await createTuiHarness({ globalSettings: SETTINGS, ...harnessOptions });
	harnesses.push(harness);
	const tui = await harness.startMode({
		tuiMode: tuiMode ?? "regular",
		columns: 100,
		rows: 40,
		...(connect === undefined ? {} : { connect }),
	});
	return { harness, tui, access: tui.mode as unknown as ModeAccess, session: harness.startup.session };
}

/** A turn the faux provider holds open until it is released, or stopped. */
function heldTurn(text: string) {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		started: started.promise,
		release: () => released.resolve(),
		response: (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
			new Promise<AssistantMessage>((resolve, reject) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				void released.promise.then(() => resolve(fauxAssistantMessage(text)));
			}),
	};
}

function submit(tui: TuiModeFixture, text: string, key = "\r"): void {
	tui.terminal.sendInput(text);
	tui.terminal.sendInput(key);
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
		{ timeout: 5_000 },
	);
	return shown;
}

function userTexts(session: AgentSession): string[] {
	return session.messages.flatMap((message) =>
		message.role === "user"
			? [
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
				]
			: [],
	);
}

async function runsTurn(tui: TuiModeFixture): Promise<void> {
	await vi.waitFor(() => expect(tui.store.phase?.operation).toBe("turn"));
}

describe("the TUI's input as intents", () => {
	it.each(["regular", "fullscreen"] as const)(
		"prompts while idle, then steers and queues follow-ups while a turn runs, showing the host's queue (%s)",
		async (tuiMode) => {
			const { harness, tui, session } = await start({ tuiMode });
			const turn = heldTurn("first reply");
			harness.faux.setResponses([
				turn.response,
				fauxAssistantMessage("after steering"),
				fauxAssistantMessage("after the follow-up"),
			]);

			submit(tui, "first question");
			await turn.started;
			await runsTurn(tui);
			submit(tui, "steer me");
			submit(tui, "later on", ALT_ENTER);
			await vi.waitFor(() =>
				expect(queuedInput(tui.store.state)).toMatchObject({ steering: ["steer me"], followUp: ["later on"] }),
			);
			await waitForScreen(tui, "Steering: steer me", "Follow-up: later on");

			turn.release();
			await vi.waitFor(() => expect(userTexts(session)).toEqual(["first question", "steer me", "later on"]));
			await tui.store.client.waitForIdle(10_000);
			expect(await screen(tui)).not.toContain("Steering:");
			expect(lastAssistantText(session)).toBe("after the follow-up");
		},
	);

	it("takes the queue back into the editor with the dequeue key, and with Esc, which stops the run", async () => {
		const { harness, tui, access, session } = await start();
		const turn = heldTurn("never");
		harness.faux.setResponses([turn.response]);
		submit(tui, "work on it");
		await turn.started;
		await runsTurn(tui);
		submit(tui, "one");
		submit(tui, "two", ALT_ENTER);
		await vi.waitFor(() =>
			expect(queuedInput(tui.store.state)).toMatchObject({ steering: ["one"], followUp: ["two"] }),
		);

		tui.terminal.sendInput(ALT_UP);
		await vi.waitFor(() => expect(access.editor.getText()).toBe("one\n\ntwo"));
		await vi.waitFor(() => expect(queuedInput(tui.store.state).steering).toEqual([]));
		await waitForScreen(tui, "Restored 2 queued messages to editor");
		expect(tui.store.phase?.operation).toBe("turn");

		access.editor.setText("");
		submit(tui, "three");
		await vi.waitFor(() => expect(queuedInput(tui.store.state).steering).toEqual(["three"]));
		tui.terminal.sendInput("my draft");
		tui.terminal.sendInput(ESC);
		await vi.waitFor(() => expect(access.editor.getText()).toBe("three\n\nmy draft"));
		await tui.store.client.waitForIdle(10_000);
		expect(userTexts(session)).toEqual(["work on it"]);
		expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "aborted" });
	});

	it("queues what is sent during a compaction on the host, and delivers it once the compaction ends", async () => {
		const { harness, tui, session } = await start();
		harness.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await tui.store.client.promptAndWait("first", { timeoutMs: 10_000 });
		await tui.store.client.promptAndWait("second", { timeoutMs: 10_000 });
		const summary = heldTurn("The conversation so far.");
		harness.faux.setResponses([summary.response, fauxAssistantMessage("after the compaction")]);
		const compacting = session.compact();
		await summary.started;
		await vi.waitFor(() => expect(tui.store.phase?.operation).toBe("compaction"));

		submit(tui, "sent while compacting");
		await waitForScreen(tui, "Queued message for after compaction", "Steering: sent while compacting");
		summary.release();
		await compacting;
		await vi.waitFor(() => expect(lastAssistantText(session)).toBe("after the compaction"));
		expect(userTexts(session).at(-1)).toBe("sent while compacting");
	});

	it("runs `!` and `!!` on the host, shows them while they run, and stops one with Esc", async () => {
		const { tui, access, session } = await start();
		submit(tui, "!printf 'one\\ntwo\\n'");
		await vi.waitFor(() =>
			expect(session.messages.filter((message) => message.role === "bashExecution")).toHaveLength(1),
		);
		await waitForScreen(tui, "$ printf", "one", "two", "[success]");

		submit(tui, "!!printf 'quiet\\n'");
		await vi.waitFor(() =>
			expect(session.messages.at(-1)).toMatchObject({
				role: "bashExecution",
				command: "printf 'quiet\\n'",
				excludeFromContext: true,
			}),
		);

		submit(tui, "!sleep 5");
		await vi.waitFor(() => expect(tui.store.value("bash")).toMatchObject({ command: "sleep 5" }));
		await waitForScreen(tui, "[running]");
		// A second command waits for the first.
		submit(tui, "!echo again");
		await waitForScreen(tui, "A bash command is already running");
		expect(access.editor.getText()).toBe("!echo again");
		access.editor.setText("");
		tui.terminal.sendInput(ESC);
		await vi.waitFor(() =>
			expect(session.messages.at(-1)).toMatchObject({ role: "bashExecution", command: "sleep 5", cancelled: true }),
		);
		await waitForScreen(tui, "[cancelled]");
		expect(tui.store.value("bash")).toBeUndefined();
	});

	it("stops a running shell command with Esc before idle work, then cancels the work, keeping the draft", async () => {
		const cancelled: string[] = [];
		const { tui, access, session } = await start({
			extension: (volt) => {
				volt.registerWorkKind("job");
				volt.registerCommand("start-job", {
					description: "Start a job that runs until it is cancelled",
					handler: async (_args, ctx) => {
						await ctx.startWork("job", { title: "Long job" }, async ({ signal }) => {
							await new Promise<void>((resolve) =>
								signal.addEventListener("abort", () => resolve(), { once: true }),
							);
							cancelled.push("job");
							return { outcome: "cancelled" };
						});
					},
				});
			},
		});
		const abort = vi.spyOn(session, "abort");
		submit(tui, "/start-job");
		await vi.waitFor(() =>
			expect([...tui.store.live.values.values()].some((value) => value.kind === "work")).toBe(true),
		);
		submit(tui, "!sleep 5");
		await vi.waitFor(() => expect(tui.store.value("bash")).toMatchObject({ command: "sleep 5" }));

		tui.terminal.sendInput(ESC);
		await vi.waitFor(() =>
			expect(session.messages.at(-1)).toMatchObject({ role: "bashExecution", command: "sleep 5", cancelled: true }),
		);
		expect(cancelled).toEqual([]);
		expect(abort).not.toHaveBeenCalled();

		tui.terminal.sendInput("unsubmitted draft");
		tui.terminal.sendInput(ESC);
		await vi.waitFor(() => expect(cancelled).toEqual(["job"]));
		expect(abort).toHaveBeenCalledExactlyOnceWith("keyboard_interrupt");
		expect(access.editor.getText()).toBe("unsubmitted draft");
	});

	it("shows a shell command run during a turn below the transcript until its entry commits after the turn", async () => {
		const { harness, tui, session } = await start();
		const turn = heldTurn("the reply");
		harness.faux.setResponses([turn.response]);
		submit(tui, "keep going");
		await turn.started;
		await runsTurn(tui);
		// The command runs while the turn does; its entry waits for the turn to settle.
		submit(tui, "!printf 'beside\\n'");
		await vi.waitFor(() => expect(tui.store.value("bash")).toMatchObject({ exitCode: 0 }));
		await waitForScreen(tui, "$ printf", "beside");
		expect(session.messages.some((message) => message.role === "bashExecution")).toBe(false);

		turn.release();
		await vi.waitFor(() => expect(session.messages.at(-1)).toMatchObject({ role: "bashExecution" }));
		await vi.waitFor(() => expect(tui.store.value("bash")).toBeUndefined());
		const shown = await screen(tui);
		expect(shown.indexOf("the reply")).toBeLessThan(shown.indexOf("$ printf"));
		expect(shown.split("$ printf").length - 1).toBe(1);
	});

	it("attaches the images a prompt names when the conversation's model takes images", async () => {
		const { harness, tui, session } = await start();
		const image = join(harness.tempDir, "pasted.png");
		writeFileSync(image, Buffer.from(TINY_PNG_BASE64, "base64"));
		harness.faux.setResponses([fauxAssistantMessage("I see it")]);
		submit(tui, `what is in ${image}`);
		await vi.waitFor(() => expect(lastAssistantText(session)).toBe("I see it"));
		const prompt = session.messages.find((message) => message.role === "user");
		expect(
			prompt?.role === "user" && Array.isArray(prompt.content) ? prompt.content.map((part) => part.type) : [],
		).toEqual(["text", "image"]);
		await waitForScreen(tui, "[attached pasted.png as image]");
	});

	it("switches the model, thinking level, and agent mode through intents, keeping the model as the default", async () => {
		const { tui, session } = await start({
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: true },
			],
		});
		tui.terminal.sendInput(CTRL_P);
		await vi.waitFor(() => expect(tui.store.state.model?.modelId).toBe("faux-2"));
		await waitForScreen(tui, "Switched to faux-2");
		await vi.waitFor(() => expect(session.settingsManager.getDefaultModel()).toBe("faux-2"));

		const before = tui.store.state.thinkingLevel;
		tui.terminal.sendInput(CTRL_SHIFT_T);
		await vi.waitFor(() => expect(tui.store.state.thinkingLevel).not.toBe(before));
		await waitForScreen(tui, `Thinking level: ${tui.store.state.thinkingLevel}`);
		expect(session.settingsManager.getDefaultThinkingLevel()).toBe(tui.store.state.thinkingLevel);

		tui.terminal.sendInput(SHIFT_TAB);
		await vi.waitFor(() => expect(tui.store.state.planning?.mode).toBe("plan"));
		await waitForScreen(tui, "Plan mode: agent tools are read-only");
		tui.terminal.sendInput(SHIFT_TAB);
		await vi.waitFor(() => expect(session.agentMode).toBe("build"));

		// Back to the first model: the cycle wraps.
		tui.terminal.sendInput(CTRL_P);
		await vi.waitFor(() => expect(tui.store.state.model?.modelId).toBe("faux-1"));
	});

	it("says when the model does not think or nothing else is in the cycle", async () => {
		const { tui } = await start();
		tui.terminal.sendInput(CTRL_SHIFT_T);
		await waitForScreen(tui, "Current model does not support thinking");
		tui.terminal.sendInput(CTRL_P);
		await waitForScreen(tui, "Only one model available");
	});
});

describe("the TUI's slash menu, shortcuts, and completions from the intents catalog", () => {
	const resources = () => {
		const dir = mkdtempSync(join(tmpdir(), "volt-tui-input-"));
		const skill = join(dir, "skills", "lint-check");
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(skill, "SKILL.md"),
			"---\nname: lint-check\ndescription: Check the lint rules\n---\nRun lint.\n",
		);
		const prompts = join(dir, "prompts");
		mkdirSync(prompts, { recursive: true });
		writeFileSync(
			join(prompts, "summarize.md"),
			'---\ndescription: Summarize a file\nargument-hint: "<file>"\n---\nSummarize $1.\n',
		);
		return { skillPaths: [join(dir, "skills")], promptTemplatePaths: [prompts] };
	};

	const ran: string[] = [];
	const extension: ExtensionFactory = (volt) => {
		volt.registerCommand("deploy", {
			description: "Deploy the app",
			getArgumentCompletions: (prefix) =>
				["staging", "production"].filter((env) => env.startsWith(prefix)).map((env) => ({ value: env })),
			handler: async (args) => {
				ran.push(`deploy:${args}`);
			},
		});
		// A command a TUI command shadows.
		volt.registerCommand("model", { description: "Shadowed", handler: async () => {} });
		volt.registerIntent("ping", {
			label: "Ping",
			input: Type.Object({}),
			handler: async (_input, ctx) => {
				ran.push(`ping:${await ctx.ui.getEditorText()}`);
			},
		});
		volt.registerShortcut("ctrl+shift+u", { description: "Ping the extension", intent: "ping" });
		// A key a reserved TUI action takes.
		volt.registerShortcut("ctrl+c", { intent: "ping" });
		volt.registerCompletionProvider("issues", {
			trigger: "#",
			complete: ({ query }) => [{ value: `#4${query}`, label: `#4${query}`, description: "Fix the crash" }],
		});
	};

	async function suggestions(access: ModeAccess, line: string) {
		const provider = (access.defaultEditor as unknown as { autocompleteProvider: AutocompleteProvider })
			.autocompleteProvider;
		return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	}

	it("lists intent aliases, extension commands with their completions, prompt templates, and skills", async () => {
		const { access, tui } = await start({ extension, ...resources() });
		const listed = await suggestions(access, "/");
		const names = listed?.items.map((item) => item.value) ?? [];
		for (const name of ["model", "clear", "compact", "fast", "name", "deploy", "summarize", "skill:lint-check"]) {
			expect(names.some((value) => value.replace(/^\//, "").startsWith(name))).toBe(true);
		}
		// A TUI command wins the name: the extension's /model is not listed beside it.
		expect(names.filter((value) => value.replace(/^\//, "") === "model")).toHaveLength(1);
		expect(access.inputDiagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				"Extension command '/model' conflicts with built-in interactive command. Skipping in autocomplete.",
				"Extension shortcut 'ctrl+c' for extension.intent.test-extension.ping conflicts with built-in shortcut. Skipping.",
			]),
		);
		const deploy = await suggestions(access, "/deploy pro");
		expect(deploy?.items).toEqual([expect.objectContaining({ value: "production", label: "production" })]);

		// The template names its argument; a slash text runs the command through its intent.
		const summarize = listed?.items.find((item) => item.value.replace(/^\//, "").startsWith("summarize"));
		expect(summarize?.description).toContain("Summarize a file");
		submit(tui, "/deploy staging");
		await vi.waitFor(() => expect(ran).toContain("deploy:staging"));
	});

	it("binds the catalog's shortcuts, answers the editor's text, and asks the host to complete trigger tokens", async () => {
		const { access, tui } = await start({ extension });
		tui.terminal.sendInput("draft text");
		tui.terminal.sendInput(CTRL_SHIFT_U);
		await vi.waitFor(() => expect(ran).toContain("ping:draft text"));

		const completed = await suggestions(access, "fix #2");
		expect(completed).toEqual({
			prefix: "#2",
			items: [{ value: "#42", label: "#42", description: "Fix the crash" }],
		});
	});
});

describe("the TUI's startup input", () => {
	it("sends what was submitted before its client connected once it connects", async () => {
		const { harness, tui, session } = await start({ connect: false });
		harness.faux.setResponses([fauxAssistantMessage("early reply")]);
		submit(tui, "early prompt");
		await tui.connect();
		await vi.waitFor(() => expect(lastAssistantText(session)).toBe("early reply"));
		expect(userTexts(session)).toEqual(["early prompt"]);
	});

	it("sends the initial messages one after another, each once the one before settled", async () => {
		const { harness, access, session } = await start();
		harness.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await access.sendInitialMessages([{ text: "first" }, { text: "second" }]);
		expect(userTexts(session)).toEqual(["first", "second"]);
		expect(lastAssistantText(session)).toBe("second reply");
	});

	it("reports a rejected key action instead of leaking an unhandled rejection", async () => {
		const receiver = { showError: vi.fn() };
		const runKeyAction = Reflect.get(InteractiveMode.prototype, "runKeyAction") as (
			this: unknown,
			action: () => Promise<void>,
		) => void;
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		try {
			runKeyAction.call(receiver, async () => {
				throw new Error("The model to cycle to is not available");
			});
			// Two macrotask turns: Node reports an unhandled rejection only after the
			// microtask queue drains without a handler being attached.
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", unhandled);
		}
		expect(unhandled).not.toHaveBeenCalled();
		expect(receiver.showError).toHaveBeenCalledWith("The model to cycle to is not available");
	});
});
