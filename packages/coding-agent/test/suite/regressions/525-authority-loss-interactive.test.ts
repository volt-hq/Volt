import type { Component, TUI } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { SessionConversationStateUnavailableError } from "../../../src/core/session-manager.ts";
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
	bindCurrentSessionExtensions(session: AgentSession): Promise<void>;
	subscribeToAgent(session: AgentSession): void;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	registerSignalHandlers(): void;
	unregisterSignalHandlers(): void;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: FatalOptions) => Promise<void>;
};
type RuntimeMock = {
	session: AgentSession;
	setBeforeSessionInvalidate: () => void;
	setRebindSession: () => void;
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
	const runtime: RuntimeMock = {
		session: harness.session,
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
		dispose: vi.fn(async () => {}),
	};
	const mode = new InteractiveMode(runtime as unknown as AgentSessionRuntime, { tuiMode: "regular" });
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
	await access.bindCurrentSessionExtensions(harness.session);
	access.subscribeToAgent(harness.session);
	// Never let the fatal exit reach the real process.exit.
	const handleFatalRuntimeError = vi.fn(async (_prefix: string, _error: unknown, _options?: FatalOptions) => {});
	access.handleFatalRuntimeError = handleFatalRuntimeError;
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	cleanups.push(() => mode.stop());
	await terminal.waitForRender();
	return { harness, runtime, mode, access, terminal, handleFatalRuntimeError, exit };
}

function viewport(terminal: VirtualTerminal): string {
	return terminal.getViewport().join("\n");
}

async function loseAuthority(harness: Harness, cause: Error): Promise<void> {
	harness.session.sessionManager.retireConversationAuthority(cause);
	// The authority listener defers the shutdown to a microtask.
	await Promise.resolve();
}

describe("regression #525: interactive mode ends a session that lost conversation authority", () => {
	it("disposes the runtime and exits with a fatal error suggesting /resume, handing back the draft", async () => {
		const { harness, runtime, access, handleFatalRuntimeError, exit } = await fixture();
		access.editor.setText("unsent draft");

		await loseAuthority(harness, new Error("Expected log ordinal 4, but the log head is 5"));

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1));
		const [prefix, error, options] = handleFatalRuntimeError.mock.calls[0]!;
		expect(prefix).toBe(FATAL_PREFIX);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("Expected log ordinal 4, but the log head is 5");
		expect((error as Error).message).toContain("/resume");
		expect(options).toEqual({ unsentDraft: "unsent draft" });
		// Disposal releases the session's lock before the TUI exits.
		expect(runtime.dispose).toHaveBeenCalledTimes(1);
		expect(runtime.dispose.mock.invocationCallOrder[0]).toBeLessThan(
			handleFatalRuntimeError.mock.invocationCallOrder[0]!,
		);
		expect(exit).not.toHaveBeenCalled();

		// A second loss signal for the same session does not end it again.
		await loseAuthority(harness, new Error("second failure"));
		expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1);
	});

	it("reports a steer that failed with the authority loss and restores its text", async () => {
		const { harness, access, terminal } = await fixture();
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async () => {
			throw harness.session.sessionManager.retireConversationAuthority(new Error("steer commit failed"));
		});

		await expect(access.editor.onSubmit?.("steer text")).resolves.toBeUndefined();

		expect(prompt).toHaveBeenCalledWith("steer text", expect.objectContaining({ streamingBehavior: "steer" }));
		expect(access.editor.getText()).toBe("steer text");
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("Error: Session conversation authority requires reconciliation");
	});

	it("ends the session on uncaught authority errors and still crashes on anything else", async () => {
		const { harness, access, handleFatalRuntimeError, exit } = await fixture();
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		access.registerSignalHandlers();
		cleanups.push(() => access.unregisterSignalHandlers());
		// The handlers are prepended; call them directly instead of emitting through the test runner's own.
		const onUncaughtException = process.listeners("uncaughtException")[0] as (error: Error) => void;
		const onUnhandledRejection = process.listeners("unhandledRejection")[0] as (reason: unknown) => void;
		const authorityError = () => new SessionConversationStateUnavailableError({ cause: new Error("lost") });

		// From a session that was already replaced: dropped without ending the current one.
		onUncaughtException(authorityError());
		onUnhandledRejection(authorityError());
		await Promise.resolve();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();

		// From the current session: the session ends once, not an immediate crash.
		await loseAuthority(harness, new Error("lost"));
		onUncaughtException(authorityError());
		onUnhandledRejection(authorityError());
		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1));
		expect(exit).not.toHaveBeenCalled();

		onUnhandledRejection("plain rejection");
		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalledWith(new Error("plain rejection"));
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
