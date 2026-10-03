/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, type ConversationLog, InMemoryConversationLog, uuidv7 } from "@hansjm10/volt-agent-core";
import {
	createFauxProvider,
	type FauxModelDefinition,
	type FauxPromptCacheRefresh,
	type FauxProvider,
	type FauxResponseStep,
	type Model,
	type PromptCacheRefreshCheck,
} from "@hansjm10/volt-ai";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SqliteConversationLog } from "../../src/core/conversation-log/sqlite-conversation-log.ts";
import type { ExtensionRunner } from "../../src/core/extensions/index.ts";
import type { LspServerPool } from "../../src/core/lsp/server-pool.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { SubagentToolManager } from "../../src/core/tools/subagent.ts";
import type { ExtensionFactory, ExtensionWorkLimits, ResourceLoader } from "../../src/index.ts";
import { createAgentSessionTestControl, type LegacyPrepareDelivery } from "../agent-session-test-control.ts";
import { FaultyConversationLog, injectFaultyLog } from "../utilities/faulty-log.ts";
import { type SeedLogBuild, type SeedModel, seedLog } from "../utilities/seed-log.ts";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.ts";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	agentDir?: string;
	/** Optional faux streaming pace for tests that interrupt an unfinished provider response. */
	tokensPerSecond?: number;
	models?: FauxModelDefinition[];
	settings?: Partial<Settings>;
	extensionWorkLimits?: Partial<ExtensionWorkLimits>;
	systemPrompt?: string;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	subagentToolManager?: SubagentToolManager;
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	prepareDelivery?: LegacyPrepareDelivery;
	withConfiguredAuth?: boolean;
	/** Inject a persisted manager when a test needs to exercise session reload behavior. */
	sessionManager?: SessionManager;
	/**
	 * Build the session from a conversation log instead: `"memory"` (the default
	 * with `seed`) for an in-memory log, `"sqlite"` for a persisted session in
	 * the harness temp directory, or a log to use as given, such as an
	 * `InMemoryConversationLog`. The session writes through a
	 * `FaultyConversationLog`, exposed as `harness.log`.
	 */
	log?: "memory" | "sqlite" | ConversationLog;
	/** Entries committed to the log before the session opens; assistant messages name the faux model. */
	seed?: SeedLogBuild;
	/** Project root for project-scoped services such as LSP. Defaults to the harness temp dir. */
	projectCwd?: string;
	/** Share language servers with other sessions using the same pool. */
	lspServerPool?: LspServerPool;
	/** Give the faux provider a prompt-cache refresh and wire the session to it. */
	refreshPromptCache?: true | FauxPromptCacheRefresh;
	/** Which request options the faux refresh supports; omitted means all of them. */
	canRefreshPromptCache?: PromptCacheRefreshCheck;
}

export interface Harness {
	session: AgentSession;
	control: ReturnType<typeof createAgentSessionTestControl>;
	sessionManager: SessionManager;
	/** The log the session writes, for fault injection, when it was built from a log (`log` or `seed`). */
	log: FaultyConversationLog | undefined;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProvider;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
	cleanupAsync: () => Promise<void>;
}

/**
 * A model registry over the harness's credentials whose client streams the harness's faux provider,
 * for sessions created outside the harness (the registry `createAgentSession` would create for `agentDir`).
 */
export function createFauxModelRegistry(harness: Harness, agentDir = harness.tempDir): ModelRegistry {
	const registry = ModelRegistry.create(harness.authStorage, join(agentDir, "models.json"));
	registry.client.registerProvider(harness.faux);
	return registry;
}

/** A session manager over a (seeded) conversation log, writing through a fault-injecting wrapper. */
async function openLogSession(
	options: HarnessOptions,
	tempDir: string,
	model: SeedModel,
): Promise<{ sessionManager: SessionManager; log: FaultyConversationLog }> {
	if (options.sessionManager) throw new Error("A harness takes either a session manager or a log");
	const seed = options.seed;
	if (options.log === "sqlite") {
		const created = await SqliteConversationLog.create({ sessionDirectory: join(tempDir, "sessions"), cwd: tempDir });
		try {
			if (seed) await seedLog(created, seed, { model });
		} finally {
			await created.close();
		}
		const sessionManager = await SessionManager.open(created.ref);
		return { sessionManager, log: injectFaultyLog(sessionManager) };
	}
	const log =
		options.log === undefined || options.log === "memory" ? new InMemoryConversationLog(uuidv7()) : options.log;
	if (seed) await seedLog(log, seed, { model });
	const faulty = log instanceof FaultyConversationLog ? log : new FaultyConversationLog(log);
	return { sessionManager: await SessionManager.openInMemory(faulty), log: faulty };
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	// Leave room for nested worktree/quarantine paths within Git for Windows' path limit.
	const tempDir = mkdtempSync(join(tmpdir(), "volt-"));
	const fauxProvider = createFauxProvider({
		models: options.models,
		tokensPerSecond: options.tokensPerSecond,
		...(options.refreshPromptCache === undefined ? {} : { refreshPromptCache: options.refreshPromptCache }),
		...(options.canRefreshPromptCache === undefined ? {} : { canRefreshPromptCache: options.canRefreshPromptCache }),
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const fromLog =
		options.log !== undefined || options.seed !== undefined
			? await openLogSession(options, tempDir, model)
			: undefined;
	const sessionManager = fromLog?.sessionManager ?? options.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.client.registerProvider(fauxProvider);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ??
		createTestResourceLoader({
			...(extensionsResult === undefined ? {} : { extensionsResult }),
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
		});

	const session = new AgentSession({
		sessionManager,
		model,
		thinkingLevel: "off",
		streamFn: modelRegistry.client.streamSimple,
		...(options.refreshPromptCache === undefined ? {} : { promptCacheRefresh: modelRegistry.client }),
		convertToLlm,
		settingsManager,
		extensionWorkLimits: options.extensionWorkLimits,
		cwd: tempDir,
		...(options.projectCwd === undefined ? {} : { projectCwd: options.projectCwd }),
		agentDir: options.agentDir ?? tempDir,
		modelRegistry,
		resourceLoader,
		baseToolsOverride: toolMap,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
		subagentToolManager: options.subagentToolManager,
		...(options.lspServerPool === undefined ? {} : { lspServerPool: options.lspServerPool }),
		extensionRunnerRef,
	});
	const control = createAgentSessionTestControl(session);
	if (options.prepareDelivery) control.setPrepareDelivery(options.prepareDelivery);

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		control,
		sessionManager,
		log: fromLog?.log,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			if (sessionManager.isPersisted()) {
				throw new Error("Persisted harness cleanup must await cleanupAsync()");
			}
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
		async cleanupAsync() {
			session.dispose();
			try {
				await session.waitForClosed();
			} finally {
				await rm(tempDir, {
					recursive: true,
					force: true,
					...(process.platform === "win32" ? { maxRetries: 10, retryDelay: 50 } : {}),
				});
			}
		},
	};
}
