import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Message,
	type ProviderError,
} from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { type AgentSessionTestControl, createAgentSessionTestControl } from "./agent-session-test-control.ts";
import { createTestResourceLoader } from "./utilities.ts";

const compactionMockState = vi.hoisted(() => ({ firstKeptEntryId: undefined as string | undefined }));

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({
		summary: "compacted",
		firstKeptEntryId: compactionMockState.firstKeptEntryId ?? "missing-first-kept-entry",
		tokensBefore: 100,
		details: {},
	}),
	estimateTokens: (message: { content?: unknown }) => Math.ceil(JSON.stringify(message.content ?? "").length / 4),
	estimateMessagesTokens: (messages: Array<{ content?: unknown }>) =>
		messages.reduce((total, message) => total + Math.ceil(JSON.stringify(message.content ?? "").length / 4), 0),
	estimateContextTokens: (
		messages: Array<{
			role: string;
			content?: Array<{ type: string; text?: string; thinking?: string }>;
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
			stopReason?: string;
		}>,
	) => {
		const estimateMessageTokens = (message: (typeof messages)[number]) =>
			Math.ceil(
				(message.content ?? []).reduce(
					(chars, part) => chars + (part.text?.length ?? 0) + (part.thinking?.length ?? 0),
					0,
				) / 4,
			);
		// Walk backwards to find last non-error, non-aborted assistant with usage,
		// then include tool results and other messages appended after that request.
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant" && msg.stopReason !== "error" && msg.stopReason !== "aborted" && msg.usage) {
				const usageTokens =
					msg.usage.totalTokens ?? msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				const trailingTokens = messages
					.slice(i + 1)
					.reduce((total, message) => total + estimateMessageTokens(message), 0);
				return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: i };
			}
		}
		const tokens = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
		return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
	},
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: (branchEntries: Array<{ id: string }>) => {
		compactionMockState.firstKeptEntryId = branchEntries.at(-1)?.id;
		return { dummy: true };
	},
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
	) => settings.enabled && contextTokens > contextWindow - settings.reserveTokens,
}));

vi.mock("../src/core/compaction/context-compaction.ts", () => ({
	compactContext: async () => ({
		summary: "compacted",
		firstKeptEntryId: compactionMockState.firstKeptEntryId ?? "missing-first-kept-entry",
		tokensBefore: 100,
		details: {},
	}),
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

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

const model = getModel("anthropic", "claude-sonnet-4-5")!;

/** A response from the session's model with `totalTokens` of usage. */
function response(
	content: AssistantMessage["content"],
	options: {
		totalTokens?: number;
		stopReason?: AssistantMessage["stopReason"];
		error?: ProviderError;
		timestamp?: number;
	} = {},
): AssistantMessage {
	const totalTokens = options.totalTokens ?? 110;
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? (content.some((part) => part.type === "toolCall") ? "toolUse" : "stop"),
		...(options.error === undefined ? {} : { error: options.error }),
		timestamp: options.timestamp ?? Date.now(),
	};
}

type ResponseStep = AssistantMessage | (() => AssistantMessage | Promise<AssistantMessage>);

/** The text of a provider request message. */
function requestText(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("AgentSession auto-compaction queue resume", () => {
	let session: AgentSession;
	let control: AgentSessionTestControl;
	let sessionManager: SessionManager;
	let tempDir: string;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-auto-compaction-queue-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		vi.useFakeTimers();
	});

	afterEach(() => {
		if (session) session.dispose();
		vi.useRealTimers();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	/** Open the session over the entries `seed` appends first: structural writes are refused once it is live. */
	async function openSession(seed?: (manager: SessionManager) => Promise<void>): Promise<void> {
		sessionManager = SessionManager.inMemory();
		await seed?.(sessionManager);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = await AgentSession.create({
			sessionManager,
			model,
			thinkingLevel: "off",
			streamFn: modelRegistry.client.streamSimple,
			convertToLlm,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		control = createAgentSessionTestControl(session);
		events = [];
		session.subscribe((event) => {
			events.push(event);
		});
	}

	/** Answer provider requests with `steps` in order; records each request's message texts. */
	function useResponses(steps: ResponseStep[]): { calls(): number; requests: string[][] } {
		const requests: string[][] = [];
		control.setStreamFn((_model, context) => {
			const step = steps[Math.min(requests.length, steps.length - 1)]!;
			requests.push(context.messages.map(requestText));
			const stream = new MockAssistantStream();
			void (async () => {
				const message = typeof step === "function" ? await step() : step;
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({
					type: "done",
					seq: 1,
					reason:
						message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "length" ? "length" : "stop",
					message,
				});
			})();
			return stream;
		});
		return { calls: () => requests.length, requests };
	}

	/** Hold every `session_before_compact` until released; no other extension event runs. */
	function holdBeforeCompact(): { started: Promise<void>; release(): void } {
		const started = createDeferred();
		const finish = createDeferred();
		vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact",
		);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				started.resolve();
				await finish.promise;
			}
			return undefined;
		});
		return { started: started.promise, release: finish.resolve };
	}

	function compactionStarts(): string[] {
		return events.flatMap((event) => (event.type === "compaction_start" ? [event.reason] : []));
	}

	function hasCompactionEntry(): boolean {
		return sessionManager.getEntries().some((entry) => entry.type === "compaction");
	}

	it("should resume after threshold compaction when only host-queued messages exist", async () => {
		await openSession();
		const queueViews: Array<{ pending: number; queued: boolean }> = [];
		const stream = useResponses([
			async () => {
				await control.queueFollowUp({
					role: "custom",
					customType: "test",
					content: [{ type: "text", text: "Queued custom" }],
					display: false,
					timestamp: Date.now(),
				});
				queueViews.push({ pending: session.pendingMessageCount, queued: control.hasQueuedMessages() });
				return response([{ type: "text", text: "over the threshold" }], {
					totalTokens: model.contextWindow - 10_000,
				});
			},
			response([{ type: "text", text: "after compaction" }]),
		]);

		await session.prompt("compaction seed");
		await session.waitForIdle();

		// A host message projects no queue entry, yet it resumes the run after threshold compaction.
		expect(queueViews).toEqual([{ pending: 0, queued: true }]);
		expect(compactionStarts()).toEqual(["threshold"]);
		expect(hasCompactionEntry()).toBe(true);
		expect(stream.calls()).toBe(2);
		expect(stream.requests[1]?.some((text) => text.includes("compacted"))).toBe(true);
		expect(stream.requests[1]).toContain("Queued custom");
		expect(control.hasQueuedMessages()).toBe(false);
	});

	it("should continue after threshold compaction when a length stop has no visible response", async () => {
		await openSession();
		let streamCallCount = 0;

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callNumber === 1) {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "thinking", thinking: "still reasoning" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: model.contextWindow - 20_000,
							output: 10_000,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: model.contextWindow - 10_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "length",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
					stream.push({ type: "done", seq: 1, reason: "length", message });
					return;
				}

				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "continued" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});

		await session.prompt("trigger length continuation");

		expect(streamCallCount).toBe(2);
	});

	it("should compact mid-run when a turn with tool calls crosses the threshold", async () => {
		await openSession();
		let streamCallCount = 0;
		let streamCallsAtCompactionStart = -1;
		const agentEnds: string[] = [];
		const compactionContinuations: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") {
				streamCallsAtCompactionStart = streamCallCount;
			}
			if (event.type === "compaction_end") {
				compactionContinuations.push(event.willRetry);
			}
			if (event.type === "agent_end") {
				agentEnds.push(event.type);
			}
		});

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (callNumber === 1) {
					// Tool-call turn whose usage already exceeds the compaction threshold.
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing-file.txt" } }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: model.contextWindow - 20_000,
							output: 10_000,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: model.contextWindow - 10_000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
					stream.push({ type: "done", seq: 1, reason: "toolUse", message });
					return;
				}

				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "finished after compaction" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 100,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 110,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});

		await session.prompt("trigger proactive mid-run compaction");

		// Compaction ran between the tool-call turn and the continuation, not
		// after the full agent/tool loop finished.
		expect(streamCallsAtCompactionStart).toBe(1);
		expect(streamCallCount).toBe(2);
		expect(agentEnds).toHaveLength(2);
		expect(compactionContinuations).toEqual([true]);
		expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("should include newly appended tool results in proactive threshold checks", async () => {
		await openSession();
		writeFileSync(join(tempDir, "large-result.txt"), "x".repeat(40_000));
		let streamCallCount = 0;
		let streamCallsAtCompactionStart = -1;
		session.subscribe((event) => {
			if (event.type === "compaction_start") {
				streamCallsAtCompactionStart = streamCallCount;
			}
		});

		control.setStreamFn(() => {
			const callNumber = ++streamCallCount;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content:
						callNumber === 1
							? [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large-result.txt" } }]
							: [{ type: "text", text: "finished after tool-result compaction" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: callNumber === 1 ? model.contextWindow - 20_000 : 100,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: callNumber === 1 ? model.contextWindow - 20_000 : 100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: callNumber === 1 ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({
					type: "done",
					seq: 1,
					reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
					message,
				});
			});
			return stream;
		});

		await session.prompt("trigger compaction from a large tool result");

		expect(streamCallsAtCompactionStart).toBe(1);
		expect(streamCallCount).toBe(2);
	});

	it("should compact a terminating tool batch using its live tool-result context without resuming", async () => {
		await openSession();
		writeFileSync(join(tempDir, "large-terminating-result.txt"), "x".repeat(40_000));
		let streamCallCount = 0;
		control.onToolResult(async () => ({ disposition: "stop" }));
		control.setStreamFn(() => {
			streamCallCount += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "read",
							arguments: { path: "large-terminating-result.txt" },
						},
					],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: model.contextWindow - 20_000,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: model.contextWindow - 20_000,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "toolUse", message });
			});
			return stream;
		});

		await session.prompt("run terminating tool");

		expect(streamCallCount).toBe(1);
		expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("keeps session busy and waitForIdle pending during manual compaction", async () => {
		await openSession();
		control.setStreamFn(() => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "ready" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 10,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 11,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				};
				stream.push({ type: "start", seq: 0, snapshot: message, toolState: [] });
				stream.push({ type: "done", seq: 1, reason: "stop", message });
			});
			return stream;
		});
		await session.prompt("seed compaction history");

		const beforeCompactStarted = createDeferred();
		const finishBeforeCompact = createDeferred();
		vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact",
		);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_compact") {
				beforeCompactStarted.resolve();
				await finishBeforeCompact.promise;
			}
			return undefined;
		});

		const compaction = session.compact();
		await beforeCompactStarted.promise;
		expect(session.isBusy).toBe(true);
		let idleResolved = false;
		const idle = session.waitForIdle().then(() => {
			idleResolved = true;
		});
		await Promise.resolve();
		expect(idleResolved).toBe(false);

		finishBeforeCompact.resolve();
		await compaction;
		await idle;
		expect(idleResolved).toBe(true);
		expect(session.isBusy).toBe(false);
	});

	it("reports no continuation when session abort cancels proactive compaction", async () => {
		await openSession();
		const hold = holdBeforeCompact();
		// An empty length stop over the threshold compacts, then continues the run.
		const stream = useResponses([
			response([{ type: "thinking", thinking: "still reasoning" }], {
				totalTokens: model.contextWindow - 10_000,
				stopReason: "length",
			}),
			response([{ type: "text", text: "unexpected continuation" }]),
		]);
		const compactionEnds: Array<{ aborted: boolean; willRetry: boolean }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				compactionEnds.push({ aborted: event.aborted, willRetry: event.willRetry });
			}
		});

		const prompt = session.prompt("trigger length continuation");
		await hold.started;
		const abort = session.abort();
		hold.release();
		await abort;
		await prompt;
		await session.waitForIdle();

		expect(compactionEnds).toEqual([{ aborted: true, willRetry: false }]);
		expect(stream.calls()).toBe(1);
		expect(hasCompactionEntry()).toBe(false);
	});

	it("does not authorize queued continuation when abort lands during post-run compaction", async () => {
		await openSession();
		const hold = holdBeforeCompact();
		// A final response over the threshold compacts after the run.
		const stream = useResponses([
			response([{ type: "text", text: "done" }], { totalTokens: model.contextWindow - 10_000 }),
			response([{ type: "text", text: "unexpected continuation" }]),
		]);

		const prompt = session.prompt("finish over the threshold");
		await hold.started;
		const steerId = await control.queueSteer({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "retained" }],
			display: false,
			timestamp: Date.now(),
		});
		const abort = session.abort();
		hold.release();
		await abort;
		await prompt;
		await session.waitForIdle();

		// The abort revokes the continuation: the queued input stays queued, undelivered.
		expect(stream.calls()).toBe(1);
		expect(control.hasQueuedMessages()).toBe(true);
		expect(control.conversation.state.clientInputs.inputs.get(steerId)?.state).toBe("accepted");
		expect(stream.requests.flat()).not.toContain("retained");
	});

	it("should not continue after disposal during proactive compaction", async () => {
		await openSession();
		const hold = holdBeforeCompact();
		// A tool-call turn over the threshold stops for compaction before continuing.
		const stream = useResponses([
			response([{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "missing.txt" } }], {
				totalTokens: model.contextWindow - 10_000,
			}),
			response([{ type: "text", text: "unexpected continuation" }]),
		]);

		const promptPromise = session.prompt("trigger proactive compaction");
		await hold.started;
		session.dispose();
		hold.release();
		await promptPromise;
		await session.waitForClosed();

		expect(stream.calls()).toBe(1);
	});

	it("ends the run once when proactive compaction fails instead of continuing to churn", async () => {
		await openSession();
		vi.spyOn(session.extensionRunner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_compact",
		);
		vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) =>
			event.type === "session_before_compact" ? { cancel: true } : undefined,
		);
		const toolCall = () =>
			response([{ type: "toolCall", id: `call-${Date.now()}`, name: "read", arguments: { path: "x" } }], {
				totalTokens: model.contextWindow - 10_000,
			});
		const stream = useResponses([toolCall, toolCall, response([{ type: "text", text: "done" }])]);

		// The failed mandatory compaction rejects the prompt that ran the turn.
		await expect(session.prompt("cross the threshold")).rejects.toThrow(
			"Auto-compaction failed: Auto-compaction was cancelled by an extension",
		);
		await session.waitForIdle();

		// The threshold stopped the tool loop once; the failed compaction does not resume it.
		expect(compactionStarts()).toEqual(["threshold"]);
		expect(stream.calls()).toBe(1);
		expect(hasCompactionEntry()).toBe(false);
	});

	it("should not compact repeatedly after overflow recovery already attempted", async () => {
		await openSession();
		const overflow = () =>
			response([{ type: "text", text: "" }], {
				totalTokens: 0,
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
			});
		const stream = useResponses([overflow, overflow, response([{ type: "text", text: "unexpected" }])]);

		await session.prompt("overflow twice");
		await session.waitForIdle();

		// One compact-and-retry; the retried request overflows again and recovery stops.
		expect(compactionStarts()).toEqual(["overflow"]);
		expect(stream.calls()).toBe(2);
		expect(
			events.flatMap((event) =>
				event.type === "compaction_end"
					? [{ type: event.type, reason: event.reason, errorMessage: event.errorMessage }]
					: [],
			),
		).toContainEqual({
			type: "compaction_end",
			reason: "overflow",
			errorMessage:
				"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		});
	});

	it("should ignore stale pre-compaction assistant usage on pre-prompt compaction checks", async () => {
		const staleAssistantTimestamp = Date.now() - 10_000;
		const staleAssistant = response([{ type: "text", text: "large response before compaction" }], {
			totalTokens: 610_000,
			timestamp: staleAssistantTimestamp,
		});
		// The kept stale response is the branch tail the pre-prompt check reads.
		await openSession(async (manager) => {
			await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "before compaction" }],
				timestamp: staleAssistantTimestamp - 1000,
			});
			await manager.appendMessage(staleAssistant);
			const firstKeptEntryId = manager.getEntries()[0]!.id;
			await manager.appendCompaction(
				"summary",
				firstKeptEntryId,
				staleAssistant.usage.totalTokens,
				undefined,
				false,
			);
		});
		const stream = useResponses([response([{ type: "text", text: "answered" }])]);

		await session.prompt("session recovery payload");

		expect(compactionStarts()).toEqual([]);
		expect(stream.calls()).toBe(1);
	});

	it("should trigger threshold compaction for error messages using last successful usage", async () => {
		// A successful response near the context limit, then an error (e.g. 529 overloaded) with no usage.
		const successfulAssistant = response([{ type: "text", text: "large successful response" }], {
			totalTokens: model.contextWindow - 10_000,
		});
		const errorAssistant = response([{ type: "text", text: "" }], {
			totalTokens: 0,
			stopReason: "error",
			error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
			timestamp: Date.now() + 1000,
		});
		await openSession(async (manager) => {
			for (const message of [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "hello" }],
					timestamp: Date.now() - 1000,
				},
				successfulAssistant,
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: "another prompt" }],
					timestamp: Date.now() + 500,
				},
				errorAssistant,
			]) {
				await manager.appendMessage(message);
			}
		});
		const stream = useResponses([response([{ type: "text", text: "answered" }])]);

		await session.prompt("next");

		// The pre-prompt check compacts for the threshold without retrying the failed response.
		expect(compactionStarts()).toEqual(["threshold"]);
		expect(
			events.flatMap((event) => (event.type === "compaction_end" ? [[event.reason, event.willRetry]] : [])),
		).toEqual([["threshold", false]]);
		expect(hasCompactionEntry()).toBe(true);
		expect(stream.calls()).toBe(1);
	});

	it("should not trigger threshold compaction for error messages when no prior usage exists", async () => {
		// An error message with no prior successful assistant in context
		const errorAssistant = response([{ type: "text", text: "" }], {
			totalTokens: 0,
			stopReason: "error",
			error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
		});
		await openSession(async (manager) => {
			await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "hello" }],
				timestamp: Date.now() - 1000,
			});
			await manager.appendMessage(errorAssistant);
		});
		const stream = useResponses([response([{ type: "text", text: "answered" }])]);

		await session.prompt("next");

		expect(compactionStarts()).toEqual([]);
		expect(stream.calls()).toBe(1);
	});

	it("should not trigger threshold compaction for error messages when only kept pre-compaction usage exists", async () => {
		const preCompactionTimestamp = Date.now() - 10_000;
		// A "kept" assistant message from before compaction with high usage
		const keptAssistant = response([{ type: "text", text: "kept response from before compaction" }], {
			totalTokens: model.contextWindow - 10_000,
			timestamp: preCompactionTimestamp,
		});
		// A post-compaction error message, newer than the compaction
		const errorAssistant = response([{ type: "text", text: "" }], {
			totalTokens: 0,
			stopReason: "error",
			error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
			timestamp: Date.now() + 1000,
		});
		await openSession(async (manager) => {
			await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "before compaction" }],
				timestamp: preCompactionTimestamp - 1000,
			});
			await manager.appendMessage(keptAssistant);
			const firstKeptEntryId = manager.getEntries()[0]!.id;
			await manager.appendCompaction("summary", firstKeptEntryId, keptAssistant.usage.totalTokens, undefined, false);
			// Canonical context has only new post-compaction work after the summary.
			await manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "new prompt" }],
				timestamp: Date.now() + 500,
			});
			await manager.appendMessage(errorAssistant);
		});
		const stream = useResponses([response([{ type: "text", text: "answered" }])]);

		await session.prompt("next");

		// Should NOT compact because the only usage data is from a kept pre-compaction message
		expect(compactionStarts()).toEqual([]);
		expect(stream.calls()).toBe(1);
	});
});
