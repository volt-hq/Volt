import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@earendil-works/volt-agent-core";
import { createInProcessRpcClient, type InProcessRpcClient } from "../../modes/rpc/in-process-rpc-client.ts";
import type { RpcClientEvent } from "../../modes/rpc/rpc-client-base.ts";
import type { SessionStats } from "../agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	type SubagentRuntimeContext,
} from "../agent-session-runtime.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { RpcSessionState, RpcTranscriptResponse } from "../rpc/types.ts";
import { SessionManager } from "../session-manager.ts";
import type { SubagentDefinition } from "./index.ts";

export type SubagentEvent = RpcClientEvent;
export type SubagentEndEvent = Extract<SubagentEvent, { type: "agent_end" }>;
export type SubagentEventListener = (event: SubagentEvent) => void;

export interface SubagentResult {
	id: string;
	sessionId: string;
	event: SubagentEndEvent;
}

export interface SubagentHandle {
	id: string;
	sessionId: string;
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<RpcSessionState>;
	getTranscript(options?: { limit?: number; beforeEntryId?: string }): Promise<RpcTranscriptResponse>;
	getSessionStats(): Promise<SessionStats>;
	waitForEnd(): Promise<SubagentResult>;
	dispose(): Promise<void>;
	onEvent(listener: SubagentEventListener): () => void;
}

export interface SubagentRuntimeCreatedEvent {
	id: string;
	sessionId: string;
	runtime: AgentSessionRuntime;
	definition?: SubagentDefinition;
	parentSessionId?: string;
	parentSessionFile?: string;
}

export interface SubagentManagerOptions {
	createRuntime: CreateAgentSessionRuntimeFactory;
	cwd: string;
	agentDir: string;
	resourceLoader?: ResourceLoader;
	/** Parent session used to create durable child sessions when start options do not supply one. */
	parentSessionManager?: SessionManager;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
	/** Current subagent identity and delegation policy when this manager belongs to a child runtime. */
	subagentContext?: SubagentRuntimeContext;
	requestTimeoutMs?: number;
	/** Keep child runtimes alive after the hidden loopback client detaches. Another owner must retain/dispose them. */
	retainRuntimeOnDispose?: boolean;
	/** Called after a child runtime is ready so hosts can register it for live attachment. */
	onRuntimeCreated?: (event: SubagentRuntimeCreatedEvent) => void | Promise<void>;
}

export interface SubagentStartOptions {
	cwd?: string;
	agentDir?: string;
	sessionManager?: SessionManager;
	requestTimeoutMs?: number;
}

export interface SubagentStartByNameOptions extends SubagentStartOptions {
	resourceLoader?: ResourceLoader;
	/** Maximum tool policy inherited from the parent context. Definition tools are intersected with this list. */
	allowedTools?: string[];
}

export class SubagentDefinitionNotFoundError extends Error {
	readonly agentName: string;
	readonly availableNames: string[];
	readonly diagnostics: ResourceDiagnostic[];

	constructor(agentName: string, availableNames: string[], diagnostics: ResourceDiagnostic[] = []) {
		super(
			agentName.trim() ? `Subagent definition "${agentName}" was not found` : "Subagent definition name is required",
		);
		this.name = "SubagentDefinitionNotFoundError";
		this.agentName = agentName;
		this.availableNames = availableNames;
		this.diagnostics = diagnostics;
	}
}

export class SubagentDefinitionConfigurationError extends Error {
	readonly agentName: string;
	readonly field: "model" | "thinking";

	constructor(agentName: string, field: "model" | "thinking", message: string) {
		super(`Invalid subagent definition "${agentName}" ${field}: ${message}`);
		this.name = "SubagentDefinitionConfigurationError";
		this.agentName = agentName;
		this.field = field;
	}
}

const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function isThinkingLevel(value: string): value is ThinkingLevel {
	return VALID_THINKING_LEVELS.includes(value as ThinkingLevel);
}

function normalizeUniqueNames(names: readonly string[] | undefined): string[] | undefined {
	if (!names) {
		return undefined;
	}
	return Array.from(new Set(names.map((name) => name.trim()).filter((name) => name.length > 0)));
}

function resolveEffectiveTools(options: {
	requestedTools: string[] | undefined;
	excludedTools: string[] | undefined;
	allowedTools: string[] | undefined;
	defaultTools: string[];
}): string[] | undefined {
	const normalizedRequested = normalizeUniqueNames(options.requestedTools);
	const normalizedAllowed = normalizeUniqueNames(options.allowedTools);
	const normalizedExcluded = normalizeUniqueNames(options.excludedTools);
	let effectiveTools: string[] | undefined;

	if (normalizedRequested && normalizedAllowed) {
		const allowed = new Set(normalizedAllowed);
		effectiveTools = normalizedRequested.filter((toolName) => allowed.has(toolName));
	} else if (normalizedRequested) {
		effectiveTools = normalizedRequested;
	} else if (normalizedAllowed) {
		effectiveTools = normalizedAllowed;
	} else if (normalizedExcluded) {
		effectiveTools = normalizeUniqueNames(options.defaultTools);
	}

	if (!effectiveTools || !normalizedExcluded) {
		return effectiveTools;
	}

	const excluded = new Set(normalizedExcluded);
	return effectiveTools.filter((toolName) => !excluded.has(toolName));
}

class LocalSubagentHandle implements SubagentHandle {
	readonly id: string;
	readonly sessionId: string;
	private readonly client: InProcessRpcClient;
	private readonly abortRuntime: () => Promise<void>;
	private readonly removeFromManager: (id: string) => void;
	private waitForIdle: (() => Promise<void>) | undefined;
	private readonly eventListeners = new Set<SubagentEventListener>();
	private readonly endPromise: Promise<SubagentResult>;
	private resolveEnd: (result: SubagentResult) => void = () => {};
	private rejectEnd: (error: Error) => void = () => {};
	private latestEndEvent: SubagentEndEvent | undefined;
	private settlementWatcherStarted = false;
	private promptStarted = false;
	private promptAccepted = false;
	private promptMessageObserved = false;
	private endSettled = false;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: {
		id: string;
		sessionId: string;
		client: InProcessRpcClient;
		abortRuntime: () => Promise<void>;
		removeFromManager: (id: string) => void;
		waitForIdle: () => Promise<void>;
	}) {
		this.id = options.id;
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.abortRuntime = options.abortRuntime;
		this.removeFromManager = options.removeFromManager;
		this.waitForIdle = options.waitForIdle;
		this.endPromise = new Promise<SubagentResult>((resolve, reject) => {
			this.resolveEnd = resolve;
			this.rejectEnd = reject;
		});
		void this.endPromise.catch(() => {});
	}

	async prompt(message: string): Promise<void> {
		this.assertOpen();
		this.promptStarted = true;
		await this.client.prompt(message, undefined, () => {
			this.promptAccepted = true;
		});
	}

	async abort(): Promise<void> {
		this.assertOpen();
		// Abort the in-process runtime directly so cancellation is signalled before
		// concurrent disposal can close the loopback transport.
		await this.abortRuntime();
	}

	async getState(): Promise<RpcSessionState> {
		this.assertOpen();
		return this.client.getState();
	}

	async getTranscript(options: { limit?: number; beforeEntryId?: string } = {}): Promise<RpcTranscriptResponse> {
		this.assertOpen();
		return this.client.getTranscript(options);
	}

	async getSessionStats(): Promise<SessionStats> {
		this.assertOpen();
		return this.client.getSessionStats();
	}

	waitForEnd(): Promise<SubagentResult> {
		return this.endPromise;
	}

	onEvent(listener: SubagentEventListener): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		this.disposed = true;
		this.waitForIdle = undefined;
		if (!this.endSettled) {
			this.endSettled = true;
			this.rejectEnd(new Error(`Subagent ${this.id} was disposed before completion`));
		}
		this.disposePromise = Promise.resolve().then(async () => {
			try {
				await this.client.stop();
			} finally {
				this.eventListeners.clear();
				this.removeFromManager(this.id);
			}
		});
		return this.disposePromise;
	}

	handleEvent(event: SubagentEvent): void {
		if (this.disposed) {
			return;
		}
		if (
			event.type === "message_start" &&
			(event.message.role === "user" || event.message.role === "custom") &&
			this.promptStarted
		) {
			this.promptMessageObserved = true;
		}
		if (event.type === "agent_end" && this.promptMessageObserved) {
			this.latestEndEvent = event;
		}
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch {
				// Listener failures should not break the child RPC event stream.
			}
		}
		const shouldWatchSettlement =
			(event.type === "agent_end" && this.promptMessageObserved) ||
			(event.type === "agent_settled" && this.promptAccepted);
		if (shouldWatchSettlement && !this.settlementWatcherStarted && !this.disposed && !this.endSettled) {
			this.settlementWatcherStarted = true;
			void this.settleAfterIdle();
		}
	}

	private async settleAfterIdle(): Promise<void> {
		const waitForIdle = this.waitForIdle;
		this.waitForIdle = undefined;
		if (!waitForIdle) {
			return;
		}
		try {
			await waitForIdle();
		} catch (error) {
			if (!this.disposed && !this.endSettled) {
				this.endSettled = true;
				this.rejectEnd(error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}

		if (this.disposed || this.endSettled) {
			return;
		}
		const latestEndEvent = this.latestEndEvent;
		if (!this.promptMessageObserved || !latestEndEvent) {
			this.endSettled = true;
			this.rejectEnd(new Error(`Subagent ${this.id} settled without an agent result`));
			return;
		}
		this.endSettled = true;
		const event = latestEndEvent.willRetry ? { ...latestEndEvent, willRetry: false } : latestEndEvent;
		this.resolveEnd({ id: this.id, sessionId: this.sessionId, event });
	}

	private assertOpen(): void {
		if (this.disposed) {
			throw new Error(`Subagent ${this.id} is disposed`);
		}
	}
}

export class SubagentManager {
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly resourceLoader?: ResourceLoader;
	private readonly parentSessionManager?: SessionManager;
	private readonly allowedTools?: string[];
	private readonly subagentContext?: SubagentRuntimeContext;
	private readonly requestTimeoutMs?: number;
	private readonly retainRuntimeOnDispose: boolean;
	private readonly onRuntimeCreated?: (event: SubagentRuntimeCreatedEvent) => void | Promise<void>;
	private readonly handles = new Map<string, LocalSubagentHandle>();
	private childStartCount = 0;

	constructor(options: SubagentManagerOptions) {
		this.createRuntime = options.createRuntime;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.resourceLoader = options.resourceLoader;
		this.parentSessionManager = options.parentSessionManager;
		this.allowedTools = normalizeUniqueNames(options.allowedTools);
		this.subagentContext = options.subagentContext;
		this.requestTimeoutMs = options.requestTimeoutMs;
		this.retainRuntimeOnDispose = options.retainRuntimeOnDispose ?? false;
		this.onRuntimeCreated = options.onRuntimeCreated;
	}

	async start(options: SubagentStartOptions = {}): Promise<SubagentHandle> {
		const releaseReservation = this.reserveChildStart(undefined);
		try {
			return await this.startRuntime(options);
		} catch (error) {
			releaseReservation();
			throw error;
		}
	}

	listDefinitions(options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition[] {
		const resourceLoader = options.resourceLoader ?? this.resourceLoader;
		return resourceLoader?.getSubagents().definitions ?? [];
	}

	getDefinition(agentName: string, options: { resourceLoader?: ResourceLoader } = {}): SubagentDefinition {
		return this.resolveDefinition(agentName, options.resourceLoader);
	}

	async startByName(agentName: string, options: SubagentStartByNameOptions = {}): Promise<SubagentHandle> {
		const definition = this.getDefinition(agentName, { resourceLoader: options.resourceLoader });
		const releaseReservation = this.reserveChildStart(definition.name);
		try {
			return await this.startRuntime(options, {
				definition,
				allowedTools: options.allowedTools ?? this.allowedTools,
			});
		} catch (error) {
			releaseReservation();
			throw error;
		}
	}

	async dispose(): Promise<void> {
		const handles = Array.from(this.handles.values());
		await Promise.all(handles.map((handle) => handle.dispose()));
	}

	private reserveChildStart(agentName: string | undefined): () => void {
		const context = this.subagentContext;
		if (!context) {
			return () => undefined;
		}

		if (!agentName) {
			throw new Error(`Subagent "${context.agentName}" cannot start unnamed child subagents.`);
		}

		if (context.maxSubagentDepth !== undefined && context.depth >= context.maxSubagentDepth) {
			throw new Error(
				`Subagent "${context.agentName}" cannot delegate to "${agentName}": maxSubagentDepth ${context.maxSubagentDepth} reached at depth ${context.depth}.`,
			);
		}

		const allowedSubagents = normalizeUniqueNames(context.allowedSubagents);
		if (allowedSubagents && allowedSubagents.length === 0) {
			throw new Error(
				`Subagent "${context.agentName}" cannot delegate to "${agentName}": no child subagents are allowed.`,
			);
		}
		if (allowedSubagents && !allowedSubagents.includes(agentName)) {
			throw new Error(
				`Subagent "${context.agentName}" cannot delegate to "${agentName}". Allowed subagents: ${allowedSubagents.join(", ")}.`,
			);
		}

		if (context.maxChildAgents !== undefined && this.childStartCount >= context.maxChildAgents) {
			throw new Error(
				`Subagent "${context.agentName}" cannot start more than ${context.maxChildAgents} child subagent${context.maxChildAgents === 1 ? "" : "s"}.`,
			);
		}

		this.childStartCount += 1;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.childStartCount = Math.max(0, this.childStartCount - 1);
		};
	}

	private createChildSubagentContext(definition: SubagentDefinition | undefined): SubagentRuntimeContext | undefined {
		if (!definition) {
			return undefined;
		}
		const parentPath = this.subagentContext?.path ?? [];
		const inheritedMaxDepth = this.subagentContext?.maxSubagentDepth;
		const definitionMaxDepth = definition.maxSubagentDepth;
		const maxSubagentDepth =
			inheritedMaxDepth === undefined
				? definitionMaxDepth
				: definitionMaxDepth === undefined
					? inheritedMaxDepth
					: Math.min(inheritedMaxDepth, definitionMaxDepth);
		return {
			depth: (this.subagentContext?.depth ?? 0) + 1,
			agentName: definition.name,
			path: [...parentPath, definition.name],
			...(definition.allowedSubagents ? { allowedSubagents: definition.allowedSubagents } : {}),
			...(maxSubagentDepth !== undefined ? { maxSubagentDepth } : {}),
			...(definition.maxChildAgents !== undefined ? { maxChildAgents: definition.maxChildAgents } : {}),
		};
	}

	private async startRuntime(
		options: SubagentStartOptions,
		definitionOptions?: {
			definition: SubagentDefinition;
			allowedTools?: string[];
		},
	): Promise<SubagentHandle> {
		const cwd = options.cwd ?? this.cwd;
		const agentDir = options.agentDir ?? this.agentDir;
		const sessionManager = options.sessionManager ?? this.createDefaultChildSessionManager(cwd);
		const id = `sa_${randomUUID()}`;
		const subagentContext = this.createChildSubagentContext(definitionOptions?.definition);
		const runtime = await this.createChildRuntime({ cwd, agentDir, sessionManager, subagentContext });
		let client: InProcessRpcClient | undefined;
		try {
			if (definitionOptions) {
				await this.applyDefinitionToRuntime(runtime, definitionOptions.definition, definitionOptions.allowedTools);
			}

			let handle: LocalSubagentHandle | undefined;
			client = await createInProcessRpcClient(runtime, {
				disposeRuntimeOnClose: !this.retainRuntimeOnDispose,
				requestTimeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
				onEvent: (event) => {
					handle?.handleEvent(event);
				},
			});
			await this.notifyRuntimeCreated({ id, runtime, definition: definitionOptions?.definition });
			handle = new LocalSubagentHandle({
				id,
				sessionId: runtime.session.sessionId,
				client,
				abortRuntime: () => runtime.session.abort(),
				removeFromManager: (handleId) => {
					this.handles.delete(handleId);
				},
				waitForIdle: () => runtime.session.waitForIdle(),
			});
			this.handles.set(id, handle);
			return handle;
		} catch (error) {
			await client?.stop().catch(() => undefined);
			await runtime.dispose().catch(() => undefined);
			throw error;
		}
	}

	private createDefaultChildSessionManager(cwd: string): SessionManager {
		if (!this.parentSessionManager?.isPersisted()) {
			return SessionManager.inMemory(cwd);
		}
		const parentSession = this.parentSessionManager.getSessionFile();
		return SessionManager.create(
			cwd,
			this.parentSessionManager.getSessionDir(),
			parentSession ? { parentSession } : undefined,
		);
	}

	private async notifyRuntimeCreated(options: {
		id: string;
		runtime: AgentSessionRuntime;
		definition?: SubagentDefinition;
	}): Promise<void> {
		if (!this.onRuntimeCreated) {
			return;
		}
		await this.onRuntimeCreated({
			id: options.id,
			sessionId: options.runtime.session.sessionId,
			runtime: options.runtime,
			...(options.definition ? { definition: options.definition } : {}),
			...(this.parentSessionManager ? { parentSessionId: this.parentSessionManager.getSessionId() } : {}),
			...(this.parentSessionManager?.getSessionFile()
				? { parentSessionFile: this.parentSessionManager.getSessionFile() }
				: {}),
		});
	}

	private resolveDefinition(
		agentName: string,
		resourceLoaderOverride: ResourceLoader | undefined,
	): SubagentDefinition {
		const resourceLoader = resourceLoaderOverride ?? this.resourceLoader;
		if (!resourceLoader) {
			throw new SubagentDefinitionNotFoundError(agentName, []);
		}

		const result = resourceLoader.getSubagents();
		const definition = result.definitions.find((candidate) => candidate.name === agentName.trim());
		if (!definition) {
			throw new SubagentDefinitionNotFoundError(
				agentName,
				result.definitions.map((candidate) => candidate.name),
				result.diagnostics,
			);
		}
		return definition;
	}

	private async applyDefinitionToRuntime(
		runtime: AgentSessionRuntime,
		definition: SubagentDefinition,
		allowedTools: string[] | undefined,
	): Promise<void> {
		const activeTools = resolveEffectiveTools({
			requestedTools: definition.tools,
			excludedTools: definition.excludedTools,
			allowedTools,
			defaultTools: runtime.session.getActiveToolNames(),
		});
		if (activeTools) {
			runtime.session.setActiveToolsByName(activeTools);
		}
		runtime.session.appendSystemPromptContext(definition.systemPrompt);

		let thinkingLevel = this.validateThinkingLevel(definition);
		if (definition.model) {
			const availableModels = await runtime.session.modelRegistry.getAvailable();
			const resolved = parseModelPattern(definition.model, availableModels, {
				allowInvalidThinkingLevelFallback: false,
			});
			if (!resolved.model) {
				throw new SubagentDefinitionConfigurationError(
					definition.name,
					"model",
					`model reference "${definition.model}" is not available or is not configured`,
				);
			}
			await runtime.session.setModel(resolved.model, { persistDefault: false });
			thinkingLevel ??= resolved.thinkingLevel;
		}

		if (thinkingLevel) {
			runtime.session.setThinkingLevel(thinkingLevel, { persistDefault: false });
		}
	}

	private validateThinkingLevel(definition: SubagentDefinition): ThinkingLevel | undefined {
		if (!definition.thinking) {
			return undefined;
		}
		// Discovery keeps invalid frontmatter as diagnostics, but definition-backed starts fail
		// before prompting so callers get a clear configuration error for this subagent.
		if (!isThinkingLevel(definition.thinking)) {
			throw new SubagentDefinitionConfigurationError(
				definition.name,
				"thinking",
				`"${definition.thinking}" is not a supported thinking level`,
			);
		}
		return definition.thinking;
	}

	private async createChildRuntime(options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		subagentContext?: SubagentRuntimeContext;
	}): Promise<AgentSessionRuntime> {
		return createAgentSessionRuntime(this.createRuntime, {
			cwd: options.cwd,
			agentDir: options.agentDir,
			sessionManager: options.sessionManager,
			...(options.subagentContext ? { subagentContext: options.subagentContext } : {}),
		});
	}
}
