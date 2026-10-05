/**
 * Extension runner - executes extensions and manages their lifecycle.
 *
 * The runner runs the active extensions of one runtime generation, in order.
 * Every contribution an extension makes lives on its record (handlers, tools,
 * commands, intents, shortcuts, completion providers, flags, renderers, work
 * kinds), and the runner reads contributions only from the active records:
 * replacing the active set (`setExtensions`) removes a record's
 * contributions at once. A context an extension's handler, command, or tool
 * sees belongs to that instance and throws once it is retired.
 */

import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonValue, Model } from "@hansjm10/volt-ai";
import { EXTENSION_ID_PATTERN } from "@hansjm10/volt-protocol";
import type { KeyId } from "@hansjm10/volt-tui";
import { CanonicalDataError, cloneCanonicalData } from "../canonical-data.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager, SessionReference } from "../session-manager.ts";
import type { ExtensionSessionWriter } from "../session-writer.ts";
import type { BuildSystemPromptOptions } from "../system-prompt.ts";
import { type Theme, theme } from "../theme/runtime.ts";
import type { MessagePresenter } from "../ui/presentation.ts";
import type { DeclaredWorkKind, StartWorkHandler } from "../work/extension-kinds.ts";
import { type PermissionHolder, permissionCheckedModelRegistry } from "./permissions.ts";
import {
	type ExtensionServicesManager,
	extensionServicesForbidden,
	withoutExtensionServices,
} from "./services-runtime.ts";
import type { ExtensionOperationEvent, ExtensionOperationOrigin, RequestBoundaryEvent } from "./services-types.ts";
import type {
	ActivateEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeProviderRequestEvent,
	CompactOptions,
	ContextEvent,
	ContextEventResult,
	ContextUsage,
	DeactivateEvent,
	Extension,
	ExtensionActions,
	ExtensionCommandContext,
	ExtensionCommandContextActions,
	ExtensionContext,
	ExtensionContextActions,
	ExtensionError,
	ExtensionEvent,
	ExtensionFlag,
	ExtensionLifetime,
	ExtensionMode,
	ExtensionRuntime,
	ExtensionShortcut,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadExtensionsResult,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCompletionProvider,
	RegisteredIntent,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	ResourcesDiscoverEvent,
	ResourcesDiscoverResult,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeSwitchResult,
	SessionBeforeTreeResult,
	SessionIntentResult,
	SessionShutdownEvent,
	SessionStartEvent,
	SettingsChangedEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
	UserBashEvent,
	UserBashEventResult,
} from "./types.ts";

interface ServicesPolicyOptions {
	signal?: AbortSignal;
	origin?: ExtensionOperationOrigin;
	strict?: boolean;
}

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only main-view global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.plan.togglePane",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
	messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ExtensionEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| UserBashEvent
	| ContextEvent
	| BeforeProviderRequestEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| ResourcesDiscoverEvent
	| InputEvent
	| RequestBoundaryEvent
	| ExtensionOperationEvent
	| SettingsChangedEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_switch" | "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult =
	| SessionBeforeSwitchResult
	| SessionBeforeForkResult
	| SessionBeforeCompactResult
	| SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_switch" }
	? SessionBeforeSwitchResult | undefined
	: TEvent extends { type: "session_before_fork" }
		? SessionBeforeForkResult | undefined
		: TEvent extends { type: "session_before_compact" }
			? SessionBeforeCompactResult | undefined
			: TEvent extends { type: "session_before_tree" }
				? SessionBeforeTreeResult | undefined
				: undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

/** Options of a session change that may continue in the new session. */
interface SessionChangeOptions {
	readonly withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}

/** `options` with a `withSession` that sees its context as `holder` holds it (see {@link ownedSessionContext}). */
function withOwnedSession<O extends SessionChangeOptions>(
	options: O | undefined,
	holder: PermissionHolder,
): O | undefined {
	const withSession = options?.withSession;
	if (options === undefined || withSession === undefined) return options;
	return { ...options, withSession: (ctx: ReplacedSessionContext) => withSession(ownedSessionContext(ctx, holder)) };
}

/** An extension a replaced session's context may be had as: its manifest id and where its code came from. */
export interface ReplacedSessionOwner {
	readonly id: string;
	readonly fingerprint: string | undefined;
}

/** How a replaced session's context is had as one extension's own, while the same extension runs there. */
const replacedSessionOwners = new WeakMap<
	object,
	(owner: ReplacedSessionOwner) => ReplacedSessionContext | undefined
>();

/**
 * Register how `ctx`, a replaced session's context that belongs to no
 * extension, is had as one extension's own: `forOwner` returns the context of
 * that extension in the new session, or undefined when it does not run there
 * (an extension with the same id from other code does not count).
 */
export function registerReplacedSessionContext(
	ctx: ReplacedSessionContext,
	forOwner: (owner: ReplacedSessionOwner) => ReplacedSessionContext | undefined,
): void {
	replacedSessionOwners.set(ctx, forOwner);
}

/**
 * A replaced session's context as the extension that changed sessions holds
 * it: its own context in the new session when it runs there (its UI, work
 * kinds, and services), else one that belongs to no extension; its model
 * registry is checked against that extension's permissions, and so are the
 * session changes it starts.
 */
function ownedSessionContext(given: ReplacedSessionContext, holder: PermissionHolder): ReplacedSessionContext {
	const fingerprint =
		"fingerprint" in holder && typeof holder.fingerprint === "string" ? holder.fingerprint : undefined;
	const ctx = replacedSessionOwners.get(given)?.({ id: holder.id, fingerprint }) ?? given;
	const owned = Object.defineProperties({}, Object.getOwnPropertyDescriptors(ctx)) as ReplacedSessionContext;
	let checked: { readonly source: ModelRegistry; readonly registry: ModelRegistry } | undefined;
	Object.defineProperty(owned, "modelRegistry", {
		get: () => {
			const source = ctx.modelRegistry;
			if (checked?.source !== source) checked = { source, registry: permissionCheckedModelRegistry(source, holder) };
			return checked.registry;
		},
		enumerable: true,
		configurable: true,
	});
	owned.newSession = (options) => ctx.newSession(withOwnedSession(options, holder));
	owned.fork = (entryId, options) => ctx.fork(entryId, withOwnedSession(options, holder));
	owned.switchSession = (sessionRef, options) => ctx.switchSession(sessionRef, withOwnedSession(options, holder));
	return owned;
}

/** A resource path an extension's `resources_discover` handler returned. */
export interface DiscoveredResourcePath {
	readonly path: string;
	/** The manifest id of the extension that returned it. */
	readonly extensionId: string;
	/** The extension's directory, when it has one. */
	readonly baseDir?: string;
}

/**
 * An extension attempted to replace a finalized message with a different role.
 * Role changes would let extension output cross a trust and persistence boundary,
 * so callers must treat this as a terminal event failure rather than a patch to
 * ignore.
 */
export class ExtensionMessageRoleMismatchError extends Error {
	readonly code = "extension_message_role_mismatch";
	readonly extensionId: string;
	readonly expectedRole: AgentMessage["role"];
	readonly receivedRole: AgentMessage["role"];

	constructor(extensionId: string, expectedRole: AgentMessage["role"], receivedRole: AgentMessage["role"]) {
		super(
			`Extension ${JSON.stringify(extensionId)} message_end handler cannot change the role from ${JSON.stringify(expectedRole)} to ${JSON.stringify(receivedRole)}`,
		);
		this.name = "ExtensionMessageRoleMismatchError";
		this.extensionId = extensionId;
		this.expectedRole = expectedRole;
		this.receivedRole = receivedRole;
	}
}

export type NewSessionHandler = (options?: {
	parentSessionRef?: SessionReference;
	setup?: (writer: ExtensionSessionWriter) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<SessionIntentResult>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<SessionIntentResult>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionRef: SessionReference,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<SessionIntentResult>;

export type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	extensionRunner: ExtensionRunner,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (extensionRunner.hasHandlers("session_shutdown")) {
		await extensionRunner.emit(event);
		return true;
	}
	return false;
}

export async function emitProjectTrustEvent(
	extensionsResult: LoadExtensionsResult,
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ExtensionError[] }> {
	const errors: ExtensionError[] = [];
	for (const ext of extensionsResult.extensions) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		const handlers = ext.handlers.get("project_trust");
		if (!handlers || handlers.length === 0) continue;

		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					extensionId: ext.id,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ExtensionUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	form: async () => undefined,
	dialog: async () => undefined,
	notify: () => {},
	setPanel: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: async () => undefined,
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getAllThemes: () => [],
	getTheme: () => undefined,
	setTheme: (_theme: string | Theme) => ({ success: false, error: "UI not available" }),
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/** The UI of the extension with manifest id `owner`; `undefined` for a context no extension owns. */
export type ExtensionUIFactory = (owner: string | undefined) => ExtensionUIContext;

const noOpUIFactory: ExtensionUIFactory = () => noOpUIContext;

/** Calls on an AI client that register something, and the key each records: undone when the extension stops. */
const CLIENT_REGISTRATIONS: Readonly<Record<string, (args: readonly unknown[]) => string | undefined>> = {
	registerProvider: (args) => keyed("api", (args[0] as { api?: unknown } | undefined)?.api),
	registerImagesProvider: (args) => keyed("images", (args[0] as { api?: unknown } | undefined)?.api),
	registerOAuthProvider: (args) => keyed("oauth", (args[0] as { id?: unknown } | undefined)?.id),
	setModels: () => "models",
};

function keyed(kind: string, key: unknown): string | undefined {
	return typeof key === "string" ? `${kind}:${key}` : undefined;
}

/**
 * `target` with each member `wrap` replaces, read through `get` and through
 * property descriptors alike.
 */
function wrapMembers<T extends object>(target: T, wrap: (key: string, value: unknown) => unknown): T {
	return new Proxy(target, {
		get: (object, key) => {
			const value: unknown = Reflect.get(object, key);
			return typeof key === "string" ? wrap(key, value) : value;
		},
		getOwnPropertyDescriptor: (object, key) => {
			const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(object, key);
			if (descriptor !== undefined && "value" in descriptor && typeof key === "string") {
				descriptor.value = wrap(key, descriptor.value);
			}
			return descriptor;
		},
	});
}

/**
 * `registry` as `extension` holds it, recording the providers it registers by
 * name and what it registers on the AI client directly, so they are undone
 * when it stops. A stopped instance registers nothing more.
 */
function recordingProviders(registry: ModelRegistry, extension: Extension): ModelRegistry {
	let client: { readonly source: object; readonly recording: object } | undefined;
	const recordingClient = (source: object): object => {
		if (client?.source !== source) {
			client = {
				source,
				recording: wrapMembers(source, (member, method) => {
					const record = CLIENT_REGISTRATIONS[member];
					if (record === undefined || typeof method !== "function") return method;
					return (...args: unknown[]) => {
						extension.lifetime.assertRunning();
						const result: unknown = Reflect.apply(method, source, args);
						const registration = record(args);
						if (registration !== undefined) extension.clientRegistrations.add(registration);
						return result;
					};
				}),
			};
		}
		return client.recording;
	};
	return wrapMembers(registry, (key, value) => {
		if (key === "registerProvider" && typeof value === "function") {
			return (name: string, ...rest: unknown[]) => {
				extension.lifetime.assertRunning();
				const result: unknown = Reflect.apply(value, registry, [name, ...rest]);
				extension.providers.add(name);
				return result;
			};
		}
		if (key === "unregisterProvider" && typeof value === "function") {
			return (name: string) => {
				const result: unknown = Reflect.apply(value, registry, [name]);
				extension.providers.delete(name);
				return result;
			};
		}
		return key === "client" && typeof value === "object" && value !== null ? recordingClient(value) : value;
	});
}

/** An event one extension hears alone: its activation and deactivation, and its own start or stop at runtime. */
export type ExtensionLifecycleEvent = ActivateEvent | DeactivateEvent | SessionStartEvent | SessionShutdownEvent;

/** Check that `extensions` have manifest ids and no two share one: ownership is by id. */
function checkIds(extensions: readonly Extension[]): void {
	const idPattern = new RegExp(EXTENSION_ID_PATTERN);
	const ids = new Set<string>();
	for (const extension of extensions) {
		if (!idPattern.test(extension.id)) throw new Error(`Invalid extension id ${JSON.stringify(extension.id)}`);
		if (ids.has(extension.id)) throw new Error(`Two extensions have the id ${JSON.stringify(extension.id)}`);
		ids.add(extension.id);
	}
}

export class ExtensionRunner {
	/** The active extensions, in load order: the only records contributions are read from. */
	private extensions: Extension[];
	/** The instance last active under each id, active or stopping: contexts belong to it. */
	private readonly instances = new Map<string, Extension>();
	/** Tool executions running per extension id: stopping an extension waits for them. */
	private readonly toolCalls = new Map<string, Set<Promise<unknown>>>();
	private runtime: ExtensionRuntime;
	private uiFactory: ExtensionUIFactory;
	private guardedContextObjects = new WeakMap<object, object>();
	/** Context objects as each extension instance's contexts show them: they throw once it retires. */
	private ownedContextObjects = new WeakMap<ExtensionLifetime, WeakMap<object, object>>();
	/** `ctx.modelRegistry` as each extension instance sees it: what its permissions allow. */
	private ownerModelRegistries = new WeakMap<ExtensionLifetime, ModelRegistry>();
	private mode: ExtensionMode = "print";
	private hasUIFn: () => boolean = () => this.uiFactory !== noOpUIFactory;
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ExtensionErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () => ({ cwd: this.cwd });
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: true });
	private forkHandler: ForkHandler = async () => ({ cancelled: true });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: true });
	private reloadHandler: ReloadHandler = async () => {};
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];
	private staleMessage: string | undefined;
	private servicesManager: ExtensionServicesManager | undefined;
	private startWorkFn: StartWorkHandler = () => Promise.reject(new Error("Work is not available in this runtime"));

	/** @throws when an extension's id is not a manifest id or two extensions share one: ownership is by id. */
	constructor(
		extensions: Extension[],
		runtime: ExtensionRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		checkIds(extensions);
		this.extensions = [...extensions];
		for (const extension of extensions) this.instances.set(extension.id, extension);
		this.runtime = runtime;
		this.uiFactory = noOpUIFactory;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
	}

	bindServices(manager: ExtensionServicesManager): void {
		this.servicesManager = manager;
		this.runtime.getServicesStatus = (owner) => {
			this.assertActive();
			return manager.getStatus(owner);
		};
	}

	/** Start the extensions' work through `start`; `refresh` registers the work kinds they declare after binding. */
	bindWork(start: StartWorkHandler, refresh: () => void): void {
		this.startWorkFn = start;
		this.runtime.refreshWorkKinds = () => {
			this.assertActive();
			refresh();
		};
	}

	emitRequestBoundary(event: RequestBoundaryEvent): void {
		this.emitServicesObservation(event);
	}

	emitExtensionOperation(event: ExtensionOperationEvent): void {
		withoutExtensionServices(() => this.emitServicesObservation(event));
	}

	private emitServicesObservation(event: RequestBoundaryEvent | ExtensionOperationEvent): void {
		if (this.isInert) return;
		for (const ext of this.extensions) {
			if (event.type === "extension_operation" && this.servicesManager?.isOwner(ext.id, event.extensionId)) continue;
			for (const handler of ext.handlers.get(event.type) ?? []) {
				const report = () =>
					this.emitErrorContained({
						extensionId: "<extension-services>",
						event: event.type,
						error: "Extension services observer failed",
					});
				try {
					const ctx = this.createContext(ext.id, event.type === "request_boundary");
					void Promise.resolve(handler(cloneCanonicalData(event, "Extension services observation"), ctx)).catch(
						report,
					);
				} catch {
					report();
				}
			}
		}
	}

	bindCore(
		actions: ExtensionActions,
		contextActions: ExtensionContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			unregisterProvider?: (name: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn = contextActions.getSystemPromptOptions ?? (() => ({ cwd: this.cwd }));

		// Flush provider registrations queued during extension loading
		for (const { name, config, extensionId } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					extensionId,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
	}

	bindCommandContext(actions?: ExtensionCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			this.reloadHandler = actions.reload;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: true });
		this.forkHandler = async () => ({ cancelled: true });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: true });
		this.reloadHandler = async () => {};
	}

	/**
	 * Set the UI extensions see: one context for every extension, or a factory
	 * of each extension's own (status items, panels, and title are keyed by the
	 * extension that set them).
	 *
	 * @param hasUI Whether the UI can reach a user right now; defaults to whether a UI context is set.
	 */
	setUIContext(
		uiContext?: ExtensionUIContext | ExtensionUIFactory,
		mode: ExtensionMode = "print",
		hasUI?: () => boolean,
	): void {
		this.uiFactory =
			uiContext === undefined ? noOpUIFactory : typeof uiContext === "function" ? uiContext : () => uiContext;
		this.mode = mode;
		this.hasUIFn = hasUI ?? (() => this.uiFactory !== noOpUIFactory);
	}

	/** The UI of the extension with manifest id `owner`, or of a context no extension owns. */
	getUIContext(owner?: string): ExtensionUIContext {
		return this.uiFactory(owner);
	}

	hasUI(): boolean {
		return this.hasUIFn();
	}

	/** The active extension with manifest id `id`, if any. */
	getExtension(id: string): Extension | undefined {
		return this.extensions.find((extension) => extension.id === id);
	}

	/** The active extensions, in load order. */
	getExtensions(): readonly Extension[] {
		return [...this.extensions];
	}

	/**
	 * Replace the active extensions: what a removed extension contributed
	 * (hooks, tools, commands, intents, shortcuts, completion providers, flags,
	 * renderers, work kinds) is gone at once; an added one's settings start
	 * from what they are now. Contexts of a removed instance keep working until
	 * it retires.
	 *
	 * @throws when an extension's id is not a manifest id or two extensions share one.
	 */
	setExtensions(extensions: readonly Extension[]): void {
		checkIds(extensions);
		const added = extensions.filter((extension) => !this.extensions.includes(extension));
		this.extensions = [...extensions];
		for (const extension of added) this.instances.set(extension.id, extension);
		this.runtime.settings.changes(added);
	}

	/** Run `execution`, a tool call of the extension `owner`, counting it until it settles. */
	trackToolCall<T>(owner: string | undefined, execution: () => Promise<T>): Promise<T> {
		if (owner === undefined) return execution();
		const running = execution();
		let calls = this.toolCalls.get(owner);
		if (!calls) {
			calls = new Set();
			this.toolCalls.set(owner, calls);
		}
		const tracked: Promise<unknown> = running.then(
			() => undefined,
			() => undefined,
		);
		calls.add(tracked);
		void tracked.then(() => {
			calls.delete(tracked);
			if (calls.size === 0 && this.toolCalls.get(owner) === calls) this.toolCalls.delete(owner);
		});
		return running;
	}

	/** Resolves once no tool call of the extension `owner` runs. */
	async toolCallsSettled(owner: string): Promise<void> {
		for (let calls = this.toolCalls.get(owner); calls && calls.size > 0; calls = this.toolCalls.get(owner)) {
			await Promise.all([...calls]);
		}
	}

	/**
	 * Send `event` to `extension` alone, which need not be active: its
	 * activation, deactivation, or its own start or stop at runtime. Failures
	 * are reported as its errors.
	 */
	async emitTo(extension: Extension, event: ExtensionLifecycleEvent): Promise<void> {
		if (this.isInert) return;
		for (const handler of extension.handlers.get(event.type) ?? []) {
			try {
				await handler(event, this.createContext(extension.id));
			} catch (err) {
				const stack = err instanceof Error ? err.stack : undefined;
				this.emitErrorContained({
					extensionId: extension.id,
					event: event.type,
					error: err instanceof Error ? err.message : String(err),
					...(stack === undefined ? {} : { stack }),
				});
			}
			if (this.isInert || extension.lifetime.retired) return;
		}
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.extensions) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.extensions) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	/** Every extension's intents, in load order. */
	getRegisteredIntents(): RegisteredIntent[] {
		return this.extensions.flatMap((ext) => [...ext.intents.values()]);
	}

	/** The intent `extension.intent.<id>.<name>` an extension registered. */
	getIntent(intent: string): RegisteredIntent | undefined {
		for (const ext of this.extensions) {
			const prefix = `extension.intent.${ext.id}.`;
			if (intent.startsWith(prefix)) return ext.intents.get(intent.slice(prefix.length));
		}
		return undefined;
	}

	/** Every extension's editor completion providers, in load order. */
	getCompletionProviders(): RegisteredCompletionProvider[] {
		return this.extensions.flatMap((ext) => [...ext.completionProviders.values()]);
	}

	/** The work kinds every extension declared, in load order. */
	getWorkKinds(): DeclaredWorkKind[] {
		return this.extensions.flatMap((ext) =>
			[...ext.workKinds].map(([name, kind]) => ({ extensionId: ext.id, name, kind })),
		);
	}

	getFlags(): Map<string, ExtensionFlag> {
		const allFlags = new Map<string, ExtensionFlag>();
		for (const ext of this.extensions) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

		const addDiagnostic = (message: string, path: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.extensions) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`Extension shortcut '${key}' from extension ${ext.id} conflicts with built-in shortcut. Skipping.`,
						ext.path,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and extension ${ext.id}. Using extension ${ext.id}.`,
						ext.path,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`Extension shortcut conflict: '${key}' registered by both extensions ${existingExtensionShortcut.extensionId} and ${ext.id}. Using extension ${ext.id}.`,
						ext.path,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	invalidate(
		message = "This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
	): void {
		if (!this.staleMessage) {
			this.staleMessage = message;
			this.runtime.invalidate(message);
		}
	}

	/**
	 * Invalidate this runner because a new runner generation replaced it (reload).
	 * No-op when the replacement shares this runner's runtime (e.g. the
	 * project-trust reload path reuses the pre-trust runtime), so a live
	 * generation is never invalidated by mistake.
	 */
	invalidateStaleGeneration(nextRuntime: ExtensionRuntime): void {
		if (this.runtime === nextRuntime) {
			return;
		}
		this.invalidate();
	}

	/**
	 * Whether this runner belongs to a dead generation (disposed session or
	 * pre-reload runner). Inert runners must produce no side effects: emits
	 * pass values through unchanged, handlers never run, and errors never
	 * reach listeners (which may be wired to a live transport).
	 */
	private get isInert(): boolean {
		return this.staleMessage !== undefined;
	}

	private assertActive(): void {
		if (this.staleMessage) {
			throw new Error(this.staleMessage);
		}
	}

	onError(listener: ExtensionErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ExtensionError): void {
		// A stale runner's error listeners may still be wired to a live transport
		// (e.g. the RPC extension_error stream). Dead generations must stay silent.
		if (this.isInert) {
			return;
		}
		for (const listener of [...this.errorListeners]) {
			try {
				Promise.resolve((listener as (reportedError: ExtensionError) => unknown)(error)).catch(() => {});
			} catch {
				// Error reporting is observational. One listener cannot suppress later listeners
				// or alter the operation whose failure is being reported.
			}
		}
	}

	private emitErrorContained(error: ExtensionError): void {
		try {
			this.emitError(error);
		} catch {
			// Error reporting is observational and cannot rewrite the hook outcome.
		}
	}

	hasHandlers(eventType: string): boolean {
		if (this.isInert) {
			return false;
		}
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	/** The presenter of custom messages of `customType`, and the extension that registered it: the first in load order. */
	getMessagePresenter(
		customType: string,
	): { readonly present: MessagePresenter; readonly extensionId: string } | undefined {
		for (const ext of this.extensions) {
			const present = ext.messagePresenters.get(customType);
			if (present) return { present, extensionId: ext.id };
		}
		return undefined;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.extensions) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	/**
	 * Every extension's commands in load order, with their slash names. The
	 * first command with a name takes it; a later one is `/<extension id>:<name>`,
	 * with a diagnostic. Registered names have no `:`, so no command takes an
	 * alias; the check that one is taken only guards against that.
	 */
	private resolveRegisteredCommands(): { commands: ResolvedCommand[]; diagnostics: ResourceDiagnostic[] } {
		const commands: ResolvedCommand[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		const owners = new Map<string, string>();

		for (const ext of this.extensions) {
			for (const command of ext.commands.values()) {
				let invocationName = command.name;
				const owner = owners.get(invocationName);
				if (owner !== undefined) {
					invocationName = `${ext.id}:${command.name}`;
					const aliasOwner = owners.get(invocationName);
					if (aliasOwner !== undefined) {
						diagnostics.push({
							type: "warning",
							message: `Extension command '/${command.name}' from extension ${ext.id} conflicts with extension ${owner}, and '/${invocationName}' with extension ${aliasOwner}. Skipping.`,
							path: ext.path,
						});
						continue;
					}
					diagnostics.push({
						type: "warning",
						message: `Extension command '/${command.name}' from extension ${ext.id} conflicts with extension ${owner}. Available as '/${invocationName}'.`,
						path: ext.path,
					});
				}
				owners.set(invocationName, ext.id);
				commands.push({ ...command, invocationName, extensionId: ext.id });
			}
		}
		return { commands, diagnostics };
	}

	getRegisteredCommands(): ResolvedCommand[] {
		const { commands, diagnostics } = this.resolveRegisteredCommands();
		this.commandDiagnostics = diagnostics;
		return commands;
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().commands.find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the attached client the call runs for.
	 */
	shutdown(): void {
		if (this.isInert) {
			return;
		}
		this.shutdownHandler();
	}

	/**
	 * Fence captured host capabilities without revoking returned
	 * cleanup/unsubscribe functions: they throw once the runner is stale, or
	 * the extension instance whose `lifetime` is given retires.
	 */
	private guardContextObject<T extends object>(target: T, lifetime?: ExtensionLifetime): T {
		let cache = this.guardedContextObjects;
		if (lifetime !== undefined) {
			let owned = this.ownedContextObjects.get(lifetime);
			if (!owned) {
				owned = new WeakMap();
				this.ownedContextObjects.set(lifetime, owned);
			}
			cache = owned;
		}
		const existing = cache.get(target);
		if (existing) return existing as T;
		const assertActive = (): void => {
			this.assertActive();
			lifetime?.assertActive();
		};
		const methods = new Map<PropertyKey, { method: unknown; invoke: (...args: unknown[]) => unknown }>();
		const guarded = new Proxy(target, {
			get: (object, key) => {
				assertActive();
				const value = Reflect.get(object, key, object);
				if (value === this.modelRegistry.authStorage)
					return this.guardContextObject(this.modelRegistry.authStorage, lifetime);
				if (typeof value !== "function") return value;
				let cached = methods.get(key);
				if (!cached || cached.method !== value) {
					cached = {
						method: value,
						invoke: (...args) => {
							assertActive();
							return Reflect.apply(value, object, args);
						},
					};
					methods.set(key, cached);
				}
				return cached.invoke;
			},
		});
		cache.set(target, guarded);
		return guarded;
	}

	/** The model registry an extension's context shows: credentials need `secrets`, provider registration `providers`. */
	private modelRegistryFor(owner: string | undefined, instance: Extension | undefined): ModelRegistry {
		const lifetime = instance?.lifetime;
		const guarded = this.guardContextObject(this.modelRegistry, lifetime);
		if (owner === undefined) return guarded;
		if (instance === undefined || lifetime === undefined) {
			return permissionCheckedModelRegistry(guarded, this.permissionHolder(owner));
		}
		let registry = this.ownerModelRegistries.get(lifetime);
		if (!registry) {
			registry = recordingProviders(permissionCheckedModelRegistry(guarded, instance), instance);
			this.ownerModelRegistries.set(lifetime, registry);
		}
		return registry;
	}

	/** The extension `owner` names, as its permissions are checked; one this runner never ran has none. */
	private permissionHolder(owner: string): PermissionHolder {
		return this.instances.get(owner) ?? { id: owner, manifest: {} };
	}

	/**
	 * Report the stored settings values the extensions' settings dropped, as
	 * errors of the extensions they belong to.
	 */
	reportDroppedSettings(): void {
		if (this.isInert) return;
		for (const { id, message } of this.runtime.settings.drainDropped()) {
			this.emitErrorContained({ extensionId: id, event: "settings", error: `Ignored stored settings: ${message}` });
		}
	}

	/**
	 * Start tracking the extensions' settings: changes from now on reach them
	 * as `settings_changed` through {@link emitSettingsChanged}.
	 */
	trackSettings(): void {
		this.runtime.settings.changes(this.extensions);
	}

	/** Send `settings_changed` to each extension whose effective settings changed since it last saw them. */
	async emitSettingsChanged(): Promise<void> {
		if (this.isInert) return;
		const changes = this.runtime.settings.changes(this.extensions);
		this.reportDroppedSettings();
		for (const change of changes) {
			const extension = this.extensions.find((candidate) => candidate.id === change.id);
			for (const handler of extension?.handlers.get("settings_changed") ?? []) {
				const event: SettingsChangedEvent = {
					type: "settings_changed",
					settings: change.settings,
					previous: change.previous,
					scope: change.scope,
				};
				try {
					await handler(event, this.createContext(change.id));
				} catch (err) {
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitErrorContained({
						extensionId: change.id,
						event: "settings_changed",
						error: err instanceof Error ? err.message : String(err),
						...(stack === undefined ? {} : { stack }),
					});
				}
				if (this.isInert) return;
			}
		}
	}

	/**
	 * Create an ExtensionContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 *
	 * @param owner The manifest id of the extension the context belongs to: `startWork` starts only its
	 *   kinds, and `services` are its own.
	 * @param services Whether the owner's managed services are part of the context.
	 */
	createContext(owner?: string, services = false): ExtensionContext {
		// The instance the context belongs to now: a context of a retired instance throws, even once its id runs again.
		const instance = owner === undefined ? undefined : this.instances.get(owner);
		const lifetime = instance?.lifetime;
		const runner = this;
		const assertActive = (): void => {
			runner.assertActive();
			lifetime?.assertActive();
		};
		// What steers the conversation throws once the instance stopped, while its tool calls finish.
		const assertRunning = (): void => {
			runner.assertActive();
			lifetime?.assertRunning();
		};
		const getModel = this.getModel;
		const servicesContext = owner && services ? this.servicesManager?.getContext(owner) : undefined;
		return {
			get services() {
				assertActive();
				return extensionServicesForbidden() ? undefined : servicesContext;
			},
			get ui() {
				assertActive();
				return runner.guardContextObject(runner.getUIContext(owner), lifetime);
			},
			get mode() {
				assertActive();
				return runner.mode;
			},
			get hasUI() {
				assertActive();
				return runner.hasUI();
			},
			get cwd() {
				assertActive();
				return runner.cwd;
			},
			get sessionManager() {
				assertActive();
				return runner.sessionManager;
			},
			get modelRegistry() {
				assertActive();
				return runner.modelRegistryFor(owner, instance);
			},
			get model() {
				assertActive();
				return getModel();
			},
			isIdle: () => {
				assertActive();
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				assertActive();
				return runner.isProjectTrustedFn();
			},
			get signal() {
				assertActive();
				return runner.getSignalFn();
			},
			abort: () => {
				assertRunning();
				runner.abortFn();
			},
			hasPendingMessages: () => {
				assertActive();
				return runner.hasPendingMessagesFn();
			},
			shutdown: () => {
				assertRunning();
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				assertActive();
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				assertRunning();
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				assertActive();
				return runner.getSystemPromptFn();
			},
			startWork: (kind, options, run) => {
				assertRunning();
				return runner.startWorkFn(owner, kind, options, run);
			},
		};
	}

	/**
	 * @param signal Session-lifetime signal exposed as the command's `ctx.signal`. The owning
	 *   session aborts it when it loses its log or is disposed.
	 * @param owner The manifest id of the extension whose command runs.
	 */
	createCommandContext(
		waitForIdle: () => Promise<void> = this.waitForIdleFn,
		signal: AbortSignal = new AbortController().signal,
		owner?: string,
	): ExtensionCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext(owner)),
		) as ExtensionCommandContext;
		const lifetime = owner === undefined ? undefined : this.instances.get(owner)?.lifetime;
		const assertActive = (): void => {
			this.assertActive();
			lifetime?.assertActive();
		};
		const assertRunning = (): void => {
			this.assertActive();
			lifetime?.assertRunning();
		};
		Object.defineProperty(context, "signal", {
			get: () => {
				assertActive();
				return signal;
			},
			enumerable: true,
			configurable: true,
		});
		context.getSystemPromptOptions = () => {
			assertActive();
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			assertActive();
			return waitForIdle();
		};
		// The new session's context belongs to no extension: the owner's permissions go with it.
		const holder = owner === undefined ? undefined : this.permissionHolder(owner);
		const own = <O extends SessionChangeOptions>(options: O | undefined): O | undefined =>
			holder === undefined ? options : withOwnedSession(options, holder);
		context.newSession = (options) => {
			assertRunning();
			return this.newSessionHandler(own(options));
		};
		context.fork = (entryId, options) => {
			assertRunning();
			return this.forkHandler(entryId, own(options));
		};
		context.navigateTree = (targetId, options) => {
			assertRunning();
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionRef, options) => {
			assertRunning();
			return this.switchSessionHandler(sessionRef, own(options));
		};
		context.reload = () => {
			assertRunning();
			return this.reloadHandler();
		};
		return context;
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_switch" ||
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		if (this.isInert) {
			return undefined as RunnerEmitResult<TEvent>;
		}
		let result: SessionBeforeEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get(event.type);
			if (!handlers || handlers.length === 0) continue;

			for (const handler of handlers) {
				try {
					const ctx = this.createContext(ext.id, event.type === "tool_execution_end");
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = cloneCanonicalData(
							handlerResult,
							`Extension ${event.type} output from ${ext.id}`,
						) as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitErrorContained({
						extensionId: ext.id,
						event: event.type,
						error: message,
						...(stack === undefined ? {} : { stack }),
					});
					if (
						err instanceof CanonicalDataError &&
						(event.type === "session_before_compact" || event.type === "session_before_tree")
					) {
						throw err;
					}
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		if (this.isInert) {
			return undefined;
		}
		let currentMessage = cloneCanonicalData(event.message, "Extension message_end input");
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("message_end");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);

			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = {
						...event,
						message: cloneCanonicalData(currentMessage, `Extension message_end input for ${ext.id}`),
					};
					const rawHandlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (rawHandlerResult === undefined) continue;
					const handlerResult = cloneCanonicalData(
						rawHandlerResult,
						`Extension message_end output from ${ext.id}`,
					);
					if (!handlerResult.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						const error = new ExtensionMessageRoleMismatchError(
							ext.id,
							currentMessage.role,
							handlerResult.message.role,
						);
						try {
							this.emitError({
								extensionId: ext.id,
								event: "message_end",
								error: error.message,
							});
						} catch {
							// Diagnostics are observers. They cannot mask the typed contract
							// violation and downgrade transport handling to an ambiguous error.
						}
						throw error;
					}

					currentMessage = cloneCanonicalData(
						handlerResult.message,
						`Extension message_end replacement from ${ext.id}`,
					);
					modified = true;
				} catch (err) {
					if (err instanceof ExtensionMessageRoleMismatchError) throw err;
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitErrorContained({
						extensionId: ext.id,
						event: "message_end",
						error: message,
						...(stack === undefined ? {} : { stack }),
					});
					if (err instanceof CanonicalDataError) throw err;
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	/** Monotonic policy revisions detect replacement, change-and-restore, and explicit invalidation. */
	captureToolPolicyGuard(): () => boolean {
		const policies = this.extensions.map((extension) => ({
			extension,
			revision: extension.handlers.authorizationRevision,
		}));
		return () =>
			!this.isInert &&
			policies.length === this.extensions.length &&
			policies.every(
				({ extension, revision }, index) =>
					this.extensions[index] === extension && extension.handlers.authorizationRevision === revision,
			);
	}

	async emitToolResult(
		event: ToolResultEvent,
		options?: ServicesPolicyOptions,
	): Promise<ToolResultEventResult | undefined> {
		if (this.isInert) {
			if (options?.strict) throw new Error("Extension runtime is stale");
			return undefined;
		}
		const currentEvent = cloneCanonicalData(
			{ ...event, ...(options?.origin ? { origin: options.origin } : {}) },
			`Tool result input for ${event.toolName}`,
		);
		let modified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_result");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);
			if (options) Object.defineProperty(ctx, "signal", { value: options.signal });

			for (const handler of handlers) {
				try {
					const handlerEvent = cloneCanonicalData(currentEvent, `Extension tool_result input for ${ext.id}`);
					const rawHandlerResult = (await withoutExtensionServices(() => handler(handlerEvent, ctx))) as
						| ToolResultEventResult
						| undefined;
					const description = `Extension tool_result output from ${ext.id}`;
					const ownedEvent = cloneCanonicalData(handlerEvent, description);
					const handlerResult =
						rawHandlerResult === undefined ? undefined : cloneCanonicalData(rawHandlerResult, description);
					const details: JsonValue | undefined =
						handlerResult?.details !== undefined
							? handlerResult.details
							: (ownedEvent.details as JsonValue | undefined);
					const nextEvent = cloneCanonicalData(
						{
							...ownedEvent,
							content: handlerResult?.content ?? ownedEvent.content,
							...(details === undefined ? {} : { details }),
							isError: handlerResult?.isError ?? ownedEvent.isError,
						},
						description,
					);
					currentEvent.content = nextEvent.content;
					if (nextEvent.details === undefined) delete currentEvent.details;
					else currentEvent.details = nextEvent.details;
					currentEvent.isError = nextEvent.isError;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					if (options?.strict) throw err;
					this.emitErrorContained({
						extensionId: ext.id,
						event: "tool_result",
						error: message,
						...(stack === undefined ? {} : { stack }),
					});
					if (err instanceof CanonicalDataError) throw err;
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		const details = currentEvent.details as JsonValue | undefined;
		return {
			content: currentEvent.content,
			...(details === undefined ? {} : { details }),
			isError: currentEvent.isError,
		};
	}

	async emitToolCall(event: ToolCallEvent, options?: ServicesPolicyOptions): Promise<ToolCallEventResult | undefined> {
		if (this.isInert) {
			if (options?.strict) throw new Error("Extension runtime is stale");
			return undefined;
		}
		const attributedEvent = event;
		if (options?.origin)
			Object.defineProperty(attributedEvent, "origin", {
				value: Object.freeze({ ...options.origin }),
				enumerable: true,
			});
		let result: ToolCallEventResult | undefined;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("tool_call");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);
			if (options) Object.defineProperty(ctx, "signal", { value: options.signal });

			for (const handler of handlers) {
				const handlerResult = await withoutExtensionServices(() => handler(attributedEvent, ctx));

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
		if (this.isInert) {
			return undefined;
		}
		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("user_bash");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);

			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);
					if (handlerResult) {
						return handlerResult as UserBashEventResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionId: ext.id,
						event: "user_bash",
						error: message,
						stack,
					});
				}
			}
		}

		return undefined;
	}

	async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
		if (this.isInert) {
			return messages;
		}
		let currentMessages = structuredClone(messages);

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("context");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);

			for (const handler of handlers) {
				try {
					const event: ContextEvent = { type: "context", messages: currentMessages };
					const handlerResult = await handler(event, ctx);

					if (handlerResult && (handlerResult as ContextEventResult).messages) {
						currentMessages = (handlerResult as ContextEventResult).messages!;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionId: ext.id,
						event: "context",
						error: message,
						stack,
					});
				}
			}
		}

		return currentMessages;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		if (this.isInert) {
			return payload;
		}
		let currentPayload = payload;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_provider_request");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);

			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionId: ext.id,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeAgentStart(
		prompt: string,
		images: ImageContent[] | undefined,
		systemPrompt: string,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult | undefined> {
		if (this.isInert) {
			return undefined;
		}
		let currentSystemPrompt = systemPrompt;
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
		let systemPromptModified = false;

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("before_agent_start");
			if (!handlers || handlers.length === 0) continue;
			const ctx = Object.defineProperties(
				{},
				Object.getOwnPropertyDescriptors(this.createContext(ext.id)),
			) as ExtensionContext;
			ctx.getSystemPrompt = () => {
				this.assertActive();
				return currentSystemPrompt;
			};

			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						type: "before_agent_start",
						prompt,
						images,
						systemPrompt: currentSystemPrompt,
						systemPromptOptions,
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = cloneCanonicalData(
							handlerResult as BeforeAgentStartEventResult,
							`Extension before_agent_start output from ${ext.id}`,
						);
						if (result.message) {
							messages.push(result.message);
						}
						if (result.systemPrompt !== undefined) {
							currentSystemPrompt = result.systemPrompt;
							systemPromptModified = true;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitErrorContained({
						extensionId: ext.id,
						event: "before_agent_start",
						error: message,
						...(stack === undefined ? {} : { stack }),
					});
				}
			}
		}

		if (messages.length > 0 || systemPromptModified) {
			return {
				...(messages.length > 0 ? { messages } : {}),
				...(systemPromptModified ? { systemPrompt: currentSystemPrompt } : {}),
			};
		}

		return undefined;
	}

	async emitResourcesDiscover(
		cwd: string,
		reason: ResourcesDiscoverEvent["reason"],
	): Promise<{
		skillPaths: DiscoveredResourcePath[];
		promptPaths: DiscoveredResourcePath[];
		themePaths: DiscoveredResourcePath[];
	}> {
		if (this.isInert) {
			return { skillPaths: [], promptPaths: [], themePaths: [] };
		}
		const skillPaths: DiscoveredResourcePath[] = [];
		const promptPaths: DiscoveredResourcePath[] = [];
		const themePaths: DiscoveredResourcePath[] = [];

		for (const ext of this.extensions) {
			const handlers = ext.handlers.get("resources_discover");
			if (!handlers || handlers.length === 0) continue;
			const ctx = this.createContext(ext.id);
			const discovered = (path: string): DiscoveredResourcePath => ({
				path,
				extensionId: ext.id,
				...(ext.sourceInfo.baseDir === undefined ? {} : { baseDir: ext.sourceInfo.baseDir }),
			});

			for (const handler of handlers) {
				try {
					const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
					const handlerResult = await handler(event, ctx);
					const result = handlerResult as ResourcesDiscoverResult | undefined;

					if (result?.skillPaths?.length) {
						skillPaths.push(...result.skillPaths.map(discovered));
					}
					if (result?.promptPaths?.length) {
						promptPaths.push(...result.promptPaths.map(discovered));
					}
					if (result?.themePaths?.length) {
						themePaths.push(...result.themePaths.map(discovered));
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						extensionId: ext.id,
						event: "resources_discover",
						error: message,
						stack,
					});
				}
			}
		}

		return { skillPaths, promptPaths, themePaths };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		if (this.isInert) {
			return { action: "continue" };
		}
		let currentText = text;
		let currentImages = images;

		for (const ext of this.extensions) {
			const ctx = this.createContext(ext.id);
			for (const handler of ext.handlers.get("input") ?? []) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						extensionId: ext.id,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}
