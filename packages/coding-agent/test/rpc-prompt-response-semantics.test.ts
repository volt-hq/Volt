import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { feedLiveState } from "../src/core/host/live-feed.ts";
import { getClientMessageId } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createFakeConversation, createFakeHost } from "./utilities/fake-conversation-host.ts";
import {
	createTestAgentSessionRuntimeConfig,
	createTestResourceLoader,
	loadPersistedSessionSnapshot,
} from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
	outputObserver: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	restoreStdout: vi.fn(),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
		rpcIo.outputObserver?.(line);
	},
}));

vi.mock("../src/core/protocol/transport/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

/** The `accepted` and `rejected` frames of the intent `intentId`. */
function getOutcomes(outputLines: string[], intentId: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.intentId === intentId && (record.type === "accepted" || record.type === "rejected"),
	);
}

/** The committed message entries of `role`. */
function getMessageEntries(outputLines: string[], role: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter((record) => {
		const entry = record.entry as { type?: string; payload?: { message?: { role?: string } } } | undefined;
		return record.type === "entry" && entry?.type === "message" && entry.payload?.message?.role === role;
	});
}

function sendFrame(frame: object): void {
	if (!rpcIo.lineHandler) throw new Error("RPC mode reads no input yet");
	rpcIo.lineHandler(JSON.stringify(frame));
}

/** A prompt intent: its intent id is the prompt's durable client message id. */
function sendPrompt(clientMessageId: string, message: string, extra: Record<string, unknown> = {}): void {
	sendFrame({ type: "prompt", intentId: clientMessageId, input: { message, ...extra } });
}

type FakeRuntimeHost = ReturnType<typeof createFakeHost> & { conversation: HostedConversation };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	configureSession?: (session: AgentSession) => void;
	sessionManager?: SessionManager;
}): Promise<{
	runtimeHost: FakeRuntimeHost;
	sessionManager: SessionManager;
	getStreamCallCount: () => number;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `volt-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	let streamCallCount = 0;
	const runtimeConfig = createTestAgentSessionRuntimeConfig({
		model,
		streamFn: (_model, _context, _options) => {
			streamCallCount++;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", seq: 0, snapshot: createAssistantMessage(""), toolState: [] });
				setTimeout(() => {
					stream.push({ type: "done", seq: 1, reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = options.sessionManager ?? SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const session = await AgentSession.create({
		...runtimeConfig,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	options.configureSession?.(session);
	const liveFeed = feedLiveState(session);

	const runtimeHost = { ...createFakeHost(), conversation: createFakeConversation(session).conversation };

	return {
		runtimeHost,
		sessionManager,
		getStreamCallCount: () => streamCallCount,
		cleanup: async () => {
			liveFeed.close();
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			await session.waitForClosed();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	configureSession?: (session: AgentSession) => void;
	sessionManager?: SessionManager;
}): Promise<{
	lineHandler: (line: string) => void;
	sessionManager: SessionManager;
	getStreamCallCount: () => number;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	rpcIo.outputObserver = undefined;

	const { runtimeHost, sessionManager, getStreamCallCount, cleanup } = await createRuntimeHost(options);
	const ready = Promise.withResolvers<void>();
	void runRpcMode(runtimeHost.host, runtimeHost.conversation, { onReady: ready.resolve });
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	sendFrame({ type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } });
	await ready.promise;
	sendFrame({
		type: "subscribe",
		subscriptionId: "s",
		conversation: runtimeHost.conversation.id,
		after: "snapshot",
	});

	return { lineHandler: rpcIo.lineHandler!, sessionManager, getStreamCallCount, cleanup };
}

describe("RPC prompt intent outcomes", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		rpcIo.outputObserver = undefined;
	});

	it("rejects once when prompt preflight rejects", async () => {
		const { cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			sendPrompt("client-b1", "Hello");

			await vi.waitFor(() => {
				const outcomes = getOutcomes(rpcIo.outputLines, "client-b1");
				expect(outcomes).toHaveLength(1);
				expect(outcomes[0]).toMatchObject({
					type: "rejected",
					intentId: "client-b1",
					reason: {
						code: "failed",
						message: expect.stringContaining(
							"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
						),
					},
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("accepts once when prompt preflight succeeds, after the input committed", async () => {
		const sessionDir = join(tmpdir(), `volt-rpc-durable-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionDir, { recursive: true });
		const manager = await SessionManager.create(sessionDir, sessionDir);
		const { cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			sessionManager: manager,
		});
		let acceptedObservedCanonicalCommit = false;
		rpcIo.outputObserver = (line) => {
			const accepted = parseOutputLines([line]).find(
				(record) => record.intentId === "client-b2" && record.type === "accepted",
			);
			if (!accepted) return;
			acceptedObservedCanonicalCommit =
				manager.getClientInput("client-b2")?.state === "completed" &&
				manager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" && entry.message.role === "user" && entry.clientMessageId === "client-b2",
					);
		};

		try {
			sendPrompt("client-b2", "Hello");

			await vi.waitFor(() => {
				const outcomes = getOutcomes(rpcIo.outputLines, "client-b2");
				expect(outcomes).toHaveLength(1);
				expect(outcomes[0]).toMatchObject({ type: "accepted", intentId: "client-b2", ordinals: expect.any(Array) });
			});
			expect(acceptedObservedCanonicalCommit).toBe(true);
			const persisted = await loadPersistedSessionSnapshot(manager);
			expect(JSON.stringify(persisted.entries)).toContain('"clientMessageId":"client-b2"');
			// The subscriber receives the user message entry with its client message id.
			await vi.waitFor(() => {
				expect(getMessageEntries(rpcIo.outputLines, "user")).toMatchObject([
					{ entry: { payload: { clientMessageId: "client-b2" }, view: { clientMessageId: "client-b2" } } },
				]);
			});
		} finally {
			await cleanup();
			if (existsSync(sessionDir)) {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		}
	});

	it("accepts a retry after immediate teardown without dispatching the same durable input again", async () => {
		const sessionDir = join(tmpdir(), `volt-rpc-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(sessionDir, { recursive: true });
		const manager = await SessionManager.create(sessionDir, sessionDir);
		const sessionRef = manager.getSessionRef();
		if (!sessionRef) throw new Error("expected a persisted session reference");
		const clientMessageId = "client-success-crash";
		const message = "Commit before acknowledging";
		const first = await startRpcMode({
			withAuth: true,
			responseDelayMs: 250,
			sessionManager: manager,
		});
		let second: Awaited<ReturnType<typeof startRpcMode>> | undefined;

		try {
			sendPrompt(clientMessageId, message);
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, clientMessageId)).toMatchObject([{ type: "accepted" }]);
			});
			expect(manager.getClientInput(clientMessageId)?.state).toBe("completed");
			expect(first.getStreamCallCount()).toBe(1);
			await first.cleanup();

			rpcIo.outputLines = [];
			rpcIo.lineHandler = undefined;
			const reopened = await SessionManager.open(sessionRef, sessionDir);
			second = await startRpcMode({ withAuth: true, responseDelayMs: 0, sessionManager: reopened });
			sendPrompt(clientMessageId, message);
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, clientMessageId)).toMatchObject([{ type: "accepted" }]);
			});
			expect(second.getStreamCallCount()).toBe(0);
			expect(
				reopened
					.getConversationState()
					.context.messages.filter((entry) => getClientMessageId(entry) === clientMessageId),
			).toHaveLength(1);
		} finally {
			await first.cleanup();
			await second?.cleanup();
			if (existsSync(sessionDir)) {
				rmSync(sessionDir, { recursive: true, force: true });
			}
		}
	});

	it("shows a busy phase while the prompt waits in preflight, before the provider streams", async () => {
		let releaseInput: () => void = () => undefined;
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		let notifyInputStarted: () => void = () => undefined;
		const inputStarted = new Promise<void>((resolve) => {
			notifyInputStarted = resolve;
		});
		const { cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async () => {
					notifyInputStarted();
					await inputRelease;
					return { action: "handled" };
				};
			},
		});

		try {
			sendPrompt("client-busy", "Wait in preflight");
			await inputStarted;
			await vi.waitFor(() => {
				const phases = parseOutputLines(rpcIo.outputLines).flatMap((record) =>
					record.type === "live"
						? (record.items as Array<Record<string, unknown>>).filter(
								(item) => item.type === "set" && item.key === "phase",
							)
						: [],
				);
				expect(phases.at(-1)).toMatchObject({ value: { kind: "phase", busy: true } });
			});
			const streamed = parseOutputLines(rpcIo.outputLines).some(
				(record) =>
					record.type === "live" &&
					(record.items as Array<Record<string, unknown>>).some((item) => item.type === "assistant_start"),
			);
			expect(streamed).toBe(false);
		} finally {
			releaseInput();
			await cleanup();
		}
	});

	it("accepts handled identified prompts without a canonical row", async () => {
		const { sessionManager, getStreamCallCount, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async () => ({ action: "handled" });
			},
		});

		try {
			sendPrompt("client-handled", "Handled without a model turn");

			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-handled")).toMatchObject([{ type: "accepted" }]);
			});
			expect(sessionManager.getClientInput("client-handled")).toMatchObject({ state: "completed" });
			expect(sessionManager.getClientInput("client-handled")?.canonicalEntryId).toBeUndefined();
			expect(getStreamCallCount()).toBe(0);
			expect(getMessageEntries(rpcIo.outputLines, "user")).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("joins concurrent retries of one input into one dispatch and accepts each", async () => {
		let releaseInput!: () => void;
		let markInputStarted!: () => void;
		const inputRelease = new Promise<void>((resolve) => {
			releaseInput = resolve;
		});
		const inputStarted = new Promise<void>((resolve) => {
			markInputStarted = resolve;
		});
		const { cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			configureSession: (session) => {
				const runner = session.extensionRunner;
				const hasHandlers = runner.hasHandlers.bind(runner);
				runner.hasHandlers = (eventType) => eventType === "input" || hasHandlers(eventType);
				runner.emitInput = async (text, images) => {
					markInputStarted();
					await inputRelease;
					return { action: "transform", text, images };
				};
			},
		});

		try {
			sendPrompt("client-concurrent-retry", "One dispatch");
			await inputStarted;
			sendPrompt("client-concurrent-retry", "One dispatch");
			releaseInput();

			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-concurrent-retry")).toMatchObject([
					{ type: "accepted" },
					{ type: "accepted" },
				]);
			});
			await vi.waitFor(() => {
				expect(getMessageEntries(rpcIo.outputLines, "user")).toHaveLength(1);
				expect(getMessageEntries(rpcIo.outputLines, "assistant")).toHaveLength(1);
			});
		} finally {
			releaseInput();
			await cleanup();
		}
	});

	it("accepts a prompt queued while the agent streams", async () => {
		const { cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			sendPrompt("client-b3-start", "Start");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-b3-start")).toHaveLength(1);
			});

			sendPrompt("client-b3", "Queue this", { streamingBehavior: "followUp" });

			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-b3")).toMatchObject([{ type: "accepted" }]);
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("accepts completed retries without replaying the turn and rejects a conflicting reuse", async () => {
		const { cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			sendPrompt("client-retry-complete", "Only once");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-retry-complete")).toMatchObject([{ type: "accepted" }]);
				expect(getMessageEntries(rpcIo.outputLines, "assistant")).toHaveLength(1);
			});

			sendPrompt("client-retry-complete", "Only once");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-retry-complete")).toMatchObject([
					{ type: "accepted" },
					{ type: "accepted" },
				]);
			});

			sendPrompt("client-retry-complete", "Different input");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-retry-complete").at(-1)).toMatchObject({
					type: "rejected",
					reason: { code: "conflict", message: expect.stringContaining("client_input_conflict") },
				});
			});

			expect(getMessageEntries(rpcIo.outputLines, "user")).toHaveLength(1);
			expect(getMessageEntries(rpcIo.outputLines, "assistant")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("rejects a retried durable prompt failure the same way", async () => {
		const { cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "failed-replay-model",
				name: "Failed Replay Model",
				api: "openai-completions",
				provider: "failed-replay-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			sendPrompt("client-retry-failed", "Cannot dispatch");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-retry-failed")).toMatchObject([
					{ type: "rejected", reason: { message: expect.stringContaining("No API key found") } },
				]);
			});

			sendPrompt("client-retry-failed", "Cannot dispatch");
			await vi.waitFor(() => {
				expect(getOutcomes(rpcIo.outputLines, "client-retry-failed")).toMatchObject([
					{ type: "rejected" },
					{ type: "rejected", reason: { message: expect.stringContaining("No API key found") } },
				]);
			});

			expect(getMessageEntries(rpcIo.outputLines, "user")).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});
});
