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
type ReloadRequest = { expectedSessionId: string };
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
	reloadCurrentSessionFromStore: ReturnType<typeof vi.fn<(options: ReloadRequest) => Promise<{ reloaded: boolean }>>>;
};

const FATAL_PREFIX = "Failed to reload the session after its state could not be saved";
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

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((settleResolve, settleReject) => {
		resolve = settleResolve;
		reject = settleReject;
	});
	return { promise, resolve, reject };
}

async function fixture(reloadResult: Promise<{ reloaded: boolean }>) {
	const harness = await createTestHarness();
	const runtime: RuntimeMock = {
		session: harness.session,
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
		reloadCurrentSessionFromStore: vi.fn((_options: ReloadRequest) => reloadResult),
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
	// Never let a recovery reach the real process.exit.
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
	// The authority listener defers recovery to a microtask.
	await Promise.resolve();
}

describe("regression #525: interactive recovery from conversation authority loss", () => {
	it("keeps rendering, holds input during the reload, and re-renders the reloaded session", async () => {
		const reload = deferred<{ reloaded: boolean }>();
		const { harness, runtime, access, terminal, handleFatalRuntimeError, exit } = await fixture(reload.promise);
		const sessionId = harness.session.sessionId;

		await loseAuthority(harness, new Error("commit failed"));
		access.ui.requestRender(true);
		await terminal.waitForRender();

		const shown = viewport(terminal);
		expect(shown).toContain("Could not confirm the session's saved state: commit failed");
		expect(shown).toContain("Reloading the session from the store");
		// The footer still renders every frame.
		expect(shown).toContain(harness.getModel().id);
		expect(exit).not.toHaveBeenCalled();
		expect(runtime.reloadCurrentSessionFromStore).toHaveBeenCalledTimes(1);
		expect(runtime.reloadCurrentSessionFromStore).toHaveBeenCalledWith(
			expect.objectContaining({ expectedSessionId: sessionId }),
		);

		terminal.sendInput("typed during reload");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(access.editor.getText()).toBe("typed during reload"));
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("Reloading the session — input will stay in the editor until it finishes.");
		expect(access.pendingUserInputs).toEqual([]);

		// A second loss signal for the same session does not start another reload.
		await loseAuthority(harness, new Error("second failure"));
		expect(runtime.reloadCurrentSessionFromStore).toHaveBeenCalledTimes(1);

		// The runtime replaced the session with a copy reopened from the store.
		const replacement = await createTestHarness();
		runtime.session = replacement.session;
		reload.resolve({ reloaded: true });
		await vi.waitFor(() => expect(viewport(terminal)).toContain("Reloaded the session from the store."));

		const recovered = viewport(terminal);
		expect(recovered).toContain("Could not confirm the session's saved state: commit failed");
		expect(recovered).not.toContain("Reloading the session from the store…");
		expect(access.editor.getText()).toBe("typed during reload");
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();

		// Input flows again once the reload finished.
		access.editor.setText("");
		terminal.sendInput("after reload");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(access.pendingUserInputs).toEqual(["after reload"]));
	});

	it("treats a failed reload as fatal and hands back the unsent draft", async () => {
		const reload = deferred<{ reloaded: boolean }>();
		const { harness, access, handleFatalRuntimeError } = await fixture(reload.promise);
		access.editor.setText("unsent draft");

		await loseAuthority(harness, new Error("commit failed"));
		const failure = new Error("store unavailable");
		reload.reject(failure);

		await vi.waitFor(() =>
			expect(handleFatalRuntimeError).toHaveBeenCalledWith(FATAL_PREFIX, failure, { unsentDraft: "unsent draft" }),
		);
	});

	it("treats a session that is still without authority after the reload as fatal", async () => {
		const { harness, access, handleFatalRuntimeError } = await fixture(Promise.resolve({ reloaded: false }));
		access.editor.setText("unsent draft");

		await loseAuthority(harness, new Error("commit failed"));

		await vi.waitFor(() =>
			expect(handleFatalRuntimeError).toHaveBeenCalledWith(
				FATAL_PREFIX,
				expect.any(SessionConversationStateUnavailableError),
				{ unsentDraft: "unsent draft" },
			),
		);
	});

	it("reports a steer that failed with the authority loss and restores its text", async () => {
		const { harness, access, terminal } = await fixture(new Promise(() => {}));
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

	it("recovers from uncaught authority errors and still crashes on anything else", async () => {
		const { harness, runtime, access, exit } = await fixture(new Promise(() => {}));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		access.registerSignalHandlers();
		cleanups.push(() => access.unregisterSignalHandlers());
		// The handlers are prepended; call them directly instead of emitting through the test runner's own.
		const onUncaughtException = process.listeners("uncaughtException")[0] as (error: Error) => void;
		const onUnhandledRejection = process.listeners("unhandledRejection")[0] as (reason: unknown) => void;
		const authorityError = () => new SessionConversationStateUnavailableError({ cause: new Error("lost") });

		// From a session that was already replaced: dropped without a reload.
		onUncaughtException(authorityError());
		onUnhandledRejection(authorityError());
		expect(runtime.reloadCurrentSessionFromStore).not.toHaveBeenCalled();

		// From the current session: recovery, not an exit.
		await loseAuthority(harness, new Error("lost"));
		onUncaughtException(authorityError());
		onUnhandledRejection(authorityError());
		expect(runtime.reloadCurrentSessionFromStore).toHaveBeenCalledTimes(1);
		expect(exit).not.toHaveBeenCalled();

		onUnhandledRejection("plain rejection");
		expect(exit).toHaveBeenCalledWith(1);
		expect(consoleError).toHaveBeenCalledWith(new Error("plain rejection"));
	});

	it("crashes on a plain uncaught exception", async () => {
		const { access, exit } = await fixture(new Promise(() => {}));
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
