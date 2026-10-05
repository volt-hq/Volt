/**
 * The session's extension binding: the extension runner over the loaded
 * extensions, the clients attached to them, the core actions and resources
 * extensions reach the session through, and the in-place runtime reload that
 * rebuilds the runner and the tools.
 *
 * The extensions are bound once: the first client to attach fixes the mode and
 * `session_start` fires. Later clients only add their surface. The data-only
 * UI calls (dialogs, notifications, status, string widgets, title, and editor
 * text) write the conversation's live state, which every attached client that
 * accepts them sees; the first answer to a dialog wins. The terminal-only UI
 * calls go to the last attached client with a terminal, which receives the
 * latest component widgets when it starts showing UI. Errors go to every
 * client. Command context actions, abort, and shutdown go to the client the
 * call runs for (its client scope); calls outside any client scope go to the
 * anchor, the oldest attached client, and calls for a client that has left go
 * nowhere.
 */

import type { AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import { type HostRequest, type HostResponse, WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../agent-session.ts";
import {
	type ExtensionCommandContextActions,
	type ExtensionError,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type ReplacedSessionContext,
	type SessionStartEvent,
	type ShutdownHandler,
} from "../extensions/index.ts";
import { type DiscoveredResourcePath, emitSessionShutdownEvent } from "../extensions/runner.ts";
import { ClientScope } from "../host/client-scope.ts";
import { hostRequestTimeout, type LiveState, liveKey } from "../host/live-state.ts";
import type { CustomMessageInput } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "../resource-loader.ts";
import type { SessionManager } from "../session-manager.ts";
import { type ExtensionSessionWriter, extensionSessionWriter, type SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import { theme } from "../theme/runtime.ts";
import type { ExtensionKinds, WorkKindRefusal } from "../work/extension-kinds.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import type { SessionJobs } from "./jobs.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

/** The error of an extension message of a type only the host sends (work notices); none for others. */
function reservedCustomType(message: { readonly customType?: unknown }): Error | undefined {
	return message.customType === WORK_NOTICE_CUSTOM_TYPE
		? new Error(`Custom messages of type ${WORK_NOTICE_CUSTOM_TYPE} are the host's`)
		: undefined;
}

/** The session's public API, as extension actions drive it. */
export type ExtensionBindingSession = Pick<
	AgentSession,
	| "sendUserMessage"
	| "setSessionName"
	| "getActiveToolNames"
	| "getAllTools"
	| "setActiveToolsByName"
	| "setModel"
	| "thinkingLevel"
	| "setThinkingLevel"
	| "model"
	| "isBusy"
	| "abort"
	| "pendingMessageCount"
	| "getContextUsage"
	| "compact"
	| "systemPrompt"
	| "promptTemplates"
>;

/** Resources an extension discovered, attributed to it as `extension:<manifest id>`. */
function buildExtensionResourcePaths(entries: readonly DiscoveredResourcePath[]): Array<{
	path: string;
	metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
}> {
	return entries.map((entry) => ({
		path: entry.path,
		metadata: {
			source: `extension:${entry.extensionId}`,
			scope: "temporary",
			origin: "top-level",
			baseDir: entry.baseDir,
		},
	}));
}

/** A work kind the session refused to register, as an extension error. */
function refusedKind(refusal: WorkKindRefusal): ExtensionError {
	return { extensionId: refusal.extensionId, event: "register_work_kind", error: refusal.error };
}

export interface SessionExtensionBindingHost {
	readonly session: ExtensionBindingSession;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	readonly modelSettings: ModelSettings;
	readonly resourceLoader: ResourceLoader;
	/** The session's working directory. */
	readonly cwd: string;
	/** Aborted when the session loses its log or is disposed; command handlers see it as `ctx.signal`. */
	readonly lifetimeSignal: AbortSignal;
	/** The conversation's live state, where the data-only UI calls go. */
	readonly liveState: LiveState;
	conversation(): Conversation<AgentTool>;
	tools(): SessionToolRuntime;
	extensionServices(): SessionExtensionServices;
	/** The work kinds the extensions declared, registered in the conversation's work registry. */
	extensionKinds(): ExtensionKinds;
	jobs(): SessionJobs;
	sessionWriter(): SessionWriter;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Whether active session work owns the runtime: a turn, a bash run, a session mutation, or running work. */
	hasActiveWork(): boolean;
	/** Whether an extension command handler is running. */
	extensionCommandRunning(): boolean;
	/** Send a custom message; `allowDuringPromptTransaction` lets it start a turn while a prompt is being prepared. */
	sendCustomMessage<T>(
		message: CustomMessageInput<T>,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		allowDuringPromptTransaction: boolean,
	): Promise<void>;
	/** Track work that must settle before the session's resources close. */
	trackAncillaryWork<T>(work: Promise<T>): Promise<T>;
}

/** The `ctx.ui` members the conversation's live state carries. */
type LiveUIMember = "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setTitle" | "setEditorText";

/**
 * A client's terminal: the `ctx.ui` members that need one (custom components,
 * header, footer, editor components, terminal input, working indicators,
 * themes, editor paste, and component widgets) until extensions declare their
 * UI as data. Dialogs, notifications, status, string widgets, title, and
 * editor text reach every client through the conversation's live state.
 */
export type ExtensionTerminalUI = Omit<ExtensionUIContext, LiveUIMember>;

/**
 * A client's surface on the session's extensions. A client keeps its id across
 * the sessions it attaches to.
 */
export interface ExtensionClient {
	/** Matches the client scope the client's requests run in. */
	readonly id: string;
	/**
	 * The client's run mode. The first client to attach fixes the session's
	 * `ctx.mode`; a `ConversationHost` attaches every client in its own mode.
	 */
	readonly mode: ExtensionMode;
	/**
	 * The client's terminal. Terminal-only calls go to the last attached client
	 * with one; a client without one receives none. Component widgets are
	 * passed to `setWidget`, string widgets go to the live state.
	 */
	readonly ui?: ExtensionTerminalUI;
	/** Session control for the commands the client invoked. */
	readonly commandContextActions?: ExtensionCommandContextActions;
	/** Replaces the session abort for the `ctx.abort()` calls the client invoked. */
	readonly abortHandler?: () => void;
	/** Handles the `ctx.shutdown()` calls the client invoked. */
	readonly shutdownHandler?: ShutdownHandler;
	/** Receives every extension error. */
	readonly onError?: ExtensionErrorListener;
}

/** A client's attachment to a session's extensions. */
export interface ExtensionClientAttachment {
	/** Settles once the extensions are bound; rejects, with the client detached, when binding fails. */
	readonly ready: Promise<void>;
	/** Detach the client; later calls do nothing. */
	detach(): void;
}

export interface SessionExtensionBindingOptions {
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent: SessionStartEvent;
}

export class SessionExtensionBinding {
	private readonly host: SessionExtensionBindingHost;
	private extensionRunner!: ExtensionRunner;
	private readonly extensionRunnerRef?: { current?: ExtensionRunner };
	private readonly sessionStartEvent: SessionStartEvent;
	private extensionMode: ExtensionMode = "print";
	/** The attached clients, oldest first. */
	private readonly clients: ExtensionClient[] = [];
	/** Set by the first attachment; settles once `session_start` and resource discovery ran. */
	private bound: Promise<void> | undefined;
	/** The latest component widget per key, replayed to a client that starts showing UI. */
	private readonly widgets = new Map<string, (ui: ExtensionTerminalUI) => void>();
	/** Dialogs the extensions asked, ended when the extensions reload. */
	private readonly extensionRequests = new Set<AbortController>();
	private readonly uiRouter: ExtensionUIContext = this.createUIRouter();
	private readonly commandActions: ExtensionCommandContextActions = this.createCommandActions();
	private extensionErrorUnsubscriber?: () => void;
	/** Stops sending the extensions `settings_changed`. */
	private settingsUnsubscriber?: () => void;
	/** Work kinds refused before any client listened for extension errors. */
	private refusedKinds: ExtensionError[] = [];
	/** Fences session replacement and fresh mutations across asynchronous runtime reload. */
	private reloadInProgress = false;

	constructor(host: SessionExtensionBindingHost, options: SessionExtensionBindingOptions) {
		this.host = host;
		this.extensionRunnerRef = options.extensionRunnerRef;
		this.sessionStartEvent = options.sessionStartEvent;
	}

	/** The runner over the loaded extensions. */
	get runner(): ExtensionRunner {
		return this.extensionRunner;
	}

	/** Where a host bound to the session reads its current extension runner. */
	get runnerRef(): { current?: ExtensionRunner } | undefined {
		return this.extensionRunnerRef;
	}

	/** The UI extensions see, while an attached client shows a terminal. */
	get uiContext(): ExtensionUIContext | undefined {
		return this.uiClient() ? this.uiRouter : undefined;
	}

	/** The mode the first attached client fixed. */
	get mode(): ExtensionMode {
		return this.extensionMode;
	}

	/** The mode of the client the current call runs for, else the session's mode. */
	get invokingMode(): ExtensionMode {
		return this.scopedClient()?.mode ?? this.extensionMode;
	}

	/** Whether a runtime reload is in progress. */
	get reloading(): boolean {
		return this.reloadInProgress;
	}

	/**
	 * Attach a client. The first attachment binds the extensions with the
	 * client's mode and emits `session_start`; a client attaching again under the
	 * same id replaces its surface. The client can detach before binding settles.
	 */
	attach(client: ExtensionClient): ExtensionClientAttachment {
		this.host.assertActive();
		const previousUIClient = this.uiClient();
		const index = this.clients.findIndex((attached) => attached.id === client.id);
		if (index === -1) this.clients.push(client);
		else this.clients[index] = client;
		this.uiClientChanged(previousUIClient);
		const detach = (): void => this.detach(client);
		const bound = this.bound ?? this.bind(client.mode);
		this.bound = bound;
		const ready = bound.catch((error: unknown) => {
			detach();
			// A later attachment binds again.
			if (this.bound === bound) this.bound = undefined;
			throw error;
		});
		return { ready, detach };
	}

	private detach(client: ExtensionClient): void {
		// A later attachment under the same id replaced this one and owns the slot.
		const index = this.clients.indexOf(client);
		if (index === -1) return;
		const previousUIClient = this.uiClient();
		this.clients.splice(index, 1);
		this.uiClientChanged(previousUIClient);
	}

	private async bind(mode: ExtensionMode): Promise<void> {
		this.extensionMode = mode;
		this.applyExtensionBindings(this.extensionRunner);
		// Interactive-only native tools follow the bound mode and UI.
		this.host.tools().syncPlanningRuntime();
		await this.extensionRunner.emit(this.sessionStartEvent);
		this.host.assertActive();
		await this.extendResourcesFromExtensions(this.sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this.host.assertActive();
	}

	/** The client terminal-only calls go to: the last attached client with a terminal. */
	private uiClient(): ExtensionClient | undefined {
		for (let index = this.clients.length - 1; index >= 0; index--) {
			const client = this.clients[index];
			if (client?.ui) return client;
		}
		return undefined;
	}

	/** The attached client the current call runs for, if any. */
	private scopedClient(): ExtensionClient | undefined {
		const clientId = ClientScope.current();
		return clientId === undefined ? undefined : this.clients.find((client) => client.id === clientId);
	}

	/**
	 * The client session actions go to: the invoking client, or the anchor (the
	 * oldest attached client) for calls outside any client scope. An invoking
	 * client that has detached gets none, and nothing falls through to the anchor.
	 */
	private actionClient(): ExtensionClient | undefined {
		return ClientScope.current() === undefined ? this.clients[0] : this.scopedClient();
	}

	private uiClientChanged(previous: ExtensionClient | undefined): void {
		const current = this.uiClient();
		if (current && current.id !== previous?.id) this.replayUI(current);
		// request_user_input is offered only while an interactive client shows UI.
		if (this.bound && this.extensionMode === "tui" && (current === undefined) !== (previous === undefined)) {
			this.host.tools().syncPlanningRuntime();
		}
	}

	/** Show the latest component widgets on a client that starts showing UI. */
	private replayUI(client: ExtensionClient): void {
		const ui = client.ui;
		if (!ui) return;
		for (const replay of this.widgets.values()) {
			try {
				replay(ui);
			} catch (error) {
				this.extensionRunner.emitError({
					extensionId: "<runtime>",
					event: "ui_replay",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/** Forget what the extensions declared: their component widgets and their live status, widgets, and title. */
	private clearDeclaredUI(): void {
		this.widgets.clear();
		this.host.liveState.clearMatching(["ext_status/", "ext_widget/", "ext_title"]);
	}

	/** Whether an attached client answers dialogs. */
	private acceptsDialogs(): boolean {
		const live = this.host.liveState;
		return live.accepts("select") || live.accepts("confirm") || live.accepts("input") || live.accepts("editor");
	}

	/**
	 * Ask the attached clients through the live state. Resolves with the first
	 * answer, or undefined when the request ended without one: `signal`
	 * aborted, it timed out, no client takes dialogs, or the extensions reloaded.
	 */
	private async ask(request: HostRequest, signal?: AbortSignal): Promise<HostResponse | undefined> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		this.extensionRequests.add(controller);
		try {
			const outcome = await this.host.liveState.request(request, { signal: controller.signal });
			return outcome.status === "answered" ? outcome.response : undefined;
		} finally {
			this.extensionRequests.delete(controller);
			signal?.removeEventListener("abort", abort);
		}
	}

	/** Every attached client hears every extension error; one failing listener cannot silence the others. */
	private reportError(error: ExtensionError): void {
		for (const client of [...this.clients]) {
			const listener = client.onError;
			if (!listener) continue;
			try {
				void Promise.resolve((listener as (reported: ExtensionError) => unknown)(error)).catch(() => {});
			} catch {
				// Error reporting is observational.
			}
		}
	}

	/**
	 * Session control for extension commands. Without a client that handles it
	 * a session intent reports cancelled: the session did not change. A tree
	 * navigation does nothing, and reports cancelled for an invoking client that
	 * has left, so the extension does not act as if it ran.
	 */
	private createCommandActions(): ExtensionCommandContextActions {
		const actions = () => this.actionClient()?.commandContextActions;
		const unchanged = { cancelled: true } as const;
		return {
			waitForIdle: () => actions()?.waitForIdle() ?? Promise.resolve(),
			newSession: (options) => {
				// An extension seeds the new session without review records, which only the host writes.
				const setup = options?.setup;
				const seeded =
					setup === undefined
						? options
						: { ...options, setup: (writer: ExtensionSessionWriter) => setup(extensionSessionWriter(writer)) };
				return actions()?.newSession(seeded) ?? Promise.resolve(unchanged);
			},
			fork: (entryId, options) => actions()?.fork(entryId, options) ?? Promise.resolve(unchanged),
			navigateTree: (targetId, options) =>
				actions()?.navigateTree(targetId, options) ?? Promise.resolve({ cancelled: this.invokerLeft() }),
			switchSession: (sessionRef, options) =>
				actions()?.switchSession(sessionRef, options) ?? Promise.resolve(unchanged),
			reload: () => actions()?.reload() ?? Promise.resolve(),
		};
	}

	/** Whether the current call runs for a client that has detached. */
	private invokerLeft(): boolean {
		return ClientScope.current() !== undefined && this.scopedClient() === undefined;
	}

	/**
	 * The UI extensions see. Data-only calls write the live state; terminal-only
	 * calls go to the terminal client with their arguments as given, and no-op
	 * without one.
	 */
	private createUIRouter(): ExtensionUIContext {
		const ui = () => this.uiClient()?.ui;
		// The router is built before the binding's host is set.
		const live = () => this.host.liveState;
		type UI = ExtensionUIContext;
		return {
			select: (title, options, opts) => {
				// Nothing to choose from: the dialog would only be dismissed.
				if (options.length === 0) return Promise.resolve(undefined);
				const request: HostRequest = {
					kind: "select",
					title,
					options: [...options],
					...hostRequestTimeout(opts?.timeout),
				};
				return this.ask(request, opts?.signal).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				);
			},
			confirm: (title, message, opts) =>
				this.ask({ kind: "confirm", title, message, ...hostRequestTimeout(opts?.timeout) }, opts?.signal).then(
					(response) => response !== undefined && "confirmed" in response && response.confirmed,
				),
			input: (title, placeholder, opts) => {
				const request: HostRequest = {
					kind: "input",
					title,
					...(placeholder === undefined ? {} : { placeholder }),
					...hostRequestTimeout(opts?.timeout),
				};
				return this.ask(request, opts?.signal).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				);
			},
			editor: (title, prefill) =>
				this.ask({ kind: "editor", title, ...(prefill === undefined ? {} : { prefill }) }).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				),
			notify: (message, type) => live().notice(type === "warning" || type === "error" ? type : "info", message),
			onTerminalInput: (...args: Parameters<UI["onTerminalInput"]>) => ui()?.onTerminalInput(...args) ?? (() => {}),
			setStatus: (key, text) => {
				const statusKey = liveKey("ext_status", key);
				if (text === undefined) live().clear(statusKey);
				else live().set(statusKey, { kind: "ext_status", text });
			},
			setWorkingMessage: (...args: Parameters<UI["setWorkingMessage"]>) => ui()?.setWorkingMessage(...args),
			setWorkingVisible: (...args: Parameters<UI["setWorkingVisible"]>) => ui()?.setWorkingVisible(...args),
			setWorkingIndicator: (...args: Parameters<UI["setWorkingIndicator"]>) => ui()?.setWorkingIndicator(...args),
			setHiddenThinkingLabel: (...args: Parameters<UI["setHiddenThinkingLabel"]>) =>
				ui()?.setHiddenThinkingLabel(...args),
			setWidget: (key, content, options) => {
				const widgetKey = liveKey("ext_widget", key);
				if (content === undefined) {
					this.widgets.delete(key);
					live().clear(widgetKey);
					ui()?.setWidget(key, undefined, options);
				} else if (Array.isArray(content)) {
					live().set(widgetKey, {
						kind: "ext_widget",
						lines: [...content],
						placement: options?.placement ?? "aboveEditor",
					});
					// The lines replace a component widget under the key, which no terminal shows again.
					this.widgets.delete(key);
				} else {
					live().clear(widgetKey);
					const show = (target: ExtensionTerminalUI): void => target.setWidget(key, content, options);
					this.widgets.set(key, show);
					const target = ui();
					if (target) show(target);
				}
			},
			setFooter: (...args: Parameters<UI["setFooter"]>) => ui()?.setFooter(...args),
			setHeader: (...args: Parameters<UI["setHeader"]>) => ui()?.setHeader(...args),
			setTitle: (title) => live().set("ext_title", { kind: "ext_title", title }),
			custom: (factory, options) => ui()?.custom(factory, options) ?? Promise.resolve(undefined as never),
			pasteToEditor: (...args: Parameters<UI["pasteToEditor"]>) => ui()?.pasteToEditor(...args),
			setEditorText: (text) => live().setEditorText(text),
			getEditorText: () => ui()?.getEditorText() ?? "",
			addAutocompleteProvider: (...args: Parameters<UI["addAutocompleteProvider"]>) =>
				ui()?.addAutocompleteProvider(...args),
			setEditorComponent: (...args: Parameters<UI["setEditorComponent"]>) => ui()?.setEditorComponent(...args),
			getEditorComponent: () => ui()?.getEditorComponent(),
			get theme() {
				return ui()?.theme ?? theme;
			},
			getAllThemes: () => ui()?.getAllThemes() ?? [],
			getTheme: (...args: Parameters<UI["getTheme"]>) => ui()?.getTheme(...args),
			setTheme: (...args: Parameters<UI["setTheme"]>) =>
				ui()?.setTheme(...args) ?? { success: false, error: "UI not available" },
			getToolsExpanded: () => ui()?.getToolsExpanded() ?? false,
			setToolsExpanded: (...args: Parameters<UI["setToolsExpanded"]>) => ui()?.setToolsExpanded(...args),
		};
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this.extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this.extensionRunner.emitResourcesDiscover(
			this.host.cwd,
			reason,
		);
		this.host.assertActive();

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: buildExtensionResourcePaths(skillPaths),
			promptPaths: buildExtensionResourcePaths(promptPaths),
			themePaths: buildExtensionResourcePaths(themePaths),
		};

		this.host.resourceLoader.extendResources(extensionPaths);
		this.host.tools().refreshSystemPrompt();
	}

	/** Route the runner's UI, command context actions, and errors through the attached clients. */
	private applyExtensionBindings(runner: ExtensionRunner): void {
		// TUI and RPC sessions keep UI while no client shows it: dialogs then resolve to their defaults.
		runner.setUIContext(
			this.uiRouter,
			this.extensionMode,
			() =>
				this.uiClient() !== undefined ||
				this.acceptsDialogs() ||
				this.extensionMode === "tui" ||
				this.extensionMode === "rpc",
		);
		runner.bindCommandContext(this.commandActions);

		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = runner.onError((error) => this.reportError(error));
		for (const error of this.refusedKinds.splice(0)) runner.emitError(error);
		runner.reportDroppedSettings();
	}

	/** Report the work kinds the session refused to register: at once, or once clients listen. */
	private refuseKinds(runner: ExtensionRunner, refusals: readonly WorkKindRefusal[]): void {
		const errors = refusals.map(refusedKind);
		if (this.bound) for (const error of errors) runner.emitError(error);
		else this.refusedKinds.push(...errors);
	}

	/** Detach every client of a disposed session: nothing reaches them or is replayed to them afterwards. */
	releaseClients(): void {
		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = undefined;
		this.settingsUnsubscriber?.();
		this.settingsUnsubscriber = undefined;
		this.clients.length = 0;
	}

	/**
	 * Release the runner of a session whose open failed: invalidate it, stop
	 * forwarding its errors, and withdraw it from the runner ref. Each step runs
	 * through `cleanup`, which collects failures.
	 */
	releaseFailedOpen(cleanup: (finalize: () => void) => void): void {
		const extensionRunner = this.extensionRunner as ExtensionRunner | undefined;
		if (extensionRunner) {
			cleanup(() => extensionRunner.invalidate("AgentSession construction failed before ownership transfer"));
		}
		const extensionErrorUnsubscriber = this.extensionErrorUnsubscriber;
		this.extensionErrorUnsubscriber = undefined;
		if (extensionErrorUnsubscriber) cleanup(extensionErrorUnsubscriber);
		if (extensionRunner && this.extensionRunnerRef) {
			cleanup(() => {
				if (this.extensionRunnerRef?.current === extensionRunner) {
					this.extensionRunnerRef.current = undefined;
				}
			});
		}
	}

	/** Provider registration is synchronous; a fallback selection it causes commits in the background. */
	private refreshModelAfterProviderChange(): void {
		void this.host.trackAncillaryWork(this.host.modelSettings.refreshFromRegistry()).catch((error: unknown) => {
			this.extensionRunner.emitError({
				extensionId: "<runtime>",
				event: "register_provider",
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	/** Create the runner for the loaded extensions, carrying `flagValues` over, and bind it to the session. */
	rebuildRunner(flagValues: Map<string, boolean | string> | undefined): void {
		const extensionsResult = this.host.resourceLoader.getExtensions();
		if (flagValues) {
			for (const [name, value] of flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		// May be undefined during construction (first runtime build).
		const previousRunner: ExtensionRunner | undefined = this.extensionRunner;
		this.extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this.host.cwd,
			this.host.sessionManager,
			this.host.modelRegistry,
		);
		if (this.extensionRunnerRef) {
			this.extensionRunnerRef.current = this.extensionRunner;
		}
		// Honor the documented contract: a ctx/volt captured before reload must
		// not be used after reload. No-ops when the new runner shares the old
		// runtime (project-trust rebuild), so live generations are unaffected.
		previousRunner?.invalidateStaleGeneration(extensionsResult.runtime);
		// The extensions read and write the session's settings; their changes reach them as `settings_changed`.
		extensionsResult.runtime.settings.bind(this.host.settingsManager);
		this.extensionRunner.trackSettings();
		this.settingsUnsubscriber ??= this.host.settingsManager.subscribeExtensionSettings(() => {
			this.extensionRunner.emitSettingsChanged().catch(() => {});
		});
		this.bindExtensionCore(this.extensionRunner);
		// The previous generation's work kinds go with it, interrupting their work; this generation's replace them.
		// Its refusals reach the clients once they listen to it.
		const kinds = this.host.extensionKinds();
		void this.host.trackAncillaryWork(kinds.clear());
		this.refusedKinds = kinds.bind(this.extensionRunner.getWorkKinds()).map(refusedKind);
		if (this.bound) this.applyExtensionBindings(this.extensionRunner);
	}

	private bindExtensionCore(runner: ExtensionRunner): void {
		const session = this.host.session;
		runner.bindServices(this.host.extensionServices().servicesManager);
		const kinds = this.host.extensionKinds();
		runner.bindWork(kinds.start, () => this.refuseKinds(runner, kinds.sync(runner.getWorkKinds())));
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = session.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this.host.resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					const reserved = reservedCustomType(message);
					const sending = reserved
						? Promise.reject(reserved)
						: this.host.sendCustomMessage(message, options, this.host.extensionCommandRunning());
					sending.catch((err) => {
						runner.emitError({
							extensionId: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionId: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: async (customType, data) => {
					await this.host.sessionWriter().appendCustomEntry(customType, data);
				},
				setSessionName: (name) => session.setSessionName(name),
				getSessionName: () => {
					return this.host.sessionManager.getSessionName();
				},
				setLabel: async (entryId, label) => {
					await this.host.sessionWriter().appendLabelChange(entryId, label);
				},
				getActiveTools: () => session.getActiveToolNames(),
				getAllTools: () => session.getAllTools(),
				setActiveTools: (toolNames) => session.setActiveToolsByName(toolNames),
				refreshTools: () => this.host.tools().refreshRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.host.modelRegistry.hasConfiguredAuth(model)) return false;
					await session.setModel(model);
					return true;
				},
				getThinkingLevel: () => session.thinkingLevel,
				setThinkingLevel: (level) => session.setThinkingLevel(level),
			},
			{
				getModel: () => session.model,
				isIdle: () => !session.isBusy,
				isProjectTrusted: () => this.host.settingsManager.isProjectTrusted(),
				getSignal: () => this.host.jobs().hookSignal(),
				abort: () => {
					const abortHandler = this.actionClient()?.abortHandler;
					if (abortHandler) {
						abortHandler();
						return;
					}
					void session.abort();
				},
				hasPendingMessages: () => session.pendingMessageCount > 0,
				shutdown: () => {
					this.actionClient()?.shutdownHandler?.();
				},
				getContextUsage: () => session.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await session.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => session.systemPrompt,
				getSystemPromptOptions: () => this.host.tools().baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this.host.modelRegistry.registerProvider(name, config);
					this.refreshModelAfterProviderChange();
				},
				unregisterProvider: (name) => {
					this.host.modelRegistry.unregisterProvider(name);
					this.refreshModelAfterProviderChange();
				},
			},
		);
	}

	/** Reload resources, extensions, MCP, and tools in place; the log is untouched. */
	async reload(): Promise<void> {
		this.host.assertActive();
		if (this.host.hasActiveWork()) {
			throw new Error(
				"Cannot reload while active session work still owns this runtime; abort or wait for it to finish",
			);
		}
		// Reload holds the conversation as a host operation: nothing else runs until it settles.
		await this.host.conversation().runHostOperation(async () => {
			this.reloadInProgress = true;
			try {
				await this.reloadRuntime();
			} finally {
				this.reloadInProgress = false;
			}
		});
	}

	private async reloadRuntime(): Promise<void> {
		// The dialogs the extensions asked end with them; the reloaded extensions ask again.
		for (const request of this.extensionRequests) request.abort();
		this.host.extensionServices().invalidate();
		await this.host.extensionServices().reopen();
		const previousFlagValues = this.extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this.extensionRunner, { type: "session_shutdown", reason: "reload" });
		this.host.assertActive();
		// The shut-down extensions' work kinds go with them, interrupting the work they still run.
		await this.host.extensionKinds().clear();
		this.host.assertActive();
		await this.host.settingsManager.reload();
		this.host.assertActive();
		this.host.modelSettings.syncFromSettings();
		this.host.modelRegistry.clearRegisteredProviders();
		await this.host.resourceLoader.reload();
		this.host.assertActive();
		await this.host.tools().reloadMcpManager();
		this.host.assertActive();
		this.host.tools().rebuild(previousFlagValues);
		await this.host.modelSettings.refreshFromRegistry();

		if (this.bound) {
			// The reloaded extensions declare their UI again from session_start.
			this.clearDeclaredUI();
			await this.extensionRunner.emit({ type: "session_start", reason: "reload" });
			this.host.assertActive();
			await this.extendResourcesFromExtensions("reload");
			this.host.assertActive();
		}
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(
				this.extensionRunner.createCommandContext(undefined, this.host.lifetimeSignal),
			),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => {
			const reserved = reservedCustomType(message);
			return reserved ? Promise.reject(reserved) : this.host.sendCustomMessage(message, options, true);
		};
		context.sendUserMessage = (content, options) => this.host.session.sendUserMessage(content, options);
		return context;
	}
}
