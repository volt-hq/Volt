/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

import type {
	AgentMessage,
	AgentToolResult,
	AgentToolUpdateCallback,
	ThinkingLevel,
	ToolExecutionMode,
} from "@hansjm10/volt-agent-core";
import type {
	Api,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	ImageContent,
	JsonCompatibleInput,
	JsonObject,
	JsonValue,
	Model,
	OAuthCredentials,
	OAuthLoginCallbacks,
	PromptCacheMetadata,
	SimpleStreamOptions,
	SubscriptionUsageFetchOptions,
	SubscriptionUsageResult,
	TextContent,
	ToolResultMessage,
} from "@hansjm10/volt-ai";
import type {
	ExtensionManifest,
	ExtensionSettingsScope,
	RemoteCapability,
	UiNode,
	UiNodeFormField,
	UiNodeStyledText,
	UiNodeToken,
	WorkDelivery,
	WorkProgress,
	WorkResult,
} from "@hansjm10/volt-protocol";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	Component,
	EditorComponent,
	EditorTheme,
	KeyId,
	OverlayHandle,
	OverlayOptions,
	TUI,
} from "@hansjm10/volt-tui";
import type { Static, TObject, TSchema } from "typebox";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { EventBus } from "../event-bus.ts";
import type { ExecOptions, ExecResult } from "../exec.ts";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.ts";
import type { KeybindingsManager } from "../keybindings.ts";
import type { CustomMessage, CustomMessageInput } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ReadonlySessionManager,
	SessionEntry,
	SessionReference,
} from "../session-manager.ts";
import type { ExtensionSessionWriter } from "../session-writer.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SourceInfo } from "../source-info.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import type { Theme } from "../theme/runtime.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { EditToolDetails } from "../tools/edit.ts";
import type {
	BashToolDetails,
	BashToolInput,
	EditToolInput,
	FindToolDetails,
	FindToolInput,
	GrepToolDetails,
	GrepToolInput,
	LsToolDetails,
	LsToolInput,
	ReadToolDetails,
	ReadToolInput,
	WebFetchToolDetails,
	WebFetchToolInput,
	WebSearchToolDetails,
	WebSearchToolInput,
	WriteToolDetails,
	WriteToolInput,
} from "../tools/index.ts";

import type { ExtensionHandlerRegistry, PolicyRegistration } from "./policy-registration.ts";
import type { ExtensionSettingsRuntime, ExtensionSettingValue } from "./settings.ts";

export type { PolicyRegistration } from "./policy-registration.ts";

import type {
	ExtensionOperationEvent,
	ExtensionOperationOrigin,
	ExtensionServicesContext,
	ExtensionServicesStatus,
	RequestBoundaryEvent,
} from "./services-types.ts";

export type { ExecOptions, ExecResult } from "../exec.ts";
export type { BuildSystemPromptOptions } from "../system-prompt.ts";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.ts";

// ============================================================================
// UI Context
// ============================================================================

/**
 * Rejection of `ctx.ui.custom()` when Volt removes the component before it calls `done()`,
 * for example when the session is replaced, reloaded, or ends.
 */
export class ExtensionUIDismissedError extends Error {
	constructor() {
		super("Extension UI was dismissed by the host before it completed");
		this.name = "ExtensionUIDismissedError";
	}
}

/** Options for extension UI dialogs. */
export interface ExtensionUIDialogOptions {
	/** AbortSignal to programmatically dismiss the dialog. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
	timeout?: number;
}

/**
 * Text with semantic styling: a string, or styled spans. ANSI styling in a
 * string becomes semantic tokens on the host; other terminal controls are
 * removed.
 */
export type StyledText = UiNodeStyledText;

/** Where a panel shows. Clients without a sidebar show `sidebar` panels above the editor. */
export type ExtensionPanelPlacement = "aboveEditor" | "belowEditor" | "sidebar";

/**
 * A named panel: UI data an extension shows beside the conversation. Every
 * client renders it; actions and forms in it may send only the extension's own
 * intents and commands, and `open_work`/`cancel_work` for its own work.
 */
export interface ExtensionPanel {
	title?: StyledText;
	/** Defaults to `aboveEditor`. */
	placement?: ExtensionPanelPlacement;
	node: UiNode;
}

/** A dialog button: choosing it answers the dialog with its id. */
export interface ExtensionDialogAction {
	id: string;
	label: string;
	token?: UiNodeToken;
	destructive?: boolean;
}

/** A dialog: a title, UI data, and the buttons that answer it. */
export interface ExtensionDialog {
	title: string;
	body?: UiNode[];
	actions: ExtensionDialogAction[];
}

/** A form: string, boolean, enum, and integer fields every client renders and validates. */
export interface ExtensionForm {
	title: string;
	fields: UiNodeFormField[];
}

/** The values a submitted form holds, by field id; fields left empty are absent. */
export type ExtensionFormValues = Record<string, string | boolean | number>;

/** Placement for extension widgets. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for extension widgets. */
export interface ExtensionWidgetOptions {
	/** Where the widget is rendered. Defaults to "aboveEditor". */
	placement?: WidgetPlacement;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
export interface WorkingIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
	/** Show a selector and return the user's choice. */
	select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a confirmation dialog. */
	confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

	/** Show a text input dialog. */
	input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/**
	 * Show a form: resolves with the submitted values, or undefined when the
	 * form was dismissed, timed out, or no client shows forms.
	 */
	form(form: ExtensionForm, opts?: ExtensionUIDialogOptions): Promise<ExtensionFormValues | undefined>;

	/**
	 * Show a dialog: resolves with the id of the action chosen, or undefined
	 * when it was dismissed, timed out, or no client shows dialogs.
	 */
	dialog(dialog: ExtensionDialog, opts?: ExtensionUIDialogOptions): Promise<string | undefined>;

	/** Show a notification to the user. */
	notify(message: StyledText, type?: "info" | "warning" | "error"): void;

	/**
	 * Show, replace, or (with undefined) remove the panel `name` (1 to 128
	 * characters). A panel's node is at most 32 KB of JSON; an extension shows
	 * at most 16 panels.
	 */
	setPanel(name: string, panel: ExtensionPanel | undefined): void;

	/** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
	onTerminalInput(handler: TerminalInputHandler): () => void;

	/**
	 * Set the status item `key` (1 to 128 characters) in the footer, or clear it
	 * with undefined. Its text is at most 1 KB of JSON; an extension sets at
	 * most 32 status items.
	 */
	setStatus(key: string, text: StyledText | undefined): void;

	/** Set the working/loading message shown during streaming. Call with no argument to restore default. */
	setWorkingMessage(message?: string): void;

	/** Show or hide the built-in interactive working loader row during streaming. */
	setWorkingVisible(visible: boolean): void;

	/**
	 * Configure the interactive working indicator shown during streaming.
	 *
	 * - Omit the argument to restore the default animated spinner.
	 * - Use `frames: ["●"]` for a static indicator.
	 * - Use `frames: []` to hide the indicator entirely.
	 * - Custom frames are rendered as provided, so extensions must add their own colors.
	 */
	setWorkingIndicator(options?: WorkingIndicatorOptions): void;

	/** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
	setHiddenThinkingLabel(label?: string): void;

	/**
	 * Set a widget to display above or below the editor. Accepts string array or component factory.
	 * A string array shows as the panel `key`, as `setPanel` does.
	 */
	setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
	setWidget(
		key: string,
		content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void;

	/** Set a custom footer component, or undefined to restore the built-in footer.
	 *
	 * The factory receives a FooterDataProvider for data not otherwise accessible:
	 * git branch and extension statuses from setStatus(). Token stats, model info,
	 * etc. are available via ctx.sessionManager and ctx.model.
	 */
	setFooter(
		factory:
			| ((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void;

	/** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
	setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;

	/** Set the terminal window/tab title. */
	setTitle(title: string): void;

	/** Show a custom component with keyboard focus. */
	custom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			/** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			/** Called with the overlay handle after the overlay is shown. Use to control visibility. */
			onHandle?: (handle: OverlayHandle) => void;
			/** Closes the component: the call rejects with `ExtensionUIDismissedError`. Disabling the extension closes it too. */
			signal?: AbortSignal;
		},
	): Promise<T>;

	/** Paste text into the editor of every interactive client, triggering paste handling (collapse for large content). */
	pasteToEditor(text: string): void;

	/** Set the text in the core input editor. */
	setEditorText(text: string): void;

	/**
	 * The text in the editor of the client the call runs for (outside any
	 * client's call, the conversation's first client); undefined when that
	 * client has no editor or does not answer within 2 seconds.
	 */
	getEditorText(): Promise<string | undefined>;

	/** Show a multi-line editor for text editing. */
	editor(title: string, prefill?: string): Promise<string | undefined>;

	/** Stack additional autocomplete behavior on top of the built-in provider. */
	addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

	/**
	 * Set a custom editor component via factory function.
	 * Pass undefined to restore the default editor.
	 *
	 * The factory receives:
	 * - `theme`: EditorTheme for styling borders and autocomplete
	 * - `keybindings`: KeybindingsManager for app-level keybindings
	 *
	 * For full app keybinding support (escape, ctrl+d, model switching, etc.),
	 * extend `CustomEditor` from `@hansjm10/volt-coding-agent` and call
	 * `super.handleInput(data)` for keys you don't handle.
	 *
	 * @example
	 * ```ts
	 * import { CustomEditor } from "@hansjm10/volt-coding-agent";
	 *
	 * class VimEditor extends CustomEditor {
	 *   private mode: "normal" | "insert" = "insert";
	 *
	 *   handleInput(data: string): void {
	 *     if (this.mode === "normal") {
	 *       // Handle vim normal mode keys...
	 *       if (data === "i") { this.mode = "insert"; return; }
	 *     }
	 *     super.handleInput(data);  // App keybindings + text editing
	 *   }
	 * }
	 *
	 * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
	 *   new VimEditor(tui, theme, keybindings)
	 * );
	 * ```
	 */
	setEditorComponent(factory: EditorFactory | undefined): void;

	/** Get the currently configured custom editor factory, or undefined when using the default editor. */
	getEditorComponent(): EditorFactory | undefined;

	/** Get the current theme for styling. */
	readonly theme: Theme;

	/** Get all available themes with their names and file paths. */
	getAllThemes(): { name: string; path: string | undefined }[];

	/** Load a theme by name without switching to it. Returns undefined if not found. */
	getTheme(name: string): Theme | undefined;

	/** Set the current theme by name or Theme object. */
	setTheme(theme: string | Theme): { success: boolean; error?: string };

	/** Get current tool output expansion state. */
	getToolsExpanded(): boolean;

	/** Set tool output expansion state. */
	setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface CompactOptions {
	customInstructions?: string;
	onComplete?: (result: CompactionResult) => void;
	onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
export type ExtensionMode = "tui" | "rpc" | "json" | "print";

export interface ExtensionContext {
	/** Optional managed services for this captured conversational scope; absent in policy/idle contexts. */
	readonly services?: ExtensionServicesContext;
	/** UI methods for user interaction */
	ui: ExtensionUIContext;
	/** Run mode of the client that opened the session. Use "tui" to guard terminal-only UI such as custom components. */
	mode: ExtensionMode;
	/** Whether dialog-capable UI is available (true in TUI and RPC modes) */
	hasUI: boolean;
	/** Current working directory */
	cwd: string;
	/** Session manager (read-only) */
	sessionManager: ReadonlySessionManager;
	/** Model registry for API key resolution */
	modelRegistry: ModelRegistry;
	/** Current model (may be undefined) */
	model: Model<any> | undefined;
	/** Whether the agent is idle (not streaming) */
	isIdle(): boolean;
	/** Whether project-local trust is active for this context. */
	isProjectTrusted(): boolean;
	/** The current abort signal, or undefined when the agent is not streaming. */
	signal: AbortSignal | undefined;
	/** Abort the current agent operation */
	abort(): void;
	/** Whether there are queued messages waiting */
	hasPendingMessages(): boolean;
	/** Gracefully shutdown volt and exit. Available in all contexts. */
	shutdown(): void;
	/** Get current context usage for the active model. */
	getContextUsage(): ContextUsage | undefined;
	/** Trigger compaction without awaiting completion. */
	compact(options?: CompactOptions): void;
	/** Get the current effective system prompt. */
	getSystemPrompt(): string;
	/**
	 * Start work of a kind this extension registered with `volt.registerWorkKind`:
	 * `run` executes in the background, and its progress, cancellation, and
	 * result reach every client. Resolves with the work id once the work is
	 * recorded. An extension starts only its own kinds.
	 */
	startWork(kind: string, options: StartWorkOptions, run: WorkRun): Promise<{ readonly workId: string }>;
}

// ============================================================================
// Work
// ============================================================================

/** A kind of work an extension runs (RFC §7): `volt.registerWorkKind(name, kind)`. */
export interface WorkKindDeclaration {
	/**
	 * What a completed or failed result does: `none` (the default), `message`
	 * (a notice the model sees with its next turn), or `wake` (the notice, and
	 * a turn when the conversation is idle).
	 */
	readonly delivery?: WorkDelivery;
	/** Whether a client may cancel the kind's work. Defaults to true. */
	readonly cancellable?: boolean;
	/** `false`: stopping the conversation's run (Escape, the `abort` intent) leaves the kind's work running. */
	readonly cancelOnAbort?: false;
	/** Most items of the kind running at once in the conversation: 1 by default, at most 8. */
	readonly maxActive?: number;
	/**
	 * Remote capabilities a paired device needs, beyond the intent's or query's
	 * own, to cancel the kind's work or read its output. A kind that requires
	 * any keeps its work running when the conversation's run stops, since a
	 * device without them may stop the run.
	 */
	readonly requires?: readonly RemoteCapability[];
}

/** Work to start: its one-line title, and the input the log keeps (JSON, at most 16 KB; `null` by default). */
export interface StartWorkOptions {
	readonly title: string;
	readonly input?: JsonValue;
}

/** What extension work reports through. Nothing else of the host reaches it. */
export interface WorkRunContext {
	readonly workId: string;
	/** Aborted when the work is cancelled, its extension reloads, or the conversation closes. */
	readonly signal: AbortSignal;
	/** Fine-grained progress, which clients see live. */
	progress(progress: WorkProgress): void;
	/** A phase: live at once, and durable in the log as a coarse checkpoint at most every 10 seconds. */
	checkpoint(progress: WorkProgress): void;
	/** Output: its newest 50 KB become the result's output unless the result names its own. */
	output(text: string): void;
}

/** How extension work ended. A run that throws fails, or is cancelled when its signal aborted. */
export interface WorkRunResult {
	readonly outcome: "completed" | "failed" | "cancelled";
	/** A summary (at most 2,000 characters) the notice carries, output, and kind-specific data (JSON, at most 64 KB). */
	readonly result?: Omit<WorkResult, "child">;
	readonly error?: string;
	/**
	 * The notice text (at most 20,000 characters) the model sees after the
	 * line naming the work, instead of the summary, when a `message` or `wake`
	 * kind completes or fails. Paired devices see the title and summary.
	 */
	readonly notice?: string;
}

/** Extension work: runs in the background until it returns how it ended. */
export type WorkRun = (ctx: WorkRunContext) => Promise<WorkRunResult>;

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
	/**
	 * Aborted when this command's session ends: it loses its log (a write could not be
	 * confirmed as saved) or is disposed, including replacement by newSession, fork, or
	 * switchSession. Unlike event-handler contexts, it is always defined and is not the agent
	 * run's signal.
	 */
	signal: AbortSignal;

	/** Get the current base system-prompt construction options. */
	getSystemPromptOptions(): BuildSystemPromptOptions;

	/** Wait for the agent to finish streaming */
	waitForIdle(): Promise<void>;

	/**
	 * Start a new session, optionally with initialization, and move the client
	 * whose command called it there. Resolves with the new session's id.
	 */
	newSession(options?: {
		parentSessionRef?: SessionReference;
		/** Write the new session before it opens, such as entries to seed it with. */
		setup?: (writer: ExtensionSessionWriter) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<SessionIntentResult>;

	/** Fork from a specific entry into a new persisted session and move the invoking client there. */
	fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<SessionIntentResult>;

	/** Navigate to a different point in the session tree. */
	navigateTree(
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ cancelled: boolean }>;

	/** Switch to a different persisted session and move the invoking client there. */
	switchSession(
		sessionRef: SessionReference,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<SessionIntentResult>;

	/** Reload extensions, skills, prompts, and themes. */
	reload(): Promise<void>;
}

/**
 * The outcome of a session intent (`newSession`, `fork`, `switchSession`).
 *
 * - `cancelled: true`: the session did not change, because an extension
 *   cancelled it or no client handles session changes; no `withSession`
 *   callback ran.
 * - `cancelled: false`: `sessionId` is the session the invoking client is on
 *   now (the current one for a switch to itself). `seeded` is `true` only when
 *   the requested `withSession` callback ran to completion; it is `false` when
 *   none was requested, for a switch to the current session, and when the
 *   callback was skipped because recovered durable client input failed to
 *   replay into the new session.
 */
export type SessionIntentResult =
	| { cancelled: true }
	| {
			cancelled: false;
			sessionId: string;
			seeded: boolean;
	  };

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
	sendMessage<T>(
		message: CustomMessageInput<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;

	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded */
	expanded: boolean;
	/** Whether this is a partial/streaming result */
	isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether inline images are currently shown in the TUI. */
	showImages: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
}

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown, TState = any> {
	/** Tool name (used in LLM tool calls) */
	name: string;
	/** Human-readable label for UI */
	label: string;
	/** Description for LLM */
	description: string;
	/** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
	promptSnippet?: string;
	/** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
	promptGuidelines?: string[];
	/** Parameter schema (TypeBox) */
	parameters: TParams;
	/** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
	renderShell?: "default" | "self";
	/** Set when renderCall/renderResult already display the tool's execution duration (like the built-in bash tool). Suppresses the generic duration suffix in the tool header. */
	rendersDuration?: boolean;

	/** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
	prepareArguments?: (args: unknown) => Static<TParams>;

	/**
	 * Per-tool execution mode override.
	 * - "sequential": this tool must execute one at a time with other tool calls.
	 * - "parallel": this tool can execute concurrently with other tool calls.
	 *
	 * If omitted, the default execution mode applies.
	 */
	executionMode?: ToolExecutionMode;

	/** Execute the tool. Final details and all streamed updates must contain only JSON-compatible data. */
	execute(
		toolCallId: string,
		params: Static<TParams>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<TDetails>>;

	/** Custom rendering for tool call display */
	renderCall?: (args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>) => Component;

	/** Custom rendering for tool result display */
	renderResult?: (
		result: AgentToolResult<TDetails>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<TState, Static<TParams>>,
	) => Component;

	/**
	 * Release renderer resources held in the shared render state (e.g. repaint
	 * timers) when the host discards the tool row before a terminal render.
	 * Must be idempotent.
	 */
	disposeRenderState?: (state: TState) => void;
}

type AnyToolDefinition = ToolDefinition<any, any, any>;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
	tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
	return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// Startup/Resource Events
// ============================================================================

export interface ProjectTrustEvent {
	type: "project_trust";
	cwd: string;
}

export type ProjectTrustEventDecision = "yes" | "no" | "undecided";

export interface ProjectTrustEventResult {
	trusted: ProjectTrustEventDecision;
	remember?: boolean;
}

export interface ProjectTrustContext {
	cwd: string;
	mode: ExtensionMode;
	hasUI: boolean;
	ui: Pick<ExtensionUIContext, "select" | "confirm" | "input" | "notify">;
}

export type ProjectTrustHandler = (
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
) => Promise<ProjectTrustEventResult> | ProjectTrustEventResult;

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
	type: "resources_discover";
	cwd: string;
	reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded, and to one extension when it is enabled at runtime */
export interface SessionStartEvent {
	type: "session_start";
	/** Why this session start happened; `enable`: the extension was just enabled in a running session. */
	reason: "startup" | "reload" | "new" | "resume" | "fork" | "enable";
	/** Previously active persisted session. Present for "new", "resume", and "fork". */
	previousSessionRef?: SessionReference;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
	type: "session_before_switch";
	reason: "new" | "resume";
	targetSessionRef?: SessionReference;
}

/** Fired before forking a session (can be cancelled) */
export interface SessionBeforeForkEvent {
	type: "session_before_fork";
	entryId: string;
	position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
	type: "session_before_compact";
	preparation: CompactionPreparation;
	branchEntries: SessionEntry[];
	customInstructions?: string;
	/** What triggered compaction: `/compact`, the context threshold, or context overflow recovery. */
	reason: "manual" | "threshold" | "overflow";
	/** Whether the interrupted turn resumes after compaction (overflow retry or threshold continuation). */
	willRetry: boolean;
	signal: AbortSignal;
}

/** Fired after context compaction */
export interface SessionCompactEvent {
	type: "session_compact";
	compactionEntry: CompactionEntry;
	fromExtension: boolean;
	/** What triggered compaction: `/compact`, the context threshold, or context overflow recovery. */
	reason: "manual" | "threshold" | "overflow";
	/** Whether the interrupted turn resumes after compaction (overflow retry or threshold continuation). */
	willRetry: boolean;
}

/**
 * Fired before an extension runtime is torn down due to quit, reload, or
 * session replacement, and to one extension when it is disabled at runtime.
 */
export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork" | "disable";
	/** Destination persisted session when shutting down due to session replacement. */
	targetSessionRef?: SessionReference;
}

/** Preparation data for tree navigation */
export interface TreePreparation {
	targetId: string;
	oldLeafId: string | null;
	commonAncestorId: string | null;
	entriesToSummarize: SessionEntry[];
	userWantsSummary: boolean;
	/** Custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Label to attach to the branch summary entry */
	label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
	type: "session_before_tree";
	preparation: TreePreparation;
	signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
	type: "session_tree";
	newLeafId: string | null;
	oldLeafId: string | null;
	summaryEntry?: BranchSummaryEntry;
	fromExtension?: boolean;
}

/**
 * Fired to one extension when it becomes active in a conversation, before its
 * `session_start`: the conversation started with it (`startup`), it was
 * enabled at runtime (`enable`), or the extensions reloaded (`reload`).
 */
export interface ActivateEvent {
	type: "activate";
	reason: "startup" | "enable" | "reload";
}

/**
 * Fired to one extension after its `session_shutdown` when it stops running
 * in a conversation: it was disabled at runtime (`disable`) or the extensions
 * reloaded (`reload`). Its tools, commands, intents, shortcuts, completion
 * providers, providers, UI, and work are removed afterwards, and its `volt`
 * and contexts stop working.
 */
export interface DeactivateEvent {
	type: "deactivate";
	reason: "disable" | "reload";
}

export type SessionEvent =
	| SessionStartEvent
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionBeforeCompactEvent
	| SessionCompactEvent
	| SessionShutdownEvent
	| SessionBeforeTreeEvent
	| SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
	type: "before_provider_request";
	payload: unknown;
}

/** Fired after a provider response is received and before the response stream is consumed. */
export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
	type: "before_agent_start";
	/** The raw user prompt text (after expansion). */
	prompt: string;
	/** Images attached to the user prompt, if any. */
	images?: ImageContent[];
	/** The fully assembled system prompt string. */
	systemPrompt: string;
	/** Structured options used to build the system prompt. Extensions can inspect this to understand what Volt loaded without re-discovering resources. */
	systemPromptOptions: BuildSystemPromptOptions;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
	type: "agent_end";
	messages: AgentMessage[];
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
	type: "turn_end";
	turnIndex: number;
	message: AgentMessage;
	toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
	type: "message_start";
	message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
	type: "message_update";
	message: AgentMessage;
	assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
	type: "message_end";
	message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolCallId: string;
	toolName: string;
	args: JsonObject;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolCallId: string;
	toolName: string;
	args: JsonObject;
	partialResult: AgentToolResult<JsonValue | undefined>;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolCallId: string;
	toolName: string;
	result: AgentToolResult<JsonValue | undefined>;
	isError: boolean;
}

// ============================================================================
// Model Events
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
	type: "model_select";
	model: Model<any>;
	previousModel: Model<any> | undefined;
	source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
	type: "thinking_level_select";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
	type: "user_bash";
	/** The command to execute */
	command: string;
	/** True if !! prefix was used (excluded from LLM context) */
	excludeFromContext: boolean;
	/** Current working directory */
	cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Source of user input */
export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
	type: "input";
	/** The input text */
	text: string;
	/** Attached images, if any */
	images?: ImageContent[];
	/** Where the input came from */
	source: InputSource;
	/** How the input will be delivered during streaming, or undefined when idle */
	streamingBehavior?: "steer" | "followUp";
}

/** Result from input event handler */
export type InputEventResult =
	| { action: "continue" }
	| { action: "transform"; text: string; images?: ImageContent[] }
	| { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
	type: "tool_call";
	toolCallId: string;
	/** Host-owned attribution; absent on ordinary foreground calls is equivalent to agent. */
	origin?: ExtensionOperationOrigin;
}

export interface BashToolCallEvent extends ToolCallEventBase {
	toolName: "bash";
	input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
	toolName: "read";
	input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
	toolName: "edit";
	input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
	toolName: "write";
	input: WriteToolInput;
}

export interface WebSearchToolCallEvent extends ToolCallEventBase {
	toolName: "web_search";
	input: WebSearchToolInput;
}

export interface WebFetchToolCallEvent extends ToolCallEventBase {
	toolName: "web_fetch";
	input: WebFetchToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
	toolName: "grep";
	input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
	toolName: "find";
	input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
	toolName: "ls";
	input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
	toolName: string;
	input: JsonObject;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent =
	| BashToolCallEvent
	| ReadToolCallEvent
	| EditToolCallEvent
	| WriteToolCallEvent
	| WebSearchToolCallEvent
	| WebFetchToolCallEvent
	| GrepToolCallEvent
	| FindToolCallEvent
	| LsToolCallEvent
	| CustomToolCallEvent;

interface ToolResultEventBase {
	type: "tool_result";
	toolCallId: string;
	/** Host-owned attribution, never supplied by a tool result. */
	origin?: ExtensionOperationOrigin;
	input: JsonObject;
	content: (TextContent | ImageContent)[];
	isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
	toolName: "bash";
	details?: BashToolDetails;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
	toolName: "read";
	details?: ReadToolDetails;
}

export interface EditToolResultEvent extends ToolResultEventBase {
	toolName: "edit";
	details?: EditToolDetails;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
	toolName: "write";
	details?: WriteToolDetails;
}

export interface WebSearchToolResultEvent extends ToolResultEventBase {
	toolName: "web_search";
	details?: WebSearchToolDetails;
}

export interface WebFetchToolResultEvent extends ToolResultEventBase {
	toolName: "web_fetch";
	details?: WebFetchToolDetails;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
	toolName: "grep";
	details?: GrepToolDetails;
}

export interface FindToolResultEvent extends ToolResultEventBase {
	toolName: "find";
	details?: FindToolDetails;
}

export interface LsToolResultEvent extends ToolResultEventBase {
	toolName: "ls";
	details?: LsToolDetails;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
	toolName: string;
	details?: JsonValue;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
	| BashToolResultEvent
	| ReadToolResultEvent
	| EditToolResultEvent
	| WriteToolResultEvent
	| WebSearchToolResultEvent
	| WebFetchToolResultEvent
	| GrepToolResultEvent
	| FindToolResultEvent
	| LsToolResultEvent
	| CustomToolResultEvent;

// Type guards for ToolResultEvent
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
	return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
	return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
	return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
	return e.toolName === "write";
}
export function isWebSearchToolResult(e: ToolResultEvent): e is WebSearchToolResultEvent {
	return e.toolName === "web_search";
}
export function isWebFetchToolResult(e: ToolResultEvent): e is WebFetchToolResultEvent {
	return e.toolName === "web_fetch";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
	return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
	return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
	return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(toolName: "bash", event: ToolCallEvent): event is BashToolCallEvent;
export function isToolCallEventType(toolName: "read", event: ToolCallEvent): event is ReadToolCallEvent;
export function isToolCallEventType(toolName: "edit", event: ToolCallEvent): event is EditToolCallEvent;
export function isToolCallEventType(toolName: "write", event: ToolCallEvent): event is WriteToolCallEvent;
export function isToolCallEventType(toolName: "web_search", event: ToolCallEvent): event is WebSearchToolCallEvent;
export function isToolCallEventType(toolName: "web_fetch", event: ToolCallEvent): event is WebFetchToolCallEvent;
export function isToolCallEventType(toolName: "grep", event: ToolCallEvent): event is GrepToolCallEvent;
export function isToolCallEventType(toolName: "find", event: ToolCallEvent): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
	toolName: TName,
	event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
	return event.toolName === toolName;
}

// ============================================================================
// Settings Events
// ============================================================================

/** Settings as `volt.settings` holds them: values by setting name. */
export type ExtensionSettingsShape = { readonly [name: string]: ExtensionSettingValue | undefined };

/**
 * Fired to one extension when its effective settings change: through
 * `volt.updateSettings`, the `set_extension_settings` intent from any client,
 * or a settings reload. `scope` is where the stored values changed.
 */
export interface SettingsChangedEvent<TSettings extends ExtensionSettingsShape = ExtensionSettingsShape> {
	type: "settings_changed";
	settings: TSettings;
	previous: TSettings;
	scope: ExtensionSettingsScope;
}

/** Union of all event types */
export type ExtensionEvent =
	| RequestBoundaryEvent
	| ExtensionOperationEvent
	| ProjectTrustEvent
	| ResourcesDiscoverEvent
	| SessionEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| AfterProviderResponseEvent
	| BeforeAgentStartEvent
	| AgentStartEvent
	| AgentEndEvent
	| TurnStartEvent
	| TurnEndEvent
	| MessageStartEvent
	| MessageUpdateEvent
	| MessageEndEvent
	| ToolExecutionStartEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionEndEvent
	| ModelSelectEvent
	| ThinkingLevelSelectEvent
	| UserBashEvent
	| InputEvent
	| ToolCallEvent
	| ToolResultEvent
	| SettingsChangedEvent
	| ActivateEvent
	| DeactivateEvent;

/** Keyed by `ExtensionEvent["type"]`, so a name missing from or added beyond the union fails to compile. */
const EXTENSION_EVENTS: { readonly [Name in ExtensionEvent["type"]]: true } = {
	request_boundary: true,
	extension_operation: true,
	project_trust: true,
	resources_discover: true,
	session_start: true,
	session_before_switch: true,
	session_before_fork: true,
	session_before_compact: true,
	session_compact: true,
	session_shutdown: true,
	session_before_tree: true,
	session_tree: true,
	context: true,
	before_provider_request: true,
	after_provider_response: true,
	before_agent_start: true,
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	model_select: true,
	thinking_level_select: true,
	user_bash: true,
	input: true,
	tool_call: true,
	tool_result: true,
	settings_changed: true,
	activate: true,
	deactivate: true,
};

/** Every event `volt.on()` subscribes to. It throws for any other name. */
export const EXTENSION_EVENT_NAMES = Object.freeze(Object.keys(EXTENSION_EVENTS) as ExtensionEvent["type"][]);

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
	messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
	/** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
	block?: boolean;
	reason?: string;
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
	/** Custom operations to use for execution */
	operations?: BashOperations;
	/** Full replacement: extension handled execution, use this result */
	result?: BashResult;
}

export interface ToolResultEventResult {
	content?: (TextContent | ImageContent)[];
	/** Replacement details must contain only JSON-compatible data. */
	details?: JsonValue;
	isError?: boolean;
}

export interface MessageEndEventResult {
	/** Replace the finalized message. The replacement must keep the original message role. */
	message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
	message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
	/** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
	systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
	cancel?: boolean;
}

export interface SessionBeforeForkResult {
	cancel?: boolean;
	skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
	cancel?: boolean;
	compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
	cancel?: boolean;
	summary?: {
		summary: string;
		details?: JsonValue;
	};
	/** Override custom instructions for summarization */
	customInstructions?: string;
	/** Override whether customInstructions replaces the default prompt */
	replaceInstructions?: boolean;
	/** Override label to attach to the branch summary entry */
	label?: string;
}

// ============================================================================
// Message Rendering
// ============================================================================

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = JsonValue> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
	name: string;
	sourceInfo: SourceInfo;
	description?: string;
	/** Explicit host opt-in for invocation by an authorized remote RPC client. Defaults to false. */
	remoteSafe?: boolean;
	getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

// ============================================================================
// Intents, shortcuts, and completions
// ============================================================================

/**
 * An intent an extension registers: clients invoke it as
 * `extension.intent.<manifest id>.<name>`, from UI actions and forms, the
 * extension's shortcuts, or any protocol client.
 */
export interface ExtensionIntentOptions<TInput extends TObject = TObject> {
	label: string;
	description?: string;
	/** The input, a TypeBox object schema; the host rejects other input before `handler` runs. Defaults to no fields. */
	input?: TInput;
	/**
	 * Paired remote devices may invoke it. Defaults to false. They also need
	 * `conversation.control.v1` and every capability in `requires`.
	 */
	remote?: boolean;
	/** Remote capabilities an invocation needs beyond `conversation.control.v1`. */
	requires?: readonly RemoteCapability[];
	/** Runs the intent in the extension's command context; a throw rejects it as `failed`. */
	handler: (input: Static<TInput>, ctx: ExtensionCommandContext) => Promise<void> | void;
}

/** An intent an extension registered, as its extension record keeps it. */
export interface RegisteredIntent {
	/** The name within the extension. */
	readonly name: string;
	/** The intent name clients invoke: `extension.intent.<manifest id>.<name>`. */
	readonly intent: string;
	readonly label: string;
	readonly description?: string;
	readonly input: TObject;
	readonly remote: boolean;
	readonly requires: readonly RemoteCapability[];
	readonly handler: (input: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
	/** The manifest id of the extension that registered it: its handler's `ctx` belongs to it. */
	readonly extensionId: string;
}

/** What an editor completion offers: `value` replaces the token, shown as `label` with `description`. */
export interface ExtensionCompletionItem {
	value: string;
	label?: string;
	description?: string;
}

/** What a completion provider is asked to complete. */
export interface ExtensionCompletionRequest {
	/** The editor's text. */
	readonly text: string;
	/** The cursor, in Unicode scalars from the start of `text`. */
	readonly cursor: number;
	/** The token before the cursor, starting with the provider's trigger. */
	readonly prefix: string;
	/** `prefix` without the trigger. */
	readonly query: string;
	/** Aborted once the host stops waiting (after 1 second) or the client moves on. */
	readonly signal: AbortSignal;
}

/**
 * An editor completion provider: asked when the token before the cursor starts
 * with its trigger. The host keeps at most 50 items and waits at most 1 second.
 */
export interface ExtensionCompletionProvider {
	/** What starts the token it completes, such as `#` or `@`: 1 to 8 characters without whitespace. */
	trigger: string;
	/** Paired remote devices may ask it. Defaults to false. */
	remote?: boolean;
	complete(
		request: ExtensionCompletionRequest,
	): ExtensionCompletionItem[] | undefined | Promise<ExtensionCompletionItem[] | undefined>;
}

/** A completion provider an extension registered, as its extension record keeps it. */
export interface RegisteredCompletionProvider {
	readonly name: string;
	readonly trigger: string;
	readonly remote: boolean;
	readonly complete: ExtensionCompletionProvider["complete"];
	readonly extensionId: string;
}

export interface ResolvedCommand extends RegisteredCommand {
	/** The slash name: `name`, or `<extension id>:<name>` when an earlier extension took `name`. */
	invocationName: string;
	/** The manifest id of the extension that registered the command: its handler's `ctx` belongs to it. */
	extensionId: string;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions. `TSettings` types
 * `settings`: `ExtensionAPI<ExtensionSettingsOf<typeof manifest>>`.
 */
export interface ExtensionAPI<TSettings extends ExtensionSettingsShape = ExtensionSettingsShape> {
	// =========================================================================
	// Settings
	// =========================================================================

	/**
	 * The extension's effective settings, frozen: each declared default, then
	 * the user's global values, then a trusted project's values. Reading it
	 * again after `settings_changed` gives the new values.
	 */
	readonly settings: TSettings;

	/**
	 * Merge `values` over what `scope` (default `global`) stores for this
	 * extension; an `undefined` value clears that setting there. Rejects
	 * values the manifest does not declare or allow, and project writes in an
	 * untrusted project. Resolves once the settings are saved.
	 */
	updateSettings(
		values: { readonly [K in keyof TSettings]?: TSettings[K] | undefined },
		options?: { readonly scope?: ExtensionSettingsScope },
	): Promise<void>;

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Notification-only; promises are observed for errors but do not delay provider admission. */
	on(event: "request_boundary", handler: (event: RequestBoundaryEvent, ctx: ExtensionContext) => void): void;
	/** Diagnostic-only; managed execution is prohibited throughout the handler's async lineage. */
	on(event: "extension_operation", handler: (event: ExtensionOperationEvent, ctx: ExtensionContext) => void): void;
	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "resources_discover", handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(
		event: "session_before_switch",
		handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
	): void;
	on(event: "session_before_fork", handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>): void;
	on(
		event: "session_before_compact",
		handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
	): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
	on(
		event: "before_provider_request",
		handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
	): void;
	on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
	on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
	on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
	on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
	on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
	on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
	on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
	on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
	on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
	on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
	on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
	on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
	on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
	on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
	/** Owns the callback; use the returned handle to update, remove, or invalidate closure-state changes. */
	on(
		event: "tool_call",
		handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>,
	): PolicyRegistration<ExtensionHandler<ToolCallEvent, ToolCallEventResult>>;
	on(
		event: "tool_result",
		handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>,
	): PolicyRegistration<ExtensionHandler<ToolResultEvent, ToolResultEventResult>>;
	on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
	on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
	/** This extension's settings changed. */
	on(event: "settings_changed", handler: ExtensionHandler<SettingsChangedEvent<TSettings>>): void;
	/** This extension became active in the conversation; its `session_start` follows. */
	on(event: "activate", handler: ExtensionHandler<ActivateEvent>): void;
	/** This extension stops running in the conversation, after its `session_shutdown`. */
	on(event: "deactivate", handler: ExtensionHandler<DeactivateEvent>): void;

	// =========================================================================
	// Tool Registration
	// =========================================================================

	/** Register a tool that the LLM can call. */
	registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
		tool: ToolDefinition<TParams, TDetails, TState>,
	): void;

	// =========================================================================
	// Command, Shortcut, Flag Registration
	// =========================================================================

	/**
	 * Register a slash command: `name` is a letter or digit, then at most 63
	 * letters, digits, `_`, and `-`. Clients invoke it as the intent
	 * `extension.command.<manifest id>.<name>`. When an earlier extension took
	 * the name, the command is `/<manifest id>:<name>`.
	 */
	registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

	/**
	 * Register an intent: `name` is a letter or digit, then at most 63
	 * letters, digits, `_`, and `-`. Returns the intent's name,
	 * `extension.intent.<manifest id>.<name>`, which UI actions, forms, and
	 * shortcuts send.
	 */
	registerIntent<TInput extends TObject = TObject>(name: string, options: ExtensionIntentOptions<TInput>): string;

	/**
	 * Map a key to one of the extension's intents or commands: `intent` is a
	 * name `registerIntent` returned, an `extension.command.<manifest id>.<name>`,
	 * or the name of one of the extension's intents. The key is its default:
	 * users rebind it in keybindings.json under the intent's name. Pressing it
	 * invokes the intent with no input.
	 */
	registerShortcut(shortcut: KeyId, options: { description?: string; intent: string }): void;

	/** Register an editor completion provider: at most 8 per extension. */
	registerCompletionProvider(name: string, provider: ExtensionCompletionProvider): void;

	/** Register a CLI flag. */
	registerFlag(
		name: string,
		options: {
			description?: string;
			type: "boolean" | "string";
			default?: boolean | string;
		},
	): void;

	/** Get the value of a registered CLI flag. */
	getFlag(name: string): boolean | string | undefined;

	// =========================================================================
	// Work
	// =========================================================================

	/**
	 * Register a kind of work (RFC §7) as `ext:<manifest id>/<name>`: `name` is
	 * lowercase letters, digits, `-`, and `_`, starting with a letter or digit.
	 * Start the kind's work with `ctx.startWork(name, ...)`. Reloading the
	 * extensions removes the kind and interrupts the work it runs.
	 */
	registerWorkKind(name: string, kind?: WorkKindDeclaration): void;

	// =========================================================================
	// Message Rendering
	// =========================================================================

	/** Register a custom renderer for CustomMessageEntry. */
	registerMessageRenderer<T = JsonValue>(customType: string, renderer: MessageRenderer<T>): void;

	// =========================================================================
	// Actions
	// =========================================================================

	/** Send a custom message to the session. */
	sendMessage<T>(
		message: CustomMessageInput<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;

	/**
	 * Append a custom entry to the session for state persistence (not sent to LLM).
	 * Resolves after the entry commits.
	 */
	appendEntry<T>(customType: string, data?: JsonCompatibleInput<T>): Promise<void>;

	// =========================================================================
	// Session Metadata
	// =========================================================================

	/** Set the session display name (shown in session selector). Resolves after the name commits. */
	setSessionName(name: string): Promise<void>;

	/** Get the current session name, if set. */
	getSessionName(): string | undefined;

	/**
	 * Set or clear a label on an entry. Labels are user-defined markers for
	 * bookmarking/navigation. Resolves after the label commits.
	 */
	setLabel(entryId: string, label: string | undefined): Promise<void>;

	/** Bounded metadata for this extension's managed tasks; does not grant execution authority. */
	getServicesStatus(): ExtensionServicesStatus;

	/** Execute a shell command. Needs the `exec` permission. */
	exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

	/** Get the list of currently active tool names. */
	getActiveTools(): string[];

	/** Get all configured tools with parameter schema, prompt guidelines, and source metadata. */
	getAllTools(): ToolInfo[];

	/** Set the active tools by name. */
	setActiveTools(toolNames: string[]): void;

	/** Get available slash commands in the current session. */
	getCommands(): SlashCommandInfo[];

	// =========================================================================
	// Model and Thinking Level
	// =========================================================================

	/** Set the current model: the catalog's model with this provider and id. Returns false if there is none or no API key is available. */
	setModel(model: Model<any>): Promise<boolean>;

	/** Get current thinking level. */
	getThinkingLevel(): ThinkingLevel;

	/** Set thinking level (clamped to model capabilities). */
	setThinkingLevel(level: ThinkingLevel): void;

	// =========================================================================
	// Provider Registration
	// =========================================================================

	/**
	 * Register or override a model provider. Needs the `providers` permission.
	 *
	 * If `models` is provided: replaces all existing models for this provider.
	 * If only `baseUrl` is provided: overrides the URL for existing models.
	 * If `oauth` is provided: registers OAuth provider for /login support.
	 * If `streamSimple` is provided: registers a custom API stream handler.
	 *
	 * During initial extension load this call is queued and applied once the
	 * runner has bound its context. After that it takes effect immediately, so
	 * it is safe to call from command handlers or event callbacks without
	 * requiring a `/reload`.
	 *
	 * @example
	 * // Register a new provider with custom models
	 * volt.registerProvider("my-proxy", {
	 *   baseUrl: "https://proxy.example.com",
	 *   apiKey: "$PROXY_API_KEY",
	 *   api: "anthropic-messages",
	 *   models: [
	 *     {
	 *       id: "claude-sonnet-4-20250514",
	 *       name: "Claude 4 Sonnet (proxy)",
	 *       reasoning: false,
	 *       input: ["text", "image"],
	 *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	 *       contextWindow: 200000,
	 *       maxTokens: 16384
	 *     }
	 *   ]
	 * });
	 *
	 * @example
	 * // Override baseUrl for an existing provider
	 * volt.registerProvider("anthropic", {
	 *   baseUrl: "https://proxy.example.com"
	 * });
	 *
	 * @example
	 * // Register provider with OAuth support
	 * volt.registerProvider("corporate-ai", {
	 *   baseUrl: "https://ai.corp.com",
	 *   api: "openai-responses",
	 *   models: [...],
	 *   oauth: {
	 *     name: "Corporate AI (SSO)",
	 *     async login(callbacks) { ... },
	 *     async refreshToken(credentials) { ... },
	 *     getApiKey(credentials) { return credentials.access; }
	 *   }
	 * });
	 */
	registerProvider(name: string, config: ProviderConfig): void;

	/**
	 * Unregister a previously registered provider. Needs the `providers` permission.
	 *
	 * Removes all models belonging to the named provider and restores any
	 * built-in models that were overridden by it. Has no effect if the provider
	 * is not currently registered.
	 *
	 * Like `registerProvider`, this takes effect immediately when called after
	 * the initial load phase.
	 *
	 * @example
	 * volt.unregisterProvider("my-proxy");
	 */
	unregisterProvider(name: string): void;

	/** Shared event bus for extension communication. */
	events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Configuration for registering a provider via volt.registerProvider(). */
export interface ProviderConfig {
	/** Display name for the provider in UI. */
	name?: string;
	/** Base URL for the API endpoint. Required when defining models. */
	baseUrl?: string;
	/** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or leading !command. Required when defining models (unless oauth provided). */
	apiKey?: string;
	/** API type. Required at provider or model level when defining models. */
	api?: Api;
	/** Optional streamSimple handler for custom APIs. */
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	/** Custom headers to include in requests. */
	headers?: Record<string, string>;
	/** If true, adds Authorization: Bearer header with the resolved API key. */
	authHeader?: boolean;
	/** Prompt-cache behavior inherited by registered models. Set to null to clear inherited metadata. */
	promptCache?: PromptCacheMetadata | null;
	/** Models to register. If provided, replaces all existing models for this provider. */
	models?: ProviderModelConfig[];
	/** OAuth provider for /login support. The `id` is set automatically from the provider name. */
	oauth?: {
		/** Display name for the provider in login UI. */
		name: string;
		/** Run the login flow, return credentials to persist. */
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
		/** Refresh expired credentials, return updated credentials to persist. */
		refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		/** Convert credentials to API key string for the provider. */
		getApiKey(credentials: OAuthCredentials): string;
		/** Fetch provider-neutral subscription quota usage for `/usage`. */
		fetchSubscriptionUsage?(
			credentials: OAuthCredentials,
			options?: SubscriptionUsageFetchOptions,
		): Promise<SubscriptionUsageResult>;
		/** Optional: modify models for this provider (e.g., update baseUrl based on credentials). */
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
	/** Model ID (e.g., "claude-sonnet-4-20250514"). */
	id: string;
	/** Display name (e.g., "Claude 4 Sonnet"). */
	name: string;
	/** API type override for this model. */
	api?: Api;
	/** API endpoint URL override for this model. */
	baseUrl?: string;
	/** Whether the model supports extended thinking. */
	reasoning: boolean;
	/** Maps volt thinking levels to provider/model-specific values; null marks a level unsupported. */
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	/** Supported input types. */
	input: ("text" | "image")[];
	/** Prompt-cache behavior for this model. Overrides the provider default. */
	promptCache?: PromptCacheMetadata;
	/** Cost per token (for tracking, can be 0). */
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	/** Maximum context window size in tokens. */
	contextWindow: number;
	/** Maximum output tokens. */
	maxTokens: number;
	/** Custom headers for this model. */
	headers?: Record<string, string>;
	/** OpenAI compatibility settings. */
	compat?: Model<Api>["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory<TSettings extends ExtensionSettingsShape = ExtensionSettingsShape> = (
	volt: ExtensionAPI<TSettings>,
) => void | Promise<void>;

/**
 * An extension given to the SDK (`extensionFactories`): its manifest, without
 * `entry`, and its factory, which may type its settings.
 */
export interface ExtensionDefinition {
	readonly manifest: ExtensionManifest;
	factory(volt: ExtensionAPI): void | Promise<void>;
}

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
	/** The manifest id of the extension that registered the tool: its executions' `ctx` belongs to it. */
	extensionId?: string;
}

export interface ExtensionFlag {
	name: string;
	description?: string;
	type: "boolean" | "string";
	default?: boolean | string;
	/** The manifest id of the extension that registered the flag. */
	extensionId: string;
}

export interface ExtensionShortcut {
	shortcut: KeyId;
	description?: string;
	/** The intent the key invokes: one of the extension's own intents or commands. */
	intent: string;
	/** The manifest id of the extension that registered the shortcut. */
	extensionId: string;
}

export type SendMessageHandler = <T>(
	message: CustomMessageInput<T>,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
	content: string | (TextContent | ImageContent)[],
	options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = <T>(customType: string, data?: JsonCompatibleInput<T>) => Promise<void>;

export type SetSessionNameHandler = (name: string) => Promise<void>;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** Tool info with name, description, parameter schema, prompt guidelines, and source metadata. */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptGuidelines"> & {
	sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model<any>) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => Promise<void>;

/**
 * Shared state created by loader, used during registration and runtime.
 * Contains flag values (defaults set during registration, CLI values set after).
 */
export interface ExtensionRuntimeState {
	/** The extensions' settings: `volt.settings` and `volt.updateSettings` go through it. */
	readonly settings: ExtensionSettingsRuntime;
	/** The managed-services status of the extension with manifest id `owner`. */
	getServicesStatus(owner: string): ExtensionServicesStatus;
	flagValues: Map<string, boolean | string>;
	/** Provider registrations queued during extension loading, processed when runner binds */
	pendingProviderRegistrations: Array<{ name: string; config: ProviderConfig; extensionId: string }>;
	/** Registers the work kinds declared since the runner bound; does nothing before. */
	refreshWorkKinds: () => void;
	/** Throws when this extension instance is stale after runtime replacement. */
	assertActive: () => void;
	/** Marks this extension instance as stale after runtime replacement or reload. */
	invalidate: (message?: string) => void;
	/**
	 * Register or unregister a provider.
	 *
	 * Before bindCore(): queues registrations / removes from queue.
	 * After bindCore(): calls ModelRegistry directly for immediate effect.
	 */
	registerProvider: (name: string, config: ProviderConfig, extensionId?: string) => void;
	unregisterProvider: (name: string, extensionId?: string) => void;
}

/**
 * Action implementations for volt.* API methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface ExtensionActions {
	sendMessage: SendMessageHandler;
	sendUserMessage: SendUserMessageHandler;
	appendEntry: AppendEntryHandler;
	setSessionName: SetSessionNameHandler;
	getSessionName: GetSessionNameHandler;
	setLabel: SetLabelHandler;
	getActiveTools: GetActiveToolsHandler;
	getAllTools: GetAllToolsHandler;
	setActiveTools: SetActiveToolsHandler;
	refreshTools: RefreshToolsHandler;
	getCommands: GetCommandsHandler;
	setModel: SetModelHandler;
	getThinkingLevel: GetThinkingLevelHandler;
	setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * Actions for ExtensionContext (ctx.* in event handlers).
 * Required by all modes.
 */
export interface ExtensionContextActions {
	getModel: () => Model<any> | undefined;
	isIdle: () => boolean;
	isProjectTrusted: () => boolean;
	getSignal: () => AbortSignal | undefined;
	abort: () => void;
	hasPendingMessages: () => boolean;
	shutdown: () => void;
	getContextUsage: () => ContextUsage | undefined;
	compact: (options?: CompactOptions) => void;
	getSystemPrompt: () => string;
	getSystemPromptOptions?: () => BuildSystemPromptOptions;
}

/**
 * Actions for ExtensionCommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where extension commands are invokable.
 */
export interface ExtensionCommandContextActions {
	waitForIdle: () => Promise<void>;
	newSession: (options?: {
		parentSessionRef?: SessionReference;
		setup?: (writer: ExtensionSessionWriter) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}) => Promise<SessionIntentResult>;
	fork: (
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<SessionIntentResult>;
	navigateTree: (
		targetId: string,
		options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	) => Promise<{ cancelled: boolean }>;
	switchSession: (
		sessionRef: SessionReference,
		options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	) => Promise<SessionIntentResult>;
	reload: () => Promise<void>;
}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/**
 * The life of one extension instance. It stops when the extension is
 * disabled: it registers nothing more, while what it runs finishes. It is
 * retired once it stopped, or when it is reloaded or fails to load: its
 * `volt` and contexts throw from then on, and what it registered to run on
 * retirement runs once.
 */
export class ExtensionLifetime {
	private message: string | undefined;
	private stoppedMessage: string | undefined;
	private readonly cleanups = new Set<() => void>();

	get retired(): boolean {
		return this.message !== undefined;
	}

	/** Whether the instance stopped or retired. */
	get stopped(): boolean {
		return this.stoppedMessage !== undefined || this.message !== undefined;
	}

	/** Throws once the instance is retired. */
	assertActive(): void {
		if (this.message !== undefined) throw new Error(this.message);
	}

	/** Throws once the instance stopped or retired: it may register or change nothing more. */
	assertRunning(): void {
		this.assertActive();
		if (this.stoppedMessage !== undefined) throw new Error(this.stoppedMessage);
	}

	/** Stop the instance: registering or changing anything throws `message` from now on. Later calls do nothing. */
	stop(message: string): void {
		this.stoppedMessage ??= message;
	}

	/** Run `cleanup` when the instance retires (at once if it has). Returns a function that cancels it. */
	onRetire(cleanup: () => void): () => void {
		if (this.message !== undefined) {
			cleanup();
			return () => {};
		}
		this.cleanups.add(cleanup);
		return () => {
			this.cleanups.delete(cleanup);
		};
	}

	/** Retire the instance: `message` is what its calls throw from now on. Later calls do nothing. */
	retire(message: string): void {
		if (this.message !== undefined) return;
		this.message = message;
		for (const cleanup of [...this.cleanups]) {
			try {
				cleanup();
			} catch {
				// Cleanups are the host's own; one failing does not keep the others from running.
			}
		}
		this.cleanups.clear();
	}
}

/** Loaded extension with all registered items. */
export interface Extension {
	/** The manifest id: the extension's identity. Contributions, errors, and work kinds are keyed by it. */
	readonly id: string;
	readonly manifest: ExtensionManifest;
	/** The package version, or `local` for a single-file or SDK extension. */
	readonly version: string;
	/** What was loaded: a module, a directory, or a package root; `<inline:N>` for an SDK extension. */
	path: string;
	resolvedPath: string;
	/** Where the extension was found: its scope (user, project, or temporary), origin, and path. */
	sourceInfo: SourceInfo;
	/**
	 * Where its code came from and which revision (`npm:<name>@<version>`,
	 * `git:<repo>@<commit>`, `local:<path hash>`, `sdk:<id>`): permission
	 * acknowledgments are bound to it.
	 */
	readonly fingerprint: string;
	readonly handlers: ExtensionHandlerRegistry;
	tools: Map<string, RegisteredTool>;
	messageRenderers: Map<string, MessageRenderer>;
	commands: Map<string, RegisteredCommand>;
	flags: Map<string, ExtensionFlag>;
	shortcuts: Map<KeyId, ExtensionShortcut>;
	/** The intents the extension registered, by name. */
	intents: Map<string, RegisteredIntent>;
	/** The editor completion providers the extension registered, by name. */
	completionProviders: Map<string, RegisteredCompletionProvider>;
	/** The work kinds the extension declared, by name. */
	workKinds: Map<string, WorkKindDeclaration>;
	/** The model providers the extension registered, by name: they are unregistered when it stops. */
	providers: Set<string>;
	/**
	 * What the extension registered on its AI client directly (`api:<api>`,
	 * `images:<api>`, `oauth:<id>`, `models`): undone when it stops.
	 */
	clientRegistrations: Set<string>;
	/** The instance's lifetime: retired when the extension is disabled, reloaded, or fails to load. */
	readonly lifetime: ExtensionLifetime;
}

/**
 * An extension that owns its manifest id in a conversation, whether it runs
 * or not: its manifest was read, and `load` runs a new instance of it. One
 * that does not run is disabled by settings or failed to load (`error`).
 */
export interface ExtensionDeclaration {
	readonly id: string;
	readonly manifest: ExtensionManifest;
	/** The package version, or `local` for a single-file or SDK extension. */
	readonly version: string;
	readonly path: string;
	readonly resolvedPath: string;
	/** Where it was found; loading it gives the extension this source. */
	sourceInfo: SourceInfo;
	/** See {@link Extension.fingerprint}. */
	readonly fingerprint: string;
	/** Why it failed to load when it was declared. */
	readonly error?: string;
	/**
	 * Run a new instance in the runtime it was declared for: import a
	 * package's entry and run the factory. Rejects with what failed; a failed
	 * instance is retired and its providers unregistered.
	 */
	load(): Promise<Extension>;
}

/** Result of loading extensions. */
export interface LoadExtensionsResult {
	/** The extensions running: loaded, and enabled. */
	extensions: Extension[];
	/** Every extension that owns its id, in load order, running or not (disabled by settings, or failed to load). */
	declarations?: ExtensionDeclaration[];
	errors: Array<{ path: string; error: string }>;
	/** Shared runtime - actions are throwing stubs until runner.initialize() */
	runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
	/**
	 * The manifest id of the extension the error belongs to, or a label in
	 * angle brackets (such as `<runtime>`) for an error of the host's own
	 * extension runtime. No manifest id contains `<`.
	 */
	extensionId: string;
	event: string;
	error: string;
	stack?: string;
}
