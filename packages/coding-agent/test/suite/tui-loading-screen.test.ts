/**
 * The TUI's full-screen loading animation: it shows from startup until the
 * conversation does, and covers the conversation while the TUI moves to a new
 * session (`/clear`) and while it reloads (`/reload`), animating meanwhile.
 * The conversation shows again once the load ended.
 */

import { type Component, setKeybindings } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { ConversationConnector } from "../../src/client/conversation-connector.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import { createInteractiveTui, InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import type * as ToolsManager from "../../src/utils/tools-manager.ts";
import { createTuiHarness, type TuiHarness, type TuiModeFixture, waitForScreen } from "./tui-harness.ts";

// Startup looks for fd and rg, and downloads them where they are missing.
vi.mock("../../src/utils/tools-manager.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ToolsManager>()),
	ensureTool: vi.fn(async () => undefined),
}));

type ModeAccess = {
	editor: Component & { getText(): string };
	showLoadingScreen(message: string, focus: Component): (focus?: Component) => Promise<void>;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
};

const SETTINGS = {
	theme: "dark",
	quietStartup: true,
	lsp: { enabled: false },
	compaction: { enabled: false },
	retry: { enabled: false },
};
const EDITOR_PLACEHOLDER = "Type a request or / for commands";
const BOLT = /[▀▄█]/;

const harnesses: TuiHarness[] = [];
/** The modes a test started itself, through `init` as the volt CLI starts one. */
const modes: InteractiveMode[] = [];

afterEach(async () => {
	for (const mode of modes.splice(0)) {
		mode.stop("resume-hint");
		stopThemeWatcher();
		setKeybindings(new KeybindingsManager());
		vi.unstubAllEnvs();
	}
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	vi.restoreAllMocks();
});

async function start(tuiMode: "regular" | "fullscreen"): Promise<{ harness: TuiHarness; tui: TuiModeFixture }> {
	const harness = await createTuiHarness({ globalSettings: SETTINGS });
	harnesses.push(harness);
	return { harness, tui: await harness.startMode({ tuiMode, columns: 100, rows: 30 }) };
}

/** A mode over the harness's connector that starts through `init`, as the volt CLI starts the TUI. */
async function startup(tuiMode: "regular" | "fullscreen"): Promise<{
	harness: TuiHarness;
	mode: InteractiveMode;
	terminal: VirtualTerminal;
	/** The terminal's visible rows once it rendered. */
	shown(): Promise<string>;
}> {
	const harness = await createTuiHarness({ globalSettings: SETTINGS });
	harnesses.push(harness);
	vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
	const mode = new InteractiveMode(harness.connector, {
		tuiMode,
		settingsScope: {
			cwd: harness.startup.cwd,
			projectTrusted: harness.startup.session.settingsManager.isProjectTrusted(),
		},
	});
	modes.push(mode);
	const terminal = new VirtualTerminal(100, 30);
	(mode as unknown as { renderer: unknown }).renderer = createInteractiveTui({
		tuiMode,
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
		terminal,
	});
	const shown = async (): Promise<string> => {
		await terminal.waitForRender();
		return terminal.getViewport().join("\n");
	};
	return { harness, mode, terminal, shown };
}

describe("the TUI's loading screen", () => {
	it.each(["regular", "fullscreen"] as const)(
		"shows from startup until the conversation does, keeping what is typed meanwhile (%s)",
		async (tuiMode) => {
			const { mode, terminal, shown } = await startup(tuiMode);

			const started = mode.init();
			await vi.waitFor(async () => {
				const loading = await shown();
				expect(loading).toContain("Starting Volt");
				expect(loading).toMatch(BOLT);
				expect(loading).not.toContain(EDITOR_PLACEHOLDER);
			});
			terminal.sendInput("typed early");
			await started;

			await vi.waitFor(async () => {
				const conversation = await shown();
				expect(conversation).toContain("typed early");
				expect(conversation).not.toContain("Starting Volt");
				expect(conversation).not.toMatch(BOLT);
			});
		},
	);

	it("stays at startup until the conversation's host finished starting, showing what it waits for", async () => {
		const { harness, mode, shown } = await startup("regular");
		// A daemon serves the TUI before it finished starting: its connector says when it has.
		const hostStarted = Promise.withResolvers<void>();
		(harness.connector as ConversationConnector).started = async (options) => {
			options?.onStatus?.("Starting the Volt daemon's phone transport");
			await hostStarted.promise;
			options?.onStatus?.(undefined);
		};

		// The conversation is ready, and the screen's own minimum has long passed.
		await mode.init();
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		const waiting = await shown();
		expect(waiting).toMatch(BOLT);
		expect(waiting).toContain("Starting Volt");
		expect(waiting).toContain("Starting the Volt daemon's phone transport...");
		expect(waiting).not.toContain(EDITOR_PLACEHOLDER);

		hostStarted.resolve();
		await vi.waitFor(async () => {
			const conversation = await shown();
			expect(conversation).toContain(EDITOR_PLACEHOLDER);
			expect(conversation).not.toContain("Starting the Volt daemon's phone transport");
			expect(conversation).not.toMatch(BOLT);
		});
	});

	it.each(["regular", "fullscreen"] as const)(
		"covers the conversation while /clear moves to a new session (%s)",
		async (tuiMode) => {
			const { tui } = await start(tuiMode);
			await waitForScreen(tui, EDITOR_PLACEHOLDER);
			const before = tui.store.conversation;

			const cleared = tui.submit("/clear");
			const loading = await waitForScreen(tui, "Starting a new session");
			expect(loading).toMatch(BOLT);
			expect(loading).not.toContain(EDITOR_PLACEHOLDER);
			expect(tui.terminal.getViewport()).toHaveLength(30);

			await cleared;
			const shown = await waitForScreen(tui, "New session started", EDITOR_PLACEHOLDER);
			expect(shown).not.toContain("Starting a new session");
			expect(shown).not.toMatch(BOLT);
			expect(tui.store.conversation).not.toBe(before);
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"animates while /reload runs, without taking what is typed (%s)",
		async (tuiMode) => {
			const { harness, tui } = await start(tuiMode);
			const access = tui.mode as unknown as ModeAccess;
			const entered = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			vi.spyOn(harness.startup.session, "reload").mockImplementation(async () => {
				entered.resolve();
				await released.promise;
			});

			const reloading = tui.submit("/reload");
			try {
				await entered.promise;
				const first = await waitForScreen(tui, "Reloading keybindings, extensions, skills, prompts, themes...");
				expect(first).toMatch(BOLT);
				// The bolt's halves move: a later frame differs.
				await vi.waitFor(
					async () => {
						await tui.terminal.waitForRender();
						expect(tui.screen()).not.toBe(first);
					},
					{ timeout: 5_000 },
				);
				tui.terminal.sendInput("typed while reloading");
				await tui.terminal.waitForRender();
				expect(access.editor.getText()).toBe("");
			} finally {
				released.resolve();
				await reloading;
			}
			const shown = await waitForScreen(tui, "Reloaded keybindings, extensions, skills, prompts, themes");
			expect(shown).toContain(EDITOR_PLACEHOLDER);
			expect(shown).not.toMatch(BOLT);
		},
	);

	it("does not stay on the main screen when the TUI stops while it shows", async () => {
		const { tui } = await start("regular");
		const access = tui.mode as unknown as ModeAccess;
		void access.showLoadingScreen("Loading a while", access.editor);
		expect(await waitForScreen(tui, "Loading a while")).toMatch(BOLT);

		tui.mode.stop("resume-hint");
		await tui.terminal.flush();
		const left = tui.screen();
		expect(left).toContain(EDITOR_PLACEHOLDER);
		expect(left).not.toContain("Loading a while");
		expect(left).not.toMatch(BOLT);
	});

	it("leaves a dialog that opened over it, which returns to the conversation once the load ended", async () => {
		const { tui } = await start("regular");
		const access = tui.mode as unknown as ModeAccess;
		const loaded = access.showLoadingScreen("Loading a while", access.editor);
		await waitForScreen(tui, "Loading a while");

		const answer = access.showExtensionSelector("Pick one", ["first", "second"]);
		const asked = await waitForScreen(tui, "Pick one", "first", "second");
		expect(asked).not.toContain("Loading a while");
		await loaded();
		expect(await waitForScreen(tui, "Pick one")).not.toContain(EDITOR_PLACEHOLDER);

		tui.terminal.sendInput("\r");
		expect(await answer).toBe("first");
		const shown = await waitForScreen(tui, EDITOR_PLACEHOLDER);
		expect(shown).not.toContain("Loading a while");
		expect(shown).not.toMatch(BOLT);
	});
});
