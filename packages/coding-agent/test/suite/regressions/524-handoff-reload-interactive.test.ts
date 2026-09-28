import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

type ReloadRequest = { expectedSessionId: string; projectTrustContextFactory?: (cwd: string) => unknown };
type FatalOptions = { unsentDraft?: string };

type AbsorbContext = {
	handoffReloadsPending: number;
	isShuttingDown: boolean;
	session: {
		sessionRef: object | undefined;
		reload: () => Promise<void>;
	};
	runtimeHost: {
		reloadCurrentSessionFromStore: (options: ReloadRequest) => Promise<{ reloaded: boolean }>;
		startRecoveredClientInputs: () => Promise<void>;
	};
	editor: { getText: () => string };
	createProjectTrustContext: (cwd: string) => unknown;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: FatalOptions) => Promise<void>;
};

type GrantContext = AbsorbContext & {
	drainViewer: { finish: (message?: string) => void } | undefined;
	drainViewerFeedId: string | undefined;
	absorbRemoteSessionChangesFromDisk: (this: AbsorbContext, sessionId: string) => Promise<void>;
	renderCurrentSessionState: () => void;
	showStatus: (message: string) => void;
	ui: { requestRender: () => void };
};

type SubmitContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { addToHistory?: (text: string) => void; setText: (text: string) => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	pendingUserInputs: string[];
	isDrainViewerActive: () => boolean;
	handoffReloadsPending: number;
	showStatus: (message: string) => void;
};

type FatalContext = { showError: (message: string) => void; stop: () => void };

type InteractiveModePrivate = {
	absorbRemoteSessionChangesFromDisk(this: AbsorbContext, sessionId: string): Promise<void>;
	finishDrainViewerGrant(this: GrantContext, sessionId: string): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
	handleFatalRuntimeError(this: FatalContext, prefix: string, error: unknown, options?: FatalOptions): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function createGrantContext(overrides: { reloadGate?: Promise<void>; reloadError?: Error } = {}) {
	const reloadCurrentSessionFromStore = vi.fn(async (_options: ReloadRequest) => {
		await overrides.reloadGate;
		if (overrides.reloadError) throw overrides.reloadError;
		return { reloaded: true };
	});
	const handleFatalRuntimeError = vi.fn(async (_prefix: string, _error: unknown, _options?: FatalOptions) => {});
	const finish = vi.fn();
	const context: GrantContext = {
		handoffReloadsPending: 0,
		isShuttingDown: false,
		session: {
			sessionRef: { sessionId: "s-1" },
			reload: vi.fn(async () => {}),
		},
		runtimeHost: { reloadCurrentSessionFromStore, startRecoveredClientInputs: vi.fn(async () => {}) },
		editor: { getText: () => "typed while the phone turn ran" },
		createProjectTrustContext: vi.fn(),
		handleFatalRuntimeError,
		drainViewer: { finish },
		drainViewerFeedId: "feed-1",
		absorbRemoteSessionChangesFromDisk: interactiveModePrototype.absorbRemoteSessionChangesFromDisk,
		renderCurrentSessionState: vi.fn(),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn() },
	};
	return { context, reloadCurrentSessionFromStore, handleFatalRuntimeError, finish };
}

describe("regression #524: interactive handoff reload", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("holds input from the drain grant until the granted session finishes reloading", async () => {
		// The runtime reload waits out local work (runs, reviews) before it settles.
		const reloadGate = deferred();
		const { context, reloadCurrentSessionFromStore, handleFatalRuntimeError, finish } = createGrantContext({
			reloadGate: reloadGate.promise,
		});

		const grant = interactiveModePrototype.finishDrainViewerGrant.call(context, "s-1");

		// No gap between tearing down the viewer and holding input for the reload.
		expect(context.drainViewer).toBeUndefined();
		expect(finish).toHaveBeenCalledTimes(1);
		expect(context.handoffReloadsPending).toBe(1);
		expect(reloadCurrentSessionFromStore).toHaveBeenCalledWith({
			expectedSessionId: "s-1",
			projectTrustContextFactory: expect.any(Function),
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(context.handoffReloadsPending).toBe(1);
		expect(context.runtimeHost.startRecoveredClientInputs).not.toHaveBeenCalled();

		reloadGate.resolve();
		await grant;

		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(context.handoffReloadsPending).toBe(0);
		expect(context.runtimeHost.startRecoveredClientInputs).toHaveBeenCalledTimes(1);
	});

	it("treats a failed reload as fatal and hands over the unsent editor draft", async () => {
		const reloadError = new Error("store unavailable");
		const { context, handleFatalRuntimeError } = createGrantContext({ reloadError });

		await interactiveModePrototype.absorbRemoteSessionChangesFromDisk.call(context, "s-1");

		expect(handleFatalRuntimeError).toHaveBeenCalledWith(
			"Failed to reload the session after the daemon handoff",
			reloadError,
			{ unsentDraft: "typed while the phone turn ran" },
		);
		expect(context.session.reload).not.toHaveBeenCalled();
		expect(context.handoffReloadsPending).toBe(0);
	});

	it("leaves the exit to shutdown when the runtime is already being disposed", async () => {
		const { context, handleFatalRuntimeError } = createGrantContext({
			reloadError: new Error("Agent session runtime is no longer accepting structural operations"),
		});
		context.isShuttingDown = true;

		await interactiveModePrototype.absorbRemoteSessionChangesFromDisk.call(context, "s-1");

		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});

	it("keeps submitted text in the editor while a handoff reload is pending", async () => {
		const context: SubmitContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn(), setText: vi.fn() },
			session: { isCompacting: false, isStreaming: false, isBashRunning: false, prompt: vi.fn(async () => {}) },
			flushPendingBashComponents: vi.fn(),
			pendingUserInputs: [],
			isDrainViewerActive: () => false,
			handoffReloadsPending: 1,
			showStatus: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.(" follow-up after the handoff ");

		expect(context.editor.setText).toHaveBeenCalledWith("follow-up after the handoff");
		expect(context.showStatus).toHaveBeenCalledWith(
			"Loading the remote turn — input will stay in the editor until it finishes.",
		);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toEqual([]);
	});

	it("writes the unsent draft to stderr after stopping the TUI", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const context: FatalContext = { showError: vi.fn(), stop: vi.fn() };

		await interactiveModePrototype.handleFatalRuntimeError.call(context, "Failed", new Error("boom"), {
			unsentDraft: "  keep this text \n",
		});

		expect(context.showError).toHaveBeenCalledWith("Failed: boom");
		expect(write).toHaveBeenCalledWith("Unsent input (not submitted before volt exited):\nkeep this text\n");
		expect(vi.mocked(context.stop).mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
		expect(exit).toHaveBeenCalledWith(1);

		write.mockClear();
		await interactiveModePrototype.handleFatalRuntimeError.call(context, "Failed", new Error("boom"), {
			unsentDraft: "   ",
		});
		expect(write).not.toHaveBeenCalled();
	});
});
