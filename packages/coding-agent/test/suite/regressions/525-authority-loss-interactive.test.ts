import type { Component, TUI } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type FatalOptions = { unsentDraft?: string };
type TestAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	pendingUserInputs: string[];
	isInitialized: boolean;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	renderWidgets(): void;
	client: HostClient;
	showSessionExtensions(session: AgentSession): void;
	subscribeToAgent(session: AgentSession): void;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	registerSignalHandlers(): void;
	unregisterSignalHandlers(): void;
	handleRuntimeLost(error: Error): Promise<void>;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: FatalOptions) => Promise<void>;
};
/** The host of the TUI's one conversation: closing it releases the session's lock. */
type HostMock = {
	close: ReturnType<typeof vi.fn<() => Promise<void>>>;
	dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

const FATAL_PREFIX = "Volt stopped this session because its saved state could not be confirmed";
const harnesses: Harness[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const harness of harnesses.splice(0)) {
		await harness.session.abort().catch(() => {});
		await harness.cleanupAsync().catch(() => {});
	}
	stopThemeWatcher();
	vi.restoreAllMocks();
});

async function createTestHarness(): Promise<Harness> {
	const harness = await createHarness({
		settings: { theme: "dark", lsp: { enabled: false }, quietStartup: true, compaction: { enabled: false } },
	});
	harnesses.push(harness);
	return harness;
}

async function fixture() {
	const harness = await createTestHarness();
	const lost = Promise.withResolvers<Error>();
	const host: HostMock = {
		close: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
	const conversation = {
		id: harness.session.sessionId,
		session: harness.session,
		work: harness.session.work,
		lost: lost.promise,
	};
	const mode = new InteractiveMode(
		host as unknown as ConversationHost,
		conversation as unknown as HostedConversation,
		{ tuiMode: "regular" },
	);
	const access = mode as unknown as TestAccess;
	const terminal = new VirtualTerminal(140, 30);
	access.renderer = createInteractiveTui({
		tuiMode: "regular",
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
		terminal,
	});
	access.renderWidgets();
	access.setupKeyHandlers();
	access.setupPlanPaneInputRouting();
	access.setupEditorSubmitHandler();
	access.activateView(access.conversationView, access.editor, false);
	access.isInitialized = true;
	access.ui.start();
	// The TUI's surface on the session's extensions, as its host attaches it.
	await harness.session.attachExtensionClient({ ...access.client.surface, id: access.client.id, mode: "tui" }).ready;
	access.showSessionExtensions(harness.session);
	access.subscribeToAgent(harness.session);
	// Never let the fatal exit reach the real process.exit.
	const handleFatalRuntimeError = vi.fn(async (_prefix: string, _error: unknown, _options?: FatalOptions) => {});
	access.handleFatalRuntimeError = handleFatalRuntimeError;
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	cleanups.push(() => mode.stop());
	await terminal.waitForRender();
	return { harness, host, mode, access, terminal, handleFatalRuntimeError, exit, loseLog: lost.resolve };
}

describe("regression #525: interactive mode ends a conversation whose session lost its log", () => {
	it("closes the conversation and exits with a fatal error suggesting /resume, handing back the draft", async () => {
		const { host, access, handleFatalRuntimeError, exit, loseLog } = await fixture();
		access.editor.setText("unsent draft");

		loseLog(new Error("Session ordinal changed from 4 to 5"));

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1));
		const [prefix, error, options] = handleFatalRuntimeError.mock.calls[0]!;
		expect(prefix).toBe(FATAL_PREFIX);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Session ordinal changed from 4 to 5");
		expect((error as Error).message).toContain("/resume");
		expect(options).toEqual({ unsentDraft: "unsent draft" });
		// Closing the conversation releases the session's lock before the TUI exits.
		expect(host.close).toHaveBeenCalledTimes(1);
		expect(host.close.mock.invocationCallOrder[0]).toBeLessThan(handleFatalRuntimeError.mock.invocationCallOrder[0]!);
		expect(exit).not.toHaveBeenCalled();

		// Ending again does nothing.
		await access.handleRuntimeLost(new Error("second failure"));
		expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1);
		expect(host.close).toHaveBeenCalledTimes(1);
	});

	it("crashes on a plain uncaught exception", async () => {
		const { access, exit } = await fixture();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		access.registerSignalHandlers();
		cleanups.push(() => access.unregisterSignalHandlers());
		const onUncaughtException = process.listeners("uncaughtException")[0] as (error: Error) => void;
		const crash = new Error("plain crash");

		onUncaughtException(crash);

		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalledWith(crash);
	});
});
