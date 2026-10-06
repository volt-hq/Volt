import { type Component, Container, setKeybindings, Text, type TUI } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as SessionIntents from "../src/core/host/session-intents.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ReviewWorkflowHooks, ReviewWorkflowOptions, ReviewWorkflowResult } from "../src/core/review.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const reviewMocks = vi.hoisted(() => ({
	runReviewWorkflow: vi.fn<(options: ReviewWorkflowOptions) => Promise<ReviewWorkflowResult>>(),
}));

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/review.ts")>();
	return { ...actual, runReviewWorkflow: reviewMocks.runReviewWorkflow };
});

// The TUI opens the review session through its host's session intents.
const openNewSession = vi.hoisted(() => vi.fn());
vi.mock("../src/core/host/session-intents.ts", async (importOriginal) => ({
	...(await importOriginal<typeof SessionIntents>()),
	openNewSession,
}));

import { BorderedLoader } from "../src/modes/interactive/components/bordered-loader.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

interface ReviewContext {
	tuiHost: {
		conversation: {
			session: Record<string, unknown>;
			services: { agentDir: string };
			/** The conversation's work registry; the review runs as its `review` work. */
			work: object;
		};
		hostClient: object;
	};
	host: object;
	/** The TUI's `openNewSession` intent. */
	newSession: ReturnType<typeof vi.fn>;
	ui: TUI;
	editorContainer: Container;
	chatContainer: Container;
	pendingMessagesContainer: Container;
	renderCurrentConversation: ReturnType<typeof vi.fn>;
	refreshPlanningUi: ReturnType<typeof vi.fn>;
	editor: Text;
	footer: { setTransientUsage: ReturnType<typeof vi.fn> };
	activeInteractiveReview: boolean;
	createInlineSessionRenderer: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showError: ReturnType<typeof vi.fn>;
	activeView: { regularComponents: Component[]; fullscreenRoot: Component };
	conversationView: { regularComponents: Component[]; fullscreenRoot: Component };
	extensionSelector?: { handleInput(data: string): void };
}

function createContext(): ReviewContext {
	setKeybindings(KeybindingsManager.create());
	initTheme("dark", true);
	const editor = new Text("editor");
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	let focusedComponent: Component | null = editor;
	const ui = {
		terminal: { rows: 24 },
		requestRender: vi.fn(),
		setFocus: vi.fn((component: Component | null) => {
			focusedComponent = component;
		}),
		getFocusedComponent: vi.fn(() => focusedComponent),
		clear: vi.fn(),
		addChild: vi.fn(),
	} as unknown as TUI;
	const sessionManager = { getCwd: () => "/workspace" };
	const session = {
		isStreaming: false,
		isCompacting: false,
		modelRegistry: { authStorage: {} },
		settingsManager: {},
		sessionManager,
		resourceLoader: {},
	};
	const chatContainer = new Container();
	const view = { regularComponents: [editorContainer], fullscreenRoot: editorContainer };
	return Object.assign(Object.create(InteractiveMode.prototype), {
		tuiHost: {
			conversation: {
				session,
				services: { agentDir: "/workspace/.volt" },
				work: {},
			},
			hostClient: {},
		},
		host: {},
		// The review's progress is its work's: none reported here.
		workSource: { subscribe: () => () => undefined, items: () => [] },
		newSession: openNewSession,
		ui,
		editorContainer,
		chatContainer,
		pendingMessagesContainer: new Container(),
		// The transcript of the conversation the TUI shows, drawn afresh.
		renderCurrentConversation: vi.fn(async () => {
			chatContainer.clear();
			chatContainer.addChild(new Text("Seeded review findings"));
		}),
		refreshPlanningUi: vi.fn(),
		editor,
		footer: { setTransientUsage: vi.fn() },
		activeInteractiveReview: false,
		activeView: view,
		conversationView: view,
		pendingExtensionDialogs: new Set<() => void>(),
		createInlineSessionRenderer: vi.fn(() => ({ onSessionEvent: vi.fn(), dispose: vi.fn() })),
		showWarning: vi.fn(InteractiveMode.prototype.showWarning),
		showStatus: vi.fn(),
		showError: vi.fn(),
	}) as ReviewContext;
}

const runInteractiveReviewWorkflow = Reflect.get(InteractiveMode.prototype, "runInteractiveReviewWorkflow") as (
	this: ReviewContext,
	target: { kind: "uncommitted" },
	options: {
		tools: readonly string[];
		requireConfirmation: boolean;
		requireProjectTrust: boolean;
	},
) => Promise<ReviewWorkflowResult>;

const resolution = {
	description: "uncommitted changes",
	diffCommand: "git diff",
	identity: { kind: "uncommitted" as const, baseTree: "base", headTree: "head" },
	changedFiles: [],
	root: "/workspace",
	readFile: vi.fn(async () => undefined),
	listFiles: vi.fn(async () => []),
	search: vi.fn(),
	materializeHead: vi.fn(async () => "/tmp/review"),
	dispose: vi.fn(async () => {}),
};

function run(context: ReviewContext, requireConfirmation = false): Promise<ReviewWorkflowResult> {
	return runInteractiveReviewWorkflow.call(
		context,
		{ kind: "uncommitted" },
		{
			tools: [],
			requireConfirmation,
			requireProjectTrust: false,
		},
	);
}

const DIAGNOSTIC_RETENTION_WARNING = "Could not retain optional private review diagnostics.";

afterEach(() => {
	reviewMocks.runReviewWorkflow.mockReset();
	openNewSession.mockReset();
	vi.restoreAllMocks();
});

describe("InteractiveMode review workflow", () => {
	it.each(["handoff", "cancelled handoff", "cancelled review", "failed review"] as const)(
		"renders the local diagnostic warning once after %s settles",
		async (outcome) => {
			const context = createContext();
			context.chatContainer.addChild(new Text("Original session"));
			const completed: ReviewWorkflowResult = {
				status: "completed",
				resolution,
				findingsCount: 0,
				completionStatus: "complete",
				sessionSwitchCancelled: outcome === "cancelled handoff",
			};
			context.newSession.mockImplementationOnce(async () => {
				context.chatContainer.clear();
				context.chatContainer.addChild(new Text("Replacement session before render"));
				return { cancelled: false, sessionId: "review-session", seeded: true };
			});
			reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
				const hooks = await options.createHooks?.("review-work");
				try {
					await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
					await options.onDiagnosticRetentionWarning?.(DIAGNOSTIC_RETENTION_WARNING);
					expect(context.showWarning).not.toHaveBeenCalled();
					if (outcome === "failed review") throw new Error("Review failed.");
					if (outcome === "cancelled review") return { status: "cancelled", resolution };
					if (outcome === "handoff") await options.newSession();
					return completed;
				} finally {
					hooks?.cleanup?.();
				}
			});

			const result = await run(context);
			expect(result.status).toBe(outcome.endsWith("review") ? "cancelled" : "completed");
			expect(context.showWarning.mock.calls).toEqual([[DIAGNOSTIC_RETENTION_WARNING]]);
			const rendered = context.chatContainer.render(120).lines.map(stripAnsi).join("\n");
			expect(rendered.match(/Warning: Could not retain optional private review diagnostics\./g)).toHaveLength(1);
			if (outcome === "handoff") {
				expect(context.newSession).toHaveBeenCalledOnce();
				expect(context.renderCurrentConversation).toHaveBeenCalledOnce();
				expect(rendered).toContain("Seeded review findings");
				expect(rendered).not.toContain("Original session");
				expect(rendered).not.toContain("Replacement session before render");
				expect(rendered.indexOf("Warning:")).toBeGreaterThan(rendered.indexOf("Seeded review findings"));
			} else if (outcome === "cancelled handoff") {
				expect(context.renderCurrentConversation).not.toHaveBeenCalled();
				expect(rendered).toContain("Original session");
			} else {
				expect(context.renderCurrentConversation).toHaveBeenCalledOnce();
				expect(rendered).toContain("Seeded review findings");
				expect(rendered.indexOf("Warning:")).toBeGreaterThan(rendered.indexOf("Seeded review findings"));
			}
			expect(JSON.stringify(result)).not.toContain(DIAGNOSTIC_RETENTION_WARNING);
			expect(context.editorContainer.children).toEqual([context.editor]);
			expect(context.footer.setTransientUsage).toHaveBeenLastCalledWith(undefined);
			expect(context.activeInteractiveReview).toBe(false);
		},
	);

	it.each([false, true])(
		"contains a failed warning renderer after successful handoff (stderr throws=%s)",
		async (stderrThrows) => {
			const context = createContext();
			const privateError = "private-warning-renderer-error /private/path";
			context.showWarning.mockImplementationOnce(() => {
				throw new Error(privateError);
			});
			const stderrWarning = vi.spyOn(console, "warn").mockImplementation(() => {
				if (stderrThrows) throw new Error(privateError);
			});
			const completed: ReviewWorkflowResult = {
				status: "completed",
				resolution,
				findingsCount: 0,
				completionStatus: "complete",
				sessionSwitchCancelled: false,
			};
			reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
				await options.onDiagnosticRetentionWarning?.(DIAGNOSTIC_RETENTION_WARNING);
				return completed;
			});

			await expect(run(context)).resolves.toBe(completed);
			expect(context.showError).not.toHaveBeenCalled();
			expect(context.showWarning.mock.calls).toEqual([[DIAGNOSTIC_RETENTION_WARNING]]);
			expect(stderrWarning.mock.calls).toEqual([[`Warning: ${DIAGNOSTIC_RETENTION_WARNING}`]]);
			expect(context.activeInteractiveReview).toBe(false);
		},
	);

	it("installs and focuses the cancellable loader before preparation resolves", async () => {
		const context = createContext();
		let releasePreparation!: () => void;
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let hooksCreated!: () => void;
		const hooksReady = new Promise<void>((resolve) => {
			hooksCreated = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.("review-work");
			hooksCreated();
			await preparationGate;
			await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
			hooks?.cleanup?.();
			return { status: "cancelled", resolution };
		});

		const pending = run(context);
		await hooksReady;
		const loader = context.editorContainer.children[0];
		expect(loader).toBeInstanceOf(BorderedLoader);
		expect(context.ui.setFocus).toHaveBeenCalledWith(loader);
		expect(context.createInlineSessionRenderer).not.toHaveBeenCalled();

		releasePreparation();
		await pending;
		expect(context.createInlineSessionRenderer).toHaveBeenCalledOnce();
		expect(context.editorContainer.children).toEqual([context.editor]);
	});

	it("shows the review's progress and accounting from its live work value, as every client sees it", async () => {
		const context = createContext();
		const listeners = new Set<() => void>();
		let live: object | undefined;
		Object.assign(context, {
			workSource: {
				subscribe: (listener: () => void) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				items: () => (live ? [{ item: { workId: "review-work" }, live }] : []),
			},
		});
		const report = (value: object) => {
			live = { kind: "work", workId: "review-work", ...value };
			for (const listener of listeners) listener();
		};
		const shown = () => stripAnsi(context.editorContainer.render(120).lines.join("\n"));
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.("review-work");
			report({ progress: { text: "Resolving repository…" } });
			expect(shown()).toContain("Resolving repository…");
			await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
			report({
				progress: { text: "Discovery pass" },
				detail: {
					type: "keyValue",
					key: "review-usage",
					items: [{ key: "requests", label: "Requests", value: "2 (0 pending)" }],
				},
			});
			expect(shown()).toContain("Reviewing uncommitted changes with review-model… Discovery pass");
			expect(shown()).toContain("Requests: 2 (0 pending)");
			hooks?.cleanup?.();
			expect(listeners.size).toBe(0);
			return { status: "cancelled", resolution };
		});
		await run(context);
		expect(context.editorContainer.children).toEqual([context.editor]);
	});

	it("reattaches and focuses the loader after accepting review confirmation", async () => {
		const context = createContext();
		let loader!: BorderedLoader;
		let releasePrepared!: () => void;
		const preparedGate = new Promise<void>((resolve) => {
			releasePrepared = resolve;
		});
		let prepared!: () => void;
		const preparedReady = new Promise<void>((resolve) => {
			prepared = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			expect(options.requireConfirmation).toBe(true);
			const hooks = await options.createHooks?.("review-work");
			loader = context.editorContainer.children[0] as BorderedLoader;
			const confirmed = await options.confirm?.({
				title: "Review changes",
				message: "Confirm rerun",
				resolution,
			});
			expect(confirmed).toBe(true);
			await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
			prepared();
			await preparedGate;
			hooks?.cleanup?.();
			return { status: "cancelled", resolution };
		});

		const pending = run(context, true);
		await vi.waitFor(() => expect(context.extensionSelector).toBeDefined());
		context.extensionSelector?.handleInput("\n");
		await preparedReady;

		// The loader, then the review work's detail (empty until the work reports it).
		expect(context.editorContainer.children[0]).toBe(loader);
		expect(context.editorContainer.children).toHaveLength(2);
		expect(context.editorContainer.children[1]?.render(80).lines).toEqual([]);
		expect(context.ui.setFocus).toHaveBeenLastCalledWith(loader);
		expect(context.createInlineSessionRenderer).toHaveBeenCalledOnce();

		releasePrepared();
		await pending;
		expect(context.editorContainer.children).toEqual([context.editor]);
	});

	it("dismisses review confirmation when the workflow signal is aborted", async () => {
		const context = createContext();
		const controller = new AbortController();
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.("review-work");
			const confirmed = await options.confirm?.({
				title: "Review changes",
				message: "Confirm rerun",
				resolution,
				signal: controller.signal,
			});
			expect(confirmed).toBe(false);
			hooks?.cleanup?.();
			return { status: "cancelled", resolution };
		});

		const pending = run(context, true);
		await vi.waitFor(() => expect(context.extensionSelector).toBeDefined());
		controller.abort();
		await pending;

		expect(context.extensionSelector).toBeUndefined();
		expect(context.editorContainer.children).toEqual([context.editor]);
		expect(context.ui.setFocus).toHaveBeenLastCalledWith(context.editor);
	});

	it("Escape aborts preparation, restores the editor, and prevents promotion or inference", async () => {
		const context = createContext();
		let hooks: ReviewWorkflowHooks | undefined;
		let inferenceCalls = 0;
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			hooks = await options.createHooks?.("review-work");
			await new Promise<void>((resolve) => {
				if (hooks?.signal?.aborted) resolve();
				else hooks?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			if (!hooks?.signal?.aborted) {
				await hooks?.onPrepared?.(resolution, { id: "review-model" } as never);
				inferenceCalls++;
			}
			hooks?.cleanup?.();
			return { status: "cancelled" };
		});

		const pending = run(context);
		await vi.waitFor(() => expect(context.editorContainer.children[0]).toBeInstanceOf(BorderedLoader));
		const loader = context.editorContainer.children[0] as BorderedLoader;
		loader.handleInput("\u001b");
		await pending;

		expect(hooks?.signal?.aborted).toBe(true);
		expect(context.createInlineSessionRenderer).not.toHaveBeenCalled();
		expect(inferenceCalls).toBe(0);
		expect(context.footer.setTransientUsage).toHaveBeenLastCalledWith(undefined);
		expect(context.editorContainer.children).toEqual([context.editor]);
		expect(context.ui.setFocus).toHaveBeenLastCalledWith(context.editor);
	});

	it("starts a TUI review as the conversation's review work", async () => {
		const context = createContext();
		reviewMocks.runReviewWorkflow.mockResolvedValueOnce({ status: "cancelled" });

		await run(context);
		expect(reviewMocks.runReviewWorkflow).toHaveBeenCalledOnce();
		expect(reviewMocks.runReviewWorkflow.mock.calls[0]?.[0].work).toBe(context.tuiHost.conversation.work);
	});

	it("rejects a duplicate local start while the first review is active", async () => {
		const context = createContext();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		reviewMocks.runReviewWorkflow.mockImplementationOnce(async (options) => {
			const hooks = await options.createHooks?.("review-work");
			await gate;
			hooks?.cleanup?.();
			return { status: "cancelled" };
		});

		const first = run(context);
		await vi.waitFor(() => expect(context.activeInteractiveReview).toBe(true));
		await expect(run(context)).resolves.toEqual({ status: "cancelled" });
		expect(reviewMocks.runReviewWorkflow).toHaveBeenCalledOnce();
		expect(context.showWarning).toHaveBeenCalledWith(
			"A review is already running. Cancel it before starting another.",
		);

		release();
		await first;
		expect(context.activeInteractiveReview).toBe(false);
	});
});
