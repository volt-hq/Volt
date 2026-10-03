/**
 * The session's extension binding: the extension runner over the loaded
 * extensions, the host surface a mode binds to it (UI context, mode, command
 * context actions, abort and shutdown handlers, error listener), the core
 * actions and resources extensions reach the session through, and the
 * in-place runtime reload that rebuilds the runner and the tools.
 */

import { basename, dirname } from "node:path";
import type { AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import type { AgentSession, ExtensionBindings } from "../agent-session.ts";
import {
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type ReplacedSessionContext,
	type SessionStartEvent,
	type ShutdownHandler,
} from "../extensions/index.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import type { CustomMessageInput } from "../messages.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "../resource-loader.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SlashCommandInfo } from "../slash-commands.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import type { SessionExtensionWork } from "./extension-work.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionToolRuntime } from "./tool-runtime.ts";

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

function getExtensionSourceLabel(extensionPath: string): string {
	if (extensionPath.startsWith("<")) {
		return `extension:${extensionPath.replace(/[<>]/g, "")}`;
	}
	const base = basename(extensionPath);
	const name = base.replace(/\.(ts|js)$/, "");
	return `extension:${name}`;
}

function buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
	path: string;
	metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
}> {
	return entries.map((entry) => {
		const source = getExtensionSourceLabel(entry.extensionPath);
		const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
		return {
			path: entry.path,
			metadata: {
				source,
				scope: "temporary",
				origin: "top-level",
				baseDir,
			},
		};
	});
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
	conversation(): Conversation<AgentTool>;
	tools(): SessionToolRuntime;
	extensionWork(): SessionExtensionWork;
	background(): SessionBackgroundContinuation;
	sessionWriter(): SessionWriter;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Whether active session work owns the runtime: a turn, a bash run, a session mutation, or background jobs. */
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
	private extensionUIContext?: ExtensionUIContext;
	private extensionMode: ExtensionMode = "print";
	private extensionCommandContextActions?: ExtensionCommandContextActions;
	private extensionAbortHandler?: () => void;
	private extensionShutdownHandler?: ShutdownHandler;
	private extensionErrorListener?: ExtensionErrorListener;
	private extensionErrorUnsubscriber?: () => void;
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

	get uiContext(): ExtensionUIContext | undefined {
		return this.extensionUIContext;
	}

	get mode(): ExtensionMode {
		return this.extensionMode;
	}

	/** Whether a runtime reload is in progress. */
	get reloading(): boolean {
		return this.reloadInProgress;
	}

	async bind(bindings: ExtensionBindings): Promise<void> {
		this.host.assertActive();
		if (bindings.uiContext !== undefined) {
			this.extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this.extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this.extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this.extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this.extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this.extensionErrorListener = bindings.onError;
		}

		this.applyExtensionBindings(this.extensionRunner);
		// Interactive-only native tools follow the currently bound host surface.
		this.host.tools().syncPlanningRuntime();
		await this.extensionRunner.emit(this.sessionStartEvent);
		this.host.assertActive();
		await this.extendResourcesFromExtensions(this.sessionStartEvent.reason === "reload" ? "reload" : "startup");
		this.host.assertActive();
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

	private applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this.extensionUIContext, this.extensionMode);
		runner.bindCommandContext(this.extensionCommandContextActions);

		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = this.extensionErrorListener
			? runner.onError(this.extensionErrorListener)
			: undefined;
	}

	/** Stop forwarding extension errors to the listener the host bound. */
	releaseErrorListener(): void {
		this.extensionErrorUnsubscriber?.();
		this.extensionErrorUnsubscriber = undefined;
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
				extensionPath: "<runtime>",
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
		this.bindExtensionCore(this.extensionRunner);
		this.applyExtensionBindings(this.extensionRunner);
	}

	private bindExtensionCore(runner: ExtensionRunner): void {
		const session = this.host.session;
		runner.bindWork(this.host.extensionWork().workManager);
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
					this.host.sendCustomMessage(message, options, this.host.extensionCommandRunning()).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					session.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
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
				getSignal: () => this.host.background().hookSignal(),
				abort: () => {
					if (this.extensionAbortHandler) {
						this.extensionAbortHandler();
						return;
					}
					void session.abort();
				},
				hasPendingMessages: () => session.pendingMessageCount > 0,
				shutdown: () => {
					this.extensionShutdownHandler?.();
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
		this.host.extensionWork().invalidate();
		await this.host.extensionWork().reopen();
		const previousFlagValues = this.extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this.extensionRunner, { type: "session_shutdown", reason: "reload" });
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

		const hasBindings =
			this.extensionUIContext ||
			this.extensionCommandContextActions ||
			this.extensionShutdownHandler ||
			this.extensionErrorListener;
		if (hasBindings) {
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
		context.sendMessage = (message, options) => this.host.sendCustomMessage(message, options, true);
		context.sendUserMessage = (content, options) => this.host.session.sendUserMessage(content, options);
		return context;
	}
}
