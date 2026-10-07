/**
 * The session's extension binding: the extension runner over the loaded
 * extensions, the clients attached to them, the core actions and resources
 * extensions reach the session through, and the in-place runtime reload that
 * rebuilds the runner and the tools.
 *
 * The extensions are bound once: the first client to attach fixes the mode,
 * and `activate` and `session_start` fire. Later clients only add their
 * surface. The extension registry (core/extensions/registry.ts) keeps which
 * extensions run in line with settings: an extension enabled or disabled
 * while the session runs starts or stops alone, and what it declared here
 * (UI, dialogs, providers, services tasks, work) goes with it.
 * The UI calls (dialogs, forms, notifications, status, panels, title,
 * editor text, and theme) write the conversation's live state, which every
 * attached client that accepts them sees; the first answer to a dialog wins.
 * Each extension's `ctx.ui` is its own: its status items and panels are keyed
 * by its manifest id (core/ui/extension-ui.ts). Reading the editor text asks
 * only the client the call runs for, or the anchor outside any client's call.
 * The themes listed are the host's; setting one asks the attached clients to
 * show it. Errors go to every client. Command context actions, abort, and
 * shutdown go to the client the call runs for (its client scope); calls
 * outside any client scope go to the anchor, the oldest attached client, and
 * calls for a client that has left go nowhere. A command's `ctx.invokedBy`
 * says whether the client it runs for is a paired remote device. A stopped
 * instance's `ctx.ui` stays stopped when its id runs again: the new instance
 * gets a `ctx.ui` of its own.
 */

import { join } from "node:path";
import type { AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import { type HostRequest, type HostResponse, WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../agent-session.ts";
import {
	type CommandInvoker,
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
import { ExtensionPermissionStore, permissionSubject } from "../extensions/permissions.ts";
import { ExtensionRegistry, type ExtensionRegistryHost } from "../extensions/registry.ts";
import {
	type DiscoveredResourcePath,
	emitSessionShutdownEvent,
	registerReplacedSessionContext,
} from "../extensions/runner.ts";
import type { Extension } from "../extensions/types.ts";
import { ClientScope } from "../host/client-scope.ts";
import { type HostRequestOptions, hostRequestTimeout, type LiveState } from "../host/live-state.ts";
import type { CustomMessageInput } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "../resource-loader.ts";
import type { SessionManager } from "../session-manager.ts";
import {
	assertExtensionEntryType,
	type ExtensionSessionWriter,
	extensionSessionWriter,
	type SessionWriter,
} from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import { getAvailableThemesWithPaths } from "../theme/discovery.ts";
import type { Theme } from "../theme/theme.ts";
import type { ThemeInfo } from "../theme/types.ts";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";
import {
	dialogRequest,
	EDITOR_TEXT_TIMEOUT_MS,
	type ExtensionUiHost,
	formRequest,
	notificationText,
	setExtensionPanel,
	setExtensionStatus,
	setExtensionTitle,
} from "../ui/extension-ui.ts";
import { HOST_CUSTOM_MESSAGE_TYPES } from "../ui/message-presenters.ts";
import type { ExtensionKinds, WorkKindRefusal } from "../work/extension-kinds.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import type { SessionJobs } from "./jobs.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

/** The custom types the host's own contexts may not send either: a work notice is the work registry's. */
const WORK_NOTICE_TYPES: ReadonlySet<string> = new Set([WORK_NOTICE_CUSTOM_TYPE]);

/**
 * The error of a message of a type `reserved` keeps for the host; none for
 * others. Extensions may not send any of the host's message types, which the
 * host presents as its own.
 */
function reservedCustomType(
	message: { readonly customType?: unknown },
	reserved: ReadonlySet<string> = HOST_CUSTOM_MESSAGE_TYPES,
): Error | undefined {
	return typeof message.customType === "string" && reserved.has(message.customType)
		? new Error(`Custom messages of type ${message.customType} are the host's`)
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
	/** The user's agent directory, where permission acknowledgments are stored. */
	readonly agentDir: string;
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
	/** Resolves at the next turn boundary: at once when no turn runs, else when the running turn ends. */
	turnBoundary(): Promise<void>;
	/** The extensions that run changed, or their states: their commands, intents, and list may differ. */
	extensionsChanged(): void;
}

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
	/** A paired remote device: the commands it invokes see `ctx.invokedBy` as `"remote"`. */
	readonly remote?: boolean;
	/** Session control for the commands the client invoked. */
	readonly commandContextActions?: ExtensionCommandContextActions;
	/** Replaces the session abort for the `ctx.abort()` calls the client invoked. */
	readonly abortHandler?: () => void;
	/** Handles the `ctx.shutdown()` calls the client invoked. */
	readonly shutdownHandler?: ShutdownHandler;
	/** Receives every extension error. */
	readonly onError?: ExtensionErrorListener;
}

/**
 * What a stopped extension's `ctx.ui` answers while its instance retires: no
 * dialog, no UI. Members not listed read through.
 */
const STOPPED_UI: Partial<Record<keyof ExtensionUIContext, unknown>> = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	editor: async () => undefined,
	form: async () => undefined,
	dialog: async () => undefined,
	notify: () => {},
	setPanel: () => {},
	setStatus: () => {},
	setTitle: () => {},
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: async () => undefined,
	setTheme: () => ({ success: false, error: "The extension is stopping" }),
};

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
	/** Dialogs the extensions asked, by the extension that asked: ended when the extensions reload, or it stops. */
	private readonly extensionRequests = new Map<AbortController, string | undefined>();
	/** Whether `activate` and `session_start` reached the extensions: one enabled now hears them itself. */
	private started = false;
	/** The extensions of the session, which run as settings enable them. */
	readonly registry: ExtensionRegistry;
	/** The UI each extension's `ctx.ui` routes to, by manifest id; `undefined` for contexts no extension owns. */
	private readonly uiRouters = new Map<string | undefined, ExtensionUIContext>();
	/** Each extension instance's `ctx.ui`: it stops when its instance stops, whatever runs under its id later. */
	private readonly instanceUIs = new WeakMap<Extension, ExtensionUIContext>();
	private readonly uiHost: ExtensionUiHost = {
		// Read when a call runs: the routers are built before the binding's host is set.
		live: () => this.host.liveState,
		ownsWork: (extensionId, workId) => this.host.extensionKinds().owns(extensionId, workId),
		droppedIntent: (extensionId, intent) =>
			this.extensionRunner.emitError({
				extensionId,
				event: "ui",
				error: `Left out an action that sends ${intent.type}: an extension's UI sends only its own intents and commands, and opens or cancels only its own work`,
			}),
	};
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
		this.registry = new ExtensionRegistry(this.createRegistryHost());
	}

	/** What the registry starts and stops extensions through. */
	private createRegistryHost(): ExtensionRegistryHost {
		const resourceLoader = this.host.resourceLoader;
		return {
			runner: () => this.extensionRunner,
			enabled: (id) => this.host.settingsManager.getExtensionEnabled(id),
			acknowledged: (extension) => {
				try {
					return new ExtensionPermissionStore(this.host.agentDir).isAcknowledged(permissionSubject(extension));
				} catch {
					// An unreadable acknowledgment file acknowledges nothing.
					return (extension.manifest.permissions ?? []).length === 0;
				}
			},
			bound: () => this.started,
			changed: () => {
				const runner = this.extensionRunner;
				this.refuseKinds(runner, this.host.extensionKinds().sync(runner.getWorkKinds()));
				// The next request offers the active extensions' tools, and no others.
				this.host.tools().refreshRegistry();
				this.host.extensionsChanged();
			},
			statesChanged: () => this.host.extensionsChanged(),
			retireDeclarations: (extension) => this.retireDeclarations(extension),
			retireWork: (id) => this.host.extensionKinds().retire(id),
			turnBoundary: () => this.host.turnBoundary(),
			reportError: (error) => this.extensionRunner.emitError(error),
			...(resourceLoader.rescanExtensions === undefined
				? {}
				: {
						rescan: (known) =>
							resourceLoader.rescanExtensions?.(known) ?? Promise.reject(new Error("unavailable")),
					}),
		};
	}

	/**
	 * Remove what the stopped `extension` declared outside its record: its
	 * status items, panels, and title; its pending dialogs; its `ctx.ui`; its
	 * managed-services tasks; and the providers it registered.
	 */
	private retireDeclarations(extension: Extension): void {
		const id = extension.id;
		const live = this.host.liveState;
		live.clearMatching([`ext_status/${id}/`, `ext_panel/${id}/`]);
		const title = live.get("ext_title");
		if (title?.kind === "ext_title" && title.extension === id) live.clear("ext_title");
		for (const [request, owner] of this.extensionRequests) if (owner === id) request.abort();
		// An instance that runs again gets a new `ctx.ui`.
		this.uiRouters.delete(id);
		this.host.extensionServices().servicesManager.retire(id);
		this.retireProviders(extension);
	}

	/**
	 * Unregister the providers the stopped `extension` registered (one another
	 * running extension registered too stays), and undo what it registered on
	 * the AI client directly.
	 */
	private retireProviders(extension: Extension): void {
		const names = [...extension.providers];
		const client = [...extension.clientRegistrations];
		extension.providers.clear();
		extension.clientRegistrations.clear();
		if (names.length === 0 && client.length === 0) return;
		const registry = this.host.modelRegistry;
		const others = this.extensionRunner.getExtensions().filter((other) => other !== extension);
		const report = (error: unknown): void =>
			this.extensionRunner.emitError({
				extensionId: extension.id,
				event: "unregister_provider",
				error: error instanceof Error ? error.message : String(error),
			});
		for (const name of names) {
			if (others.some((other) => other.providers.has(name))) continue;
			try {
				registry.unregisterProvider(name);
			} catch (error) {
				report(error);
			}
		}
		if (client.length > 0) {
			for (const registration of client) {
				const separator = registration.indexOf(":");
				const kind = separator === -1 ? registration : registration.slice(0, separator);
				const key = registration.slice(separator + 1);
				try {
					if (kind === "api") registry.client.unregisterProvider(key);
					else if (kind === "images") registry.client.unregisterImagesProvider(key);
					else if (kind === "oauth") registry.client.unregisterOAuthProvider(key);
				} catch (error) {
					report(error);
				}
			}
			// The built-in providers and models, and the running extensions' providers, come back.
			try {
				registry.refresh();
			} catch (error) {
				report(error);
			}
		}
		this.refreshModelAfterProviderChange();
	}

	/** The runner over the loaded extensions. */
	get runner(): ExtensionRunner {
		return this.extensionRunner;
	}

	/** Where a host bound to the session reads its current extension runner. */
	get runnerRef(): { current?: ExtensionRunner } | undefined {
		return this.extensionRunnerRef;
	}

	/** The UI contexts no extension owns see, while an attached client answers dialogs. */
	get uiContext(): ExtensionUIContext | undefined {
		return this.acceptsDialogs() ? this.uiFor(undefined, undefined) : undefined;
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
		const index = this.clients.findIndex((attached) => attached.id === client.id);
		if (index === -1) this.clients.push(client);
		else this.clients[index] = client;
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
		this.clients.splice(index, 1);
	}

	private bind(mode: ExtensionMode): Promise<void> {
		// Runtime toggles wait: each extension hears `activate` and `session_start` once.
		return this.registry.exclusive(async () => {
			this.extensionMode = mode;
			this.applyExtensionBindings(this.extensionRunner);
			// Interactive-only native tools follow the bound mode and UI.
			this.host.tools().syncPlanningRuntime();
			this.started = true;
			const reloaded = this.sessionStartEvent.reason === "reload";
			await this.extensionRunner.emit({ type: "activate", reason: reloaded ? "reload" : "startup" });
			this.host.assertActive();
			await this.extensionRunner.emit(this.sessionStartEvent);
			this.host.assertActive();
			await this.extendResourcesFromExtensions(reloaded ? "reload" : "startup");
			this.host.assertActive();
		});
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

	/** Forget what the extensions declared: their live status, panels, and title. */
	private clearDeclaredUI(): void {
		this.host.liveState.clearMatching(["ext_status/", "ext_panel/", "ext_title"]);
	}

	/** Whether an attached client answers dialogs. */
	private acceptsDialogs(): boolean {
		const live = this.host.liveState;
		return (["select", "confirm", "input", "editor", "form", "dialog", "user_input"] as const).some((kind) =>
			live.accepts(kind),
		);
	}

	/** The host's themes: the built-in ones, the user's, and the ones the conversation's resources loaded. */
	private themes(): ThemeInfo[] {
		const loaded = new Map<string, Theme>();
		for (const theme of this.host.resourceLoader.getThemes().themes) {
			if (theme.name) loaded.set(theme.name, theme);
		}
		return getAvailableThemesWithPaths(loaded, { customThemesDir: join(this.host.agentDir, "themes") });
	}

	/**
	 * Ask the attached clients through the live state for the extension
	 * `owner` (only the views of `options.client`, when given). Resolves with
	 * the first answer, or undefined when the request ended without one:
	 * `signal` aborted, it timed out, no client takes it, the extensions
	 * reloaded, or `owner` stopped.
	 */
	private async ask(
		owner: string | undefined,
		request: HostRequest,
		signal?: AbortSignal,
		options: Pick<HostRequestOptions, "client"> = {},
	): Promise<HostResponse | undefined> {
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		this.extensionRequests.set(controller, owner);
		try {
			const outcome = await this.host.liveState.request(request, { ...options, signal: controller.signal });
			return outcome.status === "answered" ? outcome.response : undefined;
		} finally {
			this.extensionRequests.delete(controller);
			signal?.removeEventListener("abort", abort);
		}
	}

	/**
	 * The editor text of the client the call runs for, or of the anchor outside
	 * any client's call: undefined when that client has left, shows no editor,
	 * or does not answer within {@link EDITOR_TEXT_TIMEOUT_MS}.
	 */
	private async editorText(owner: string | undefined): Promise<string | undefined> {
		const client = this.actionClient();
		if (!client) return undefined;
		const response = await this.ask(owner, { kind: "editor_text", timeoutMs: EDITOR_TEXT_TIMEOUT_MS }, undefined, {
			client: client.id,
		});
		return response !== undefined && "value" in response ? response.value : undefined;
	}

	/**
	 * The `ctx.ui` of `instance`, an instance of the extension with manifest id
	 * `owner`, or of contexts no extension owns. Once the instance is no
	 * longer the one that runs under its id (it stops, or another runs in its
	 * place), it shows no UI and asks nothing ({@link STOPPED_UI}).
	 */
	private uiFor(owner: string | undefined, instance: Extension | undefined): ExtensionUIContext {
		let router = this.uiRouters.get(owner);
		if (!router) {
			router = this.createUIRouter(owner);
			this.uiRouters.set(owner, router);
		}
		if (owner === undefined) return router;
		if (instance === undefined) return this.stoppableUI(router, () => this.registry.stopped(owner));
		let ui = this.instanceUIs.get(instance);
		if (!ui) {
			ui = this.stoppableUI(router, () => this.registry.instance(owner) !== instance);
			this.instanceUIs.set(instance, ui);
		}
		return ui;
	}

	/** `ui` as an extension holds it: once `stopped`, each member answers as {@link STOPPED_UI} does when called. */
	private stoppableUI(ui: ExtensionUIContext, stopped: () => boolean): ExtensionUIContext {
		const wrapped = new Map<string, (...args: unknown[]) => unknown>();
		return new Proxy(ui, {
			get: (target, key) => {
				const value: unknown = Reflect.get(target, key);
				if (typeof key !== "string" || typeof value !== "function" || !Object.hasOwn(STOPPED_UI, key)) return value;
				let member = wrapped.get(key);
				if (!member) {
					const answer = STOPPED_UI[key as keyof ExtensionUIContext] as (...args: unknown[]) => unknown;
					// Checked at each call: a member taken before the extension stopped stops with it.
					member = (...args) =>
						stopped() ? answer(...args) : (Reflect.get(target, key) as (...args: unknown[]) => unknown)(...args);
					wrapped.set(key, member);
				}
				return member;
			},
		});
	}

	/**
	 * Who the call now running invokes a command for: a client the host
	 * attached as a paired remote device, or one it does not know (it left),
	 * is `"remote"`; an attached local client, or no client, is `"local"`.
	 */
	private invoker(): CommandInvoker {
		if (ClientScope.current() === undefined) return "local";
		const client = this.scopedClient();
		return client !== undefined && client.remote !== true ? "local" : "remote";
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
				// An extension seeds the new session without the host's review records, which only the host writes.
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
	 * The UI one extension sees (`owner`, its manifest id), or contexts no
	 * extension owns (`undefined`). UI calls write the live state; status
	 * items, panels, and the title need an owner. Setting a theme the host
	 * knows asks the attached clients to show it.
	 */
	private createUIRouter(owner: string | undefined): ExtensionUIContext {
		// The router is built before the binding's host is set.
		const live = () => this.host.liveState;
		const owned = (member: string): string => {
			if (owner === undefined) throw new Error(`ctx.ui.${member} is available only in an extension's own context`);
			return owner;
		};
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
				return this.ask(owner, request, opts?.signal).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				);
			},
			confirm: (title, message, opts) =>
				this.ask(
					owner,
					{ kind: "confirm", title, message, ...hostRequestTimeout(opts?.timeout) },
					opts?.signal,
				).then((response) => response !== undefined && "confirmed" in response && response.confirmed),
			input: (title, placeholder, opts) => {
				const request: HostRequest = {
					kind: "input",
					title,
					...(placeholder === undefined ? {} : { placeholder }),
					...hostRequestTimeout(opts?.timeout),
				};
				return this.ask(owner, request, opts?.signal).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				);
			},
			editor: (title, prefill) =>
				this.ask(owner, { kind: "editor", title, ...(prefill === undefined ? {} : { prefill }) }).then(
					(response) => (response !== undefined && "value" in response ? response.value : undefined),
				),
			form: (form, opts) => {
				let request: HostRequest;
				try {
					request = formRequest(form, opts?.timeout);
				} catch (error) {
					return Promise.reject(error);
				}
				return this.ask(owner, request, opts?.signal).then((response) =>
					response !== undefined && "values" in response ? response.values : undefined,
				);
			},
			dialog: (dialog, opts) => {
				let request: HostRequest;
				try {
					request = dialogRequest(this.uiHost, owner, dialog, opts?.timeout);
				} catch (error) {
					return Promise.reject(error);
				}
				return this.ask(owner, request, opts?.signal).then((response) =>
					response !== undefined && "value" in response ? response.value : undefined,
				);
			},
			notify: (message, type) =>
				live().notice(type === "warning" || type === "error" ? type : "info", notificationText(message), owner),
			setStatus: (key, text) => setExtensionStatus(this.uiHost, owned("setStatus"), key, text),
			setPanel: (name, panel) => setExtensionPanel(this.uiHost, owned("setPanel"), name, panel),
			setTitle: (title) => setExtensionTitle(this.uiHost, owned("setTitle"), title),
			pasteToEditor: (text) => live().insertEditorText(stripTerminalControls(text)),
			setEditorText: (text) => live().setEditorText(stripTerminalControls(text)),
			getEditorText: () => this.editorText(owner),
			getAllThemes: () => this.themes(),
			setTheme: (name) => {
				if (!this.themes().some((theme) => theme.name === name)) {
					return { success: false, error: `Theme not found: ${name}` };
				}
				live().setTheme(name);
				return { success: true };
			},
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
		// Sessions clients drive keep UI while no client shows it: dialogs then resolve to their defaults.
		// Print and JSON runs have none.
		runner.setUIContext(
			(owner, instance) => this.uiFor(owner, instance),
			this.extensionMode,
			() => this.acceptsDialogs() || (this.extensionMode !== "print" && this.extensionMode !== "json"),
		);
		runner.bindCommandContext(this.commandActions);
		runner.bindInvoker(() => this.invoker());

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
		this.registry.close();
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
		// The previous generation's instances the new one does not keep retire: their event-bus listeners leave.
		for (const extension of previousRunner?.getExtensions() ?? []) {
			if (!extensionsResult.extensions.includes(extension)) {
				extension.lifetime.retire(`Extension ${extension.id} was reloaded`);
			}
		}
		this.registry.reset(extensionsResult);
		// The extensions read and write the session's settings; their changes reach them as `settings_changed`.
		extensionsResult.runtime.settings.bind(this.host.settingsManager);
		this.extensionRunner.trackSettings();
		// Settings saved here or in another conversation: the extensions hear what changed, and the ones
		// settings enable or disable start or stop.
		this.settingsUnsubscriber ??= this.host.settingsManager.subscribeExtensionSettings(() => {
			this.extensionRunner.emitSettingsChanged().catch(() => {});
			this.registry.reconcile().catch((error: unknown) => {
				this.extensionRunner.emitError({
					extensionId: "<runtime>",
					event: "reconcile",
					error: error instanceof Error ? error.message : String(error),
				});
			});
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
					assertExtensionEntryType(customType);
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
					// The catalog's model, not the caller's copy: its baseUrl and headers decide where credentials go.
					const catalog = this.host.modelRegistry.find(model.provider, model.id);
					if (!catalog || !this.host.modelRegistry.hasConfiguredAuth(catalog)) return false;
					await session.setModel(catalog);
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
		// Reload holds the conversation as a host operation: nothing else runs until it settles. Runtime
		// toggles queued before it take effect first; the ones after it see the reloaded extensions.
		await this.registry.exclusive(() =>
			this.host.conversation().runHostOperation(async () => {
				this.reloadInProgress = true;
				try {
					await this.reloadRuntime();
				} finally {
					this.reloadInProgress = false;
				}
			}),
		);
	}

	private async reloadRuntime(): Promise<void> {
		// The dialogs the extensions asked end with them; the reloaded extensions ask again.
		for (const request of this.extensionRequests.keys()) request.abort();
		this.host.extensionServices().invalidate();
		await this.host.extensionServices().reopen();
		const previousFlagValues = this.extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this.extensionRunner, { type: "session_shutdown", reason: "reload" });
		this.host.assertActive();
		if (this.started) {
			await this.extensionRunner.emit({ type: "deactivate", reason: "reload" });
			this.host.assertActive();
		}
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
			await this.extensionRunner.emit({ type: "activate", reason: "reload" });
			this.host.assertActive();
			await this.extensionRunner.emit({ type: "session_start", reason: "reload" });
			this.host.assertActive();
			await this.extendResourcesFromExtensions("reload");
			this.host.assertActive();
		}
	}

	/**
	 * A command context of the session for `withSession` callbacks, belonging
	 * to the extension `owner` (its UI, work, and services), or to none. One
	 * that belongs to none is had as an extension's own by the runner of the
	 * session the extension changed from, while that extension runs here.
	 */
	createReplacedSessionContext(owner?: string): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(
				this.extensionRunner.createCommandContext(undefined, this.host.lifetimeSignal, owner),
			),
		) as ReplacedSessionContext;
		if (owner === undefined) {
			registerReplacedSessionContext(context, ({ id, fingerprint }) =>
				fingerprint !== undefined && this.extensionRunner.getExtension(id)?.fingerprint === fingerprint
					? this.createReplacedSessionContext(id)
					: undefined,
			);
		}
		context.sendMessage = (message, options) => {
			// The host's own context sends its message types (a plan execution prompt); an extension's sends none.
			const reserved = reservedCustomType(
				message,
				owner === undefined ? WORK_NOTICE_TYPES : HOST_CUSTOM_MESSAGE_TYPES,
			);
			return reserved ? Promise.reject(reserved) : this.host.sendCustomMessage(message, options, true);
		};
		context.sendUserMessage = (content, options) => this.host.session.sendUserMessage(content, options);
		return context;
	}
}
