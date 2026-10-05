/**
 * Shared manual Iroh stream doubles and lightweight session and daemon runtime doubles for Iroh remote tests.
 *
 * These implement the simple blocking-read semantics used by the notification and
 * model RPC suites. Other Iroh suites (transport, core, handshake) keep their own
 * doubles on purpose: they exercise different transport semantics (read-size
 * tracking, deferred/failing writes, non-blocking handshake reads) that would
 * change test behavior if folded into one implementation.
 */

import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import { vi } from "vitest";
import type { AgentSession, AgentSessionEvent, PromptPreflightResult } from "../src/core/agent-session.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import { ConversationHost } from "../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import type { IrohBytes, IrohRecvStreamLike, IrohSendStreamLike } from "../src/core/protocol/transport/index.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type QueuedIrohRead = { type: "data"; bytes: IrohBytes } | { type: "end" };

export class ManualIrohRecvStream implements IrohRecvStreamLike {
	private readonly queue: QueuedIrohRead[] = [];
	private readonly readers: Array<(value: IrohBytes | undefined) => void> = [];

	read(_sizeLimit: number): Promise<IrohBytes | undefined> {
		const queued = this.queue.shift();
		if (queued) {
			return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
		}
		return new Promise((resolve) => {
			this.readers.push(resolve);
		});
	}

	pushLine(line: string): void {
		this.enqueue({ type: "data", bytes: Buffer.from(`${line}\n`, "utf8") });
	}

	end(): void {
		this.enqueue({ type: "end" });
	}

	stop(_errorCode: bigint): void {
		this.end();
	}

	private enqueue(queued: QueuedIrohRead): void {
		const reader = this.readers.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}
		reader(queued.type === "data" ? queued.bytes : undefined);
	}
}

export class ManualIrohSendStream implements IrohSendStreamLike {
	readonly writes: Array<Array<number>> = [];
	finished = false;

	async writeAll(bytes: Array<number>): Promise<void> {
		this.writes.push(bytes);
	}

	async finish(): Promise<void> {
		this.finished = true;
	}

	writtenText(): string {
		return this.writes.map((bytes) => Buffer.from(bytes).toString("utf8")).join("");
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWrittenObjects(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return send
		.writtenText()
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const parsed = JSON.parse(line) as unknown;
			if (!isRecord(parsed)) {
				throw new Error("Expected JSON object");
			}
			return parsed;
		});
}

export function createTestSession(sessionId: string, leafId: string | null) {
	const session = {
		leafId,
		liveState: new LiveState(),
		autoCompactionEnabled: false,
		attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
		followUpMode: "all" as const,
		gitContextProvider: {
			getSnapshot: () => null,
			retainObservation: () => () => undefined,
		},
		isCompacting: false,
		isStreaming: false,
		messages: [] as AgentMessage[],
		model: undefined,
		modelRegistry: { authStorage: {} },
		pendingMessageCount: 0,
		prompt: vi.fn(
			async (
				_message: string,
				options?: { preflightResult?: (result: PromptPreflightResult) => void },
			): Promise<void> => {
				options?.preflightResult?.({ success: true, outcome: "admitted" });
			},
		),
		sessionRef: undefined,
		sessionId,
		sessionManager: {
			flush: vi.fn(async () => {}),
			getOrdinal: vi.fn(() => 0),
			getBranch: vi.fn((): object[] => []),
			getClientInput: vi.fn(() => undefined),
			getBranchWindow: ({
				beforeEntryId,
				maxEntries,
				lookbackEntries = 0,
			}: {
				beforeEntryId?: string;
				maxEntries: number;
				lookbackEntries?: number;
			}) => {
				const branch = session.sessionManager.getBranch() as SessionEntry[];
				const endIndex =
					beforeEntryId === undefined ? branch.length : branch.findIndex((entry) => entry.id === beforeEntryId);
				if (endIndex < 0) return undefined;
				const entryStart = Math.max(0, endIndex - maxEntries);
				const lookbackStart = Math.max(0, entryStart - lookbackEntries);
				return {
					entries: branch.slice(entryStart, endIndex),
					lookback: branch.slice(lookbackStart, entryStart),
					hasEarlier: lookbackStart > 0,
					visitedEntries: endIndex - lookbackStart + (lookbackStart > 0 ? 1 : 0),
				};
			},
			getLeafEntry: (): SessionEntry | undefined => (session.sessionManager.getBranch() as SessionEntry[]).at(-1),
			getLeafId: (): string | null => session.leafId,
			getSessionId: (): string => sessionId,
			getStartingGitContext: () => undefined,
		},
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		steeringMode: "all" as const,
		subscribe: vi.fn((_handler: (event: AgentSessionEvent) => void) => () => {}),
		thinkingLevel: "off" as const,
		fastModeEnabled: false,
		scopedModels: [],
		supportsThinking: () => false,
		getPlanningState: () => ({ mode: "build" as const, plan: null }),
		waitForIdle: vi.fn(async () => {}),
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn((_handler: () => Promise<void> | void) => () => {}),
		/** Never resolves: a test session keeps its log. */
		lost: new Promise<Error>(() => {}),
	};
	return session;
}

/** A conversation hosted for a test, as the RPC modes take it. */
export interface TestConversation {
	host: ConversationHost;
	conversation: HostedConversation;
}

/**
 * Host a lightweight test session as a conversation of its own host, which
 * opens nothing else and keeps the conversation open when its clients leave,
 * as a daemon host does.
 */
export function createTestConversation(
	session: Pick<ReturnType<typeof createTestSession>, "sessionId" | "lost">,
	options: {
		cwd?: string;
		agentDir?: string;
		/**
		 * Replaces the host's close of the conversation, which a lightweight test
		 * session cannot go through: it runs when the daemon or a test closes it.
		 */
		close?: () => Promise<void>;
	} = {},
): TestConversation {
	const host = new ConversationHost({
		factory: () => Promise.reject(new Error("A test host opens no other conversation")),
		agentDir: "/volt-test-agent",
		extensionMode: "rpc",
		whenUnattached: "keep",
	});
	const conversation = host.adoptSession({
		session: session as unknown as AgentSession,
		// Without an agent dir, the RPC mode's model catalog watcher stays off.
		services: { cwd: options.cwd ?? "/workspace", agentDir: options.agentDir } as unknown as AgentSessionServices,
		diagnostics: [],
	});
	const close = options.close;
	if (close) vi.spyOn(host, "close").mockImplementation(() => close());
	return { host, conversation };
}

/** The parts of a lightweight daemon conversation double: a session, where it runs, and how it closes. */
export interface TestDaemonRuntimeParts {
	session: object;
	cwd?: string;
	/** Runs when the daemon closes the conversation; resolves by default. */
	close?: () => Promise<void>;
	startRecoveredClientInputs?: () => Promise<void>;
	listSessions?: () => Promise<object[]>;
	/** Never resolves by default. */
	lost?: Promise<Error>;
}

/** The close of each conversation a daemon host double hosts. */
const testDaemonHostClosers = new WeakMap<ConversationHost, Map<HostedConversation, () => Promise<void>>>();

/**
 * A daemon conversation double for registry tests that never serve a stream
 * from it: the conversation is a plain object, and the host only closes it.
 * With `host`, the conversation joins that double's host instead, as a
 * conversation a phone's structural intent opened in its source's host does.
 */
export function createTestDaemonRuntime(parts: TestDaemonRuntimeParts, host?: ConversationHost): TestConversation {
	const conversation = {
		get id() {
			return (parts.session as { sessionId?: string }).sessionId;
		},
		session: parts.session,
		// The conversation's work is its session's, as in a hosted conversation.
		get work() {
			return (parts.session as { work?: unknown }).work;
		},
		cwd: parts.cwd ?? "/workspace",
		closed: false,
		lost: parts.lost ?? new Promise<Error>(() => {}),
		startRecoveredClientInputs: parts.startRecoveredClientInputs ?? (async () => {}),
		listSessions: parts.listSessions ?? (async () => []),
	} as unknown as HostedConversation;
	const conversationHost = host ?? createTestDaemonHost();
	const closers = testDaemonHostClosers.get(conversationHost);
	if (!closers) throw new Error("Not a daemon host double");
	closers.set(conversation, parts.close ?? (async () => {}));
	return { host: conversationHost, conversation };
}

/** A daemon host double: it closes the conversation doubles that joined it. */
function createTestDaemonHost(): ConversationHost {
	const closers = new Map<HostedConversation, () => Promise<void>>();
	const host = {
		close: vi.fn(async (conversation: HostedConversation) => {
			await closers.get(conversation)?.();
		}),
	} as unknown as ConversationHost;
	testDaemonHostClosers.set(host, closers);
	return host;
}

export function createTestModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}
