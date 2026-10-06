/**
 * Interactive mode for the coding agent: the TUI as a protocol client of the
 * host it reaches through its connector (client/conversation-connector.ts;
 * `InProcessConnector` in process), following its moves by reconnecting.
 * Its transcript and status (footer, indicators, alerts, plan, work,
 * extension UI) draw the store that follows the client, and their actions go
 * out as intents; its input (the editor, its keys, and the slash menu) and
 * its commands go out as the client's intents and queries (architecture
 * rewrite §10). What only the terminal has stays local: its display
 * settings, keybindings, themes, clipboard, and the daemon's control plane.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ImageContent, SubscriptionUsageError } from "@hansjm10/volt-ai";
import {
	type AuthProvider,
	type ClientQueuedInput,
	type ClientState,
	type ConversationInfo,
	type ExtensionState,
	type ExtensionSummary,
	HOST_NOTICE_SOURCE,
	type HostRequest,
	type HostResponse,
	type HostSettingsValues,
	type IntentOption,
	type LiveValue,
	type ProjectedEntry,
	type QueryResult,
	type ResourceDiagnostic,
	type ResourceSource,
	type Resources,
	type RpcCatalogModel,
	type ScopedModel,
	type UiNodeStyledText,
	type WithdrawnInput,
} from "@hansjm10/volt-protocol";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	MarkdownTheme,
	OverlayHandle,
	RenderSuspensionLease,
	SlashCommand,
	Terminal,
	TuiMainScreenRenderState,
	TuiMode,
} from "@hansjm10/volt-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	HStack,
	isKeyRelease,
	isKeyRepeat,
	isViewportTUI,
	Loader,
	Markdown,
	ProcessTerminal,
	renderStyledText,
	ScrollView,
	Spacer,
	sanitizeText,
	setKeybindings,
	styledTextToPlain,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	VStack,
} from "@hansjm10/volt-tui";
import chalk from "chalk";
import { spawn, spawnSync } from "child_process";
import { type ConversationConnector, connectThrough } from "../../client/conversation-connector.ts";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAuthPath,
	getDocsPath,
	getShareViewerUrl,
	VERSION,
} from "../../config.ts";
import type { ExtensionUIDialogOptions } from "../../core/extensions/index.ts";
import {
	ExtensionPermissionStore,
	type PackagePermissionOutcome,
	permissionRequestLines,
	reviewPackagePermissions,
} from "../../core/extensions/permissions.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, formatHttpIdleTimeoutMs } from "../../core/http-dispatcher.ts";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { findExactModelReferenceMatch } from "../../core/model-resolver.ts";
import { type ConfiguredPackage, DefaultPackageManager } from "../../core/package-manager.ts";
import { DEFAULT_PLANNING_STATE, type PlanningState, type PlanPhase, type PlanState } from "../../core/planning.ts";
import { BEDROCK_PROVIDER_ID } from "../../core/provider-auth.ts";
import {
	MUTABLE_WORKSPACE_REVIEW_TOOLS,
	parseReviewCommandArgs,
	REVIEW_USAGE,
	type ReviewRunControls,
	type ReviewTarget,
} from "../../core/review.ts";
import { formatMissingSessionCwdPrompt } from "../../core/session-cwd.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { isInstallTelemetryEnabled } from "../../core/telemetry.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { stripTerminalControls } from "../../core/ui/ansi-tokens.ts";
import type { UserInputResponse } from "../../core/user-input.ts";
import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "../../daemon/worktree-manager.ts";
import {
	findCatalogPackage,
	loadDefaultStoreCatalog,
	STORE_CATALOG_SCHEMA_VERSION,
	type StoreCatalog,
	type StoreCatalogPackage,
	searchCatalogPackages,
} from "../../store/catalog.ts";
import { inspectStorePackage } from "../../store/inspector.ts";
import { buildStoreInstallPlan, type StoreInstallScope } from "../../store/install-plan.ts";
import {
	formatStoreInstallPlanTarget,
	formatStoreProgressMessage,
	formatStoreSourceSummary,
	renderCatalogSearch,
	renderStoreInstallPlan,
	renderStoreShow,
} from "../../store/render.ts";
import { resolveStoreSource } from "../../store/resolver.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	type StoreScopeTarget,
	storeReviewSource,
	storeSourcePinsCommit,
	storeTargetMatchesUpdateSource,
	storeUpdateTouches,
} from "../../store/targets.ts";
import { getChangelogPath, getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { copyToClipboard, readClipboardText } from "../../utils/clipboard.ts";
import { extensionForImageMimeType, readClipboardImage } from "../../utils/clipboard-image.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { createPrivateTempDirectorySync, writePrivateNewFileSync } from "../../utils/private-files.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import { checkForNewVoltVersion, type LatestVoltRelease } from "../../utils/version-check.ts";
import { getVoltUserAgent } from "../../utils/volt-user-agent.ts";
import { footerViewModel, type TransientUsage, withTransientUsage } from "./client/footer-model.ts";
import { type Delivery, type InputDiagnostic, type Interruptible, TuiInput } from "./client/input.ts";
import { ReviewView } from "./client/review-view.ts";
import {
	entryTree,
	forkableMessages,
	isMissingCwd,
	lastAssistantText,
	type MoveOutcome,
	messageStats,
	sessionItem,
	TuiSessions,
} from "./client/session-commands.ts";
import { TranscriptView } from "./client/transcript-view.ts";
import { TuiCatalogs } from "./client/tui-catalogs.ts";
import { TuiStore, type TuiStoreChange } from "./client/tui-store.ts";
import { ConversationWork } from "./client/work-view.ts";
import { formatCompactionUsage } from "./compaction-usage.ts";
import { ArminComponent } from "./components/armin.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CountdownTimer } from "./components/countdown-timer.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { DaxnutsComponent } from "./components/daxnuts.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import { ExtensionEditorComponent } from "./components/extension-editor.ts";
import { ExtensionInputComponent } from "./components/extension-input.ts";
import { ExtensionSelectorComponent } from "./components/extension-selector.ts";
import { ExtensionSettingsComponent } from "./components/extension-settings.ts";
import { FooterComponent, type FooterViewModel } from "./components/footer.ts";
import { HostDialogComponent, HostFormDialogComponent } from "./components/host-request-dialog.ts";
import { type HotkeySection, HotkeysComponent } from "./components/hotkeys.ts";
import { PlanInspectorComponent } from "./components/plan-inspector.ts";
import { type PlanDetailsAction, PlanDetailsComponent, PlanStatusComponent } from "./components/plan-status.ts";
import { createRemoteControlBackend, RemoteControlCenterComponent } from "./components/remote-control-center.ts";
import { ResponsivePlanLayoutComponent } from "./components/responsive-plan-layout.ts";
import { StreamingRenderCoalescer } from "./components/streaming-render-coalescer.ts";
import { VoltAnnouncementComponent } from "./components/volt-announcement.ts";
import { withEditorCompletions } from "./editor-completions.ts";
import { ExtensionShortcutBindings } from "./extension-shortcuts.ts";
import { TUI_HOST_REQUESTS, TuiLiveView } from "./live-view.ts";
import {
	collectPromptImageAttachments,
	MAX_PROMPT_IMAGE_ATTACHMENTS,
	mayAttachImages,
} from "./prompt-image-attachments.ts";
import { createClientIntentSink } from "./ui-node/intents.ts";
import { PanelFocus, UiPanels } from "./ui-node/panels.ts";
import { TUI_SEMANTIC_THEME } from "./ui-node/semantic-theme.ts";
import type { ToolCardWork } from "./ui-node/tool-card.ts";
import { type DaemonWorktreeControl, openDaemonWorktreeControl } from "./worktree-control.ts";

function isAsciiOnlyTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM ?? "";
	return process.env.VOLT_ASCII === "1" || process.env.TERM === "linux" || termProgram === "";
}

import {
	detectTerminalBackgroundTheme,
	getAvailableThemes,
	getCurrentThemeName,
	getEditorTheme,
	getMarkdownTheme,
	initTheme,
	loadThemeFromPath,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	stopThemeWatcher,
	type Theme,
	theme,
} from "../../core/theme/runtime.ts";
import {
	editorTopBorderLabelForState,
	formatKeyText,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import { StartupHeaderComponent } from "./components/logo.ts";
import { type ModelSelectorCatalog, ModelSelectorComponent } from "./components/model-selector.ts";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./components/oauth-selector.ts";
import { type ReviewToolSelectorOption, ReviewToolsSelectorComponent } from "./components/review-tools-selector.ts";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.ts";
import { SessionSelectorComponent, type SessionSelectorItem } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { TreeSelectorComponent } from "./components/tree-selector.ts";
import { TrustSelectorComponent } from "./components/trust-selector.ts";
import { promptUserInput, type UserInputDialogFactory } from "./components/user-input-dialog.ts";
import { UserMessageSelectorComponent } from "./components/user-message-selector.ts";
import { WorkInspector } from "./components/work-inspector.ts";
import { queuedWorkNoticeLine, workOutcomeLine } from "./components/work-notice.ts";
import { WorkStatus } from "./components/work-status.ts";
import { createUiNodeView } from "./ui-node/registry.ts";

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

type PhaseValue = Extract<LiveValue, { kind: "phase" }>;

/** A problem loading resources, as the resources listing shows it. */
type LoadDiagnostic = Omit<ResourceDiagnostic, "resource">;

/** How an extension selector closed: an option picked, cancelled by the user, or dismissed by Volt or its signal. */
type ExtensionSelectorOutcome = { kind: "selected"; option: string } | { kind: "cancelled" } | { kind: "dismissed" };

/** A TUI dialog's options; a `live` dialog is closed by the live view, not by an extension UI reset. */
type TuiDialogOptions = ExtensionUIDialogOptions & {
	live?: boolean;
	/** The input is a secret, such as an API key: masked, and kept out of any history. */
	secret?: boolean;
};

/** The sign-in dialog of a provider login: the `provider_auth` requests the host asks show in it. */
interface SignInView {
	readonly dialog: LoginDialogComponent;
	/** The view and focus it replaced. */
	readonly restore: { view: ActiveViewDescriptor; focus: Component | null };
	/** How many requests it showed: a request that ended closes it only while it shows the newest. */
	shown: number;
	/** Answers the request it shows as cancelled: Escape cancels the sign-in. */
	cancel?: () => void;
}

interface ActiveViewDescriptor {
	regularComponents: readonly Component[];
	fullscreenRoot: Component;
}

/** Where the TUI reads its own settings: a conversation's cwd, its project trust, and the settings profile. */
export interface TuiSettingsScope {
	readonly cwd: string;
	readonly projectTrusted: boolean;
	readonly profile?: string;
}

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

const TURN_DONE_ALERT_BUSY_RETRY_MS = 250;
/** Idle time after settlement before the transcript records when work finished. */
const WORK_SUMMARY_IDLE_MS = 60_000;
const STDOUT_FLUSH_TIMEOUT_MS = 1000;
/**
 * How long the TUI's client waits for an intent's or query's answer: as long
 * as a timer lasts. Its host runs in this process, and an intent answers when
 * it ran, which takes as long as a shell command runs or the user takes to
 * answer an extension command's dialog.
 */
const TUI_REQUEST_TIMEOUT_MS = 2_147_483_647;
/** Width of fullscreen's panel sidebar, in columns. */
/** How `/extensions` shows an extension's state. */
const EXTENSION_STATE_LABELS: Readonly<Record<ExtensionState, string>> = {
	active: "enabled",
	disabled: "disabled",
	failed: "failed",
	activating: "enabling",
	deactivating: "disabling",
};

const PANEL_SIDEBAR_COLUMNS = 40;
/** Narrowest terminal that shows the panel sidebar; narrower ones show sidebar panels above the editor. */
const PANEL_SIDEBAR_MIN_TERMINAL_COLUMNS = 100;

/** Format an elapsed duration for the working indicator, e.g. "42s", "3m 12s", "1h 4m". */
function formatElapsedDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Local wall-clock time, e.g. "3:42 PM". */
function formatClockTime(ms: number): string {
	return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** An error's message, for the TUI's messages. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The command that resumes the conversation `info` describes, when its log is stored and stdout is a terminal. */
export function formatResumeCommand(info: ConversationInfo): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!info.persisted) return undefined;

	const args = [APP_NAME];
	if (!info.defaultSessionDir) {
		args.push("--session-dir", quoteIfNeeded(info.sessionDir));
	}
	args.push("--session", info.id);
	return args.join(" ");
}

/**
 * The models a scope limits the model cycle to, from the `models` catalog:
 * none when the cycle steps through every selectable model, in order.
 */
function scopedModels(models: readonly RpcCatalogModel[], cycleScope: readonly ScopedModel[]): readonly ScopedModel[] {
	const unscoped =
		cycleScope.length === models.length &&
		cycleScope.every(
			(scoped, index) =>
				scoped.thinkingLevel === undefined &&
				scoped.provider === models[index]?.provider &&
				scoped.modelId === models[index]?.id,
		);
	return unscoped ? [] : cycleScope;
}

/**
 * Options for InteractiveMode initialization.
 */
export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/**
	 * Where the TUI reads its own settings until its client says where the
	 * conversation runs (`conversation_info`): the startup conversation's cwd,
	 * its project trust, and the settings profile. By default the process's
	 * cwd, untrusted, without a profile.
	 */
	settingsScope?: TuiSettingsScope;
	/** Cwd to trust after reload if it gained a .volt directory during this implicitly trusted session. */
	autoTrustOnReloadCwd?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional messages to send after the initial message */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** TUI layout mode for this invocation. */
	tuiMode?: TuiMode;
}

interface InteractiveTuiOptions {
	tuiMode: TuiMode;
	showHardwareCursor: boolean;
	logDirectory: string;
	terminal?: Terminal;
	onRightClickPaste?: () => void;
}

/** Construct the requested interactive renderer over a shared terminal. */
export function createInteractiveTui(options: InteractiveTuiOptions): TuiMainScreen | TuiAltScreen {
	const terminal = options.terminal ?? new ProcessTerminal();
	if (options.tuiMode === "fullscreen") {
		const styleSearchMatch = (text: string) => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
		return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
			searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
			searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(styleSearchMatch(text))),
			openUrl: openBrowser,
			onRightClickPaste: options.onRightClickPaste,
			copySelection: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch {
					return false;
				}
			},
		});
	}
	return new TuiMainScreen(terminal, options.showHardwareCursor, options.logDirectory);
}

/** Stable TUI reference used by components while the concrete renderer changes. */
export function createInteractiveTuiReference(getTui: () => TUI): TUI {
	return new Proxy({} as TUI, {
		get: (_target, property) => {
			const tui = getTui();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: unknown[]) => {
				const currentTui = getTui();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`TUI property ${String(property)} is not callable`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => {
			const tui = getTui();
			return Reflect.set(tui, property, value, tui);
		},
		has: (_target, property) => Reflect.has(getTui(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getTui()),
	});
}

export class InteractiveMode {
	/** What the TUI connects its client through: how it reaches the conversations of its host. */
	private readonly connector: ConversationConnector;
	/** What the TUI's protocol client holds of the conversation it shows: the fold of its log and its live lane. */
	private readonly store = new TuiStore();
	/** The store's transcript in the chat: messages, tool calls as the host presents them, and what streams. */
	private readonly transcript: TranscriptView;
	/** What the editor, the TUI's keys, and the slash menu send through the TUI's client. */
	private readonly input = new TuiInput(this.store);
	/** What the TUI could not bind or list as the catalog asks: shortcuts and commands its own keys and commands take. */
	private inputDiagnostics: readonly InputDiagnostic[] = [];
	/** What the session commands send through the TUI's client, and read of the conversation from the store. */
	private readonly sessions = new TuiSessions(this.store);
	/** The resources the conversation loaded, as the `resources` query answered at startup and after a reload. */
	private resources: Resources | undefined;
	/** The TUI's client connected: the store's conversation shows from then on. */
	private connected = false;
	/** Settles once the TUI's client connected: what the user sends before then waits for it. */
	private readonly clientConnected = Promise.withResolvers<void>();
	/** Why the conversation the TUI shows lost its log, as its host reported it. */
	private lostCause: Error | undefined;
	/** The live state of the conversation the TUI shows: extension panels and title, notices, dialogs, and approvals. */
	private readonly liveView: TuiLiveView;
	private renderer: TuiMainScreen | TuiAltScreen;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private sessionRenderSuspension: RenderSuspensionLease | undefined;
	private chatContainer: Container;
	/** Below the chat: shell commands run while a turn holds the conversation, then the queued input. */
	private pendingMessagesContainer: Container;
	/** Shell commands run while a turn holds the conversation, until their entries commit. */
	private readonly pendingShellRows = new Container();
	/** The input queued for the next turn. */
	private readonly queueContainer = new Container();
	/** The client fold's queue the queued input shows. */
	private shownQueue: readonly ClientQueuedInput[] | undefined;
	private statusContainer: Container;
	/** The work of the conversation the TUI shows, for the footer's work line, tool calls, and the work inspector. */
	private readonly work: ConversationWork;
	/** The catalogs the footer and title read: models, settings, and where the conversation's log lives. */
	private readonly catalogs: TuiCatalogs;
	/** The run phase the status shows, as the store held it when the status last followed it. */
	private shownPhase: PhaseValue | undefined;
	/** The client fold the status last followed. */
	private shownFold: ClientState | undefined;
	/** Usage of another conversation the footer shows in place of the conversation's own, such as a review's. */
	private transientUsage: TransientUsage | undefined;
	/** The title an extension set; the TUI's own shows without one. */
	private extensionTitle: string | undefined;
	private workStatus: WorkStatus;
	private planStatusContainer: Container;
	private planDetailsContainer: Container;
	private documentContainer: Container;
	private footerContainer: Container;
	private fullscreenTranscript: ScrollView;
	private fullscreenFlexibleSlot: VStack;
	private fullscreenConversationRoot: VStack;
	private conversationView: ActiveViewDescriptor;
	private activeView: ActiveViewDescriptor;
	private planStatus: PlanStatusComponent;
	private planDetails: PlanDetailsComponent | undefined;
	private planInspector: PlanInspectorComponent;
	private mainView: ResponsivePlanLayoutComponent;
	private planPaneReturnFocus: Component | undefined;
	private planPaneInputUnsubscribe: (() => void) | undefined;
	private globalInputUnsubscribe: (() => void) | undefined;
	private readyPlanFocusKey: string | undefined;
	/** Last plan identity/phase rendered, used to announce a live active-to-completed transition once. */
	private lastObservedPlan: { id: string; phase: PlanPhase } | undefined;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private fdPath: string | undefined;
	private editorContainer: Container;
	private footer: FooterComponent;
	// Stored so the same manager can be injected into the editor, selectors, and dialogs.
	private keybindings: KeybindingsManager;
	private version: string;
	private isInitialized = false;
	private loadingAnimation: Loader | undefined = undefined;
	private turnStartedAt: number | undefined = undefined;
	private workingElapsedTimer: ReturnType<typeof setInterval> | undefined = undefined;
	/** Current operation, summarized in the transcript once the session stays idle. */
	private workSummary: { startedAt: number; aborted: boolean } | undefined = undefined;
	private workSummaryTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private promptCacheAlertTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private promptCacheAlertAt: number | undefined = undefined;
	private readonly defaultWorkingMessage = "Working...";

	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private changelogMarkdown: string | undefined = undefined;
	private startupNoticesShown = false;
	/** Whether a review this TUI started runs: its loader shows. */
	private activeReview = false;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;

	/** What the rows of tool calls that started work show of it, by tool call id: a row whose work changed draws again. */
	private workRows: ReadonlyMap<string, string> = new Map();
	/** Draws the tool call rows whose work changed at most every streaming render interval. */
	private readonly workRowsCoalescer = new StreamingRenderCoalescer<void>(() => this.showToolCallWork());
	/** Ticks the elapsed time of the running work tool call rows show. */
	private workTicker: ReturnType<typeof setInterval> | undefined;
	private workInspector: WorkInspector | undefined;
	private workOverlay: OverlayHandle | undefined;
	private dismissWorkInspector: (() => void) | undefined;
	private unsubscribeWorkSource: (() => void) | undefined;

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;

	private signalCleanupHandlers: Array<() => void> = [];
	private scratchDirectories = new Set<string>();
	private clipboardScratchFiles = new Map<string, string>();
	private lspTraceScratchDirectory: string | undefined;
	/** Whether `/lsp trace` traces language server traffic. */
	private lspTracing = false;

	// Track editor modes that affect the border treatment and label.
	private isBashMode = false;
	private editorHasText = false;

	// The compaction and retry indicators.
	private autoCompactionLoader: Loader | undefined = undefined;
	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	/** The attempt start the retry indicator counts down to. */
	private retryShownFor: number | undefined;
	/** Whether the terminal shows progress for a run or compaction. */
	private progressShown = false;

	// Shutdown state
	private shutdownRequested = false;
	private turnDoneAlertTimer: ReturnType<typeof setTimeout> | undefined = undefined;

	/** The conversation the TUI shows lost its log, and the TUI is exiting. */
	private endingLostSession = false;
	/**
	 * Set once the user explicitly picks a theme this session; daemon
	 * theme_snapshot broadcasts and extensions' `set_theme` directives then
	 * stop applying (local explicit choice wins).
	 */
	private localThemeOverride = false;
	/** The theme an extension last asked the TUI to show (`set_theme`), shown unless the user picked one here. */
	private extensionTheme: string | undefined;
	/** Confirmation belongs to the work that was active when the warning appeared. */
	private quitConfirmation: { warnedAt: number; activity: string } | undefined;

	// Extension UI state
	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionSelectorRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionInputRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionEditorRestore: { view: ActiveViewDescriptor; focus: Component | null } | undefined;
	/**
	 * Dismiss callbacks of pending extension dialogs, in opening order. Each
	 * settles its dialog once. The live view closes the dialogs it shows itself.
	 */
	private readonly pendingExtensionDialogs = new Set<() => void>();

	/** The rows above and below the editor: a blank line, then the panels above it; the panels below it. */
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;
	/** Extension panels: above and below the editor, and in fullscreen's sidebar. */
	private readonly panels: UiPanels;
	/** Keyboard focus in the panels' actions, forms, and trees; Tab from an empty editor enters it. */
	private readonly panelFocus = new PanelFocus(() => this.leavePanels());
	/** The keybinding-table entries of the extensions' shortcuts. */
	private readonly extensionShortcuts: ExtensionShortcutBindings;

	// Header container that holds the header
	private headerContainer: Container;

	// The header (logo + keybinding hints + changelog)
	private builtInHeader: Component | undefined = undefined;

	private options: InteractiveModeOptions;
	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};
	private autoTrustOnReloadCwd: string | undefined;
	/** The provider login `/login` runs, by provider id and name. */
	private signIn: { provider: string; name: string } | undefined;
	/** The sign-in dialog shown while a provider login waits for the user. */
	private signInView: SignInView | undefined;

	/**
	 * The TUI's own settings (D3): the display settings only the TUI reads,
	 * which it reads and writes itself in the settings files of the
	 * conversation it shows. The settings the host reads change through the
	 * host's intents.
	 */
	private settingsManager: SettingsManager;
	/** Where the TUI's settings were read: the conversation's cwd, project trust, and settings profile. */
	private settingsScope: TuiSettingsScope;
	/** Whether the chat shows the project trust warning of the conversation it shows. */
	private trustWarningShown = false;

	constructor(connector: ConversationConnector, options: InteractiveModeOptions = {}) {
		this.connector = connector;
		this.settingsScope = options.settingsScope ?? { cwd: process.cwd(), projectTrusted: false };
		this.settingsManager = this.createDisplaySettings();
		this.liveView = this.createLiveView();
		const tuiMode = options.tuiMode ?? this.settingsManager.getTuiMode();
		this.options = { ...options, tuiMode };
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		this.version = VERSION;
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
			logDirectory: getAgentDir(),
			onRightClickPaste: this.onRightClickPaste,
		});
		const ui = createInteractiveTuiReference(() => this.renderer);
		const setFocus: TUI["setFocus"] = (component) => {
			// Host loaders can restore focus without changing views. Never leave their input behind this overlay.
			if (component !== this.workInspector) this.dismissWorkInspector?.();
			ui.setFocus(component);
		};
		this.ui = new Proxy(ui, {
			get: (target, property, receiver) =>
				property === "setFocus" ? setFocus : Reflect.get(target, property, receiver),
		});
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.pendingMessagesContainer.addChild(this.pendingShellRows);
		this.pendingMessagesContainer.addChild(this.queueContainer);
		this.statusContainer = new Container();
		this.work = new ConversationWork({ client: () => this.store.client, holder: this.store });
		this.workStatus = new WorkStatus(() => this.work);
		this.planStatusContainer = new Container();
		this.planDetailsContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.transcript = new TranscriptView(this.store, this.chatContainer, {
			ui: this.ui,
			markdownTheme: () => this.getMarkdownThemeWithSettings(),
			hideThinkingBlock: () => this.hideThinkingBlock,
			toolsExpanded: () => this.toolOutputExpanded,
			showImages: () => this.settingsManager.getShowImages(),
			imageWidthCells: () => this.settingsManager.getImageWidthCells(),
			toolCallWork: (toolCallId) => this.toolCallWork(toolCallId),
			pendingShellRows: this.pendingShellRows,
			workNoticeShown: () => this.updatePendingMessagesDisplay(),
		});
		this.catalogs = new TuiCatalogs(this.store, () => {
			this.updateTerminalTitle();
			this.ui.requestRender();
		});
		this.store.subscribe((change) => this.onStoreChange(change));
		this.footerContainer = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.extensionShortcuts = new ExtensionShortcutBindings(this.keybindings);
		this.panels = new UiPanels({
			mode: () => (this.showsPanelSidebar() ? "fullscreen" : "regular"),
			intents: createClientIntentSink({
				client: () => this.store.client,
				onError: (message) => this.showError(message),
			}),
		});
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			topBorderLabel: this.planning().mode === "plan" ? "PLAN · AGENT READ-ONLY" : "ASK VOLT · BUILD",
			placeholder: "Type a request or / for commands",
		});
		this.editor = this.defaultEditor;
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.planStatus = new PlanStatusComponent(this.planning());
		this.planStatusContainer.addChild(this.planStatus);
		this.planInspector = new PlanInspectorComponent({
			planning: this.planning(),
			fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
			onAction: (action) => {
				void this.handlePlanDetailsAction(action);
			},
			onReturnFocus: () => this.focusConversation(),
			onToggleFocus: () => this.togglePlanPaneFocus(),
			onTextInput: (data) => this.composeFromPlanChooser(data),
			requestRender: () => this.ui.requestRender(),
		});
		this.footer = new FooterComponent(
			() => this.footerViewModel(),
			() => this.ui.requestRender(),
		);
		this.footerContainer.addChild(this.footer);
		this.footerContainer.addChild(this.workStatus);
		this.fullscreenTranscript = new ScrollView(this.documentContainer, {
			follow: "end",
			primary: true,
			scrollbar: this.settingsManager.getFullscreenScrollbar(),
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		this.fullscreenFlexibleSlot = new VStack([
			{ component: this.fullscreenTranscript, grow: 1, shrink: 1, minSize: 0 },
		]);
		const fullscreenDock = new VStack([
			{ component: this.pendingMessagesContainer, shrink: 4, minSize: 0 },
			{ component: this.statusContainer, shrink: 4, minSize: 0 },
			{ component: this.widgetContainerAbove, shrink: 3, minSize: 0 },
			{
				component: this.planStatusContainer,
				shrink: 2,
				minSize: 0,
				visible: () => !this.mainView.isTerminalSplit(),
			},
			{ component: this.editorContainer, shrink: 1, minSize: 1 },
			{ component: this.widgetContainerBelow, shrink: 3, minSize: 0 },
		]);
		// Sidebar panels show beside the transcript while the terminal is wide enough.
		const fullscreenBody = new HStack(
			[
				{ component: this.fullscreenFlexibleSlot, basis: 0, grow: 1, shrink: 1, minSize: 0 },
				{
					component: this.panels.sidebar,
					basis: PANEL_SIDEBAR_COLUMNS,
					grow: 0,
					shrink: 0,
					minSize: PANEL_SIDEBAR_COLUMNS,
					maxSize: PANEL_SIDEBAR_COLUMNS,
					visible: () => this.showsPanelSidebar() && this.panels.has("sidebar"),
				},
			],
			{ gap: 1 },
		);
		this.fullscreenConversationRoot = new VStack([
			{ component: fullscreenBody, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: fullscreenDock, shrink: 1, minSize: 0 },
		]);
		this.mainView = new ResponsivePlanLayoutComponent({
			planning: this.planning(),
			transcriptComponents: [this.headerContainer, this.chatContainer],
			controlComponents: [
				this.pendingMessagesContainer,
				this.statusContainer,
				this.widgetContainerAbove,
				this.editorContainer,
				this.widgetContainerBelow,
			],
			compactComponents: [
				this.headerContainer,
				this.chatContainer,
				this.pendingMessagesContainer,
				this.statusContainer,
				this.widgetContainerAbove,
				this.planStatusContainer,
				this.planDetailsContainer,
				this.editorContainer,
				this.widgetContainerBelow,
			],
			fullscreenConversation: this.fullscreenConversationRoot,
			inspector: this.planInspector,
			footer: this.footerContainer,
			getTerminalColumns: () => this.ui.terminal.columns,
			getTerminalRows: () => this.ui.terminal.rows,
			requestViewportReset: () => {
				if (this.renderer instanceof TuiMainScreen) this.renderer.resetViewportOnNextRender();
			},
			onSplitChange: (split, preserveScrollback) => this.handlePlanSplitChange(split, preserveScrollback),
		});
		this.conversationView = {
			regularComponents: [this.mainView],
			fullscreenRoot: this.mainView.getFullscreenLayout(),
		};
		this.activeView = this.conversationView;

		// Load hide thinking block setting
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		// The conversation's own themes register once its client lists them (registerThemes).
		initTheme(this.settingsManager.getTheme(), true);
	}

	private async detectThemeIfUnset(): Promise<void> {
		if (this.settingsManager.getTheme()) {
			return;
		}

		const detection = await detectTerminalBackgroundTheme({ ui: this.ui, timeoutMs: 100 });
		const result = setTheme(detection.theme, true);
		if (!result.success) {
			return;
		}

		if (detection.confidence === "high") {
			this.settingsManager.setTheme(detection.theme);
			await this.settingsManager.flush();
		}
		this.updateEditorBorderColor();
		this.ui.requestRender();
	}

	/**
	 * The editor's completions: the TUI's own slash commands, then those the
	 * conversation's intents catalog offers (intent aliases, extension
	 * commands, prompt templates, and skills when skill commands are on), and
	 * `@` paths in the conversation's working directory.
	 */
	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = async (prefix: string): Promise<AutocompleteItem[] | null> => {
				// The models the cycle steps through: the scoped ones, or every available one.
				let scope: readonly { provider: string; modelId: string }[];
				try {
					scope = (await this.store.client.query("models")).cycleScope;
				} catch {
					return null;
				}
				// Fuzzy filter by model ID + provider (allows "opus anthropic" to match)
				const filtered = fuzzyFilter([...scope], prefix, (item) => `${item.modelId} ${item.provider}`);
				if (filtered.length === 0) return null;
				return filtered.map((item) => ({
					value: `${item.provider}/${item.modelId}`,
					label: item.modelId,
					description: item.provider,
				}));
			};
		}

		const profileCommand = slashCommands.find((command) => command.name === "profile");
		if (profileCommand) {
			profileCommand.getArgumentCompletions = async (prefix: string): Promise<AutocompleteItem[] | null> => {
				let settings: { profile: string; profiles?: string[] };
				try {
					settings = await this.store.client.query("settings");
				} catch {
					return null;
				}
				const filtered = fuzzyFilter(settings.profiles ?? [], prefix, (name) => name);
				if (filtered.length === 0) return null;
				return filtered.map((name) => ({
					value: name,
					label: name,
					description: name === settings.profile ? "current profile" : "profile",
				}));
			};
		}

		const reviewCommand = slashCommands.find((command) => command.name === "review");
		if (reviewCommand) {
			reviewCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const options = ["tools", "uncommitted", "branch", "pr", "commit"];
				const normalized = prefix.trim().toLowerCase();
				const filtered = options.filter((option) => option.startsWith(normalized));
				if (filtered.length === 0) return null;
				return filtered.map((value) => ({ value, label: value }));
			};
		}

		const catalogCommands = this.input.slashCommands(new Set(slashCommands.map((command) => command.name)), {
			skills: this.settingsManager.getEnableSkillCommands(),
		});
		return new CombinedAutocompleteProvider(
			[...slashCommands, ...catalogCommands],
			this.input.catalog.cwd ?? process.cwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		// The extensions' completion providers answer through the host's editor_completions query.
		const provider = withEditorCompletions(this.createBaseAutocompleteProvider(), {
			triggers: this.input.catalog.completionTriggers,
			complete: (text, cursor) => this.store.client.query("editor_completions", { text, cursor }),
		});
		this.defaultEditor.setAutocompleteProvider(provider);
	}

	/**
	 * Load the input catalog of the conversation the store shows, and offer
	 * what it holds: slash commands, completions, and shortcuts. A catalog the
	 * TUI could not load leaves the TUI's own commands and keys.
	 */
	private async refreshInput(): Promise<void> {
		try {
			if (!(await this.input.load())) return;
		} catch (error) {
			if (this.store.conversation !== undefined) {
				this.showWarning(
					`Could not load the conversation's commands: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		this.setupAutocompleteProvider();
		this.setupExtensionShortcuts();
		this.ui.requestRender();
	}

	private showStartupNoticesIfNeeded(): void {
		if (this.startupNoticesShown) {
			return;
		}
		this.startupNoticesShown = true;

		if (!this.changelogMarkdown) {
			return;
		}

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
		if (this.settingsManager.getCollapseChangelog()) {
			const versionMatch = this.changelogMarkdown.match(/##\s+\[?(\d+\.\d+\.\d+)\]?/);
			const latestVersion = versionMatch ? versionMatch[1] : this.version;
			const condensedText = `Updated to v${latestVersion}. Use ${theme.bold("/changelog")} to view full changelog.`;
			this.chatContainer.addChild(new Text(condensedText, 1, 0));
		} else {
			this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(this.changelogMarkdown.trim(), 1, 0, this.getMarkdownThemeWithSettings()),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder());
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// Both are needed: fd for autocomplete, rg for grep tool and bash commands
		const [fdPath] = await Promise.all([ensureTool("fd"), ensureTool("rg")]);
		this.fdPath = fdPath;

		// Mount the conversation through the renderer-aware view descriptor.
		this.renderWidgets(); // Initialize with default spacer
		this.activateView(this.conversationView, this.editor, false);

		this.setupKeyHandlers();
		this.setupPlanPaneInputRouting();
		this.setupEditorSubmitHandler();
		this.refreshPlanningUi();

		// Start the UI before initializing extensions so session_start handlers can use interactive dialogs
		this.ui.start();
		this.isInitialized = true;

		await this.detectThemeIfUnset();

		// Add header with keybindings from config (unless silenced)
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Build startup instructions using keybinding hint helpers
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);

			const expandedInstructions = [
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.plan.togglePane", "to focus the plan pane"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				hint("app.editor.external", "for external editor"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste image"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
			const compactInstructions = [
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
			const compactOnboarding = theme.fg(
				"dim",
				`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
			);
			const onboarding = theme.fg(
				"dim",
				`Volt can explain its own features and look up its docs. Ask it how to use or extend Volt.`,
			);
			this.builtInHeader = new StartupHeaderComponent({
				version: this.version,
				compactInstructions,
				expandedInstructions,
				expansionHint: compactOnboarding,
				onboarding,
				expanded: this.getStartupExpansionState(),
				getTerminalRows: () => this.ui.terminal.rows,
			});

			// Setup UI layout
			this.headerContainer.addChild(new Spacer(1));
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Minimal header when silenced
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}
		this.ui.requestRender();

		await this.connect();

		// Set up theme file watcher
		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this.connector.onThemeSnapshot((themeName) => this.applyDaemonThemeSnapshot(themeName));
	}

	/**
	 * Connect the TUI's client through its connector and show its
	 * conversation; the client follows each move by reconnecting. The UI runs
	 * first: the conversation's session_start dialogs show through the live
	 * view before the conversation is ready. The TUI reads its own settings
	 * where the conversation runs; what its extensions contribute shows before
	 * its messages, its slash commands and shortcuts as its intents catalog
	 * lists them, its resources as the `resources` query lists them; then the
	 * models its cycle steps through, when scoped.
	 */
	private async connect(): Promise<void> {
		await connectThrough(this.connector, {
			name: "volt-tui",
			hostRequests: TUI_HOST_REQUESTS,
			requestTimeoutMs: TUI_REQUEST_TIMEOUT_MS,
			onClient: (client) => this.store.attach(client),
			// What the connector says about a conversation it opened, such as options its host did not apply.
			onOpened: (opened) => {
				for (const notice of opened.notices) this.showWarning(notice);
			},
			onShutdownRequested: () => this.onShutdownRequested(),
			onLost: (error) => {
				this.lostCause = error;
			},
		});
		const client = this.store.client;
		const [, resources, scope, models] = await Promise.all([
			this.input.load().catch((error: unknown) => {
				this.showWarning(
					`Could not load the conversation's commands: ${error instanceof Error ? error.message : String(error)}`,
				);
			}),
			client.query("resources").catch(() => undefined),
			this.readSettingsScope(),
			client.query("models").catch(() => undefined),
		]);
		this.resources = resources;
		if (scope) this.followSettings(scope);
		// The changelog shows new entries in a new conversation only.
		this.changelogMarkdown = this.getChangelogForDisplay();
		this.connected = true;
		this.clientConnected.resolve();
		this.showConversation({ afresh: false });
		this.showModelScope(models);
	}

	/**
	 * The models the model cycle keys step through, when a scope limits them,
	 * under the startup header unless startup is quiet.
	 */
	private showModelScope(catalog: QueryResult<"models"> | undefined): void {
		if (catalog === undefined || (!this.options.verbose && this.settingsManager.getQuietStartup())) return;
		const scope = scopedModels(catalog.models, catalog.cycleScope);
		if (scope.length === 0) return;
		const modelList = scope
			.map((scoped) => `${scoped.modelId}${scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : ""}`)
			.join(", ");
		const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
		const cycleHint =
			cycleKeys.length > 0
				? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
				: "";
		// Under the startup header, as the cycle keys' hint shows there.
		this.headerContainer.addChild(new Text(`${theme.fg("dim", `Model scope: ${modelList}`)}${cycleHint}`, 1, 0));
		this.headerContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	/**
	 * Update terminal title with session name and cwd, unless an extension set
	 * one; without the cwd yet, once it is known.
	 */
	private updateTerminalTitle(): void {
		const cwd = this.catalogs.conversationInfo?.cwd;
		if (this.extensionTitle !== undefined || cwd === undefined) return;
		const cwdBasename = path.basename(cwd);
		const sessionName = this.store.state.name;
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	/**
	 * Run the interactive mode. This is the main entry point.
	 * Initializes the UI, shows warnings, processes initial messages, and starts the interactive loop.
	 */
	async run(): Promise<void> {
		try {
			await this.runInteractiveLoop();
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			try {
				this.stop();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				await this.disposeRuntimeHost();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				stopThemeWatcher();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Interactive mode failed and cleanup did not complete");
			}
			throw error;
		}
	}

	private async runInteractiveLoop(): Promise<void> {
		await this.init();

		// Start version check asynchronously
		checkForNewVoltVersion(this.version).then((newRelease) => {
			if (newRelease) {
				this.showNewVersionNotification(newRelease);
			}
		});

		// Start package update check asynchronously
		this.checkForPackageUpdates().then((updates) => {
			if (updates.length > 0) {
				this.showPackageUpdateNotification(updates);
			}
		});

		// Check tmux keyboard setup asynchronously
		this.checkTmuxKeyboardSetup().then((warning) => {
			if (warning) {
				this.showWarning(warning);
			}
		});

		// Show startup warnings
		const { migratedProviders, initialMessage, initialImages, initialMessages } = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		this.showResourceNotices();

		await this.sendInitialMessages([
			...(initialMessage ? [{ text: initialMessage, images: initialImages }] : []),
			...(initialMessages ?? []).map((text) => ({ text })),
		]);

		// What the user sends goes out from the editor; the TUI runs until it shuts down, which ends the process.
		await new Promise<never>(() => {});
	}

	/** Send the messages the TUI started with, one after another, each as a prompt once the one before settled. */
	private async sendInitialMessages(messages: readonly { text: string; images?: ImageContent[] }[]): Promise<void> {
		for (const { text, images } of messages) {
			try {
				await this.store.client.promptAndWait(text, {
					...(images === undefined ? {} : { images }),
					timeoutMs: TUI_REQUEST_TIMEOUT_MS,
				});
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
				this.showError(errorMessage);
			}
		}
	}

	private async checkForPackageUpdates(): Promise<string[]> {
		if (process.env.VOLT_OFFLINE) {
			return [];
		}

		try {
			const packageManager = new DefaultPackageManager({
				cwd: (await this.sessions.info()).cwd,
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
			});
			const updates = await packageManager.checkForAvailableUpdates();
			return updates.map((update) => update.displayName);
		} catch {
			return [];
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return "tmux extended-keys-format is xterm. Volt works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
		}

		return undefined;
	}

	/**
	 * Get changelog entries to display on startup.
	 * Only shows new entries since last seen version, skips for resumed sessions.
	 */
	private getChangelogForDisplay(): string | undefined {
		// Skip changelog for resumed/continued sessions (already have messages)
		if (this.store.state.entries.some((entry) => entry.type === "message")) {
			return undefined;
		}

		const lastVersion = this.settingsManager.getLastChangelogVersion();
		const changelogPath = getChangelogPath();
		const entries = parseChangelog(changelogPath);

		if (!lastVersion) {
			// Fresh install - record the version, send telemetry, don't show changelog
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return undefined;
		}

		const newEntries = getNewEntries(entries, lastVersion);
		if (newEntries.length > 0) {
			this.settingsManager.setLastChangelogVersion(VERSION);
			this.reportInstallTelemetry(VERSION);
			return newEntries.map((e) => normalizeChangelogLinks(e.content, e)).join("\n\n");
		}

		return undefined;
	}

	private reportInstallTelemetry(version: string): void {
		if (process.env.VOLT_OFFLINE) {
			return;
		}

		if (!isInstallTelemetryEnabled(this.settingsManager)) {
			return;
		}

		const reportInstallUrl = process.env.VOLT_REPORT_INSTALL_URL;
		if (!reportInstallUrl) {
			return;
		}

		const url = new URL(reportInstallUrl);
		url.searchParams.set("version", version);
		void fetch(url, {
			headers: {
				"User-Agent": getVoltUserAgent(version),
			},
			signal: AbortSignal.timeout(5000),
		})
			.then(() => undefined)
			.catch(() => undefined);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	/**
	 * Get a short path relative to the package root for display.
	 */
	private getShortPath(fullPath: string, sourceInfo?: ResourceSource): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getDisplaySourceInfo(sourceInfo?: ResourceSource): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: ResourceSource): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: ResourceSource): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: ResourceSource }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: ResourceSource }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: ResourceSource }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: ResourceSource }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: ResourceSource }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: ResourceSource }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: ResourceSource }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: ResourceSource }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: ResourceSource }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(p: string, sourceInfos: Map<string, ResourceSource>): ResourceSource | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: ResourceSource): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(diagnostics: readonly LoadDiagnostic[], sourceInfos: Map<string, ResourceSource>): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, LoadDiagnostic[]>();
		const otherDiagnostics: LoadDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `    ${d.message}`));
			} else {
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${d.message}`));
			}
		}

		return lines.join("\n");
	}

	/**
	 * List the resources the conversation loaded, as the `resources` query
	 * last answered: the listing unless startup is quiet (or `force`), and
	 * what loading them reported, with `showDiagnosticsWhenQuiet` even then.
	 */
	private showLoadedResources(options?: { force?: boolean; showDiagnosticsWhenQuiet?: boolean }): void {
		const resources = this.resources;
		if (!resources) return;
		const showListing = options?.force || this.options.verbose || !this.settingsManager.getQuietStartup();
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string) => theme.bold(theme.fg("accent", name.toUpperCase()));

		const extensions = resources.extensions.map((extension) => ({
			path: extension.path,
			...(extension.source === undefined ? {} : { sourceInfo: extension.source }),
		}));
		const sourceInfos = new Map<string, ResourceSource>();
		for (const resource of [...resources.extensions, ...resources.skills, ...resources.promptTemplates]) {
			if (resource.source) sourceInfos.set(resource.path, resource.source);
		}
		for (const loadedTheme of resources.themes) {
			if (loadedTheme.path && loadedTheme.source) sourceInfos.set(loadedTheme.path, loadedTheme.source);
		}

		if (showListing) {
			const sections: Array<{ name: string; count: number; noun: string; body: string }> = [];
			const contextFiles = resources.contextFiles;
			if (contextFiles.length > 0) {
				sections.push({
					name: "Context",
					count: contextFiles.length,
					noun: "context",
					body: contextFiles.map((file) => theme.fg("dim", `  ${this.formatDisplayPath(file.path)}`)).join("\n"),
				});
			}

			const skills = resources.skills;
			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({
						path: skill.path,
						...(skill.source === undefined ? {} : { sourceInfo: skill.source }),
					})),
				);
				sections.push({
					name: "Skills",
					count: skills.length,
					noun: skills.length === 1 ? "skill" : "skills",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					}),
				});
			}

			const templates = resources.promptTemplates;
			if (templates.length > 0) {
				const groups = this.buildScopeGroups(
					templates.map((template) => ({
						path: template.path,
						...(template.source === undefined ? {} : { sourceInfo: template.source }),
					})),
				);
				const templateByPath = new Map(templates.map((template) => [template.path, template]));
				sections.push({
					name: "Prompts",
					count: templates.length,
					noun: templates.length === 1 ? "prompt" : "prompts",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
						formatPackagePath: (item) => {
							const template = templateByPath.get(item.path);
							return template ? `/${template.name}` : this.formatDisplayPath(item.path);
						},
					}),
				});
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				sections.push({
					name: "Extensions",
					count: extensions.length,
					noun: extensions.length === 1 ? "extension" : "extensions",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatExtensionDisplayPath(item.path),
						formatPackagePath: (item) =>
							this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
					}),
				});
			}

			const customThemes = resources.themes.flatMap((loadedTheme) =>
				loadedTheme.path === undefined
					? []
					: [
							{
								path: loadedTheme.path,
								...(loadedTheme.source === undefined ? {} : { sourceInfo: loadedTheme.source }),
							},
						],
			);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(customThemes);
				sections.push({
					name: "Themes",
					count: customThemes.length,
					noun: customThemes.length === 1 ? "theme" : "themes",
					body: this.formatScopeGroups(groups, {
						formatPath: (item) => this.formatDisplayPath(item.path),
						formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
					}),
				});
			}

			if (sections.length > 0) {
				const resourceSummary = sections.map((section) => `${section.count} ${section.noun}`).join(" · ");
				const resourceDetails = sections
					.map((section) => `${sectionHeader(section.name)}\n${section.body}`)
					.join("\n\n");
				this.chatContainer.addChild(
					new ExpandableText(
						() => `${theme.bold(theme.fg("accent", "RESOURCES"))}${theme.fg("muted", `  ${resourceSummary}`)}`,
						() => resourceDetails,
						this.getStartupExpansionState(),
						1,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}
		}

		if (showDiagnostics) {
			const diagnosticsOf = (resource: ResourceDiagnostic["resource"]) =>
				resources.diagnostics.filter((diagnostic) => diagnostic.resource === resource);
			const sections: Array<{ title: string; diagnostics: readonly LoadDiagnostic[] }> = [
				{ title: "[Skill conflicts]", diagnostics: diagnosticsOf("skill") },
				{ title: "[Prompt conflicts]", diagnostics: diagnosticsOf("prompt") },
				// The commands and shortcuts the TUI's own commands and keys take join the extensions' own issues.
				{ title: "[Extension issues]", diagnostics: [...diagnosticsOf("extension"), ...this.inputDiagnostics] },
				{ title: "[Theme conflicts]", diagnostics: diagnosticsOf("theme") },
			];
			for (const { title, diagnostics } of sections) {
				if (diagnostics.length === 0) continue;
				const warningLines = this.formatDiagnostics(diagnostics, sourceInfos);
				this.chatContainer.addChild(new Text(`${theme.fg("warning", title)}\n${warningLines}`, 0, 0));
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/** An extension asked to shut down: at once when the conversation is idle, else once it settles. */
	private onShutdownRequested(): void {
		this.shutdownRequested = true;
		if (!this.store.phase?.busy) void this.shutdown();
	}

	/** Show what the conversation's resources and extensions provide: themes, autocomplete, shortcuts, and the resources. */
	private showSessionExtensions(): void {
		this.registerThemes();
		this.applyConfiguredTheme();
		this.setupAutocompleteProvider();
		this.setupExtensionShortcuts();
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		this.showStartupNoticesIfNeeded();
	}

	/**
	 * Register the themes the conversation loaded, as the `resources` query
	 * last listed them: the TUI loads each from its file. A theme without a
	 * file (one an SDK embedder supplies in memory) does not register.
	 */
	private registerThemes(): void {
		const themes: Theme[] = [];
		for (const listed of this.resources?.themes ?? []) {
			if (listed.path === undefined) continue;
			try {
				themes.push(loadThemeFromPath(listed.path));
			} catch {
				// The conversation reported the theme it could not load with its resources.
			}
		}
		setRegisteredThemes(themes);
	}

	/**
	 * Apply the theme the TUI shows, when another shows: the one an extension
	 * last asked for once the TUI has it, unless the user picked one here,
	 * else the one its settings name once it is registered.
	 */
	private applyConfiguredTheme(): void {
		const requested = this.localThemeOverride ? undefined : this.extensionTheme;
		const themeName =
			requested !== undefined && getAvailableThemes().includes(requested)
				? requested
				: this.settingsManager.getTheme();
		if (themeName === undefined || getCurrentThemeName() === themeName) return;
		if (!setTheme(themeName, true).success) return;
		this.ui.invalidate();
		this.updateEditorBorderColor();
	}

	/** An extension asked the TUI to show a theme (`set_theme`): shown unless the user picked one here. */
	private applyExtensionTheme(themeName: string): void {
		this.extensionTheme = themeName;
		if (this.localThemeOverride) return;
		this.applyConfiguredTheme();
		this.ui.requestRender();
	}

	/**
	 * Apply a daemon-broadcast theme change (theme_set control request or an
	 * extension setTheme in a daemon-owned runtime) unless the user explicitly
	 * picked a theme in this TUI session.
	 */
	private applyDaemonThemeSnapshot(themeName: string): void {
		if (this.localThemeOverride || getCurrentThemeName() === themeName) {
			return;
		}
		const result = setTheme(themeName, true);
		if (result.success) {
			this.ui.invalidate();
			this.ui.requestRender();
		}
	}

	/**
	 * The footer's view of the conversation the TUI shows, from its store and
	 * catalogs; a review's usage shows in place of the conversation's own.
	 */
	private footerViewModel(): FooterViewModel {
		return withTransientUsage(
			footerViewModel(this.store, this.catalogs, {
				// Warnings are the host's settings: they show as its catalog holds them.
				contextWarningTokens:
					this.catalogs.settings?.warnings?.contextTokens ?? this.settingsManager.getContextWarningTokens(),
				phoneLabel: (count) => (isAsciiOnlyTerminal() ? `[phone ${count}]` : `📱 ${count}`),
			}),
			this.transientUsage,
		);
	}

	/** The plan state of the conversation the TUI shows, as its client fold holds it. */
	private planning(): PlanningState {
		return this.store.state.planning ?? DEFAULT_PLANNING_STATE;
	}

	/**
	 * The notices the host keeps for the conversation the TUI shows, at
	 * startup: a model it fell back from, a `models.json` it could not read,
	 * and a subscription login that bills extra usage.
	 */
	private showResourceNotices(): void {
		for (const notice of this.resources?.notices ?? []) {
			if (notice.level === "error") this.showError(notice.message);
			else if (notice.level === "warning") this.showWarning(notice.message);
			else this.showStatus(notice.message);
		}
	}

	private applyFullscreenScrollbarSetting(mode = this.settingsManager.getFullscreenScrollbar()): void {
		this.fullscreenTranscript.setScrollbar(mode);
		this.planInspector.setFullscreenScrollbar(mode);
		this.planDetails?.setFullscreenScrollbar(mode);
	}

	/** Apply the TUI's settings to what shows: the scrollbar, thinking blocks, cursor, and editor. */
	private applyRuntimeSettings(): void {
		const settingsManager = this.settingsManager;
		this.applyFullscreenScrollbarSetting(settingsManager.getFullscreenScrollbar());
		this.hideThinkingBlock = settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(settingsManager.getClearOnShrink());
		const editorPaddingX = settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
	}

	/** The TUI's settings where its settings scope says: the settings files of its cwd, for its trust and profile. */
	private createDisplaySettings(): SettingsManager {
		const { cwd, projectTrusted, profile } = this.settingsScope;
		return SettingsManager.create(cwd, getAgentDir(), {
			projectTrusted,
			...(profile === undefined ? {} : { profile }),
		});
	}

	/**
	 * Where the conversation the store shows runs, as its client tells: its
	 * cwd and project trust (`conversation_info`), and the settings profile
	 * (`settings`); undefined when the client could not tell.
	 */
	private async readSettingsScope(): Promise<TuiSettingsScope | undefined> {
		const client = this.store.client;
		try {
			const [info, settings] = await Promise.all([client.query("conversation_info"), client.query("settings")]);
			return {
				cwd: info.cwd,
				projectTrusted: info.projectTrusted,
				...(settings.profile === "" ? {} : { profile: settings.profile }),
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Read the TUI's settings again when the conversation it shows runs in
	 * another cwd, project trust, or settings profile (`scope`); writes still
	 * queued finish on their own.
	 */
	private followSettings(scope: TuiSettingsScope): boolean {
		const current = this.settingsScope;
		if (
			current.cwd === scope.cwd &&
			current.projectTrusted === scope.projectTrusted &&
			current.profile === scope.profile
		) {
			return false;
		}
		this.settingsScope = scope;
		this.settingsManager = this.createDisplaySettings();
		return true;
	}

	/** The host's settings changed: in another settings profile, the TUI reads that profile's display settings. */
	private async rereadSettings(): Promise<void> {
		const conversation = this.store.conversation;
		const scope = await this.readSettingsScope();
		if (scope === undefined || this.store.conversation !== conversation || !this.followSettings(scope)) return;
		this.applyRuntimeSettings();
		this.ui.requestRender();
	}

	/**
	 * The conversation reloaded (its resources, extensions, and settings, as
	 * `/reload` or an extension's `ctx.reload()` do): the TUI reads its own
	 * settings, keybindings, and themes again and applies them.
	 */
	private async reloadTuiResources(): Promise<void> {
		const [scope, resources] = await Promise.all([
			this.readSettingsScope(),
			this.store.client.query("resources").catch(() => undefined),
		]);
		if (scope === undefined || !this.followSettings(scope)) await this.settingsManager.reload();
		this.keybindings.reload();
		if (resources !== undefined) this.resources = resources;
		this.registerThemes();
		const themeName = this.settingsManager.getTheme();
		if (themeName !== undefined) {
			const result = setTheme(themeName, true);
			if (!result.success) {
				this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
			}
		}
		this.applyRuntimeSettings();
		this.setupAutocompleteProvider();
		this.updateEditorBorderColor();
		this.ui.invalidate();
		this.ui.requestRender();
	}

	/** What the store changed: draw it. */
	private onStoreChange(change: TuiStoreChange): void {
		switch (change.type) {
			case "live":
				this.liveView.apply(change);
				if (!this.connected || this.store.conversation === undefined) return;
				this.transcript.sync(change.items);
				this.syncStatus();
				return;
			case "entries":
				if (!this.connected || this.store.conversation === undefined) return;
				this.transcript.sync();
				for (const entry of change.entries) if (entry.type === "compaction") this.showCompacted(entry);
				this.showQueueIfChanged();
				this.syncStatus();
				return;
			case "reset":
				// Before the client connected, the conversation shows once it did.
				if (!this.connected) return;
				if (change.moved) {
					this.showConversation({ afresh: true });
					void this.refreshInput();
					void this.loadMovedConversationScope();
				} else {
					this.transcript.refresh();
					this.showQueueIfChanged();
					this.syncStatus();
				}
				return;
			case "moving":
				// The live state and the catalog of the conversation the client left are not its own anymore.
				this.liveView.apply({ reset: true, items: [] });
				this.input.clear();
				this.leaveConversation();
				return;
			case "changed":
				if (change.catalog === "resources") {
					this.refreshExtensionContributions();
					if (this.connected) void this.reloadTuiResources();
				} else if (change.catalog === "intents" && this.connected) {
					void this.refreshInput();
				} else if (change.catalog === "settings" && this.connected) {
					void this.rereadSettings();
				}
				return;
			case "ended":
				this.liveView.apply({ reset: true, items: [] });
				this.syncStatus();
				if (change.reason === "lost") void this.endLostConversation();
				return;
		}
	}

	/**
	 * The TUI shows a conversation its client moved to: once the client tells
	 * where it runs and what it loaded, the TUI reads its own settings there
	 * (with the project trust warning they call for) and registers its
	 * themes. A later move follows its own conversation.
	 */
	private async loadMovedConversationScope(): Promise<void> {
		const conversation = this.store.conversation;
		const [scope, resources] = await Promise.all([
			this.readSettingsScope(),
			this.store.client.query("resources").catch(() => undefined),
		]);
		if (conversation === undefined || this.store.conversation !== conversation) return;
		if (resources !== undefined) this.resources = resources;
		if (scope !== undefined && this.followSettings(scope)) {
			this.applyRuntimeSettings();
			if (!this.trustWarningShown) this.renderProjectTrustWarningIfNeeded();
		}
		this.registerThemes();
		this.applyConfiguredTheme();
		this.ui.requestRender();
	}

	/**
	 * Show the conversation the store shows as the TUI's: what its extensions
	 * contribute, its status and plan, and its transcript, `afresh` in a
	 * cleared chat (a conversation the client moved to) or after what the chat
	 * shows (at startup). Rendering resumes once it shows.
	 */
	private showConversation(options: { afresh: boolean }): void {
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		this.clearWorkSummaryTimer();
		this.clearPromptCacheAlertTimer();
		this.workSummary = undefined;
		this.applyRuntimeSettings();
		this.showSessionExtensions();
		this.followWork();
		this.closePlanDetails();
		// A conversation the TUI moved to is a fresh presentation, so a ready plan is offered again.
		this.readyPlanFocusKey = undefined;
		this.shownFold = this.store.state;
		this.refreshPlanningUi();
		this.syncStatus();
		this.updateTerminalTitle();
		this.renderTranscript({ afresh: options.afresh });
		this.updatePendingMessagesDisplay();
		this.ui.requestRender(true);
		const suspension = this.sessionRenderSuspension;
		this.sessionRenderSuspension = undefined;
		suspension?.release();
	}

	/**
	 * The TUI leaves the conversation it shows: its client moves, or the TUI
	 * quits. Rendering stops until the next conversation shows; what the TUI
	 * showed for the conversation's extensions and work is released.
	 */
	private leaveConversation(): void {
		this.sessionRenderSuspension ??= this.ui.suspendRendering();
		this.dismissWorkInspector?.();
		this.unsubscribeWorkSource?.();
		this.unsubscribeWorkSource = undefined;
		this.stopWorkTicker();
		// The status of the conversation left behind stops showing.
		this.syncStatus();
		this.shownFold = undefined;
		this.resetExtensionUI();
	}

	/**
	 * Draw the store's transcript, `afresh` in a cleared chat, with its user
	 * messages in the editor's history, the project trust warning, and how
	 * often the conversation was compacted.
	 */
	private renderTranscript(options: { afresh: boolean }): void {
		if (options.afresh) this.transcript.rebuild();
		else this.transcript.show();
		for (const entry of this.store.transcript()) {
			const message = entry.type === "message" ? entry.payload?.message : undefined;
			if (message?.role !== "user") continue;
			const text =
				typeof message.content === "string"
					? message.content
					: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
			if (text) this.editor.addToHistory?.(text);
		}
		this.trustWarningShown = false;
		this.renderProjectTrustWarningIfNeeded();
		const compactionCount = this.store.state.entries.filter((entry) => entry.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	/**
	 * A compaction committed while the TUI showed the conversation: the
	 * transcript now starts from it, and its summary and request usage show
	 * where the conversation goes on.
	 */
	private showCompacted(entry: Extract<ProjectedEntry, { type: "compaction" }>): void {
		const payload = entry.payload;
		if (!payload) return;
		this.chatContainer.addChild(new Spacer(1));
		const summary = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage(payload.summary, payload.tokensBefore, entry.timestamp),
			this.getMarkdownThemeWithSettings(),
		);
		summary.setExpanded(this.toolOutputExpanded);
		this.chatContainer.addChild(summary);
		for (const line of formatCompactionUsage(payload.details)) {
			this.chatContainer.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		this.ui.requestRender();
	}

	/**
	 * The conversation's extensions changed (enabled, disabled, or reloaded):
	 * the transcript is projected afresh, so a disabled extension's
	 * presentations no longer show. Their commands and shortcuts follow the
	 * intents catalog, which changed with them.
	 */
	private refreshExtensionContributions(): void {
		if (!this.connected) return;
		this.store.resync();
		this.ui.requestRender();
	}

	private async handleFatalRuntimeError(
		prefix: string,
		error: unknown,
		options?: { unsentDraft?: string },
	): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		// Stopping the TUI cancels the render that would show the error, and the
		// session behind the screen may already be disposed: print it instead.
		process.stderr.write(`${prefix}: ${message}\n`);
		const unsentDraft = options?.unsentDraft?.trim();
		if (unsentDraft) {
			// The editor dies with the process; hand the draft back for copying.
			process.stderr.write(`Unsent input (not submitted before volt exited):\n${unsentDraft}\n`);
		}
		process.exit(1);
	}

	/**
	 * The work a tool call started, as the TUI's store holds it: a background
	 * job, live, with its newest output as the `work_output` query read it.
	 */
	private toolCallWork(toolCallId: string): ToolCardWork[] {
		const now = Date.now();
		return this.work.itemsOfToolCall(toolCallId).map((view) => {
			const { item, live } = view;
			const text =
				item.outcome === undefined
					? (live?.progress?.text ?? item.progress?.text)
					: (item.error ?? item.result?.summary);
			const detail = live?.detail ?? item.detail;
			const output = this.work.newestOutput(view);
			return {
				workId: item.workId,
				title: item.title,
				status: item.outcome ?? (view.suspended ? "suspended" : item.state),
				...(view.startedAt === undefined
					? {}
					: { elapsedMs: Math.max(0, (view.finishedAt ?? now) - view.startedAt) }),
				...(text === undefined ? {} : { text }),
				...(detail === undefined ? {} : { detail }),
				...(output ? { output } : {}),
			};
		});
	}

	/**
	 * Bind the extensions' shortcuts the intents catalog lists, off the TUI's
	 * reserved keys: each key invokes its intent through the TUI's client.
	 * What the TUI's own commands and keys take shows with the loaded
	 * resources.
	 */
	private setupExtensionShortcuts(): void {
		const shortcutDiagnostics = this.extensionShortcuts.bind(this.input.catalog.shortcuts);
		this.inputDiagnostics = [
			...this.input.commandConflicts(new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name))),
			...shortcutDiagnostics,
		];
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			const intent = this.extensionShortcuts.intentFor(data);
			if (intent === undefined) return false;
			if (isKeyRelease(data) || isKeyRepeat(data)) return true;
			// Invoke async, without blocking input.
			this.input.invokeShortcut(intent).catch((error: unknown) => {
				this.showError(`Shortcut failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return true;
		};
	}

	private getWorkingLoaderMessage(): string {
		const base = this.defaultWorkingMessage;
		if (this.turnStartedAt === undefined) return base;
		const elapsed = formatElapsedDuration(Date.now() - this.turnStartedAt);
		return `${base} (${elapsed} · ${keyText("app.interrupt")} to interrupt)`;
	}

	private startWorkingElapsedTicker(): void {
		this.stopWorkingElapsedTicker();
		this.workingElapsedTimer = setInterval(() => {
			this.loadingAnimation?.setMessage(this.getWorkingLoaderMessage());
		}, 1000);
	}

	private stopWorkingElapsedTicker(): void {
		if (this.workingElapsedTimer) {
			clearInterval(this.workingElapsedTimer);
			this.workingElapsedTimer = undefined;
		}
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
		);
	}

	private clearTurnDoneAlertTimer(): void {
		if (!this.turnDoneAlertTimer) return;
		clearTimeout(this.turnDoneAlertTimer);
		this.turnDoneAlertTimer = undefined;
	}

	/** A run ended: alert once the conversation is idle, unless the run was aborted. */
	private scheduleTurnDoneAlert(aborted: boolean): void {
		this.clearTurnDoneAlertTimer();
		if (this.settingsManager.getTurnDoneAlert() === "off" || aborted || this.shutdownRequested) {
			return;
		}
		this.scheduleTurnDoneAlertTimer(0);
	}

	private clearPromptCacheAlertTimer(): void {
		if (this.promptCacheAlertTimer) clearTimeout(this.promptCacheAlertTimer);
		this.promptCacheAlertTimer = undefined;
		this.promptCacheAlertAt = undefined;
	}

	/** The prompt-cache retention of the conversation the TUI shows, as its live state holds it. */
	private promptCacheStatus(): Extract<LiveValue, { kind: "prompt_cache" }>["promptCache"] {
		const value = this.store.value("prompt_cache");
		return value?.kind === "prompt_cache" ? value.promptCache : null;
	}

	/** When idle keepalive ends, alert through the turn-done channel that the cache will now lapse. */
	private schedulePromptCacheAlert(): void {
		const status = this.promptCacheStatus();
		const until = status?.kind === "retained" ? status.keepAliveUntil : undefined;
		if (until === this.promptCacheAlertAt) return;
		this.clearPromptCacheAlertTimer();
		if (until === undefined || this.settingsManager.getTurnDoneAlert() === "off") return;
		this.promptCacheAlertAt = until;
		this.promptCacheAlertTimer = setTimeout(
			() => {
				this.promptCacheAlertTimer = undefined;
				this.promptCacheAlertAt = undefined;
				const mode = this.settingsManager.getTurnDoneAlert();
				if (mode === "off" || this.shutdownRequested || this.isShuttingDown || this.runActive()) return;
				if (this.ui.terminal.focusState === "focused") return;
				const current = this.promptCacheStatus();
				if (current?.kind !== "retained" || current.expiresAt === undefined) return;
				const remaining = current.expiresAt - Date.now();
				if (remaining <= 0) return;
				if (mode === "notify") {
					const dir = path.basename(this.catalogs.conversationInfo?.cwd ?? "");
					this.ui.terminal.notify("Volt", `Prompt cache expires in ${Math.ceil(remaining / 60_000)}m · ${dir}`);
				} else {
					this.ui.terminal.alert();
				}
			},
			Math.max(0, until - Date.now()),
		);
		this.promptCacheAlertTimer.unref?.();
	}

	private clearWorkSummaryTimer(): void {
		if (!this.workSummaryTimer) return;
		clearTimeout(this.workSummaryTimer);
		this.workSummaryTimer = undefined;
	}

	/** After settlement, record how long the operation ran and when it finished unless new work starts first. */
	private scheduleWorkSummary(): void {
		this.clearWorkSummaryTimer();
		const summary = this.workSummary;
		this.workSummary = undefined;
		if (!summary || summary.aborted || this.shutdownRequested) return;
		const doneAt = Date.now();
		const text = `Worked for ${formatElapsedDuration(doneAt - summary.startedAt)} · done ${formatClockTime(doneAt)}`;
		this.workSummaryTimer = setTimeout(() => {
			this.workSummaryTimer = undefined;
			if (this.isShuttingDown || this.runActive() || this.store.phase?.compaction !== undefined) return;
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(theme.fg("dim", text), 1, 0));
			this.ui.requestRender();
		}, WORK_SUMMARY_IDLE_MS);
	}

	private scheduleTurnDoneAlertTimer(delayMs: number): void {
		this.turnDoneAlertTimer = setTimeout(() => {
			this.turnDoneAlertTimer = undefined;
			if (this.settingsManager.getTurnDoneAlert() === "off" || this.shutdownRequested || this.isShuttingDown) {
				return;
			}
			const phase = this.store.phase;
			if (phase?.run !== undefined || phase?.compaction !== undefined || phase?.retry !== undefined) {
				this.scheduleTurnDoneAlertTimer(TURN_DONE_ALERT_BUSY_RETRY_MS);
				return;
			}

			// Skip the alert when the terminal reports that it is focused - the user
			// is already looking at it. Terminals without focus reporting stay
			// "unknown" and keep alerting as before.
			if (this.ui.terminal.focusState === "focused") {
				return;
			}

			if (this.settingsManager.getTurnDoneAlert() === "notify") {
				const dir = path.basename(this.catalogs.conversationInfo?.cwd ?? "");
				const status = this.planning().plan?.phase === "ready" ? "Plan ready for approval" : "Finished responding";
				this.ui.terminal.notify("Volt", `${status} · ${dir}`);
			} else {
				this.ui.terminal.alert();
			}
		}, delayMs);
	}

	/**
	 * Reset the TUI's UI for the extensions of a conversation it leaves:
	 * pending dialogs, completions, and shortcuts. Status, panels, title, and
	 * the dialogs of the live state stay with the live view, which follows the
	 * live state of the conversation the TUI shows.
	 */
	private resetExtensionUI(): void {
		this.dismissWorkInspector?.();
		this.dismissPendingExtensionDialogs();
		this.clearTurnDoneAlertTimer();
		this.clearPromptCacheAlertTimer();
		this.leavePanels();
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.extensionShortcuts.clear();
	}

	/** Lay out the rows around the editor: a blank line, then the panels above it; the panels below it. */
	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.widgetContainerAbove.clear();
		this.widgetContainerAbove.addChild(new Spacer(1));
		this.widgetContainerAbove.addChild(this.panels.aboveEditor);
		this.widgetContainerBelow.clear();
		this.widgetContainerBelow.addChild(this.panels.belowEditor);
		this.ui.requestRender();
	}

	/** Whether sidebar panels show in fullscreen's sidebar; otherwise they show above the editor. */
	private showsPanelSidebar(): boolean {
		return (
			this.ui.mode === "fullscreen" &&
			this.ui.terminal.columns >= PANEL_SIDEBAR_MIN_TERMINAL_COLUMNS &&
			this.mainView?.isTerminalSplit() !== true
		);
	}

	/** Show, update, or remove an extension panel under its live key. */
	private setExtensionPanel(key: string, panel: Parameters<UiPanels["set"]>[1]): void {
		try {
			this.panels.set(key, panel);
		} catch (error) {
			this.showError(`Extension panel ${key}: ${error instanceof Error ? error.message : String(error)}`);
		}
		// Focus in the panels follows what they show now.
		if (this.ui.getFocusedComponent() === this.panelFocus) {
			const focusables = this.panels.focusables(this.panelMode());
			if (focusables.length === 0) this.leavePanels();
			else this.panelFocus.setChildren(focusables);
		}
		this.ui.requestRender();
	}

	private panelMode(): TuiMode {
		return this.showsPanelSidebar() ? "fullscreen" : "regular";
	}

	/** Give the keyboard to the panels' first action, form, or tree; false when they show none. */
	private focusPanels(): boolean {
		const focusables = this.panels.focusables(this.panelMode());
		if (focusables.length === 0) return false;
		this.panelFocus.setChildren(focusables);
		if (!this.panelFocus.enterFocus(1)) return false;
		this.ui.setFocus(this.panelFocus);
		this.ui.requestRender();
		return true;
	}

	/** Give the keyboard back to the editor when the panels have it. */
	private leavePanels(): void {
		if (this.ui.getFocusedComponent() !== this.panelFocus) return;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private createLiveView(): TuiLiveView {
		return new TuiLiveView({
			showRequest: (request, signal) => this.showLiveRequest(request, signal),
			showProviderAuth: (request, signal) => this.showProviderAuth(request, signal),
			answer: (requestId, response) => this.store.client.answer(requestId, response),
			setPanel: (key, panel) => this.setExtensionPanel(key, panel),
			setTitle: (title) => {
				this.extensionTitle = title;
				if (title === undefined) this.updateTerminalTitle();
				else this.ui.terminal.setTitle(title);
			},
			notify: (level, message, source, detail) => this.showNotice(level, message, source, detail),
			setEditorText: (text) => this.editor.setText(text),
			setTheme: (themeName) => this.applyExtensionTheme(themeName),
			// Pasted as one bracketed paste: text that ended the paste could type keys into the editor.
			insertEditorText: (text) => this.editor.handleInput(`\x1b[200~${stripTerminalControls(text)}\x1b[201~`),
			editorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			workDetached: (workId) => this.showWorkEnd(workId),
			liveValue: (key) => this.store.value(key),
		});
	}

	/**
	 * Show a dialog or approval of the live state until the user answers it or
	 * the live view closes it: the answer, or undefined when it closed without one.
	 */
	private async showLiveRequest(request: HostRequest, signal: AbortSignal): Promise<HostResponse | undefined> {
		const options = { signal, live: true, ...("timeoutMs" in request ? { timeout: request.timeoutMs } : {}) };
		switch (request.kind) {
			case "select": {
				const outcome = await this.showExtensionSelectorOutcome(request.title, request.options, options);
				if (outcome.kind === "dismissed") return undefined;
				return outcome.kind === "selected" ? { value: outcome.option } : { cancelled: true };
			}
			case "confirm": {
				const outcome = await this.showExtensionSelectorOutcome(
					`${request.title}\n${request.message}`,
					["Yes", "No"],
					options,
				);
				if (outcome.kind === "dismissed") return undefined;
				return outcome.kind === "selected" ? { confirmed: outcome.option === "Yes" } : { cancelled: true };
			}
			case "input": {
				// What the provider login this TUI runs asks shows in its sign-in dialog, below the page to open.
				const signIn = this.signIn === undefined ? undefined : this.signInView;
				if (signIn) {
					const answer = await Promise.race([
						signIn.dialog
							.showPrompt(request.title, request.placeholder, { secret: request.secret === true })
							.then(
								(value): HostResponse => ({ value }),
								(): HostResponse => ({ cancelled: true }),
							),
						new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined))),
					]);
					return signal.aborted ? undefined : answer;
				}
				const value = await this.showExtensionInput(request.title, request.placeholder, {
					...options,
					secret: request.secret === true,
				});
				if (signal.aborted) return undefined;
				return value === undefined ? { cancelled: true } : { value };
			}
			case "editor": {
				const value = await this.showExtensionEditor(request.title, request.prefill, options);
				if (signal.aborted) return undefined;
				return value === undefined ? { cancelled: true } : { value };
			}
			case "approval": {
				const details = [request.message, request.commandPreview ? `Command: ${request.commandPreview}` : undefined]
					.filter((line): line is string => line !== undefined && line.length > 0)
					.join("\n\n");
				const outcome = await this.showExtensionSelectorOutcome(
					`${request.title}\n${details}`,
					["Yes", "No"],
					options,
				);
				if (outcome.kind === "dismissed") return undefined;
				return { decision: outcome.kind === "selected" && outcome.option === "Yes" ? "approved" : "denied" };
			}
			case "form":
			case "dialog":
				return this.showHostRequestDialog(request, options);
			case "user_input": {
				// The request_user_input tool's questions, in the conversation with keyboard focus.
				const response = await promptUserInput(
					(create) => this.mountUserInputDialog(create),
					{ questions: request.questions },
					signal,
				);
				if (signal.aborted) return undefined;
				return response.status === "answered" || response.status === "skipped"
					? { status: response.status, answers: response.answers }
					: { cancelled: true };
			}
			default:
				// MCP authorization is not shown in the TUI; a provider sign-in shows beside the queue
				// (showProviderAuth), and the editor answers `editor_text` at once.
				return undefined;
		}
	}

	/** Show a form or dialog request until it is answered, cancelled, or dismissed by `options.signal`. */
	private showHostRequestDialog(
		request: Extract<HostRequest, { kind: "form" | "dialog" }>,
		options: TuiDialogOptions,
	): Promise<HostResponse | undefined> {
		return new Promise((resolve) => {
			if (options.signal?.aborted) {
				resolve(undefined);
				return;
			}
			const restore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			let settled = false;
			let component: HostFormDialogComponent | HostDialogComponent | undefined;
			const settle = (response: HostResponse | undefined): void => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", dismiss);
				component?.dispose();
				this.activateView(restore.view, restore.focus ?? this.editor);
				resolve(response);
			};
			const dismiss = (): void => settle(undefined);
			const cancel = (): void => settle({ cancelled: true });
			options.signal?.addEventListener("abort", dismiss, { once: true });
			this.dismissWorkInspector?.();
			const dialogOptions = { tui: this.ui, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) };
			component =
				request.kind === "form"
					? new HostFormDialogComponent(request, (values) => settle({ values }), cancel, dialogOptions)
					: new HostDialogComponent(request, (value) => settle({ value }), cancel, {
							...dialogOptions,
							intents: createClientIntentSink({
								client: () => this.store.client,
								onError: (message) => this.showError(message),
							}),
						});
			this.activateView(this.createDedicatedView(component), component);
		});
	}

	/**
	 * Show a notice of the host or an extension: info dimmed with its
	 * styling, warnings and errors in their color. An extension's error with
	 * detail, its runtime's error and stack, names the extension.
	 */
	private showNotice(
		level: "info" | "warning" | "error",
		message: UiNodeStyledText,
		source: string | undefined,
		detail: string | undefined,
	): void {
		if (level === "error" && detail !== undefined && source !== undefined && source !== HOST_NOTICE_SOURCE) {
			this.showExtensionError(source, styledTextToPlain(message), detail);
			return;
		}
		if (level === "info") this.showStatus(renderStyledText(message, TUI_SEMANTIC_THEME, "muted"));
		else this.showExtensionNotify(styledTextToPlain(message), level);
	}

	/** An extension's runtime error, and its stack dimmed and indented. */
	private showExtensionError(extensionId: string, error: string, stack: string): void {
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"error",
					`Extension "${stripTerminalControls(extensionId)}" error: ${stripTerminalControls(error)}`,
				),
				1,
				0,
			),
		);
		const stackLines = stack
			.split("\n")
			.slice(1) // The first line repeats the message.
			.map((line) => theme.fg("dim", `  ${stripTerminalControls(line).trim()}`))
			.join("\n");
		if (stackLines) this.chatContainer.addChild(new Text(stackLines, 1, 0));
		this.ui.requestRender();
	}

	/**
	 * Work whose executor detached ended: when it finished and nothing else
	 * reports its end (it delivers no notice, and no tool call waits on it),
	 * a status line says how.
	 */
	private showWorkEnd(workId: string): void {
		const item = this.work.item(workId);
		if (item?.outcome === undefined || item.delivery !== "none" || item.toolCallId !== undefined) return;
		const line = workOutcomeLine(item);
		if (line.warning) this.showWarning(line.text);
		else this.showStatus(line.text);
	}

	/** Follow the work of the conversation the TUI shows: the footer's work line and the queued notices. */
	private followWork(): void {
		this.unsubscribeWorkSource?.();
		this.unsubscribeWorkSource = this.work.subscribe(() => {
			this.workStatus.invalidate();
			this.updatePendingMessagesDisplay();
			this.workRowsCoalescer.update(undefined);
			this.ui.requestRender();
		});
		this.workRows = new Map();
		this.showToolCallWork();
	}

	/**
	 * Tool calls show the work they started live: a row reads its work again
	 * when it changed, and every second while it runs.
	 */
	private showToolCallWork(): void {
		const shown = new Map<string, string>();
		const running = new Set<string>();
		for (const view of this.work.items()) {
			const { item, live } = view;
			if (item.toolCallId === undefined) continue;
			if (item.outcome === undefined) running.add(item.toolCallId);
			// Its row shows its newest output: read it again as soon as it may have changed.
			this.work.newestOutput(view);
			const state = [
				item.workId,
				item.state,
				item.outcome,
				item.updatedOrdinal,
				live?.progress?.text,
				live?.output?.bytes,
				this.work.outputVersion(item.workId),
			];
			shown.set(item.toolCallId, `${shown.get(item.toolCallId) ?? ""}${JSON.stringify(state)}`);
		}
		const changed = new Set<string>();
		for (const [toolCallId, state] of shown) if (this.workRows.get(toolCallId) !== state) changed.add(toolCallId);
		for (const toolCallId of this.workRows.keys()) if (!shown.has(toolCallId)) changed.add(toolCallId);
		this.workRows = shown;
		if (changed.size > 0) {
			this.transcript.invalidateWork(changed);
			this.ui.requestRender();
		}
		this.stopWorkTicker();
		if (running.size > 0) {
			this.workTicker = setInterval(() => {
				this.transcript.invalidateWork(running);
				this.ui.requestRender();
			}, 1000);
			this.workTicker.unref?.();
		}
	}

	private stopWorkTicker(): void {
		if (this.workTicker !== undefined) clearInterval(this.workTicker);
		this.workTicker = undefined;
	}

	/**
	 * Settle every pending extension dialog as dismissed, newest first so view
	 * restoration unwinds in reverse opening order.
	 */
	private dismissPendingExtensionDialogs(): void {
		for (const dismiss of [...this.pendingExtensionDialogs].reverse()) dismiss();
	}

	/**
	 * Show a selector for extensions.
	 */
	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.showExtensionSelectorOutcome(title, options, opts).then((outcome) =>
			outcome.kind === "selected" ? outcome.option : undefined,
		);
	}

	private showExtensionSelectorOutcome(
		title: string,
		options: string[],
		opts?: TuiDialogOptions,
	): Promise<ExtensionSelectorOutcome> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve({ kind: "dismissed" });
				return;
			}

			let settled = false;
			const settle = (outcome: ExtensionSelectorOutcome) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", dismiss);
				this.pendingExtensionDialogs.delete(dismiss);
				this.hideExtensionSelector();
				resolve(outcome);
			};
			const dismiss = () => settle({ kind: "dismissed" });
			opts?.signal?.addEventListener("abort", dismiss, { once: true });
			if (!opts?.live) this.pendingExtensionDialogs.add(dismiss);

			this.dismissWorkInspector?.();
			this.extensionSelectorRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => settle({ kind: "selected", option }),
				() => settle({ kind: "cancelled" }),
				{ tui: this.ui, timeout: opts?.timeout, onToggleToolsExpanded: () => this.toggleToolOutputExpansion() },
			);

			this.activateView(this.createDedicatedView(this.extensionSelector), this.extensionSelector);
		});
	}

	/**
	 * Hide the extension selector.
	 */
	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		const restore = this.extensionSelectorRestore;
		this.extensionSelectorRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Show a confirmation dialog for extensions.
	 */
	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	/**
	 * A session's working directory is gone (the host said why, `reason`):
	 * the current one when the user continues there, else undefined. A
	 * session of a daemon-managed worktree whose checkout is missing
	 * (`sessionCwd`, when known) never runs in another directory.
	 */
	private async continueInCurrentCwd(reason: string, sessionCwd: string | undefined): Promise<string | undefined> {
		if (sessionCwd !== undefined && isPathUnderWorktreesRoot(getAgentDir(), sessionCwd)) {
			this.showError(
				`This session ran in a daemon-managed worktree whose checkout is missing: ${sessionCwd}. ` +
					"Recreate the worktree (volt remote worktree add) or remove the session; refusing to open it in another directory.",
			);
			return undefined;
		}
		const cwd = (await this.sessions.info()).cwd;
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			sessionCwd === undefined
				? `${reason}\n\ncontinue in current cwd\n${cwd}`
				: formatMissingSessionCwdPrompt({ sessionCwd, fallbackCwd: cwd }),
		);
		return confirmed ? cwd : undefined;
	}

	/**
	 * Show a text input for extensions.
	 */
	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: TuiDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			let settled = false;
			const settle = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", dismiss);
				this.pendingExtensionDialogs.delete(dismiss);
				this.hideExtensionInput();
				resolve(value);
			};
			const dismiss = () => settle(undefined);
			opts?.signal?.addEventListener("abort", dismiss, { once: true });
			if (!opts?.live) this.pendingExtensionDialogs.add(dismiss);

			this.dismissWorkInspector?.();
			this.extensionInputRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionInput = new ExtensionInputComponent(title, placeholder, (value) => settle(value), dismiss, {
				tui: this.ui,
				timeout: opts?.timeout,
				secret: opts?.secret === true,
			});

			this.activateView(this.createDedicatedView(this.extensionInput), this.extensionInput);
		});
	}

	/**
	 * Hide the extension input.
	 */
	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		const restore = this.extensionInputRestore;
		this.extensionInputRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Show a multi-line editor for extensions (with Ctrl+G support).
	 */
	private showExtensionEditor(title: string, prefill?: string, opts?: TuiDialogOptions): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			let settled = false;
			const settle = (value: string | undefined) => {
				if (settled) return;
				settled = true;
				opts?.signal?.removeEventListener("abort", dismiss);
				this.pendingExtensionDialogs.delete(dismiss);
				this.hideExtensionEditor();
				resolve(value);
			};
			const dismiss = () => settle(undefined);
			opts?.signal?.addEventListener("abort", dismiss, { once: true });
			if (!opts?.live) this.pendingExtensionDialogs.add(dismiss);

			this.dismissWorkInspector?.();
			this.extensionEditorRestore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => settle(value),
				dismiss,
			);

			this.activateView(this.createDedicatedView(this.extensionEditor), this.extensionEditor);
		});
	}

	/**
	 * Hide the extension editor.
	 */
	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		const restore = this.extensionEditorRestore;
		this.extensionEditorRestore = undefined;
		if (restore) this.activateView(restore.view, restore.focus ?? this.editor);
		else {
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		}
	}

	/**
	 * Show a notification for extensions.
	 */
	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/**
	 * Show the request_user_input dialog `create` builds in the conversation,
	 * with keyboard focus, until it answers; the editor and its draft stay as
	 * they are. Rejects when the TUI dismisses its pending dialogs first.
	 */
	private mountUserInputDialog(create: UserInputDialogFactory): Promise<UserInputResponse> {
		this.dismissWorkInspector?.();
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		return new Promise((resolve, reject) => {
			let mounted = false;
			let closed = false;
			const finish = (): boolean => {
				if (closed) return false;
				closed = true;
				this.pendingExtensionDialogs.delete(dismiss);
				if (mounted) {
					this.editorContainer.clear();
					this.editorContainer.addChild(this.editor);
					this.activateView(previousView, previousFocus ?? this.editor, false);
				}
				return true;
			};
			const dismiss = (): void => {
				if (finish()) reject(new Error("The question was dismissed before it was answered"));
			};
			const dialog = create(this.ui, theme, this.keybindings, (response) => {
				if (finish()) resolve(response);
			});
			// Answered (cancelled) while it was built: it never shows.
			if (closed) return;
			this.pendingExtensionDialogs.add(dismiss);
			mounted = true;
			// The question stays in the conversation with its status, footer, and plan pane.
			this.editorContainer.clear();
			this.editorContainer.addChild(dialog);
			this.activateView(this.conversationView, dialog);
		});
	}

	private createScratchDirectory(prefix: string): string {
		const directoryPath = createPrivateTempDirectorySync(path.join(os.tmpdir(), prefix));
		this.scratchDirectories.add(directoryPath);
		return directoryPath;
	}

	private removeScratchDirectory(directoryPath: string): void {
		try {
			fs.rmSync(directoryPath, { recursive: true, force: true });
			this.scratchDirectories.delete(directoryPath);
			if (this.lspTraceScratchDirectory === directoryPath) {
				this.lspTraceScratchDirectory = undefined;
			}
			for (const [filePath, scratchDirectory] of this.clipboardScratchFiles) {
				if (scratchDirectory === directoryPath) {
					this.clipboardScratchFiles.delete(filePath);
				}
			}
		} catch {
			// Cleanup is retried during shutdown.
		}
	}

	private cleanupClipboardScratchFilesInText(text: string): void {
		this.cleanupClipboardScratchFiles(
			[...this.clipboardScratchFiles.keys()].filter((filePath) => text.includes(filePath)),
		);
	}

	private cleanupClipboardScratchFiles(filePaths: readonly string[]): void {
		for (const filePath of filePaths) {
			const directoryPath = this.clipboardScratchFiles.get(filePath);
			if (directoryPath) {
				this.removeScratchDirectory(directoryPath);
			}
		}
	}

	private cleanupAllScratchDirectories(): void {
		for (const directoryPath of [...this.scratchDirectories]) {
			this.removeScratchDirectory(directoryPath);
		}
	}

	/** Stop the language server trace `/lsp trace` started, and remove its scratch file. */
	private async closeLspTrace(): Promise<void> {
		if (this.lspTracing) {
			this.lspTracing = false;
			await this.store.client.intent("lsp.set_trace", { path: null }).catch(() => undefined);
		}
		if (this.lspTraceScratchDirectory) {
			this.removeScratchDirectory(this.lspTraceScratchDirectory);
		}
	}

	// =========================================================================
	// Key Handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			// The client moves: nothing runs here to stop, and the conversation it moves to shows soon.
			if (this.store.moving !== undefined) return;
			const target = this.connected ? this.input.interruptible() : undefined;
			if (target !== undefined) {
				this.runKeyAction(() => this.interrupt(target));
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				// Double-escape with empty editor triggers /tree, /fork, or nothing based on setting
				const action = this.settingsManager.getDoubleEscapeAction();
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						if (action === "tree") {
							this.showTreeSelector();
						} else {
							this.showUserMessageSelector();
						}
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		// Register app action handlers
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.thinking.cycle", () => this.runKeyAction(() => this.cycleThinkingLevel()));
		this.defaultEditor.onAction("app.mode.toggle", () => this.runKeyAction(() => this.toggleAgentMode()));
		this.defaultEditor.onAction("app.model.cycleForward", () => this.runKeyAction(() => this.cycleModel("forward")));
		this.defaultEditor.onAction("app.model.cycleBackward", () =>
			this.runKeyAction(() => this.cycleModel("backward")),
		);

		this.setupGlobalInputRouting();
		this.defaultEditor.onAction("app.model.select", () => this.runKeyAction(() => this.handleModelCommand()));
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => this.runKeyAction(() => this.openExternalEditor()));
		this.defaultEditor.onAction("app.message.followUp", () => this.runKeyAction(() => this.handleFollowUp()));
		this.defaultEditor.onAction("app.message.dequeue", () => this.runKeyAction(() => this.handleDequeue()));
		this.defaultEditor.onAction("app.session.new", () => this.runKeyAction(() => this.handleClearCommand()));
		this.defaultEditor.onAction("app.session.tree", () => this.showTreeSelector());
		this.defaultEditor.onAction("app.session.fork", () => this.showUserMessageSelector());
		this.defaultEditor.onAction("app.session.resume", () => this.showSessionSelector());

		let previousEditorText = this.editor.getText();
		this.defaultEditor.onChange = (text, change) => {
			if (text !== previousEditorText) {
				this.lastSigintTime = 0;
				// Keep intent while composing /quit, including completion whitespace,
				// and through submission. Other drafts or deletion withdraw that intent.
				if (
					change?.submittedText !== "/quit" &&
					(!"/quit".startsWith(text.trim()) || !text.startsWith(previousEditorText))
				)
					this.quitConfirmation = undefined;
				previousEditorText = text;
			}
			const wasBashMode = this.isBashMode;
			const hadText = this.editorHasText;
			this.isBashMode = text.trimStart().startsWith("!");
			this.editorHasText = text.length > 0;
			if (wasBashMode !== this.isBashMode || (this.runActive() && hadText !== this.editorHasText)) {
				this.updateEditorBorderColor();
			}
		};

		// Handle clipboard image paste (triggered on Ctrl+V)
		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private setupGlobalInputRouting(): void {
		this.globalInputUnsubscribe?.();
		this.globalInputUnsubscribe = this.ui.addInputListener((data) => {
			// Tab from an empty editor goes to the extension panels' actions, forms, and trees.
			if (
				this.keybindings.matches(data, "tui.focus.next") &&
				!isKeyRelease(data) &&
				this.activeView === this.conversationView &&
				this.ui.getFocusedComponent() === this.editor &&
				this.editor.getText().length === 0 &&
				!this.defaultEditor.isShowingAutocomplete() &&
				this.focusPanels()
			) {
				return { consume: true };
			}
			if (this.keybindings.matches(data, "app.work.open")) {
				if (!isKeyRelease(data) && !isKeyRepeat(data)) {
					if (this.workOverlay?.isFocused()) this.workInspector?.handleInput(data);
					else this.showWorkInspector();
				}
				return { consume: true };
			}
			if (!this.keybindings.matches(data, "app.debug")) return undefined;
			if (!isKeyRelease(data) && !isKeyRepeat(data)) {
				this.runKeyAction(() => this.handleDebugCommand());
			}
			return { consume: true };
		});
	}

	private setupPlanPaneInputRouting(): void {
		this.planPaneInputUnsubscribe?.();
		this.planPaneInputUnsubscribe = this.ui.addInputListener((data) => {
			if (
				isKeyRelease(data) ||
				this.activeView !== this.conversationView ||
				!this.keybindings.matches(data, "app.plan.togglePane")
			) {
				return undefined;
			}
			const focused = this.ui.getFocusedComponent();
			if (
				focused !== this.planInspector &&
				focused !== this.planDetails &&
				(focused === null || !this.editorContainer.children.includes(focused))
			) {
				return undefined;
			}
			this.togglePlanPaneFocus();
			return { consume: true };
		});
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch {
			// Clipboard paste is best-effort.
		}
	}

	private async handleClipboardImagePaste(): Promise<void> {
		let scratchDirectory: string | undefined;
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			scratchDirectory = this.createScratchDirectory("volt-clipboard-");
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = path.join(scratchDirectory, `image.${ext}`);
			writePrivateNewFileSync(filePath, Buffer.from(image.bytes));
			this.clipboardScratchFiles.set(filePath, scratchDirectory);

			// Insert file path directly
			this.editor.insertTextAtCursor?.(filePath);
			this.ui.requestRender();
		} catch {
			if (scratchDirectory) {
				this.removeScratchDirectory(scratchDirectory);
			}
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	/**
	 * Scan submitted prompt text for image file paths and load them as
	 * attachments. Returns undefined for text-only models (paths stay plain
	 * text), which the conversation's model in the `models` catalog says.
	 */
	private async collectPromptImages(text: string): Promise<ImageContent[] | undefined> {
		if (!mayAttachImages(text)) return undefined;
		let result: Awaited<ReturnType<typeof collectPromptImageAttachments>>;
		try {
			result = await collectPromptImageAttachments(text, process.cwd(), await this.input.model());
		} catch {
			return undefined;
		}
		if (!result) {
			return undefined;
		}
		try {
			if (result.attachedPaths.length > 0) {
				const names = result.attachedPaths.map((filePath) => path.basename(filePath));
				this.showStatus(`[attached ${names.join(", ")} as image${names.length > 1 ? "s" : ""}]`);
			}
			if (result.cappedPaths.length > 0) {
				this.showWarning(
					`Only the first ${MAX_PROMPT_IMAGE_ATTACHMENTS} images were attached; ${result.cappedPaths.length} more left as plain text.`,
				);
			}
			if (result.failedPaths.length > 0) {
				this.showWarning(
					`Could not attach ${result.failedPaths.map((filePath) => path.basename(filePath)).join(", ")} (unreadable or too large); left as plain text.`,
				);
			}
			return result.images.length > 0 ? result.images : undefined;
		} finally {
			// Attached images have already been copied into the model payload. Capped
			// or failed paths remain available as plain-text file references.
			this.cleanupClipboardScratchFiles(result.attachedPaths);
		}
	}

	private setupEditorSubmitHandler(): void {
		const submit = async (text: string): Promise<void> => {
			text = text.trim();
			if (!text) return;

			// Local inspection never enters prompt admission or the foreground wait queue.
			if (text === "/work") {
				this.editor.setText("");
				this.showWorkInspector();
				return;
			}

			// Handle commands
			if (text === "/plan" || text === "/build") {
				this.editor.setText("");
				const mode = text === "/plan" ? "plan" : "build";
				try {
					await this.clientConnected.promise;
					// The plan UI follows the mode as the client fold applies it.
					await this.store.client.intent("set_agent_mode", { mode });
					this.showStatus(mode === "plan" ? "Plan mode: agent tools are read-only" : "Build mode");
				} catch (error: unknown) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
				return;
			}
			if (text === "/plan-details") {
				this.editor.setText("");
				this.showPlanDetails();
				return;
			}
			if (text === "/plan-close") {
				this.editor.setText("");
				await this.closeFinishedPlan();
				return;
			}
			if (text === "/settings") {
				this.editor.setText("");
				await this.showSettingsSelector();
				return;
			}
			if (text === "/profile" || text.startsWith("/profile ")) {
				const profileName = text.startsWith("/profile ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleProfileCommand(profileName);
				return;
			}
			if (text === "/scoped-models") {
				this.editor.setText("");
				await this.showModelsSelector();
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/fast" || text.startsWith("/fast ")) {
				this.editor.setText("");
				await this.handleFastCommand(text);
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				await this.handleExportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/import" || text.startsWith("/import ")) {
				await this.handleImportCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/share") {
				await this.handleShareCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				await this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.editor.setText("");
				await this.handleSessionCommand();
				return;
			}
			if (text === "/usage") {
				this.editor.setText("");
				await this.handleUsageCommand();
				return;
			}
			if (text === "/lsp" || text.startsWith("/lsp ")) {
				await this.handleLspCommand(text.startsWith("/lsp ") ? text.slice(5).trim() : undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/mcp" || text.startsWith("/mcp ")) {
				await this.handleMcpCommand(text.startsWith("/mcp ") ? text.slice(5).trim() : undefined);
				this.editor.setText("");
				return;
			}
			if (text === "/changelog") {
				this.handleChangelogCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/remote") {
				this.editor.setText("");
				await this.showRemoteControlCenter();
				return;
			}
			if (text === "/fork") {
				this.showUserMessageSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/clone") {
				this.editor.setText("");
				await this.handleCloneCommand();
				return;
			}
			if (text === "/tree") {
				this.showTreeSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/trust") {
				this.editor.setText("");
				await this.showTrustSelector();
				return;
			}
			if (text === "/worktree" || text.startsWith("/worktree ")) {
				const worktreeArgs = text === "/worktree" ? "" : text.slice("/worktree ".length).trim();
				this.editor.setText("");
				await this.handleWorktreeCommand(worktreeArgs);
				return;
			}
			if (text === "/store" || text.startsWith("/store ")) {
				const args = text === "/store" ? "" : text.slice(7).trim();
				this.editor.setText("");
				await this.handleStoreInteractiveCommand(args);
				return;
			}
			if (text === "/extensions" || text.startsWith("/extensions ")) {
				const extensionId = text.slice("/extensions".length).trim();
				this.editor.setText("");
				await this.handleExtensionsInteractiveCommand(extensionId);
				return;
			}
			if (text === "/login") {
				this.showOAuthSelector("login");
				this.editor.setText("");
				return;
			}
			if (text === "/logout") {
				this.showOAuthSelector("logout");
				this.editor.setText("");
				return;
			}
			if (text === "/clear") {
				this.editor.setText("");
				await this.handleClearCommand();
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/review" || text.startsWith("/review ")) {
				const reviewArgs = text.startsWith("/review ") ? text.slice(8) : "";
				this.editor.setText("");
				await this.handleReviewCommand(reviewArgs);
				return;
			}
			if (text === "/reload") {
				this.editor.setText("");
				await this.handleReloadCommand();
				return;
			}
			if (text === "/debug") {
				this.runKeyAction(() => this.handleDebugCommand());
				this.editor.setText("");
				return;
			}
			if (text === "/arminsayshi") {
				this.handleArminSaysHi();
				this.editor.setText("");
				return;
			}
			if (text === "/voltannouncement") {
				this.handleVoltAnnouncement();
				this.editor.setText("");
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.requestQuit();
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context): the host runs it.
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					await this.clientConnected.promise;
					await this.store.settled();
					if (this.input.bashRunning()) {
						this.showWarning("A bash command is already running. Press Esc to cancel it first.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory?.(text);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					try {
						await this.input.runBash(command, isExcluded);
					} catch (error) {
						this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
					}
					return;
				}
			}

			this.editor.addToHistory?.(text);
			await this.sendText(text, { followUp: false });
		};
		this.defaultEditor.onSubmit = async (text: string) => {
			try {
				await submit(text);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		};
	}

	/**
	 * The conversation the TUI shows lost its log (`ended{lost}`): its session
	 * could not confirm a commit (a fence conflict, a missing session, or an
	 * outcome that could not be resolved), so it may no longer be the only
	 * writer of its log. The TUI disposes its host, which releases the
	 * session's lock, and exits. The store keeps what was committed; /resume
	 * reopens it.
	 */
	private async endLostConversation(): Promise<void> {
		if (this.isShuttingDown || this.endingLostSession) return;
		this.endingLostSession = true;
		this.connector.stopServing();
		const unsentDraft = this.editor.getText();
		// Pending dialogs settle as dismissed, so no caller waits on UI that is gone.
		this.resetExtensionUI();
		await this.disposeRuntimeHost().catch(() => {});
		const cause = this.lostCause?.message ?? "Its log could not be confirmed";
		await this.handleFatalRuntimeError(
			"Volt stopped this session because its saved state could not be confirmed",
			new Error(`${cause}. Run volt again and /resume the session to continue from what was saved.`),
			{ unsentDraft },
		);
	}

	/**
	 * Follow the store in the TUI's status: the working, retry, and compaction
	 * indicators, the turn-done alert, the work summary, and settlement from
	 * the run phase; the prompt-cache alert from the live prompt-cache value;
	 * and the plan, title, and editor border from the client fold.
	 * While the store shows no conversation (its client moves), nothing shows.
	 */
	private syncStatus(): void {
		this.syncPhase();
		this.syncFold();
		this.schedulePromptCacheAlert();
		this.ui.requestRender();
	}

	/** Whether a run of the conversation the TUI shows is active: from its start until it settles. */
	private runActive(): boolean {
		return this.store.phase?.run !== undefined;
	}

	private syncPhase(): void {
		const previous = this.shownPhase;
		const showing = this.store.conversation !== undefined;
		const phase = showing ? this.store.phase : undefined;
		this.shownPhase = phase;
		const run = phase?.run;
		const wasRun = previous?.run;
		if (run !== undefined && run.startedAt !== wasRun?.startedAt) this.runStarted(run.startedAt);
		if ((phase?.compaction === undefined) !== (previous?.compaction === undefined)) this.compactionChanged();
		if (run === undefined && wasRun !== undefined) this.runEnded(showing);
		const progress = run !== undefined || phase?.compaction !== undefined;
		if (progress !== this.progressShown) {
			this.progressShown = progress;
			if (this.settingsManager.getShowTerminalProgress()) this.ui.terminal.setProgress(progress);
		}
		this.showPhaseIndicator(phase);
		if (showing && previous?.busy === true && phase?.busy !== true) void this.settled();
	}

	/** A run started: the working indicator times it from its start. */
	private runStarted(startedAt: number): void {
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		this.turnStartedAt = startedAt;
		this.clearWorkSummaryTimer();
		this.workSummary = { startedAt, aborted: false };
		this.startWorkingElapsedTicker();
		this.updateEditorBorderColor(true);
	}

	/** A run ended; `showing`: in the conversation the TUI shows, rather than one it left. */
	private runEnded(showing: boolean): void {
		this.stopWorkingElapsedTicker();
		this.turnStartedAt = undefined;
		if (showing) {
			const aborted = this.lastAssistantStopReason() === "aborted";
			if (this.workSummary) this.workSummary.aborted = aborted;
			this.scheduleTurnDoneAlert(aborted);
		}
		this.updateEditorBorderColor(false);
	}

	/** The stop reason of the newest assistant message of the transcript. */
	private lastAssistantStopReason(): AssistantMessage["stopReason"] | undefined {
		const transcript = this.store.transcript();
		for (let index = transcript.length - 1; index >= 0; index--) {
			const entry = transcript[index];
			const message = entry?.type === "message" ? entry.payload?.message : undefined;
			if (message?.role === "assistant") return message.stopReason;
		}
		return undefined;
	}

	/** A compaction started or ended: how it ended shows as the host's notice, its summary once its entry commits (showCompacted). */
	private compactionChanged(): void {
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		this.clearWorkSummaryTimer();
	}

	/** The run settled: a ready plan is offered, the work summary waits, and a requested shutdown runs. */
	private async settled(): Promise<void> {
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		// A plan submitted during the run is offered only now that the run has settled.
		const plan = this.planning().plan;
		if (plan?.phase === "ready") this.presentReadyPlan(plan);
		this.scheduleWorkSummary();
		await this.checkShutdownRequested();
	}

	/**
	 * Show the indicator `phase` calls for: a running compaction, a retry
	 * counting down to its attempt, or the working indicator of a run.
	 */
	private showPhaseIndicator(phase: PhaseValue | undefined): void {
		const retry = phase?.retry;
		const waiting = retry?.retryAt !== undefined && retry.retryAt > Date.now() ? retry : undefined;
		const wanted = phase?.compaction ? "compaction" : waiting ? "retry" : phase?.run ? "working" : undefined;
		if (wanted !== "working" && this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.statusContainer.removeChild(this.loadingAnimation);
			this.loadingAnimation = undefined;
		}
		if (wanted !== "compaction" && this.autoCompactionLoader) {
			this.autoCompactionLoader.stop();
			this.statusContainer.removeChild(this.autoCompactionLoader);
			this.autoCompactionLoader = undefined;
		}
		if (wanted !== "retry" && this.retryLoader) {
			this.retryCountdown?.dispose();
			this.retryCountdown = undefined;
			this.retryLoader.stop();
			this.statusContainer.removeChild(this.retryLoader);
			this.retryLoader = undefined;
			this.retryShownFor = undefined;
		}
		switch (wanted) {
			case "working":
				if (!this.loadingAnimation) {
					this.loadingAnimation = this.createWorkingLoader();
					this.statusContainer.addChild(this.loadingAnimation);
				}
				return;
			case "compaction": {
				if (this.autoCompactionLoader) return;
				const reason = phase?.compaction?.reason;
				const cancelHint = `(${keyText("app.interrupt")} to cancel)`;
				const label =
					reason === "manual"
						? `Compacting context... ${cancelHint}`
						: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
				this.autoCompactionLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("accent", spinner),
					(text) => theme.fg("muted", text),
					label,
				);
				this.statusContainer.addChild(this.autoCompactionLoader);
				return;
			}
			case "retry": {
				if (!waiting || this.retryShownFor === waiting.retryAt) return;
				this.retryShownFor = waiting.retryAt;
				const retryMessage = (seconds: number) =>
					`Retrying (${waiting.attempt}/${waiting.maxAttempts}) in ${seconds}s... (${keyText("app.interrupt")} to cancel)`;
				const delayMs = Math.max(0, (waiting.retryAt ?? 0) - Date.now());
				if (this.retryLoader) {
					this.retryCountdown?.dispose();
				} else {
					this.retryLoader = new Loader(
						this.ui,
						(spinner) => theme.fg("warning", spinner),
						(text) => theme.fg("muted", text),
						retryMessage(Math.ceil(delayMs / 1000)),
					);
					this.statusContainer.addChild(this.retryLoader);
				}
				this.retryCountdown = new CountdownTimer(
					delayMs,
					this.ui,
					(seconds) => this.retryLoader?.setMessage(retryMessage(seconds)),
					() => {
						this.retryCountdown = undefined;
						// The attempt starts: the run's indicator shows again.
						this.showPhaseIndicator(this.shownPhase);
					},
				);
				return;
			}
			default:
				return;
		}
	}

	/** The client fold changed: the plan, the title, and the editor border follow it; the queue shows on its own (showQueueIfChanged). */
	private syncFold(): void {
		const previous = this.shownFold;
		if (this.store.conversation === undefined || previous === undefined) return;
		const state = this.store.state;
		if (state === previous) return;
		this.shownFold = state;
		if (state.planning !== previous.planning) this.handlePlanningStateChanged(this.planning());
		if (state.name !== previous.name) this.updateTerminalTitle();
		if (state.thinkingLevel !== previous.thinkingLevel) this.updateEditorBorderColor();
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg("dim", message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsScope.projectTrusted || !hasTrustRequiringProjectResources(this.settingsScope.cwd)) {
			return;
		}
		this.trustWarningShown = true;

		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new Text(
				theme.fg(
					"warning",
					"This project is not trusted. Project .volt resources and packages are ignored. Use /trust to save a trust decision, then restart volt.",
				),
				1,
				0,
			),
		);
	}

	// =========================================================================
	// Key handlers
	// =========================================================================

	private handleCtrlC(): void {
		const now = Date.now();
		if (this.editor.getText().length === 0 && (now - this.lastSigintTime < 500 || this.hasQuitConfirmation(now))) {
			this.runKeyAction(() => this.requestQuit());
		} else {
			this.quitConfirmation = undefined;
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		this.runKeyAction(() => this.requestQuit());
	}

	private hasQuitConfirmation(now: number): boolean {
		return (
			this.quitConfirmation !== undefined &&
			now - this.quitConfirmation.warnedAt < 3000 &&
			this.quitConfirmation.activity === this.activity()
		);
	}

	/**
	 * What the conversation runs, as the store shows it: its operation, the
	 * run or compaction it started and when, and whether work runs; undefined
	 * while nothing runs. A quit confirmation holds while this stays the same.
	 */
	private activity(): string | undefined {
		const phase = this.store.phase;
		const working = this.input.workRunning();
		if (phase?.busy !== true && !working && !this.activeReview) return undefined;
		return JSON.stringify([
			phase?.operation ?? null,
			phase?.run?.startedAt ?? null,
			phase?.compaction?.startedAt ?? null,
			working,
			this.activeReview,
		]);
	}

	/**
	 * Every interactive quit path must confirm before disposing active work.
	 * Phone attachment does not change local runtime ownership or this protection.
	 */
	private async requestQuit(): Promise<void> {
		const now = Date.now();
		const activity = this.activity();
		if (activity !== undefined && !this.hasQuitConfirmation(now)) {
			this.quitConfirmation = { warnedAt: now, activity };
			this.showWarning(
				"Work is active; quitting will interrupt it. Quit again within 3 seconds to confirm. Use /debug to capture diagnostics.",
			);
			return;
		}
		this.quitConfirmation = undefined;
		await this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	/**
	 * Close the TUI's conversation and host; the host hands the session back to
	 * the daemon only after the runtime finished writing the session, so the
	 * daemon's lazy resume sees final state.
	 */
	private disposeRuntimeHost(): Promise<void> {
		// The TUI's conversation closes with its UI still attached; extension UI is released before disposal.
		return this.connector.dispose({ beforeDispose: () => this.leaveConversation() });
	}

	private async flushStdout(): Promise<void> {
		await new Promise<void>((resolve) => {
			let settled = false;
			const timeout = setTimeout(settle, STDOUT_FLUSH_TIMEOUT_MS);
			function settle() {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				process.stdout.off("error", settle);
				resolve();
			}
			process.stdout.once("error", settle);
			try {
				process.stdout.write("", settle);
			} catch {
				settle();
			}
		});
	}

	private async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.connector.stopServing();
		this.dismissWorkInspector?.();
		// Keep signal handlers registered until terminal cleanup has completed.
		// `signal-exit` checks the listener list during the same SIGTERM/SIGHUP
		// dispatch and re-sends the signal if only its own listeners remain.

		const rememberActiveProfile = async () => {
			this.settingsManager.rememberActiveProfile();
			await this.settingsManager.flush();
		};
		await this.closeLspTrace().catch(() => {});
		this.cleanupAllScratchDirectories();

		if (options?.fromSignal) {
			// Signal-triggered shutdown (SIGTERM/SIGHUP). Emit extension cleanup
			// (session_shutdown) BEFORE touching the terminal. Extension teardown
			// such as removing sockets does not write to the tty, so it must not be
			// skipped if a later terminal-restore write fails on a dead or stalled
			// terminal. If the terminal is gone, the restore writes below emit EIO,
			// which the stdout/stderr error handler turns into emergencyTerminalExit;
			// the render loop is already idle, so this cannot hot-spin (see #4144).
			await this.disposeRuntimeHost();
			await rememberActiveProfile();
			await this.ui.terminal.drainInput(1000);
			this.stop();
			await this.flushStdout();
			process.exit(0);
		}

		// Interactive quit (Ctrl+D, Ctrl+C, /quit, extension shutdown()). Stop the
		// TUI before emitting shutdown events so extension UI cleanup cannot repaint
		// the final frame while the process is exiting.
		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);
		// Where the conversation's log lives, read while its host still serves it: the resume hint names it.
		const info = this.connected ? await this.sessions.info().catch(() => undefined) : undefined;

		this.stop();
		await this.disposeRuntimeHost();
		await rememberActiveProfile();

		const resumeCommand = info === undefined ? undefined : formatResumeCommand(info);
		if (resumeCommand) {
			process.stdout.write(`${chalk.dim("To resume this session:")} ${resumeCommand}\n`);
		}

		await this.flushStdout();
		process.exit(0);
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The host closes the language server traces as the process exits.
		this.cleanupAllScratchDirectories();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw from
	 * anywhere (e.g. an extension's async `ChildProcess.on("exit")` callback)
	 * tears down the process while leaving the terminal in raw mode with no
	 * cursor, requiring `stty sane && reset` to recover.
	 *
	 * Unlike emergencyTerminalExit, the terminal is still alive here, so we
	 * call ui.stop() to restore cooked mode, the cursor, and disable bracketed
	 * paste / Kitty / modifyOtherKeys sequences.
	 */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) {
			process.exit(1);
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.ui.stop();
		} catch {}
		// The host closes the language server traces as the process exits.
		this.cleanupAllScratchDirectories();
		console.error("volt exiting due to uncaughtException:");
		console.error(error);
		process.exit(1);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				// SIGHUP no longer hard-exits: graceful shutdown emits session_shutdown
				// first, then attempts terminal restore. A genuinely dead terminal
				// surfaces as an EIO on the restore writes, which the stdout/stderr
				// error handler converts into emergencyTerminalExit (see #4144, #5080).
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));

		// Restore the terminal before the process dies on any uncaught throw.
		// Without this, an unhandled exception from extension code (or anywhere
		// in volt) leaves the terminal in raw mode with no cursor.
		const uncaughtExceptionHandler = (error: Error) => {
			this.uncaughtCrash(error);
		};
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
		// Registering a listener disables Node's default throw, so other reasons
		// still crash exactly like an uncaught exception.
		const unhandledRejectionHandler = (reason: unknown) => {
			this.uncaughtCrash(reason instanceof Error ? reason : new Error(String(reason)));
		};
		process.prependListener("unhandledRejection", unhandledRejectionHandler);
		this.signalCleanupHandlers.push(() => process.off("unhandledRejection", unhandledRejectionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode without printing a fullscreen transcript).
			this.ui.stop({ preserveScreen: this.ui.mode === "fullscreen" });

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
		if (!text) return;
		if (text === "/work") {
			this.editor.setText("");
			this.showWorkInspector();
			return;
		}

		// Alt+Enter queues a follow-up while the conversation runs; while it is idle, it acts like Enter.
		if (!this.connected || (this.store.phase?.operation ?? null) === null) {
			if (this.editor.onSubmit) {
				this.editor.setText("");
				this.editor.onSubmit(text);
			}
			return;
		}
		this.editor.addToHistory?.(text);
		this.editor.setText("");
		await this.sendText(text, { followUp: true });
	}

	/**
	 * Send what the user wrote: an extension command runs at once; other text
	 * goes out with the images it names, as a prompt while the conversation is
	 * idle, else queued as steering (or `followUp`) until the host delivers it.
	 * Text sent while the client moves waits, in order, for the conversation
	 * it moves to, and goes out as that conversation's state calls for.
	 */
	private async sendText(text: string, options: { followUp: boolean }): Promise<void> {
		await this.clientConnected.promise;
		await this.store.settled();
		const command = this.input.extensionCommand(text);
		if (command !== undefined) {
			await this.input.runCommand(command);
			return;
		}
		const images = await this.collectPromptImages(text);
		const operation = this.store.phase?.operation;
		const delivery: Delivery = await this.input.send(text, {
			followUp: options.followUp,
			...(images === undefined ? {} : { images }),
		});
		if (delivery === "operation") {
			this.showStatus(
				operation === "compaction" || operation === "navigation"
					? "Queued message for after compaction"
					: "Queued message for after the current operation",
			);
		}
	}

	/**
	 * Run an async keybinding handler from CustomEditor's synchronous `() => void`
	 * dispatch. Without this the returned promise is dropped, and a rejection
	 * becomes an unhandled rejection that Node raises as an uncaught exception —
	 * tearing the TUI down through uncaughtCrash instead of reporting the error.
	 */
	private runKeyAction(action: () => Promise<void>): void {
		void action().catch((error) => {
			this.showError(error instanceof Error ? error.message : String(error));
		});
	}

	/** Take the queued input back into the editor without stopping the run. */
	private async handleDequeue(): Promise<void> {
		await this.clientConnected.promise;
		const restored = this.putQueuedTextInEditor(await this.input.withdraw());
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	private updateEditorBorderColor(streaming = this.runActive()): void {
		this.editor.borderColor = this.isBashMode
			? theme.getBashModeBorderColor()
			: theme.getThinkingBorderColor(this.store.state.thinkingLevel || "off");
		this.editor.setTopBorderLabel?.(
			editorTopBorderLabelForState({
				bashMode: this.isBashMode,
				streaming,
				hasText: this.editor.getText().length > 0,
				agentMode: this.planning().mode,
				planReady: this.planning().plan?.phase === "ready",
			}),
		);
		this.ui.requestRender();
	}

	/** Stop what the interrupt key stops now; a stopped run's queued input comes back into the editor. */
	private async interrupt(target: Interruptible): Promise<void> {
		this.putQueuedTextInEditor(await this.input.interrupt(target));
	}

	private async toggleAgentMode(): Promise<void> {
		await this.clientConnected.promise;
		const mode = await this.input.toggleAgentMode();
		this.showStatus(mode === "plan" ? "Plan mode: agent tools are read-only" : "Build mode");
	}

	private handlePlanningStateChanged(planning: PlanningState): void {
		const previous = this.lastObservedPlan;
		const plan = planning.plan;
		if (plan?.phase === "completed" && previous?.id === plan.id && previous.phase === "active") {
			this.showStatus(`Plan complete · /plan-close or ${keyText("app.plan.togglePane")} → Close Plan`);
		}
		this.refreshPlanningUi(planning);
	}

	private refreshPlanningUi(planning = this.planning()): void {
		this.lastObservedPlan = planning.plan ? { id: planning.plan.id, phase: planning.plan.phase } : undefined;
		this.planStatus.setPlanning(planning);
		this.planInspector.setPlanning(planning);
		this.mainView.setPlanning(planning);
		const plan = planning.plan;
		const split = this.mainView.isTerminalSplit();
		if (split && this.planDetails) {
			this.focusPlanInspector();
			this.closePlanDetails({ focusConversation: false });
		} else if (this.planDetails && plan) {
			this.planDetails.setPlan(plan);
		} else if (this.planDetails && !plan) {
			this.closePlanDetails();
		}
		if (!split) this.focusConversation(true);
		this.updateEditorBorderColor();
		if (plan?.phase === "ready") {
			this.presentReadyPlan(plan);
		} else {
			this.readyPlanFocusKey = undefined;
		}
		this.ui.requestRender();
	}

	/**
	 * Offer the ready-plan chooser once per plan revision. Focus moves only between
	 * runs and away from an empty composer, so in-flight typing never reaches it;
	 * otherwise the persistent approval cues stay until the next settlement or refresh.
	 */
	private presentReadyPlan(plan: PlanState): void {
		const readyKey = `${plan.id}:${plan.revision}`;
		if (this.readyPlanFocusKey === readyKey) return;
		if (this.store.phase?.busy || this.editor.getText().length > 0) return;
		if (this.mainView.isTerminalSplit()) {
			if (this.focusPlanInspector()) this.readyPlanFocusKey = readyKey;
		} else if (this.activeView === this.conversationView) {
			if (!this.planDetails) this.showPlanDetails();
			this.readyPlanFocusKey = readyKey;
		}
	}

	/** Return typing from the ready-plan chooser to the composer instead of dropping it. */
	private composeFromPlanChooser(data: string): void {
		if (this.planDetails) this.closePlanDetails();
		else this.focusConversation();
		this.ui.getFocusedComponent()?.handleInput?.(data);
		this.ui.requestRender();
	}

	private showPlanDetails(): void {
		if (this.mainView.isTerminalSplit()) {
			this.focusPlanInspector();
			return;
		}
		const plan = this.planning().plan;
		if (!plan) {
			this.showStatus("No structured plan yet");
			return;
		}
		this.planDetailsContainer.clear();
		this.planDetails = new PlanDetailsComponent({
			plan,
			getTerminalRows: () => this.ui.terminal.rows,
			fullscreenScrollbar: this.settingsManager.getFullscreenScrollbar(),
			onAction: (action) => {
				void this.handlePlanDetailsAction(action);
			},
			onClose: () => this.closePlanDetails(),
			onTextInput: (data) => this.composeFromPlanChooser(data),
			requestRender: () => this.ui.requestRender(),
		});
		this.planDetailsContainer.addChild(this.planDetails);
		this.fullscreenFlexibleSlot.clear();
		this.fullscreenFlexibleSlot.addChild(this.planDetails.getFullscreenLayout(), {
			grow: 1,
			shrink: 1,
			minSize: 0,
		});
		this.planDetails.setFullscreenActive(this.ui.mode === "fullscreen");
		this.fullscreenTranscript.setPrimary(false);
		if (!this.ui.retargetFocus(this.getConversationFocusTarget(), this.planDetails)) {
			this.ui.setFocus(this.planDetails);
		}
		this.ui.requestRender();
	}

	private closePlanDetails(options: { focusConversation?: boolean } = {}): void {
		const closingDetails = this.planDetails;
		this.planDetailsContainer.clear();
		this.planDetails = undefined;
		this.fullscreenFlexibleSlot.clear();
		this.fullscreenFlexibleSlot.addChild(this.fullscreenTranscript, { grow: 1, shrink: 1, minSize: 0 });
		if (options.focusConversation !== false && this.activeView === this.conversationView) {
			this.focusConversation();
		} else {
			if (closingDetails && this.ui.getFocusedComponent() === closingDetails) {
				this.fullscreenTranscript.setPrimary(true);
				this.ui.setFocus(this.getConversationFocusTarget());
			}
			this.ui.requestRender();
		}
	}

	private getConversationFocusTarget(): Component {
		const saved = this.planPaneReturnFocus;
		if (saved && this.editorContainer.children.includes(saved)) return saved;
		return this.editorContainer.children[0] ?? (this.editor as Component);
	}

	private focusPlanInspector(): boolean {
		if (this.activeView !== this.conversationView || !this.mainView.isTerminalSplit()) {
			return false;
		}
		const focused = this.ui.getFocusedComponent();
		let focusSource: Component | undefined;
		let retargeted = false;
		if (focused !== this.planInspector) {
			if (focused === this.planDetails || (focused !== null && this.editorContainer.children.includes(focused))) {
				focusSource = focused;
			} else {
				const focusSources: Component[] = [...this.editorContainer.children];
				if (this.planDetails) focusSources.unshift(this.planDetails);
				for (const source of focusSources) {
					if (!this.ui.retargetFocus(source, this.planInspector)) continue;
					focusSource = source;
					retargeted = true;
					break;
				}
				if (!retargeted) return false;
			}
		}
		if (!this.planInspector.focused) {
			this.planPaneReturnFocus =
				focusSource && this.editorContainer.children.includes(focusSource)
					? focusSource
					: this.getConversationFocusTarget();
			this.fullscreenTranscript.setPrimary(false);
			this.planInspector.setFullscreenActive(this.ui.mode === "fullscreen");
			this.planInspector.setSelected(true);
			if (!retargeted) this.ui.setFocus(this.planInspector);
		}
		this.ui.requestRender();
		return true;
	}

	private focusConversation(onlyFromPlanInspector = false): boolean {
		const target = this.getConversationFocusTarget();
		const wasInspectorFocused = this.planInspector.focused;
		const retargeted = this.ui.retargetFocus(this.planInspector, target);
		if (!retargeted) {
			if (onlyFromPlanInspector && !wasInspectorFocused) return false;
			this.ui.setFocus(target);
		}
		this.planInspector.setSelected(false);
		this.fullscreenTranscript.setPrimary(true);
		this.planPaneReturnFocus = undefined;
		this.ui.requestRender();
		return true;
	}

	private togglePlanPaneFocus(): void {
		if (this.mainView.isTerminalSplit()) {
			if (this.planInspector.focused) this.focusConversation();
			else this.focusPlanInspector();
			return;
		}
		if (this.planDetails) this.closePlanDetails();
		else if (this.planning().plan) this.showPlanDetails();
	}

	private handlePlanSplitChange(split: boolean, preserveScrollback: boolean): void {
		if (preserveScrollback && this.renderer instanceof TuiMainScreen) {
			this.renderer.resetViewportOnNextRender();
		}
		this.planInspector.setFullscreenActive(split && this.ui.mode === "fullscreen");
		if (split) {
			const hadPlanDetails = this.planDetails !== undefined;
			const plan = this.planning().plan;
			if (hadPlanDetails) {
				this.focusPlanInspector();
				this.closePlanDetails({ focusConversation: false });
			} else if (plan?.phase === "ready") {
				// A plan that just became ready opens the split mid-run; offer it under the same rules as settlement.
				this.presentReadyPlan(plan);
			}
			return;
		}
		this.fullscreenTranscript.setPrimary(true);
		this.focusConversation(true);
		if (this.planning().plan?.phase === "ready" && !this.planDetails && this.activeView === this.conversationView) {
			this.showPlanDetails();
		}
	}

	private async closeFinishedPlan(): Promise<void> {
		const plan = this.planning().plan;
		if (!plan) {
			this.showStatus("No plan to close");
			return;
		}
		if (this.runActive()) {
			this.showWarning("Wait for the current run to finish before closing the plan");
			return;
		}
		switch (plan.phase) {
			case "draft":
				this.showWarning("This plan is still a draft; keep refining it or submit it in Plan mode");
				return;
			case "ready":
				this.showWarning(
					`This plan is ready; choose Execute Plan or Change Plan in the plan pane (${keyText("app.plan.togglePane")})`,
				);
				return;
			case "active":
				this.showWarning(
					`This plan is still executing; ${keyText("app.mode.toggle")} returns it to draft for replanning`,
				);
				return;
		}
		try {
			this.closePlanDetails();
			await this.store.client.intent("plan_discard", { planId: plan.id, expectedRevision: plan.revision });
			this.showStatus("Plan closed");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handlePlanDetailsAction(action: PlanDetailsAction): Promise<void> {
		if (action === "close") {
			await this.closeFinishedPlan();
			return;
		}
		const plan = this.planning().plan;
		if (!plan || plan.phase !== "ready") {
			this.showWarning("The ready plan changed; reopen Plan Details");
			this.closePlanDetails();
			return;
		}
		try {
			const revision = { planId: plan.id, expectedRevision: plan.revision };
			if (action === "change") {
				await this.store.client.intent("plan_change", revision);
				this.closePlanDetails();
				this.showStatus("Describe the changes you want in the normal composer");
				return;
			}
			this.closePlanDetails();
			const accepted = await this.store.client.intent("plan_execute", { ...revision, strategy: action });
			// A plan executed in a new session moves the TUI there: the status shows in it.
			if (accepted.conversation !== undefined) await this.store.showing(accepted.conversation);
			this.showStatus(
				accepted.conversation !== undefined
					? `Executing plan in session ${accepted.conversation}`
					: accepted.result?.started
						? "Plan execution started"
						: "Plan execution was already started",
			);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
			// Offer the chooser again if the plan is still waiting on a decision.
			this.readyPlanFocusKey = undefined;
			this.refreshPlanningUi();
		}
	}

	private async cycleThinkingLevel(): Promise<void> {
		await this.clientConnected.promise;
		const newLevel = await this.input.cycleThinkingLevel();
		if (newLevel === undefined) {
			this.showStatus("Current model does not support thinking");
		} else {
			this.updateEditorBorderColor();
			this.showStatus(`Thinking level: ${newLevel}`);
		}
	}

	private async cycleModel(direction: "forward" | "backward"): Promise<void> {
		await this.clientConnected.promise;
		const cycle = await this.input.cycleModel(direction);
		if (cycle.kind === "single") {
			this.showStatus(cycle.scoped ? "Only one model in scope" : "Only one model available");
			return;
		}
		this.updateEditorBorderColor();
		const thinkingStr =
			cycle.model.reasoning && cycle.thinkingLevel !== "off" ? ` (thinking: ${cycle.thinkingLevel})` : "";
		this.showStatus(`Switched to ${cycle.model.name || cycle.model.id}${thinkingStr}`);
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		if (isExpandable(this.builtInHeader)) {
			this.builtInHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		// The transcript draws afresh, what streams included.
		this.transcript.rebuild();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private async openExternalEditor(): Promise<void> {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		let scratchDirectory: string;
		try {
			scratchDirectory = this.createScratchDirectory("volt-editor-");
		} catch (error) {
			this.showError(
				`Failed to create private editor file: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		const tmpFile = path.join(scratchDirectory, "draft.volt.md");
		let tuiStopped = false;

		try {
			// Write current content to temp file
			writePrivateNewFileSync(tmpFile, currentText);

			// Stop TUI to release terminal without printing a fullscreen transcript.
			this.ui.stop({ preserveScreen: this.ui.mode === "fullscreen" });
			tuiStopped = true;

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			process.stdout.write(`Launching external editor: ${editorCmd}\nPi will resume when the editor exits.\n`);

			// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
			// Node/libuv's console input read active after ui.stop() pauses stdin, racing
			// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
			const status = await new Promise<number | null>((resolve) => {
				const child = spawn(editor, [...editorArgs, tmpFile], {
					stdio: "inherit",
					shell: process.platform === "win32",
				});
				child.on("error", () => resolve(null));
				child.on("close", (code) => resolve(code));
			});

			// On successful exit (status 0), replace editor content
			if (status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			this.removeScratchDirectory(scratchDirectory);

			if (tuiStopped) {
				// Restart TUI and force a full render because external editors use the alternate screen.
				this.ui.start();
				this.ui.requestRender(true);
			}
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.cleanupClipboardScratchFilesInText(this.editor.getText());
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(release: LatestVoltRelease): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", `New version ${release.version} is available. Run `) + action;
		const note = release.note?.trim();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(`${theme.bold(theme.fg("warning", "Update Available"))}\n${updateInstruction}`, 1, 0),
		);
		if (note) {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Markdown(note, 1, 0, this.getMarkdownThemeWithSettings(), {
					color: (text) => theme.fg("muted", text),
				}),
			);
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		const action = theme.fg("accent", `${APP_NAME} update`);
		const updateInstruction = theme.fg("muted", "Package updates are available. Run ") + action;
		const packageLines = packages.map((pkg) => `- ${pkg}`).join("\n");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.chatContainer.addChild(
			new Text(
				`${theme.bold(theme.fg("warning", "Package Updates Available"))}\n${updateInstruction}\n${theme.fg("muted", "Packages:")}\n${packageLines}`,
				1,
				0,
			),
		);
		this.chatContainer.addChild(new DynamicBorder((text) => theme.fg("warning", text)));
		this.ui.requestRender();
	}

	/**
	 * Show the input queued for the next turn, as the client fold holds it:
	 * the notices of finished work, then the user's steering and follow-up text.
	 */
	private updatePendingMessagesDisplay(): void {
		this.queueContainer.clear();
		this.shownQueue = this.store.state.queue;
		const { steering, followUp, notices } = this.input.queue();
		// Notices of finished work wait for the next turn too; they leave with it.
		if (notices.length > 0) {
			this.queueContainer.addChild(new Spacer(1));
			for (const notice of notices) {
				this.queueContainer.addChild(new TruncatedText(queuedWorkNoticeLine(notice), 1, 0));
			}
		}
		if (steering.length > 0 || followUp.length > 0) {
			this.queueContainer.addChild(new Spacer(1));
			for (const message of steering) {
				const text = theme.fg("dim", `Steering: ${message}`);
				this.queueContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUp) {
				const text = theme.fg("dim", `Follow-up: ${message}`);
				this.queueContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.dequeue");
			const hintText = theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`);
			this.queueContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
	}

	/** Show the queued input again when the client fold's queue changed. */
	private showQueueIfChanged(): void {
		if (this.store.state.queue === this.shownQueue) return;
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}

	/** Put withdrawn queued text before the editor's draft; the count of inputs it put back. */
	private putQueuedTextInEditor(withdrawn: readonly WithdrawnInput[]): number {
		if (withdrawn.length === 0) return 0;
		const queuedText = withdrawn.map((input) => input.text).join("\n\n");
		const combinedText = [queuedText, this.editor.getText()].filter((t) => t.trim()).join("\n\n");
		this.editor.setText(combinedText);
		return withdrawn.length;
	}

	// =========================================================================
	// Renderer-aware view composition
	// =========================================================================

	private createDedicatedView(component: Component): ActiveViewDescriptor {
		return {
			regularComponents: [component],
			fullscreenRoot: new VStack([{ component, grow: 1, shrink: 1, minSize: 0 }]),
		};
	}

	private stopInteractiveTui(fullscreenExitOutput: "transcript" | "resume-hint"): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.activateView(this.conversationView, null, false);
			const suspension = this.sessionRenderSuspension;
			this.sessionRenderSuspension = undefined;
			suspension?.release();
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: TuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		const previousSuspension = this.sessionRenderSuspension;
		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: getAgentDir(),
			terminal,
			onRightClickPaste: this.onRightClickPaste,
		});
		nextUi.setClearOnShrink(clearOnShrink);
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		const nextSuspension = previousSuspension ? nextUi.suspendRendering() : undefined;

		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.activateView(this.activeView, focus, false);
		nextUi.invalidate();
		if (startRenderer) nextUi.start();
		this.setupGlobalInputRouting();
		this.setupPlanPaneInputRouting();
		if (startRenderer && restoreProgress && this.settingsManager.getShowTerminalProgress() && this.progressShown) {
			terminal.setProgress(true);
		}

		if (previousSuspension) {
			this.sessionRenderSuspension = nextSuspension;
			previousSuspension.release();
		}
		return true;
	}

	private activateView(view: ActiveViewDescriptor, focus: Component | null, forceRender = true): void {
		// A dedicated view must never receive input behind the work overlay.
		if (focus === this.workInspector) focus = this.editor;
		this.dismissWorkInspector?.();
		this.ui.clear();
		for (const component of view.regularComponents) this.ui.addChild(component);
		if (isViewportTUI(this.ui)) this.ui.setLayoutRoot(view.fullscreenRoot);
		this.activeView = view;
		const split = view === this.conversationView && this.mainView?.isTerminalSplit() === true;
		this.planInspector?.setFullscreenActive(split && this.ui.mode === "fullscreen");
		this.planDetails?.setFullscreenActive(view === this.conversationView && !split && this.ui.mode === "fullscreen");
		if (view === this.conversationView && this.fullscreenTranscript) {
			this.fullscreenTranscript.setPrimary(focus !== this.planInspector && this.planDetails === undefined);
		}
		this.ui.setFocus(focus);
		this.ui.requestRender(forceRender);
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	/**
	 * Shows a selector as a temporary viewport so transcript and startup content
	 * cannot consume the rows needed for its title, controls, and close action.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		this.dismissWorkInspector?.();
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		let component: Component | undefined;
		let dispose: (() => void) | undefined;
		let closed = false;
		const done = () => {
			if (closed) return;
			closed = true;
			dispose?.();
			if (!component) return;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.activateView(previousView, previousFocus ?? this.editor);
		};
		const created = create(done);
		component = created.component;
		dispose = created.dispose;
		if (closed) {
			dispose?.();
			return;
		}
		this.activateView(this.createDedicatedView(component), created.focus);
	}

	/** Show the work inspector over the conversation, or focus it when it shows; `workId` selects an item. */
	private showWorkInspector(workId?: string): void {
		if (this.isShuttingDown || this.sessionRenderSuspension) return;
		if (this.workOverlay) {
			this.workOverlay.focus();
			this.workInspector?.refresh();
			return;
		}
		let closed = false;
		let overlay: OverlayHandle | undefined;
		const inspector = new WorkInspector(this.work, {
			getHeight: () => Math.max(1, this.ui.terminal.rows - 2),
			requestRender: () => this.ui.requestRender(),
			onClose: () => close(),
			...(workId === undefined ? {} : { workId }),
		});
		const close = () => {
			if (closed) return;
			closed = true;
			inspector.dispose();
			// Remove only this overlay; another dialog can be stacked above it.
			overlay?.hide();
			if (this.workInspector === inspector) {
				this.workInspector = undefined;
				this.workOverlay = undefined;
				this.dismissWorkInspector = undefined;
			}
			this.ui.requestRender();
		};
		try {
			overlay = this.ui.showOverlay(inspector, {
				width: "100%",
				maxHeight: "100%",
				margin: { top: 1, bottom: 1, left: 0, right: 0 },
			});
		} catch (error) {
			inspector.dispose();
			throw error;
		}
		this.workInspector = inspector;
		this.workOverlay = overlay;
		this.dismissWorkInspector = close;
	}

	/** `/remote`: the daemon's control center, for the conversation the TUI shows. */
	private async showRemoteControlCenter(): Promise<void> {
		await this.clientConnected.promise;
		const conversation = await this.sessions.info();
		this.showSelector((done) => {
			const center = new RemoteControlCenterComponent(createRemoteControlBackend(getAgentDir()), {
				getTerminalRows: () => this.ui.terminal.rows,
				getCurrentWorkspaceName: () => this.connector.daemonWorkspaceName(),
				getCurrentWorkspacePath: () => conversation.cwd,
				currentSessionId: conversation.id,
				requestRender: () => this.ui.requestRender(),
				copyText: copyToClipboard,
				onClose: done,
			});
			void center.start();
			return { component: center, focus: center, dispose: () => center.dispose() };
		});
	}

	/**
	 * `/settings`: the settings the host reads change through its intents
	 * (`set_settings` and the conversation's setting intents) and show as its
	 * `settings` catalog holds them; the TUI's display settings change in its
	 * own settings manager.
	 */
	private async showSettingsSelector(): Promise<void> {
		await this.clientConnected.promise;
		const client = this.store.client;
		let hostSettings: QueryResult<"settings">;
		let models: readonly RpcCatalogModel[];
		try {
			[hostSettings, { models }] = await Promise.all([client.query("settings"), client.query("models")]);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const ref = this.store.state.model;
		const model = ref === null ? undefined : models.find((m) => m.provider === ref.provider && m.id === ref.modelId);
		const currentModel = ref === null ? undefined : `${ref.provider}/${ref.modelId}`;
		const settingsManager = this.settingsManager;
		const keepAlive = hostSettings.promptCacheKeepAlive ?? "off";
		/** Change settings the host reads; a refusal shows. */
		const setHostSettings = (values: HostSettingsValues, status?: string): void => {
			void client.intent("set_settings", values).then(
				() => {
					if (status !== undefined) this.showStatus(status);
				},
				(error: unknown) => this.showError(error instanceof Error ? error.message : String(error)),
			);
		};
		const runIntent = (run: () => Promise<unknown>): void => {
			void run().catch((error: unknown) => this.showError(error instanceof Error ? error.message : String(error)));
		};
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: hostSettings.autoCompaction,
					currentModel,
					compactionThresholdTokens: hostSettings.compactionThresholdTokens ?? 0,
					personality: hostSettings.personality ?? "default",
					showImages: settingsManager.getShowImages(),
					imageWidthCells: settingsManager.getImageWidthCells(),
					autoResizeImages: hostSettings.imageAutoResize ?? true,
					blockImages: hostSettings.blockImages ?? false,
					enableSkillCommands: settingsManager.getEnableSkillCommands(),
					steeringMode: hostSettings.steeringMode,
					followUpMode: hostSettings.followUpMode,
					transport: hostSettings.transport ?? "auto",
					httpIdleTimeoutMs: hostSettings.httpIdleTimeoutMs ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS,
					thinkingLevel: this.store.state.thinkingLevel,
					availableThinkingLevels: model?.availableThinkingLevels ?? ["off"],
					reviewModel: hostSettings.reviewModel ?? undefined,
					availableModels: models.map((candidate) => `${candidate.provider}/${candidate.id}`),
					currentTheme: settingsManager.getTheme() || "dark",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					collapseChangelog: settingsManager.getCollapseChangelog(),
					enableInstallTelemetry: hostSettings.enableInstallTelemetry ?? true,
					doubleEscapeAction: settingsManager.getDoubleEscapeAction(),
					treeFilterMode: settingsManager.getTreeFilterMode(),
					showHardwareCursor: settingsManager.getShowHardwareCursor(),
					defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
					editorPaddingX: settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: settingsManager.getAutocompleteMaxVisible(),
					quietStartup: settingsManager.getQuietStartup(),
					clearOnShrink: settingsManager.getClearOnShrink(),
					showTerminalProgress: settingsManager.getShowTerminalProgress(),
					turnDoneAlert: settingsManager.getTurnDoneAlert(),
					promptCacheKeepAlive: {
						enabled: keepAlive !== "off",
						idleWindowMs: keepAlive === "off" ? 0 : keepAlive * 60_000,
					},
					tuiMode: this.ui.mode,
					fullscreenExitOutput: settingsManager.getFullscreenExitOutput(),
					fullscreenScrollbar: settingsManager.getFullscreenScrollbar(),
					warnings: hostSettings.warnings ?? settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						runIntent(() =>
							client.intent("set_auto_compaction", {
								enabled,
								...(ref === null ? {} : { provider: ref.provider, modelId: ref.modelId }),
								expectedProfile: hostSettings.profile,
							}),
						);
					},
					onCompactionThresholdChange: (tokens) => {
						if (ref === null) return;
						runIntent(() =>
							client.intent("set_compaction_threshold", {
								tokens,
								provider: ref.provider,
								modelId: ref.modelId,
								expectedProfile: hostSettings.profile,
							}),
						);
					},
					onPersonalityChange: (personality) => {
						setHostSettings({ personality }, `Personality: ${personality}`);
					},
					onShowImagesChange: (enabled) => {
						settingsManager.setShowImages(enabled);
						this.transcript.forEachToolRow((row) => row.setShowImages(enabled));
					},
					onImageWidthCellsChange: (width) => {
						settingsManager.setImageWidthCells(width);
						this.transcript.forEachToolRow((row) => row.setImageWidthCells(width));
					},
					onAutoResizeImagesChange: (enabled) => {
						setHostSettings({ imageAutoResize: enabled });
					},
					onBlockImagesChange: (blocked) => {
						setHostSettings({ blockImages: blocked });
					},
					onEnableSkillCommandsChange: (enabled) => {
						settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onSteeringModeChange: (mode) => {
						runIntent(() => client.intent("set_steering_mode", { mode }));
					},
					onFollowUpModeChange: (mode) => {
						runIntent(() => client.intent("set_follow_up_mode", { mode }));
					},
					onTransportChange: (transport) => {
						setHostSettings({ transport });
					},
					onHttpIdleTimeoutMsChange: (timeoutMs) => {
						setHostSettings(
							{ httpIdleTimeoutMs: timeoutMs },
							`HTTP idle timeout: ${formatHttpIdleTimeoutMs(timeoutMs)}`,
						);
					},
					onThinkingLevelChange: (level) => {
						runIntent(async () => {
							await this.input.selectThinkingLevel(level);
							this.updateEditorBorderColor();
						});
					},
					onReviewModelChange: (modelReference) => {
						setHostSettings(
							{ reviewModel: modelReference ?? null },
							`Review model: ${modelReference ?? "session model"}`,
						);
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						settingsManager.setTheme(themeName);
						this.localThemeOverride = true;
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						settingsManager.setHideThinkingBlock(hidden);
						this.transcript.rebuild();
					},
					onCollapseChangelogChange: (collapsed) => {
						settingsManager.setCollapseChangelog(collapsed);
					},
					onEnableInstallTelemetryChange: (enabled) => {
						setHostSettings({ enableInstallTelemetry: enabled });
					},
					onQuietStartupChange: (enabled) => {
						settingsManager.setQuietStartup(enabled);
					},
					onDefaultProjectTrustChange: (defaultProjectTrust) => {
						settingsManager.setDefaultProjectTrust(defaultProjectTrust);
					},
					onDoubleEscapeActionChange: (action) => {
						settingsManager.setDoubleEscapeAction(action);
					},
					onTreeFilterModeChange: (mode) => {
						settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						settingsManager.setShowTerminalProgress(enabled);
					},
					onTurnDoneAlertChange: (mode) => {
						settingsManager.setTurnDoneAlert(mode);
					},
					onPromptCacheKeepAliveChange: (mode) => {
						setHostSettings({ promptCacheKeepAlive: mode });
					},
					onTuiModeChange: (mode) => {
						if (!this.switchTuiMode(mode)) {
							selector.getSettingsList().updateValue("tui-mode", this.ui.mode);
							this.showStatus("Close active overlays before changing TUI mode");
							return;
						}
						settingsManager.setTuiMode(mode);
						this.showStatus(`TUI mode: ${mode}`);
					},
					onFullscreenExitOutputChange: (output) => {
						settingsManager.setFullscreenExitOutput(output);
					},
					onFullscreenScrollbarChange: (mode) => {
						settingsManager.setFullscreenScrollbar(mode);
						this.applyFullscreenScrollbarSetting(mode);
					},
					onWarningsChange: (warnings) => {
						setHostSettings({ warnings });
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
				this.ui.terminal.rows,
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	/**
	 * The package manager the TUI installs with (D3): packages are the TUI's to
	 * install, into the settings files of the conversation's cwd it reads
	 * itself; the conversation loads them as it reloads.
	 */
	private getStorePackageManager(): DefaultPackageManager {
		const packageManager = new DefaultPackageManager({
			cwd: this.settingsScope.cwd,
			agentDir: getAgentDir(),
			settingsManager: this.settingsManager,
		});
		packageManager.setProgressCallback((event) => {
			if (event.type === "start" && event.message) {
				this.showStatus(formatStoreProgressMessage(event.source, event.message));
			}
		});
		return packageManager;
	}

	private async loadStoreCatalog(required: boolean): Promise<StoreCatalog | undefined> {
		try {
			const result = await loadDefaultStoreCatalog({ agentDir: getAgentDir() });
			for (const warning of result.warnings) {
				this.showWarning(warning);
			}
			return result.catalog;
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			if (required) {
				this.showError(message);
				return undefined;
			}
			this.showWarning(`${message}; continuing without catalog metadata.`);
			return { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages: [] };
		}
	}

	private showStoreText(text: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(text, 1, 0));
		this.ui.requestRender();
	}

	private formatStorePackageOption(pkg: StoreCatalogPackage, index: number): string {
		return `${index + 1}. ${pkg.id} - ${pkg.name}`;
	}

	private getStorePackageTitle(input: string, catalog: StoreCatalog): string {
		const pkg = findCatalogPackage(catalog, input);
		return pkg ? `${pkg.id} - ${pkg.name}` : input;
	}

	private async handleStoreInteractiveCommand(args: string): Promise<void> {
		const parts = args.split(/\s+/).filter((part) => part.length > 0);
		const command = parts[0];
		const input = parts.slice(1).join(" ");

		if (!command) {
			await this.showStoreCatalogBrowser();
			return;
		}
		if (command === "search") {
			await this.showStoreCatalogBrowser(input);
			return;
		}
		if (command === "show") {
			if (!input) {
				this.showWarning("Usage: /store show <id|source>");
				return;
			}
			await this.showStorePackageDetails(input);
			return;
		}
		if (command === "install") {
			if (!input) {
				this.showWarning("Usage: /store install <id|source>");
				return;
			}
			await this.showStoreInstallFlow(input);
			return;
		}
		if (command === "remove") {
			if (!input) {
				this.showWarning("Usage: /store remove <id|source>");
				return;
			}
			await this.showStoreRemoveFlow(input);
			return;
		}
		if (command === "update") {
			await this.showStoreUpdateFlow(input || undefined);
			return;
		}

		await this.showStoreCatalogBrowser(args);
	}

	private async promptStoreCatalogSearch(catalog: StoreCatalog): Promise<void> {
		const value = await this.showExtensionInput("Store search", "Search packages");
		if (value === undefined) {
			this.showStatus("Store search cancelled");
			return;
		}
		await this.showStoreCatalogBrowser(value.trim(), catalog);
	}

	private async showStoreCatalogBrowser(query = "", catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(true));
		if (!storeCatalog) {
			return;
		}

		const matches = searchCatalogPackages(storeCatalog, query).slice(0, 50);
		if (matches.length === 0) {
			this.showStoreText(renderCatalogSearch(matches, query));
			return;
		}

		const labels = new Map<string, StoreCatalogPackage>();
		const options = matches.map((pkg, index) => {
			const label = this.formatStorePackageOption(pkg, index);
			labels.set(label, pkg);
			return label;
		});
		const searchLabel = query.trim() ? "Search again" : "Search";
		options.push(searchLabel, "Cancel");

		const selection = await this.showExtensionSelector("Store packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === searchLabel) {
			await this.promptStoreCatalogSearch(storeCatalog);
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showStorePackageActions(pkg.id, storeCatalog);
		}
	}

	private async showStorePackageActions(input: string, catalog: StoreCatalog): Promise<void> {
		const title = this.getStorePackageTitle(input, catalog);
		const action = await this.showExtensionSelector(`Store: ${title}`, [
			"Show details",
			"Install for user",
			"Install for project",
			"Remove",
			"Update",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			await this.showStorePackageDetails(input, catalog);
			await this.showStorePackageActions(input, catalog);
			return;
		}
		if (action === "Install for user") {
			await this.showStoreInstallFlow(input, "user", catalog);
			return;
		}
		if (action === "Install for project") {
			await this.showStoreInstallFlow(input, "project", catalog);
			return;
		}
		if (action === "Remove") {
			await this.showStoreRemoveFlow(input, undefined, catalog);
			return;
		}
		if (action === "Update") {
			await this.showStoreUpdateFlow(input, catalog);
		}
	}

	private async showStorePackageDetails(input: string, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.showStatus(`Inspecting ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.settingsScope.cwd,
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			this.showStoreText(renderStoreShow(resolved, inspection));
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreInstallFlow(
		input: string,
		scope: StoreInstallScope = "user",
		catalog?: StoreCatalog,
	): Promise<void> {
		if (scope === "project" && !this.settingsManager.isProjectTrusted()) {
			this.showWarning("Project is not trusted. Use /trust, then restart volt before installing project packages.");
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			this.showStatus(`Preparing store install for ${formatStoreSourceSummary(input)}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.settingsScope.cwd,
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope,
				scriptPolicy: "never",
			});
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.showStoreText(renderStoreInstallPlan(plan));

			const confirmed = await this.showExtensionConfirm(
				"Store install",
				`Install ${targetLabel} to ${scope} scope? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.showStatus("Store install cancelled");
				return;
			}

			const packageManager = this.getStorePackageManager();
			await packageManager.installAndPersist(plan.source, {
				local: scope === "project",
				scripts: "never",
			});
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, scope)) {
				return;
			}
			if (
				!(await this.confirmPackagePermissions(
					packageManager,
					// A local package is found where it was installed from.
					storeReviewSource(plan.source, this.settingsScope.cwd),
					scope,
					"Declining removes the package.",
					{ installed: true },
				))
			) {
				await packageManager.removeAndPersist(plan.source, { local: scope === "project" });
				await this.settingsManager.flush();
				this.reportStoreSettingsErrors(packageManager, plan.source, scope);
				this.showStatus(`Removed ${targetLabel}: its permissions were not acknowledged`);
				return;
			}
			await this.offerStoreReload(`Installed ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreRemoveFlow(input: string, local?: boolean, catalog?: StoreCatalog): Promise<void> {
		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		try {
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: false });
			const packageManager = this.getStorePackageManager();
			const selection = chooseStoreRemoveTarget(packageManager, resolved.source, local ?? false);
			if (selection.conflict === "both-scopes") {
				this.showWarning("Package is installed in both user and project scopes. Use /extensions to pick one.");
				return;
			}
			if (!selection.target) {
				this.showWarning(`No matching package found for ${input}`);
				return;
			}
			await this.removeInstalledStorePackage(
				packageManager,
				selection.target,
				selection.target.actionSource ?? selection.target.source,
			);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showStoreUpdateFlow(input?: string, catalog?: StoreCatalog): Promise<void> {
		const packageManager = this.getStorePackageManager();
		if (!input) {
			const confirmed = await this.showExtensionConfirm("Store update", "Update all installed packages?");
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(undefined, { scripts: "never" });
				await this.reviewUpdatedPackages(packageManager);
				await this.offerStoreReload("Updated packages");
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const storeCatalog = catalog ?? (await this.loadStoreCatalog(false));
		if (!storeCatalog) {
			return;
		}
		const catalogPackage = findCatalogPackage(storeCatalog, input);
		if (!catalogPackage) {
			const inputLabel = formatStoreSourceSummary(input);
			const confirmed = await this.showExtensionConfirm("Store update", `Update ${inputLabel}?`);
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			try {
				await packageManager.update(input, { scripts: "never" });
				await this.reviewUpdatedPackages(packageManager, input);
				await this.offerStoreReload(`Updated ${inputLabel}`);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		try {
			this.showStatus(`Preparing store update for ${input}...`);
			const resolved = await resolveStoreSource({ input, catalog: storeCatalog, pinGit: true });
			const selection = chooseStoreUpdateTarget(packageManager, resolved.source);
			if (selection.conflict === "both-scopes") {
				this.showWarning("Package is installed in both user and project scopes. Use /extensions to pick one.");
				return;
			}
			if (!selection.target) {
				this.showWarning(`No matching installed package found for catalog ID ${input}`);
				return;
			}
			if (storeTargetMatchesUpdateSource(selection.target, resolved.source)) {
				const targetLabel = formatStoreSourceSummary(selection.target.source);
				const confirmed = await this.showExtensionConfirm("Store update", `Update ${targetLabel}?`);
				if (!confirmed) {
					this.showStatus("Store update cancelled");
					return;
				}
				const updateSource = selection.target.actionSource ?? selection.target.source;
				await packageManager.update(updateSource, {
					local: selection.target.scope === "project",
					scripts: "never",
				});
				await this.reviewUpdatedPackages(packageManager, updateSource);
				await this.offerStoreReload(`Updated ${targetLabel}`);
				return;
			}

			const inspection = await inspectStorePackage({
				source: resolved.source,
				cwd: this.settingsScope.cwd,
				npmCommand: this.settingsManager.getNpmCommand(),
			});
			const plan = buildStoreInstallPlan({
				resolved,
				inspection,
				scope: selection.target.scope,
				scriptPolicy: "never",
			});
			const currentLabel = formatStoreSourceSummary(selection.target.source);
			const targetLabel = formatStoreInstallPlanTarget(plan);
			this.showStoreText(renderStoreInstallPlan(plan));
			const confirmed = await this.showExtensionConfirm(
				"Store update",
				`Update ${currentLabel} to ${targetLabel}? Package lifecycle scripts will be disabled.`,
			);
			if (!confirmed) {
				this.showStatus("Store update cancelled");
				return;
			}
			const local = selection.target.scope === "project";
			await packageManager.installAndPersist(plan.source, { local, scripts: "never" });
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, plan.source, selection.target.scope)) {
				return;
			}
			if (
				!(await this.confirmPackagePermissions(
					packageManager,
					plan.source,
					selection.target.scope,
					`Declining keeps ${currentLabel}.`,
					{ installed: true },
				))
			) {
				// Back to the reviewed pin: the update's new permissions were not acknowledged.
				const scope = selection.target.scope;
				const removeDeclined = async (reason: string): Promise<void> => {
					// The declined revision must not stay installed: without the previous one, the package goes.
					await packageManager.removeAndPersist(plan.source, { local });
					await this.settingsManager.flush();
					if (this.reportStoreSettingsErrors(packageManager, plan.source, scope)) return;
					this.showWarning(`Removed ${currentLabel}: ${reason}`);
					await this.offerStoreReload(`Removed ${currentLabel}`);
				};
				try {
					await packageManager.installAndPersist(selection.target.source, { local, scripts: "never" });
					await this.settingsManager.flush();
				} catch (error: unknown) {
					this.showError(
						`Could not reinstall ${currentLabel}: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
					);
					await removeDeclined("the update's permissions were not acknowledged");
					return;
				}
				if (this.reportStoreSettingsErrors(packageManager, selection.target.source, selection.target.scope)) return;
				// A source without a commit pin reinstalls at its newest revision, which has its own permissions:
				// declining them too removes the package.
				if (
					!storeSourcePinsCommit(selection.target.source) &&
					!(await this.confirmPackagePermissions(
						packageManager,
						selection.target.source,
						selection.target.scope,
						"Declining removes the package.",
						{ installed: true },
					))
				) {
					await removeDeclined("the reinstalled revision's permissions were not acknowledged");
					return;
				}
				this.showStatus(`Kept ${currentLabel}: the update's permissions were not acknowledged`);
				return;
			}
			await this.offerStoreReload(`Updated ${currentLabel} to ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * `/extensions`: the conversation's extensions with their state, each
	 * opening its actions (enable or disable, detail and settings);
	 * `/extensions <id>` opens one's detail; `/extensions enable|disable <id>`
	 * toggles one.
	 */
	private async handleExtensionsInteractiveCommand(args: string): Promise<void> {
		const [verb, id, ...rest] = args.split(/\s+/).filter((part) => part.length > 0);
		if (verb === "enable" || verb === "disable") {
			if (id === undefined || rest.length > 0) {
				this.showWarning(`Usage: /extensions ${verb} <id>`);
				return;
			}
			await this.setExtensionEnabled(id, verb === "enable");
			return;
		}
		if (verb !== undefined) {
			await this.showExtensionDetail(args.trim());
			return;
		}
		let summaries: ExtensionSummary[];
		try {
			await this.clientConnected.promise;
			summaries = (await this.store.client.query("extensions")).extensions;
		} catch (error) {
			this.showError(`Could not list extensions: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const labels = new Map<string, ExtensionSummary>();
		const options = summaries.map((summary) => {
			const unacknowledged =
				summary.permissions.length > 0 && !summary.permissionsAcknowledged ? " · permissions not acknowledged" : "";
			const label = `${summary.displayName} (${summary.id}) · ${EXTENSION_STATE_LABELS[summary.state]}${summary.hasSettings ? " · settings" : ""}${unacknowledged}`;
			labels.set(label, summary);
			return label;
		});
		const packagesLabel = "Installed packages";
		options.push(packagesLabel, "Cancel");
		const selection = await this.showExtensionSelector("Extensions", options);
		if (!selection || selection === "Cancel") return;
		if (selection === packagesLabel) {
			await this.showInstalledPackages();
			return;
		}
		const selected = labels.get(selection);
		if (selected !== undefined) await this.showExtensionActions(selected);
	}

	/** What to do with one extension: enable or disable it, or open its detail and settings. */
	private async showExtensionActions(summary: ExtensionSummary): Promise<void> {
		const toggle = summary.enabled ? "Disable" : "Enable";
		const detailLabel = summary.hasSettings ? "Details and settings" : "Details";
		const selection = await this.showExtensionSelector(`${summary.displayName} (${summary.id})`, [
			toggle,
			detailLabel,
			"Cancel",
		]);
		if (selection === toggle) await this.setExtensionEnabled(summary.id, !summary.enabled);
		else if (selection === detailLabel) await this.showExtensionDetail(summary.id);
	}

	/**
	 * Enable or disable the extension `id` through the host's intent, in the
	 * scope that decides it: a trusted project's when it stores the choice,
	 * else the user's global settings. Enabling asks to acknowledge permissions
	 * not acknowledged yet.
	 */
	private async setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
		const settings = this.settingsManager;
		// The host or another client may have stored the choice since the TUI read its settings.
		await settings.reload();
		const scope =
			settings.isProjectTrusted() && settings.getStoredExtensionEnabled(id, "project") !== undefined
				? "project"
				: "global";
		let state: ExtensionState | undefined;
		try {
			await this.clientConnected.promise;
			const client = this.store.client;
			await client.intent("set_extension_enabled", { id, enabled, scope });
			state = (await client.query("extensions")).extensions.find((extension) => extension.id === id)?.state;
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (enabled) {
			if (state === "active") this.showStatus(`Enabled ${id}`);
			else this.showWarning(`${id} did not start (${state ?? "unknown"}); see its error in /extensions`);
		} else if (state === "active") {
			this.showWarning(`${id} stays enabled: another settings scope enables it`);
		} else {
			this.showStatus(
				state === "deactivating" ? `Disabled ${id}; its tools leave once the current turn ends` : `Disabled ${id}`,
			);
		}
	}

	/** An extension's detail and settings form, reading and saving through the host's query and intent. */
	private async showExtensionDetail(id: string): Promise<void> {
		let detail: ExtensionSummary | undefined;
		try {
			await this.clientConnected.promise;
			detail = (await this.store.client.query("extensions")).extensions.find((extension) => extension.id === id);
		} catch (error) {
			this.showError(`Could not list extensions: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (!detail) {
			this.showWarning(`No extension "${id}" in this conversation`);
			return;
		}
		const client = this.store.client;
		this.showSelector((done) => {
			const component = new ExtensionSettingsComponent(
				detail,
				{
					load: () => client.query("extension_settings", { id }),
					save: async (scope, values) => {
						await client.intent("set_extension_settings", { id, scope, values });
					},
				},
				{ onClose: done, requestRender: () => this.ui.requestRender() },
			);
			void component.start();
			return { component, focus: component };
		});
	}

	/**
	 * Ask the user to acknowledge the permissions of the package just installed
	 * or updated from `source` in `scope`, unless they already did (an update
	 * that adds none is recorded without asking). True unless the user declined,
	 * or the package was just `installed` and cannot be found.
	 */
	private async confirmPackagePermissions(
		packageManager: DefaultPackageManager,
		source: string,
		scope: StoreInstallScope,
		consequence: string,
		options: { installed?: boolean } = {},
	): Promise<boolean> {
		const root = packageManager.getInstalledPath(source, scope);
		if (root === undefined) {
			// A package just installed that cannot be found cannot be reviewed: it must not stay to run unreviewed.
			if (options.installed) this.showWarning("Could not find the installed package to review its permissions");
			return options.installed !== true;
		}
		let outcome: PackagePermissionOutcome;
		try {
			outcome = await reviewPackagePermissions({
				store: new ExtensionPermissionStore(getAgentDir()),
				root,
				source,
				confirm: (subject, added) =>
					this.showExtensionConfirm(
						"Extension permissions",
						[...permissionRequestLines(subject, added), "", `Acknowledge these permissions? ${consequence}`].join(
							"\n",
						),
					),
			});
		} catch (error: unknown) {
			// The message can carry text from the package: show it inert, and treat it as declined.
			this.showWarning(
				`Could not review the package's permissions: ${sanitizeText(error instanceof Error ? error.message : String(error))}`,
			);
			return false;
		}
		return outcome.status !== "declined";
	}

	/** After an update, review the permissions of the configured packages it updated (`source`, by identity, or all). */
	private async reviewUpdatedPackages(packageManager: DefaultPackageManager, source?: string): Promise<void> {
		for (const pkg of packageManager.listConfiguredPackages()) {
			if (source !== undefined && !storeUpdateTouches(packageManager, pkg, source)) continue;
			const acknowledged = await this.confirmPackagePermissions(
				packageManager,
				pkg.source,
				pkg.scope,
				"Declining leaves it installed with its permissions unacknowledged.",
			);
			if (!acknowledged) {
				this.showWarning(
					`${formatStoreSourceSummary(pkg.source)} asks for permissions you did not acknowledge; remove it with /store remove`,
				);
			}
		}
	}

	private async showInstalledPackages(): Promise<void> {
		const packageManager = this.getStorePackageManager();
		const packages = packageManager.listConfiguredPackages();
		if (packages.length === 0) {
			this.showStatus("No packages installed");
			return;
		}

		const labels = new Map<string, ConfiguredPackage>();
		const options = packages.map((pkg, index) => {
			const filtered = pkg.filtered ? " filtered" : "";
			const label = `${index + 1}. ${pkg.scope} - ${formatStoreSourceSummary(pkg.source)}${filtered}`;
			labels.set(label, pkg);
			return label;
		});
		options.push("Update all", "Cancel");

		const selection = await this.showExtensionSelector("Installed packages", options);
		if (!selection || selection === "Cancel") {
			return;
		}
		if (selection === "Update all") {
			await this.showStoreUpdateFlow();
			return;
		}

		const pkg = labels.get(selection);
		if (pkg) {
			await this.showInstalledStorePackageActions(packageManager, pkg);
		}
	}

	private async showInstalledStorePackageActions(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const action = await this.showExtensionSelector(`${pkg.scope}: ${sourceLabel}`, [
			"Show details",
			"Update",
			"Remove",
			"Back",
		]);
		if (!action || action === "Back") {
			return;
		}
		if (action === "Show details") {
			this.showStoreText(
				[
					"Installed package",
					`Source: ${sourceLabel}`,
					`Scope: ${pkg.scope}`,
					`Filtered: ${pkg.filtered ? "yes" : "no"}`,
					`Installed path: ${pkg.installedPath ?? "not installed"}`,
				].join("\n"),
			);
			await this.showInstalledStorePackageActions(packageManager, pkg);
			return;
		}
		if (action === "Update") {
			await this.updateInstalledStorePackage(packageManager, pkg);
			return;
		}
		if (action === "Remove") {
			await this.removeInstalledStorePackage(
				packageManager,
				{ source: pkg.source, scope: pkg.scope },
				pkg.actionSource,
			);
		}
	}

	private async updateInstalledStorePackage(
		packageManager: DefaultPackageManager,
		pkg: ConfiguredPackage,
	): Promise<void> {
		const sourceLabel = formatStoreSourceSummary(pkg.source);
		const confirmed = await this.showExtensionConfirm("Store update", `Update ${sourceLabel}?`);
		if (!confirmed) {
			this.showStatus("Store update cancelled");
			return;
		}
		try {
			await packageManager.update(pkg.actionSource, { local: pkg.scope === "project", scripts: "never" });
			await this.reviewUpdatedPackages(packageManager, pkg.actionSource);
			await this.offerStoreReload(`Updated ${sourceLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeInstalledStorePackage(
		packageManager: DefaultPackageManager,
		target: StoreScopeTarget,
		removeSource = target.source,
	): Promise<void> {
		if (target.scope === "project" && !this.settingsManager.isProjectTrusted()) {
			this.showWarning("Project is not trusted. Use /trust, then restart volt before removing project packages.");
			return;
		}
		const targetLabel = formatStoreSourceSummary(target.source);
		const confirmed = await this.showExtensionConfirm(
			"Store remove",
			`Remove ${targetLabel} from ${target.scope} scope?`,
		);
		if (!confirmed) {
			this.showStatus("Store remove cancelled");
			return;
		}
		try {
			const removed = await packageManager.removeAndPersist(removeSource, {
				local: target.scope === "project",
			});
			await this.settingsManager.flush();
			if (this.reportStoreSettingsErrors(packageManager, removeSource, target.scope)) {
				return;
			}
			if (!removed) {
				this.showWarning(`No matching package found for ${targetLabel}`);
				return;
			}
			await this.offerStoreReload(`Removed ${targetLabel}`);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private reportStoreSettingsErrors(
		packageManager: DefaultPackageManager,
		source: string,
		scope: StoreInstallScope,
	): boolean {
		const settingsErrors = this.settingsManager.drainErrors();
		if (settingsErrors.length === 0) {
			return false;
		}
		const installedPath = packageManager.getInstalledPath(source, scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			this.showWarning(`${errorScope} settings: ${error.message}`);
		}
		if (installedPath) {
			this.showWarning(`Package was installed at ${installedPath}, but settings persistence failed.`);
		}
		return true;
	}

	/**
	 * After a package install, update, or removal: the conversation loads the
	 * change as it reloads (`/reload`), which the user may leave for later.
	 */
	private async offerStoreReload(message: string): Promise<void> {
		const action = await this.showExtensionSelector(`${message}. Reload to load the change?`, [
			"Reload now",
			"Later",
		]);
		if (action === "Reload now") {
			await this.handleReloadCommand();
			return;
		}
		this.showStatus(`${message}. Run /reload to load the change.`);
	}

	private async handleProfileCommand(profileName?: string): Promise<void> {
		await this.clientConnected.promise;
		const operation = this.store.phase?.operation ?? null;
		if (operation === "compaction") {
			this.showWarning("Wait for compaction to finish before switching profiles.");
			return;
		}
		if (operation !== null) {
			this.showWarning("Wait for the current response to finish before switching profiles.");
			return;
		}
		let settings: QueryResult<"settings">;
		try {
			settings = await this.store.client.query("settings");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (profileName) {
			if (!settings.profiles?.includes(profileName)) {
				this.showWarning(`Profile "${profileName}" is not defined. Run /profile to create it.`);
				return;
			}
			await this.switchProfile(profileName, { current: settings.profile });
			return;
		}

		await this.showProfileSelector(settings.profile, settings.profiles ?? []);
	}

	private async showProfileSelector(currentProfile: string, profileNames: readonly string[]): Promise<void> {
		const profileByLabel = new Map<string, string>();
		const options: string[] = [];

		for (const [index, profileName] of profileNames.entries()) {
			const currentSuffix = profileName === currentProfile ? " (current)" : "";
			const label = `${index + 1}. ${profileName}${currentSuffix}`;
			profileByLabel.set(label, profileName);
			options.push(label);
		}

		const createCurrentLabel =
			currentProfile && !profileNames.includes(currentProfile) ? `Create "${currentProfile}"` : undefined;
		if (createCurrentLabel) {
			options.push(createCurrentLabel);
		}
		options.push("Create new profile", "Cancel");

		const selection = await this.showExtensionSelector(`Current profile: ${currentProfile || "none"}`, options);
		if (!selection || selection === "Cancel") {
			return;
		}

		const selectedProfile = profileByLabel.get(selection);
		if (selectedProfile) {
			await this.switchProfile(selectedProfile, { current: currentProfile });
			return;
		}

		if (selection === createCurrentLabel && currentProfile) {
			await this.switchProfile(currentProfile, { create: true });
			return;
		}

		const createdProfile = await this.showExtensionInput("Create profile", "Profile name");
		if (createdProfile === undefined) {
			this.showStatus("Profile creation cancelled");
			return;
		}
		await this.switchProfile(createdProfile, { create: true });
	}

	/**
	 * Switch the settings profile through the host's `set_profile`, which
	 * reloads the conversation and applies the profile's model scope and
	 * default model; `create` makes the profile first. The TUI reloads its own
	 * settings, keybindings, and themes as the conversation reloads.
	 */
	private async switchProfile(profileName: string, options: { current?: string; create?: boolean }): Promise<void> {
		const name = profileName.trim();
		if (!name) {
			this.showWarning("Profile name cannot be empty");
			return;
		}
		if (!options.create && options.current === name) {
			this.showStatus(`Current profile: ${name}`);
			return;
		}
		this.showStatus(`Switching profile to ${name}...`);
		let switched: { profile: string; created: boolean; warnings: readonly string[] } | undefined;
		try {
			switched = (
				await this.store.client.intent("set_profile", { name, ...(options.create ? { create: true } : {}) })
			).result;
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const profile = switched?.profile ?? name;
		const createdPrefix = switched?.created ? `Created profile ${profile}. ` : "";
		this.showStatus(`${createdPrefix}Profile: ${profile}. Reloaded keybindings, extensions, skills, prompts, themes`);
		for (const warning of switched?.warnings ?? []) this.showWarning(warning);
		this.updateEditorBorderColor();
	}

	/** The models the model selector offers: the conversation's `models` catalog and its model. */
	private async modelSelectorCatalog(): Promise<ModelSelectorCatalog> {
		const { models, cycleScope } = await this.store.client.query("models");
		return { models, scoped: scopedModels(models, cycleScope), current: this.store.state.model };
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		await this.clientConnected.promise;
		let catalog: ModelSelectorCatalog;
		try {
			catalog = await this.modelSelectorCatalog();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (searchTerm) {
			// The models the cycle steps through when a scope limits it, else every selectable one.
			const candidates =
				catalog.scoped.length > 0
					? catalog.models.filter((model) =>
							catalog.scoped.some((scoped) => scoped.provider === model.provider && scoped.modelId === model.id),
						)
					: catalog.models;
			const model = findExactModelReferenceMatch(searchTerm, candidates);
			if (model) {
				await this.selectModel(model);
				return;
			}
		}
		this.showModelSelector(catalog, searchTerm);
	}

	/** Switch the conversation to `model`, the default for new conversations too. */
	private async selectModel(model: RpcCatalogModel): Promise<void> {
		try {
			await this.input.selectModel(model);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.updateEditorBorderColor();
		this.showStatus(`Model: ${model.id}`);
		this.checkDaxnutsEasterEgg(model);
	}

	private async maybeSaveImplicitProjectTrustAfterReload(): Promise<boolean> {
		if (this.autoTrustOnReloadCwd === undefined) return false;
		const cwd = (await this.sessions.info()).cwd;
		if (this.autoTrustOnReloadCwd !== cwd) {
			return false;
		}
		// Trust entries are never persisted for daemon-managed worktree paths.
		if (isPathUnderWorktreesRoot(getAgentDir(), cwd)) {
			return false;
		}
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) {
			return false;
		}

		const trustStore = new ProjectTrustStore(getAgentDir());
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(
				`Could not save project trust after reload: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	/**
	 * /worktree — open a new session inside a daemon-managed git worktree
	 * (§5.2.1): ensures the daemon is running, creates (or picks) a worktree via
	 * the control socket, then starts a new session in the worktree checkout
	 * (`new_session{cwd}`), stored where the conversation it leaves is, and
	 * binds it to the worktree once the client moved there.
	 */
	private async handleWorktreeCommand(args: string): Promise<void> {
		await this.clientConnected.promise;
		const operation = this.store.phase?.operation;
		if (operation === "turn" || operation === "compaction" || operation === "navigation") {
			this.showWarning("Wait for the current response to finish before switching to a worktree.");
			return;
		}
		const parts = args.split(/\s+/).filter((part) => part.length > 0);
		let createRequested = false;
		let requestedName: string | undefined;
		if (parts.length > 0) {
			if (parts[0] !== "new" || parts.length > 2) {
				this.showWarning("Usage: /worktree [new [name]]");
				return;
			}
			createRequested = true;
			requestedName = parts[1];
		}

		this.showStatus("Contacting voltd…");
		const cwd = (await this.sessions.info()).cwd;
		const opened = await openDaemonWorktreeControl({ cwd, agentDir: getAgentDir() });
		if (!opened.ok) {
			this.showError(`Worktrees need the volt daemon: ${opened.error}`);
			return;
		}
		const control: DaemonWorktreeControl = opened.control;
		try {
			let target: { id: string; path: string; branch: string; baseRef?: string } | undefined;
			if (createRequested) {
				const created = await control.createWorktree(requestedName);
				if (!created.ok) {
					this.showError(`Failed to create worktree: ${created.error}`);
					return;
				}
				target = created.worktree;
			} else {
				const worktrees = (await control.listWorktrees()).filter((worktree) => worktree.available !== false);
				const createLabel = "Create new worktree";
				const labels = worktrees.map((worktree) => `${worktree.id} (${worktree.branch})`);
				const selection = await this.showExtensionSelector(
					`Open a session in a worktree of ${control.workspaceName}`,
					[createLabel, ...labels],
				);
				if (selection === undefined) {
					this.showStatus("Worktree selection cancelled");
					return;
				}
				if (selection === createLabel) {
					const created = await control.createWorktree(undefined);
					if (!created.ok) {
						this.showError(`Failed to create worktree: ${created.error}`);
						return;
					}
					target = created.worktree;
				} else {
					target = worktrees[labels.indexOf(selection)];
				}
			}
			if (!target) {
				this.showError("No worktree selected");
				return;
			}

			const outcome = await this.sessions.newSessionIn({
				cwd: target.path,
				workspaceName: control.workspaceName,
				...(target.baseRef === undefined ? {} : { baseRef: target.baseRef }),
			});
			if (!outcome.moved) {
				this.showStatus("Worktree session cancelled");
				return;
			}
			if (!(await control.bindSession(target.id, outcome.conversation))) {
				this.showWarning(`The daemon did not bind this session to worktree ${target.id}.`);
			}
			this.showStatus(`New session in worktree ${target.id} (branch ${target.branch}) — ${target.path}`);
			this.ui.requestRender();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			await control.close().catch(() => {});
		}
	}

	/** `/trust`: save a trust decision for the project the conversation runs in, or its worktree's parent checkout. */
	private async showTrustSelector(): Promise<void> {
		await this.clientConnected.promise;
		const agentDir = getAgentDir();
		const sessionCwd = (await this.sessions.info()).cwd;
		// Worktree sessions pin trust to the PARENT checkout; entries are never
		// prompted for or persisted on worktree paths (§5.2.1).
		const worktreeParent = resolveWorktreeParentCheckout(agentDir, sessionCwd);
		if (worktreeParent === undefined && isPathUnderWorktreesRoot(agentDir, sessionCwd)) {
			this.showWarning(
				"This session runs in a daemon-managed worktree and its parent checkout could not be resolved; trust decisions are managed on the parent workspace.",
			);
			return;
		}
		const cwd = worktreeParent ?? sessionCwd;
		const trustStore = new ProjectTrustStore(agentDir);
		const savedDecision = trustStore.getEntry(cwd);
		this.showSelector((done) => {
			const selector = new TrustSelectorComponent({
				cwd,
				savedDecision,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				onSelect: (selection) => {
					trustStore.setMany(selection.updates);
					done();
					this.showStatus(
						`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart volt for this to take effect.`,
					);
				},
				onCancel: () => {
					done();
					this.ui.requestRender();
				},
			});
			return { component: selector, focus: selector };
		});
	}

	private showModelSelector(catalog: ModelSelectorCatalog, initialSearchInput?: string): void {
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				catalog,
				(model) => {
					done();
					void this.selectModel(model);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * `/scoped-models`: the models the model cycle steps through, in order.
	 * Changes apply to the conversation at once; saving keeps them as the
	 * settings' `enabledModels`.
	 */
	private async showModelsSelector(): Promise<void> {
		await this.clientConnected.promise;
		const client = this.store.client;
		let models: readonly RpcCatalogModel[];
		let scope: readonly ScopedModel[];
		try {
			const catalog = await client.query("models");
			models = catalog.models;
			scope = scopedModels(catalog.models, catalog.cycleScope);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (models.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// The thinking level the scope gives a model stays with it.
		const levels = new Map(scope.map((scoped) => [`${scoped.provider}/${scoped.modelId}`, scoped.thinkingLevel]));
		const scopeOf = (enabledIds: readonly string[] | null): ScopedModel[] => {
			if (enabledIds === null || enabledIds.length === models.length) return [];
			return enabledIds.flatMap((id) => {
				const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === id);
				if (!model) return [];
				const thinkingLevel = levels.get(id);
				return [
					{
						provider: model.provider,
						modelId: model.id,
						...(thinkingLevel === undefined ? {} : { thinkingLevel }),
					},
				];
			});
		};
		const setScope = async (enabledIds: readonly string[] | null, persist: boolean): Promise<void> => {
			try {
				await client.intent("set_model_scope", { models: scopeOf(enabledIds), ...(persist ? { persist } : {}) });
				if (persist) this.showStatus("Model selection saved to settings");
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: models,
					enabledModelIds:
						scope.length === 0 ? null : scope.map((scoped) => `${scoped.provider}/${scoped.modelId}`),
				},
				{
					onChange: (enabledIds) => setScope(enabledIds, false),
					onPersist: (enabledIds) => setScope(enabledIds, true),
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/** `/fork`: the user messages of the conversation; a fork taken before one moves the client there, its text in the editor. */
	private showUserMessageSelector(): void {
		const userMessages = forkableMessages(this.store.state);

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const outcome = await this.sessions.fork(entryId);
						if (!outcome.moved) {
							done();
							this.ui.requestRender();
							return;
						}
						this.editor.setText(outcome.text);
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(`Failed to fork session: ${errorText(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		await this.clientConnected.promise;
		if (!this.store.state.leafId) {
			this.showStatus("Nothing to clone yet");
			return;
		}
		try {
			if (!(await this.sessions.clone()).moved) {
				this.ui.requestRender();
				return;
			}
			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(`Failed to clone session: ${errorText(error)}`);
		}
	}

	/**
	 * `/tree`: the conversation's entry tree as the client fold holds it.
	 * Picking an entry moves the active branch there (`navigate_tree`),
	 * summarizing the branch it leaves when asked; the interrupt key stops
	 * the summary. Labels change through `set_label`.
	 */
	private showTreeSelector(initialSelectedId?: string): void {
		const state = this.store.state;
		const tree = entryTree(state);
		const realLeafId = state.leafId;
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// The interrupt key stops a summary: the conversation's operation is the navigation meanwhile.
					let summaryLoader: Loader | undefined;
					if (wantsSummary) {
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("accent", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.interrupt")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.sessions.navigate(entryId, {
							summarize: wantsSummary,
							...(customInstructions === undefined ? {} : { customInstructions }),
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						// The transcript drew the branch from its leaf entry.
						if (result.editorText && !this.editor.getText().trim()) {
							this.editor.setText(result.editorText);
						}
						this.showStatus("Navigated to selected point");
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					void this.sessions.label(entryId, label).then(
						() => this.ui.requestRender(),
						(error: unknown) => this.showError(errorText(error)),
					);
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * `/resume`: the stored sessions of the conversation's workspace, or of
	 * every session directory, as the `sessions` query lists and searches
	 * them; picking one moves the client there. Renaming and deleting go
	 * through their intents; the host deletes only sessions of this
	 * workspace, so the picker refuses the others.
	 */
	private showSessionSelector(): void {
		const current = this.store.conversation;
		/** The sessions of this workspace, once listed: the ones the host deletes. */
		let workspace: ReadonlySet<string> | undefined;
		const loader =
			(scope: "workspace" | "all") =>
			async (_onProgress?: unknown, query?: string): Promise<SessionSelectorItem[]> => {
				const sessions = await this.sessions.list(scope, query);
				if (scope === "workspace" && !query?.trim()) {
					workspace = new Set(sessions.map((session) => session.sessionId));
				}
				return sessions.map(sessionItem);
			};
		this.showSelector((done) => {
			const selector = new SessionSelectorComponent(
				loader("workspace"),
				loader("all"),
				async (session) => {
					done();
					await this.handleResumeSession(session.id, session.cwd || undefined);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => {
					done();
					this.runKeyAction(() => this.requestQuit());
				},
				() => this.ui.requestRender(),
				{
					renameSession: (session, name) => this.sessions.rename(name, session.id),
					showRenameHint: true,
					keybindings: this.keybindings,
					deleteSession: (session) => this.sessions.deleteSession(session.id),
					deleteRefusal: (session) =>
						workspace === undefined || workspace.has(session.id)
							? undefined
							: "Only sessions of this folder can be deleted here",
				},
				current,
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Move the client to the stored session `sessionId`. When its working
	 * directory (`sessionCwd`, when known) is gone, the user may continue in
	 * the current one instead. Resolves where the client went, if it moved.
	 */
	private async handleResumeSession(sessionId: string, sessionCwd?: string): Promise<MoveOutcome> {
		await this.clientConnected.promise;
		const stays: MoveOutcome = { moved: false };
		try {
			const outcome = await this.sessions.switchTo(sessionId);
			if (outcome.moved) this.showStatus("Resumed session");
			return outcome;
		} catch (error: unknown) {
			if (!isMissingCwd(error)) {
				this.showError(`Failed to resume session: ${errorText(error)}`);
				return stays;
			}
			const cwd = await this.continueInCurrentCwd(error.message, sessionCwd);
			if (cwd === undefined) {
				this.showStatus("Resume cancelled");
				return stays;
			}
			try {
				const outcome = await this.sessions.switchTo(sessionId, cwd);
				if (outcome.moved) this.showStatus("Resumed session in current cwd");
				return outcome;
			} catch (retryError: unknown) {
				this.showError(`Failed to resume session: ${errorText(retryError)}`);
				return stays;
			}
		}
	}

	/** The providers `/login` offers for `authType`, as the host's `auth.providers` query lists them. */
	private async loginProviderOptions(authType: "oauth" | "api_key"): Promise<AuthSelectorProvider[]> {
		const { providers } = await this.store.client.query("auth.providers");
		return providers
			.filter((provider) =>
				authType === "oauth" ? provider.oauth : provider.apiKey || provider.id === BEDROCK_PROVIDER_ID,
			)
			.map((provider) => ({ ...provider, authType }));
	}

	private showLoginAuthTypeSelector(): void {
		const subscriptionLabel = "Use a subscription";
		const apiKeyLabel = "Use an API key";
		this.showSelector((done) => {
			const selector = new ExtensionSelectorComponent(
				"Select authentication method:",
				[subscriptionLabel, apiKeyLabel],
				(option) => {
					done();
					const authType = option === subscriptionLabel ? "oauth" : "api_key";
					this.runKeyAction(() => this.showLoginProviderSelector(authType));
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showLoginProviderSelector(authType: "oauth" | "api_key"): Promise<void> {
		await this.clientConnected.promise;
		const providerOptions = await this.loginProviderOptions(authType);
		if (providerOptions.length === 0) {
			this.showStatus(
				authType === "oauth" ? "No subscription providers available." : "No API key providers available.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				providerOptions,
				(providerId: string) => {
					done();
					const provider = providerOptions.find((candidate) => candidate.id === providerId);
					if (!provider) return;
					if (provider.id === BEDROCK_PROVIDER_ID && authType === "api_key") {
						this.showBedrockSetupDialog(provider.id, provider.name);
					} else {
						void this.login(provider.id, provider.name, authType);
					}
				},
				() => {
					done();
					this.showLoginAuthTypeSelector();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
		if (mode === "login") {
			this.showLoginAuthTypeSelector();
			return;
		}

		await this.clientConnected.promise;
		const client = this.store.client;
		const providerOptions: AuthSelectorProvider[] = (await client.query("auth.providers")).providers.flatMap(
			(provider) => (provider.stored === undefined ? [] : [{ ...provider, authType: provider.stored }]),
		);
		if (providerOptions.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
			);
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				mode,
				providerOptions,
				async (providerId: string) => {
					done();
					const provider = providerOptions.find((candidate) => candidate.id === providerId);
					if (!provider) return;
					try {
						const removed = (await client.intent("auth.logout", { provider: provider.id })).result?.removed;
						this.showStatus(
							removed === "oauth"
								? `Logged out of ${provider.name}`
								: `Removed stored API key for ${provider.name}. Environment variables and models.json config are unchanged.`,
						);
					} catch (error: unknown) {
						this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * Sign in to `provider` through the host's `auth.login`: the host runs the
	 * provider's login and asks this client alone, with `provider_auth`
	 * requests while a sign-in page or device code waits (the sign-in dialog)
	 * and `input` requests, masked for an API key.
	 */
	private async login(provider: string, name: string, method: "oauth" | "api_key"): Promise<void> {
		this.signIn = { provider, name };
		const action = method === "oauth" ? `Logged in to ${name}` : `Saved API key for ${name}`;
		try {
			const result = (await this.store.client.intent("auth.login", { provider, method })).result;
			if (result === undefined || "cancelled" in result) return;
			this.updateEditorBorderColor();
			if (result.model !== undefined) {
				this.showStatus(`${action}. Selected ${result.model.modelId}. Credentials saved to ${getAuthPath()}`);
				this.checkDaxnutsEasterEgg({ provider: result.model.provider, id: result.model.modelId });
			} else {
				this.showStatus(`${action}. Credentials saved to ${getAuthPath()}`);
			}
			if (result.warning !== undefined) this.showWarning(result.warning);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(
				method === "oauth"
					? `Failed to login to ${name}: ${message}`
					: `Failed to save API key for ${name}: ${message}`,
			);
		} finally {
			this.signIn = undefined;
			this.closeSignInView();
		}
	}

	/**
	 * Show a `provider_auth` request in the sign-in dialog until the user
	 * answers or cancels it, or the host ends it: a sign-in page to open (only
	 * an http or https address opens), a device code to enter there, or a
	 * page whose redirect URL or code the user pastes as the answer.
	 */
	private showProviderAuth(
		request: Extract<HostRequest, { kind: "provider_auth" }>,
		signal: AbortSignal,
	): Promise<HostResponse | undefined> {
		return new Promise((resolve) => {
			if (signal.aborted) {
				resolve(undefined);
				return;
			}
			const view = this.openSignInView(request.provider);
			const shown = ++view.shown;
			// The page opens for a sign-in `/login` started here; any other only shows its link.
			const open = this.signIn?.provider === request.provider;
			let settled = false;
			const settle = (response: HostResponse | undefined): void => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", end);
				if (view.cancel === cancel) view.cancel = undefined;
				resolve(response);
				// A sign-in that goes on (a device code after a page) shows its next request in the same dialog.
				setImmediate(() => {
					if (this.signInView === view && view.shown === shown) this.closeSignInView();
				});
			};
			const cancel = (): void => settle({ cancelled: true });
			const end = (): void => settle(undefined);
			signal.addEventListener("abort", end, { once: true });
			view.cancel = cancel;
			switch (request.flow) {
				case "device":
					view.dialog.showDeviceCode({ verificationUri: request.url, userCode: request.userCode ?? "" });
					view.dialog.showWaiting("Waiting for authentication...");
					return;
				case "browser":
					view.dialog.showAuth(request.url, request.instructions, { open });
					return;
				case "manual":
					view.dialog.showAuth(request.url, request.instructions, { open });
					view.dialog.showManualInput("Paste redirect URL below, or complete login in browser:").then(
						(value) => settle({ value }),
						() => settle({ cancelled: true }),
					);
					return;
			}
		});
	}

	/** The sign-in dialog, shown in place of the editor until the sign-in ends. */
	private openSignInView(provider: string): SignInView {
		if (this.signInView) return this.signInView;
		this.dismissWorkInspector?.();
		const restore = { view: this.activeView, focus: this.ui.getFocusedComponent() };
		const name = this.signIn?.provider === provider ? this.signIn.name : provider;
		const view: SignInView = {
			// Escape cancels the sign-in the dialog shows.
			dialog: new LoginDialogComponent(this.ui, provider, () => view.cancel?.(), name),
			restore,
			shown: 0,
		};
		this.signInView = view;
		this.activateView(this.createDedicatedView(view.dialog), view.dialog);
		return view;
	}

	/** Close the sign-in dialog: the sign-in ended, and the host ends what it asked. */
	private closeSignInView(): void {
		const view = this.signInView;
		if (!view) return;
		this.signInView = undefined;
		this.activateView(view.restore.view, view.restore.focus ?? this.editor);
	}

	private showBedrockSetupDialog(providerId: string, providerName: string): void {
		const previousView = this.activeView;
		const previousFocus = this.ui.getFocusedComponent();
		const restoreEditor = () => this.activateView(previousView, previousFocus ?? this.editor);

		const dialog = new LoginDialogComponent(
			this.ui,
			providerId,
			() => restoreEditor(),
			providerName,
			"Amazon Bedrock setup",
		);
		dialog.showInfo([
			theme.fg("text", "Amazon Bedrock uses AWS credentials instead of a single API key."),
			theme.fg("text", "Configure an AWS profile, IAM keys, bearer token, or role-based credentials."),
			theme.fg("muted", "See:"),
			theme.fg("accent", `  ${path.join(getDocsPath(), "providers.md")}`),
		]);

		this.activateView(this.createDedicatedView(dialog), dialog);
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	private async reloadRuntimeResources(options?: {
		action?: string;
		progressMessage?: string;
		successMessage?: (savedImplicitProjectTrust: boolean) => string;
	}): Promise<boolean> {
		const action = options?.action ?? "reloading";
		await this.clientConnected.promise;
		const operation = this.store.phase?.operation;
		if (operation === "turn") {
			this.showWarning(`Wait for the current response to finish before ${action}.`);
			return false;
		}
		if (operation === "compaction" || operation === "navigation") {
			this.showWarning(`Wait for compaction to finish before ${action}.`);
			return false;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg(
					"muted",
					options?.progressMessage ?? "Reloading keybindings, extensions, skills, prompts, themes...",
				),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.dismissWorkInspector?.();
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			// The host reloads the conversation's resources and settings; the TUI reloads its own.
			await this.sessions.reload();
			// The reloaded commands and shortcuts, as the conversation's intents catalog lists them now, and its resources.
			const [, resources, scope] = await Promise.all([
				this.input.load().catch(() => false),
				this.store.client.query("resources").catch(() => undefined),
				this.readSettingsScope(),
			]);
			this.resources = resources;
			if (scope === undefined || !this.followSettings(scope)) await this.settingsManager.reload();
			this.keybindings.reload();
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			this.registerThemes();
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.catalogs.refresh("models", "settings");
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			this.applyFullscreenScrollbarSetting();
			this.setupAutocompleteProvider();
			this.setupExtensionShortcuts();
			this.transcript.rebuild();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const savedImplicitProjectTrust = await this.maybeSaveImplicitProjectTrustAfterReload();
			// What the reloaded setup reports as errors, such as a models.json the host could not read.
			for (const notice of resources?.notices ?? []) {
				if (notice.level === "error") this.showError(notice.message);
			}
			this.showStatus(
				options?.successMessage?.(savedImplicitProjectTrust) ??
					(savedImplicitProjectTrust
						? "Reloaded keybindings, extensions, skills, prompts, themes; saved project trust"
						: "Reloaded keybindings, extensions, skills, prompts, themes"),
			);
			return true;
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private async handleReloadCommand(): Promise<void> {
		await this.reloadRuntimeResources();
	}

	/** `/export [path]`: the host writes the session as HTML, or with a `.jsonl` path its active branch as JSONL. */
	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");
		await this.clientConnected.promise;
		try {
			const filePath = await this.sessions.exportTo(outputPath);
			this.showStatus(`Session exported to: ${filePath}`);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	/**
	 * `/import <path>`: the host imports the JSONL session file as a new
	 * session and moves the client there; one whose working directory is gone
	 * runs in the current one when the user agrees.
	 */
	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		await this.clientConnected.promise;
		const imported = (moved: boolean): void =>
			this.showStatus(moved ? `Session imported from: ${inputPath}` : "Import cancelled");
		try {
			imported((await this.sessions.importSession(inputPath)).moved);
		} catch (error: unknown) {
			if (!isMissingCwd(error)) {
				this.showError(`Failed to import session: ${errorText(error)}`);
				return;
			}
			const cwd = await this.continueInCurrentCwd(error.message, undefined);
			if (cwd === undefined) {
				this.showStatus("Import cancelled");
				return;
			}
			try {
				imported((await this.sessions.importSession(inputPath, cwd)).moved);
			} catch (retryError: unknown) {
				this.showError(`Failed to import session: ${errorText(retryError)}`);
			}
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		let scratchDirectory: string;
		try {
			scratchDirectory = this.createScratchDirectory("volt-share-");
		} catch (error: unknown) {
			this.showError(
				`Failed to create private share file: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
			return;
		}
		const tmpFile = path.join(scratchDirectory, "session.html");
		try {
			await this.clientConnected.promise;
			await this.sessions.exportTo(tmpFile);
		} catch (error: unknown) {
			this.removeScratchDirectory(scratchDirectory);
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		let restored = false;
		const restoreEditor = () => {
			if (restored) return;
			restored = true;
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.removeScratchDirectory(scratchDirectory);
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.once("error", (error) => resolve({ stdout, stderr: error.message, code: null }));
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		} finally {
			restoreEditor();
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = lastAssistantText(this.store.transcript());
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleNameCommand(text: string): Promise<void> {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.store.state.name;
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		await this.clientConnected.promise;
		await this.sessions.rename(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handleFastCommand(text: string): Promise<void> {
		const argument = text.slice("/fast".length).trim();
		if (argument !== "" && argument !== "on" && argument !== "off") {
			this.showWarning("Usage: /fast [on|off]");
			return;
		}
		await this.clientConnected.promise;
		const wasEnabled = this.store.state.fastMode;
		const enabled = argument === "" ? !wasEnabled : argument === "on";
		try {
			await this.store.client.intent("set_fast_mode", { enabled });
		} catch (error: unknown) {
			this.showWarning(error instanceof Error ? error.message : String(error));
			return;
		}
		if (enabled) {
			this.showWarning(
				wasEnabled
					? "Fast mode already enabled. Priority processing may cost more."
					: "Fast mode enabled. Priority processing may cost more.",
			);
		} else {
			this.showStatus(wasEnabled ? "Fast mode disabled" : "Fast mode already disabled");
		}
	}

	/** `/session`: where the conversation's log lives, its messages from the client fold, and its usage from the live lane. */
	private async handleSessionCommand(): Promise<void> {
		await this.clientConnected.promise;
		const conversation = await this.sessions.info();
		const stats = messageStats(this.store.state);
		const usage = this.store.value("usage");
		const tokens =
			usage?.kind === "usage" ? usage.tokens : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
		const cost = usage?.kind === "usage" ? usage.cost : 0;
		const sessionName = this.store.state.name;

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "Store:")} ${conversation.persisted ? conversation.sessionDir : "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${conversation.id}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.user}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistant}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.total}\n\n`;
		info += `${theme.bold("Tokens")}\n`;
		info += `${theme.fg("dim", "Input:")} ${tokens.input.toLocaleString()}\n`;
		info += `${theme.fg("dim", "Output:")} ${tokens.output.toLocaleString()}\n`;
		if (tokens.cacheRead > 0) {
			info += `${theme.fg("dim", "Cache Read:")} ${tokens.cacheRead.toLocaleString()}\n`;
		}
		if (tokens.cacheWrite > 0) {
			info += `${theme.fg("dim", "Cache Write:")} ${tokens.cacheWrite.toLocaleString()}\n`;
		}
		info += `${theme.fg("dim", "Total:")} ${tokens.total.toLocaleString()}\n`;

		if (cost > 0) {
			info += `\n${theme.bold("Cost")}\n`;
			info += `${theme.fg("dim", "Total:")} ${cost.toFixed(4)}`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private formatSubscriptionUsageError(error: SubscriptionUsageError): string {
		switch (error.code) {
			case "unauthorized":
				return "Authentication failed. Run /login to reconnect this subscription.";
			case "rate_limited":
				return "Usage status is rate limited. Try again later.";
			case "timeout":
				return "Usage status request timed out.";
			case "malformed_response":
				return "Usage status returned an unsupported response.";
			case "unavailable":
				return "Usage status is temporarily unavailable.";
		}
	}

	private formatSubscriptionPlan(plan: string): string {
		return plan
			.split(/[_-]+/)
			.filter(Boolean)
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(" ");
	}

	private formatRemainingPercent(usedPercent: number): string {
		const remaining = Math.max(0, 100 - usedPercent);
		return Number.isInteger(remaining) ? remaining.toFixed(0) : remaining.toFixed(1);
	}

	private async handleUsageCommand(): Promise<void> {
		await this.clientConnected.promise;
		const client = this.store.client;
		let report: QueryResult<"subscription_usage">;
		let providers: readonly AuthProvider[];
		try {
			[report, { providers }] = await Promise.all([
				client.query("subscription_usage"),
				client.query("auth.providers"),
			]);
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (report.status === "no_subscription") {
			this.showStatus("No subscription login is configured. Use /login to connect a supported provider.");
			return;
		}
		if (report.status === "unsupported") {
			this.showStatus("Stored subscription credentials do not expose quota usage in Volt.");
			return;
		}

		const sections: string[] = [];
		for (const provider of report.providers) {
			const providerName =
				providers.find((candidate) => candidate.id === provider.providerId)?.name ?? provider.providerId;
			if (provider.result.status === "error") {
				sections.push(
					`${theme.bold(providerName)}\n  ${theme.fg("warning", this.formatSubscriptionUsageError(provider.result.error))}`,
				);
				continue;
			}

			const snapshot = provider.result.snapshot;
			const heading = snapshot.plan
				? `${providerName} · ${this.formatSubscriptionPlan(snapshot.plan)}`
				: providerName;
			const lines = snapshot.limits.map((limit) => {
				let line = `${theme.fg("dim", `${limit.label}:`)} ${this.formatRemainingPercent(limit.usedPercent)}% remaining`;
				if (limit.resetsAt !== undefined) {
					line += ` · resets ${new Date(limit.resetsAt).toLocaleString()}`;
				}
				if (limit.limitReached) {
					line += ` · ${theme.fg("warning", "limit reached")}`;
				}
				return `  ${line}`;
			});
			sections.push(`${theme.bold(heading)}\n${lines.join("\n")}`);
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(`${theme.bold("Subscription Usage")}\n\n${sections.join("\n\n")}`, 1, 0));
		this.ui.requestRender();
	}

	private async handleLspCommand(args?: string): Promise<void> {
		const formatIdle = (idleMs: number): string => {
			const seconds = Math.floor(idleMs / 1000);
			if (seconds < 60) return `${seconds}s`;
			return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
		};
		const disabled = "LSP is disabled. Run with --lsp or set lsp.enabled=true in settings.";

		await this.clientConnected.promise;
		const client = this.store.client;
		let info: string;
		let status: QueryResult<"lsp.status">;
		try {
			status = await client.query("lsp.status");
		} catch (error) {
			this.showError(`Could not read LSP status: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (args === "restart") {
			if (status.enabled) {
				const count = (await client.intent("lsp.restart")).result?.stopped ?? 0;
				info = `Stopped ${count} language server${count === 1 ? "" : "s"}. Servers respawn on next use.\nThis includes servers shared with subagents.`;
			} else {
				info = disabled;
			}
		} else if (args === "trace" || args?.startsWith("trace ")) {
			if (!status.enabled) {
				info = disabled;
			} else {
				const traceArg = args === "trace" ? undefined : args.slice(6).trim();
				await this.closeLspTrace();
				if (traceArg === "off") {
					info = "LSP tracing disabled.";
				} else {
					let tracePath: string;
					if (traceArg && traceArg.length > 0) {
						tracePath = traceArg;
					} else {
						const scratchDirectory = this.createScratchDirectory("volt-lsp-trace-");
						this.lspTraceScratchDirectory = scratchDirectory;
						tracePath = path.join(scratchDirectory, "trace.log");
					}
					try {
						const traceFile = (await client.intent("lsp.set_trace", { path: tracePath })).result?.traceFile;
						this.lspTracing = true;
						info = `LSP tracing enabled: ${traceFile ?? tracePath}\nUse /lsp trace off to disable.`;
					} catch (error) {
						if (this.lspTraceScratchDirectory) {
							this.removeScratchDirectory(this.lspTraceScratchDirectory);
						}
						info = `Failed to enable LSP tracing: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
			}
		} else {
			info = `${theme.bold("LSP Health")}\n${theme.fg("muted", "Workspace:")} ${status.workspaceRoot ?? "unknown"}\n`;
			info += `${theme.fg("muted", "Snapshot only; no server starts or installs. /lsp restart · /lsp trace [path|off]")}\n`;
			info += `${theme.fg("muted", "Ready means transport initialized; build settings/indexing are not verified.")}\n`;
			if (!status.enabled) {
				info += `${theme.fg("warning", "LSP is disabled. Enable with --lsp or lsp.enabled=true.")}\n`;
			}
			if (status.servers.length === 0) info += "No configured language servers.\n";
			for (const server of status.servers) {
				const state = server.state ?? (server.alive ? "starting" : server.lastError ? "failed" : "unused");
				const color =
					state === "ready"
						? "success"
						: state === "failed" || state === "blocked"
							? "error"
							: state === "degraded"
								? "warning"
								: "muted";
				info += `\n${theme.bold(server.name)} ${theme.fg(color, state)}`;
				const notStarted = state === "unused" || state === "disabled";
				if (notStarted) {
					info += ` ${theme.fg("muted", "· capabilities unknown; not started")}\n`;
				} else {
					info += ` ${theme.fg("muted", `· version ${server.version ?? server.serverInfo?.version ?? "unknown"} · breaker ${server.breaker ?? "unknown"}`)}\n`;
				}
				if (server.projectContext) info += `${theme.fg("muted", "Project context:")} ${server.projectContext}\n`;
				if (server.coverage) info += `${theme.fg("warning", `Coverage: ${server.coverage}`)}\n`;
				if (notStarted) continue;
				info += `${theme.fg("muted", "Root:")} ${server.root}\n`;
				info += `${theme.fg("muted", "Executable:")} ${server.resolvedExecutable ?? `unresolved: ${server.unresolvedCommand ?? "unknown"}`} (${server.launchSource})\n`;
				if (server.serverInfo) info += `${theme.fg("muted", "Server:")} ${server.serverInfo.name}\n`;
				info += `${theme.fg("muted", "Capabilities:")} ${server.capabilities === undefined ? "unknown" : server.capabilities.length === 0 ? "none advertised" : server.capabilities.join(", ")}\n`;
				info += `${theme.fg("muted", "Activity:")} ${server.operations ?? 0} operations · ${server.failures ?? 0} failures · ${server.attempts} starts · ${server.openDocuments} documents · idle ${formatIdle(server.idleMs)}\n`;
				info += `${theme.fg("muted", "Latency:")} last ${server.lastDurationMs === undefined ? "unknown" : `${Math.round(server.lastDurationMs)}ms`} · total ${Math.round(server.totalDurationMs ?? 0)}ms\n`;
				if (server.lastSuccess || server.lastFailure)
					info += `${theme.fg("muted", "Last success:")} ${server.lastSuccess ?? "none"} · last failure: ${server.lastFailure ?? "none"}\n`;
				if (server.lastError) info += `${theme.fg("error", `Startup: ${server.lastError}`)}\n`;
				if (server.startupStderr) info += `${theme.fg("muted", `Stderr: ${server.startupStderr}`)}\n`;
				if (server.requestError) info += `${theme.fg("warning", `Request: ${server.requestError}`)}\n`;
			}
			if (status.traceFile) info += `\n${theme.fg("muted", "Trace:")} ${status.traceFile}\n`;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleMcpCommand(args?: string): Promise<void> {
		await this.clientConnected.promise;
		const client = this.store.client;
		const showInfo = (info: string): void => {
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.ui.requestRender();
		};
		const [action, server] = (args ?? "").split(/\s+/, 2);
		let servers: QueryResult<"mcp.servers">["servers"];
		try {
			if ((action === "connect" || action === "refresh") && server) {
				await client.intent(action === "connect" ? "mcp.connect" : "mcp.refresh", { server });
				// The conversation takes the server's tools as it reloads.
				await client.intent("reload").catch((error: unknown) => {
					this.showWarning(
						`Reload to use the server's tools: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
			} else if (action === "disconnect" && server) {
				await client.intent("mcp.disconnect", { server });
			}
			servers = (await client.query("mcp.servers")).servers;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			showInfo(`${theme.bold("MCP Servers")}\n\n${theme.fg("error", message)}`);
			return;
		}

		if (servers.length === 0) {
			showInfo("MCP is not configured. Add servers to ~/.volt/agent/mcp.json, .mcp.json, or .volt/mcp.json.");
			return;
		}
		let info = `${theme.bold("MCP Servers")}\n`;
		for (const entry of servers) {
			const statusColor =
				entry.status === "ready" || entry.status === "connected"
					? "success"
					: entry.status === "error" || entry.status === "needs_auth"
						? "error"
						: "muted";
			info += `\n${theme.bold(entry.displayName)} ${theme.fg("dim", `(${entry.id})`)} ${theme.fg(statusColor, entry.status)}\n`;
			info += `${theme.fg("dim", "Source:")} ${entry.sourceLabel} (${entry.sourceScope})\n`;
			info += `${theme.fg("dim", "Transport:")} ${entry.transport} ${theme.fg("dim", "Lifecycle:")} ${entry.lifecycle}\n`;
			info += `${theme.fg("dim", "Tools:")} ${entry.toolCounts.enabled ?? entry.toolCounts.cached} enabled / ${entry.toolCounts.cached} cached`;
			if (entry.resourceCount !== undefined || entry.promptCount !== undefined) {
				info += ` ${theme.fg("dim", "Resources:")} ${entry.resourceCount ?? 0} ${theme.fg("dim", "Prompts:")} ${entry.promptCount ?? 0}`;
			}
			if (entry.lastError) {
				info += `\n${theme.fg("error", entry.lastError)}`;
			}
			info += "\n";
		}
		info += `\n${theme.fg("dim", "Use /mcp connect <server>, /mcp refresh <server>, or /mcp disconnect <server>.")}`;
		showInfo(info);
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => normalizeChangelogLinks(e.content, e))
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	/**
	 * Get capitalized display string for an app keybinding action.
	 */
	private getAppKeyDisplay(action: AppKeybinding): string {
		return keyDisplayText(action);
	}

	/**
	 * Get capitalized display string for an editor keybinding action.
	 */
	private getEditorKeyDisplay(action: Keybinding): string {
		return keyDisplayText(action);
	}

	private handleHotkeysCommand(): void {
		// Navigation keybindings
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const clear = this.getAppKeyDisplay("app.clear");
		const exit = this.getAppKeyDisplay("app.exit");
		const debug = this.getAppKeyDisplay("app.debug");
		const suspend = this.getAppKeyDisplay("app.suspend");
		const toggleAgentMode = this.getAppKeyDisplay("app.mode.toggle");
		const togglePlanPane = this.getAppKeyDisplay("app.plan.togglePane");
		const cycleThinkingLevel = this.getAppKeyDisplay("app.thinking.cycle");
		const cycleModelForward = this.getAppKeyDisplay("app.model.cycleForward");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const cycleModelBackward = this.getAppKeyDisplay("app.model.cycleBackward");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const dequeue = this.getAppKeyDisplay("app.message.dequeue");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const openWork = this.getAppKeyDisplay("app.work.open");
		const focusPanels = this.getEditorKeyDisplay("tui.focus.next");

		const sections: HotkeySection[] = [
			{
				title: "Essential workflow",
				entries: [
					{ key: submit, action: "Send message / steer active turn" },
					{ key: interrupt, action: "Stop current response or tool" },
					{ key: followUp, action: "Queue follow-up message" },
					{ key: dequeue, action: "Restore queued messages" },
					{ key: expandTools, action: "Toggle tool output expansion" },
					{ key: selectModel, action: "Open model selector" },
					{ key: toggleAgentMode, action: "Toggle Build / Plan mode" },
					{ key: togglePlanPane, action: "Switch conversation / plan pane focus" },
					{ key: cycleThinkingLevel, action: "Cycle thinking level" },
					{ key: openWork, action: "Inspect work: jobs, subagents, reviews" },
				],
			},
			{
				title: "Navigation",
				entries: [
					{ key: `${cursorUp} / ${cursorDown}`, action: "Move vertically / browse history" },
					{ key: `${cursorLeft} / ${cursorRight}`, action: "Move horizontally" },
					{ key: cursorWordLeft, action: "Move one word left" },
					{ key: cursorWordRight, action: "Move one word right" },
					{ key: cursorLineStart, action: "Start of line" },
					{ key: cursorLineEnd, action: "End of line" },
					{ key: jumpForward, action: "Jump forward to character" },
					{ key: jumpBackward, action: "Jump backward to character" },
					{ key: `${pageUp} / ${pageDown}`, action: "Scroll by page" },
				],
			},
			{
				title: "Editing",
				entries: [
					{ key: submit, action: "Send message" },
					{
						key: newLine,
						action: `New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""}`,
					},
					{ key: deleteWordBackward, action: "Delete word backwards" },
					{ key: deleteWordForward, action: "Delete word forwards" },
					{ key: deleteToLineStart, action: "Delete to start of line" },
					{ key: deleteToLineEnd, action: "Delete to end of line" },
					{ key: yank, action: "Paste the most-recently-deleted text" },
					{ key: yankPop, action: "Cycle through deleted text after pasting" },
					{ key: undo, action: "Undo" },
				],
			},
			{
				title: "Application",
				entries: [
					{ key: tab, action: "Path completion / accept autocomplete" },
					{ key: interrupt, action: "Cancel autocomplete / abort streaming" },
					{ key: clear, action: "Clear editor / exit; confirm when work is active" },
					{ key: exit, action: "Exit (empty editor); confirm when work is active" },
					{ key: `${debug} / /debug`, action: "Capture diagnostics without interrupting work" },
					{ key: suspend, action: "Suspend to background" },
					{ key: toggleAgentMode, action: "Toggle Build / Plan mode" },
					{ key: togglePlanPane, action: "Switch conversation / plan pane focus" },
					{ key: cycleThinkingLevel, action: "Cycle thinking level" },
					{ key: `${cycleModelForward} / ${cycleModelBackward}`, action: "Cycle models" },
					{ key: selectModel, action: "Open model selector" },
					{ key: expandTools, action: "Toggle tool output expansion" },
					{ key: toggleThinking, action: "Toggle thinking block visibility" },
					{ key: externalEditor, action: "Edit message in external editor" },
					{ key: followUp, action: "Queue follow-up message" },
					{ key: dequeue, action: "Restore queued messages" },
					{ key: pasteImage, action: "Paste image from clipboard" },
					{ key: `${openWork} / /work`, action: "Inspect work without interrupting it" },
					{ key: `${focusPanels} (empty editor)`, action: "Focus extension panel actions" },
					{ key: "/", action: "Slash commands" },
					{ key: "!", action: "Run bash command" },
					{ key: "!!", action: "Run bash command (excluded from context)" },
				],
			},
		];

		const shortcuts = this.extensionShortcuts.entries().filter((entry) => entry.keys.length > 0);
		if (shortcuts.length > 0) {
			sections.push({
				title: "Extensions",
				entries: shortcuts.map((entry) => ({
					key: entry.keys.map((key) => formatKeyText(key, { capitalize: true })).join(" / "),
					action: entry.description,
				})),
			});
		}

		this.showSelector((done) => {
			const hotkeys = new HotkeysComponent(
				sections,
				() => this.ui.terminal.rows,
				() => {
					done();
					this.ui.requestRender();
				},
				() => this.ui.requestRender(),
			);
			return { component: hotkeys, focus: hotkeys };
		});
	}

	/** `/clear` and the new-session key: a running turn stops, then the client moves to a new session. */
	private async handleClearCommand(): Promise<void> {
		await this.clientConnected.promise;
		if (this.store.phase?.operation === "turn") {
			// Stop the turn before the move, so it is persisted as it stopped.
			await this.store.client.intent("abort");
		}
		try {
			if (!(await this.sessions.newSession()).moved) return;
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
		} catch (error: unknown) {
			this.showError(`Failed to create session: ${errorText(error)}`);
		}
	}

	private async handleDebugCommand(): Promise<void> {
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		await this.clientConnected.promise;
		const conversation = this.store.conversation;
		const canNotify = () => this.isInitialized && !this.isShuttingDown && this.store.conversation === conversation;
		try {
			const debugLogPath = (await this.store.client.query("debug_report")).path;
			if (!canNotify()) return;
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`${theme.fg("accent", "✓ Tool progress captured")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
			);
			this.ui.requestRender();
		} catch (error) {
			if (canNotify()) {
				this.showError(`Failed to write debug log: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleVoltAnnouncement(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new VoltAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	/**
	 * The completions the conversation's review intents offer for `field` of
	 * `intent`: the workspace's base branches, recent commits, and its
	 * current branch's pull request, as the host reads them.
	 */
	private async reviewCompletions(
		intent: "review_branch" | "review_commit" | "review_pr",
		field: string,
	): Promise<readonly IntentOption[]> {
		try {
			return (await this.store.client.query("intent_completions", { intent, field, prefix: "" })).completions;
		} catch {
			return [];
		}
	}

	private async promptForReviewTarget(): Promise<ReviewTarget | undefined> {
		const branchLabel = "Against base branch";
		const uncommittedLabel = "Uncommitted changes";
		const prLabel = "Pull request";
		const commitLabel = "Specific commit";
		// The current branch's pull request, pinned by its URL as the picker shows it.
		const currentPullRequest = (await this.reviewCompletions("review_pr", "url"))[0];
		const currentPullRequestLabel = currentPullRequest
			? `Current PR ${sanitizeText(currentPullRequest.label ?? currentPullRequest.value)}`
			: undefined;
		const choice = await this.showExtensionSelector("Review what?", [
			...(currentPullRequestLabel ? [currentPullRequestLabel] : []),
			branchLabel,
			uncommittedLabel,
			prLabel,
			commitLabel,
		]);
		if (choice === undefined) {
			return undefined;
		}
		if (choice === currentPullRequestLabel && currentPullRequest) {
			return { kind: "pr", expectedUrl: currentPullRequest.value };
		}
		if (choice === branchLabel) {
			const base = await this.promptForReviewBaseBranch();
			if (!base) {
				return undefined;
			}
			return { kind: "branch", base };
		}
		if (choice === uncommittedLabel) {
			return { kind: "uncommitted" };
		}
		if (choice === prLabel) {
			const number = await this.showExtensionInput("PR number (empty for current branch's PR)", "123");
			if (number === undefined) {
				return undefined;
			}
			return { kind: "pr", number: number.trim() || undefined };
		}
		// Commit: the SHA is picked from the recent-commit list in handleReviewCommand.
		return { kind: "commit" };
	}

	/** Show logical local/upstream base branches and return the selected target. */
	private async promptForReviewBaseBranch(): Promise<string | undefined> {
		const branches = await this.reviewCompletions("review_branch", "base");
		if (branches.length === 0) {
			this.showError("No branches to review against.");
			return undefined;
		}
		const labels = branches.map((branch) => sanitizeText(branch.value));
		const choice = await this.showExtensionSelector("Select base branch", labels);
		return choice === undefined ? undefined : branches[labels.indexOf(choice)]?.value;
	}

	/** Show a recent-commit picker and return the selected SHA. */
	private async promptForReviewCommit(): Promise<string | undefined> {
		const commits = await this.reviewCompletions("review_commit", "ref");
		if (commits.length === 0) {
			this.showError("No commits to review.");
			return undefined;
		}
		const labels = commits.map((commit) =>
			sanitizeText(
				commit.label === undefined
					? commit.value
					: `${commit.value} ${commit.label}${commit.description === undefined ? "" : ` (${commit.description})`}`,
			),
		);
		const choice = await this.showExtensionSelector("Review which commit?", labels);
		if (choice === undefined) {
			return undefined;
		}
		return commits[labels.indexOf(choice)]?.value;
	}

	/**
	 * The auxiliary tools the TUI's reviews may use besides their snapshot
	 * tools (the `reviewTools` setting), of those the conversation offers
	 * reviews: not its workspace file tools.
	 */
	private async getReviewToolsForRun(): Promise<string[]> {
		const configuredTools = this.settingsManager.getReviewTools() ?? [];
		if (configuredTools.length === 0) return [];
		const { tools } = await this.store.client.query("tools");
		const availableToolNames = new Set(
			tools.map((tool) => tool.name).filter((name) => !MUTABLE_WORKSPACE_REVIEW_TOOLS.has(name)),
		);
		const selectedTools = configuredTools.filter((name) => availableToolNames.has(name));
		if (selectedTools.length !== configuredTools.length) {
			this.showWarning("Some configured auxiliary review tools are unavailable and were omitted.");
		}
		return [...new Set(selectedTools)];
	}

	private async showReviewToolsSelector(options: ReviewToolSelectorOption[]): Promise<string[] | undefined> {
		return new Promise((resolve) => {
			const previousView = this.activeView;
			const previousFocus = this.ui.getFocusedComponent();
			const restoreView = () => this.activateView(previousView, previousFocus ?? this.editor);

			const selector = new ReviewToolsSelectorComponent(
				options,
				(toolNames) => {
					restoreView();
					resolve(toolNames);
				},
				() => {
					restoreView();
					resolve(undefined);
				},
			);

			this.activateView(this.createDedicatedView(selector), selector);
		});
	}

	private async configureReviewTools(): Promise<void> {
		let tools: QueryResult<"tools">["tools"];
		try {
			tools = (await this.store.client.query("tools")).tools.filter(
				(tool) => !MUTABLE_WORKSPACE_REVIEW_TOOLS.has(tool.name),
			);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		if (tools.length === 0) {
			this.showError("No auxiliary tools are available to configure for review. Snapshot tools remain enabled.");
			return;
		}

		const selectedTools = new Set(this.settingsManager.getReviewTools() ?? []);
		const options = tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			source: tool.source,
			active: tool.active,
			selected: selectedTools.has(tool.name),
		}));

		const selected = await this.showReviewToolsSelector(options);
		if (selected === undefined) {
			this.showStatus("Review tool selection cancelled");
			return;
		}
		this.settingsManager.setReviewTools(selected);
		this.showStatus(
			selected.length > 0
				? `Auxiliary review tools saved: ${selected.join(", ")}`
				: "Auxiliary review tools disabled; immutable snapshot tools remain active.",
		);
	}

	private async handleReviewCommand(argsText: string): Promise<void> {
		await this.clientConnected.promise;
		const operation = this.store.phase?.operation ?? null;
		if (operation !== null) {
			this.showWarning("Wait for the current response to finish before starting a review.");
			return;
		}

		const parsedArgs = parseReviewCommandArgs(argsText);
		if (parsedArgs.error) {
			this.showError(parsedArgs.error);
			return;
		}
		if (parsedArgs.configureTools) {
			await this.configureReviewTools();
			return;
		}

		let target = parsedArgs.target;
		if (!target) {
			target = await this.promptForReviewTarget();
			if (!target) {
				this.showStatus("Review cancelled");
				return;
			}
		}
		if (target.kind === "commit" && !target.sha) {
			const sha = await this.promptForReviewCommit();
			if (!sha) {
				this.showStatus("Review cancelled");
				return;
			}
			target = { kind: "commit", sha };
		}

		await this.runReview(target, parsedArgs.controls);
	}

	/** Start a review of `target` through the conversation's review intent; resolves its work id. */
	private async startReview(target: ReviewTarget, controls: ReviewRunControls | undefined): Promise<string> {
		const client = this.store.client;
		const tools = await this.getReviewToolsForRun();
		const options = {
			...(controls?.focus === undefined ? {} : { focus: controls.focus }),
			...(controls === undefined || controls.scope.length === 0 ? {} : { scope: controls.scope.join(",") }),
			...(controls === undefined
				? {}
				: { effort: controls.effort, includeOptional: controls.includeOptional, scopeMode: controls.scopeMode }),
			...(tools.length === 0 ? {} : { tools }),
		};
		let accepted: { result?: { workId: string } };
		switch (target.kind) {
			case "uncommitted":
				accepted = await client.intent("review_uncommitted", options);
				break;
			case "branch":
				accepted = await client.intent("review_branch", {
					...options,
					...(target.base === undefined ? {} : { base: target.base }),
				});
				break;
			case "pr":
				accepted = await client.intent("review_pr", {
					...options,
					...(target.number === undefined ? {} : { number: target.number }),
					...(target.expectedUrl === undefined ? {} : { url: target.expectedUrl }),
				});
				break;
			case "commit":
				if (target.sha === undefined) throw new Error("No commit to review");
				accepted = await client.intent("review_commit", { ...options, ref: target.sha });
				break;
		}
		const workId = accepted.result?.workId;
		if (workId === undefined) throw new Error("The review did not start");
		return workId;
	}

	/**
	 * Run a review as the conversation's detached `review` work (D2) and show
	 * it until it ends: a loader shows the work's progress and accounting,
	 * its passes draw inline in the chat, and the footer shows its usage.
	 * Escape cancels it (`cancel_work`). A completed review opens its findings
	 * in a new conversation (`review_open_session`) while the loader shows.
	 */
	private async runReview(target: ReviewTarget, controls: ReviewRunControls | undefined): Promise<void> {
		if (this.activeReview) {
			this.showWarning("A review is already running. Cancel it before starting another.");
			return;
		}
		this.activeReview = true;
		this.quitConfirmation = undefined;
		this.lastSigintTime = 0;
		const client = this.store.client;
		const loader = new BorderedLoader(this.ui, theme, "Preparing review…");
		const detail = createUiNodeView();
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.editorContainer.addChild(detail);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		let workId: string | undefined;
		let view: ReviewView | undefined;
		const cancel = (): void => {
			loader.setMessage("Cancelling review…");
			if (workId !== undefined) void client.intent("cancel_work", { workId }).catch(() => undefined);
		};
		loader.signal.addEventListener("abort", cancel, { once: true });
		const show = (): void => {
			const progress = view?.progress();
			if (!loader.signal.aborted) loader.setMessage(progress?.text ?? "Preparing review…");
			try {
				detail.update(progress?.detail === undefined ? [] : [progress.detail]);
			} catch {
				detail.update([]);
			}
			this.transientUsage = view?.usage(this.catalogs.models?.models);
			this.ui.requestRender();
		};
		try {
			workId = await this.startReview(target, controls);
			// Escape while the review prepared cancels it as soon as it runs.
			if (loader.signal.aborted) cancel();
			view = new ReviewView({
				store: this.store,
				workId,
				container: this.chatContainer,
				transcript: {
					ui: this.ui,
					markdownTheme: () => this.getMarkdownThemeWithSettings(),
					hideThinkingBlock: () => this.hideThinkingBlock,
					toolsExpanded: () => this.toolOutputExpanded,
					showImages: () => this.settingsManager.getShowImages(),
					imageWidthCells: () => this.settingsManager.getImageWidthCells(),
				},
				onChange: show,
			});
			// How a review that did not complete ended shows as its work's end does (showWorkEnd).
			if ((await view.finished()).outcome === "completed") {
				loader.setMessage("Opening the review's findings…");
				const opened = await client.intent("review_open_session", { runId: workId });
				if (opened.conversation !== undefined) await this.store.showing(opened.conversation);
				else this.showStatus("Opening the review's findings was cancelled; open them from /work.");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.showError(
				message.includes("git") || message.includes("repository") ? `${message} ${REVIEW_USAGE}` : message,
			);
		} finally {
			loader.signal.removeEventListener("abort", cancel);
			view?.dispose();
			this.transientUsage = undefined;
			loader.dispose();
			detail.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.activeReview = false;
			this.quitConfirmation = undefined;
			this.lastSigintTime = 0;
			this.ui.requestRender();
		}
	}

	/**
	 * `/compact [instructions]`: the host compacts the conversation. The
	 * compaction runs beside the TUI's other intents, so input sent meanwhile
	 * queues on the host, and the interrupt key stops it.
	 */
	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		await this.clientConnected.promise;
		const messageCount = this.store.state.entries.filter((entry) => entry.type === "message").length;
		if (messageCount < 2) {
			this.showWarning("Nothing to compact (no messages yet)");
			return;
		}

		// A compaction already running takes this one's place.
		if (this.store.phase?.operation === "compaction") return;
		try {
			await this.sessions.compact(customInstructions);
		} catch {
			// The compaction's end reports how it failed.
		}
	}

	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		this.dismissWorkInspector?.();
		this.stopWorkTicker();
		this.workRowsCoalescer.dispose();
		this.unsubscribeWorkSource?.();
		this.unsubscribeWorkSource = undefined;
		this.work.dispose();
		this.catalogs.dispose();
		this.clearTurnDoneAlertTimer();
		this.clearPromptCacheAlertTimer();
		this.clearWorkSummaryTimer();
		this.stopWorkingElapsedTicker();
		this.transcript.dispose();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.globalInputUnsubscribe?.();
		this.globalInputUnsubscribe = undefined;
		this.planPaneInputUnsubscribe?.();
		this.planPaneInputUnsubscribe = undefined;
		this.footer.dispose();
		this.retryCountdown?.dispose();
		this.retryCountdown = undefined;
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.cleanupAllScratchDirectories();
		this.unregisterSignalHandlers();
	}
}
