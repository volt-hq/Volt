import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ConversationProjectionSubscription } from "../../../src/core/rpc/conversation-projection-feed.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/loopback-transport.ts";
import { buildRpcSessionState } from "../../../src/core/rpc/session-state.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../../../src/modes/rpc/rpc-transport-client.ts";
import { createHarness, type Harness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const harnesses: Harness[] = [];
const runtimes: AgentSessionRuntime[] = [];
const connections: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];

async function connect(runtime: AgentSessionRuntime) {
	const pair = createLoopbackRpcTransportPair();
	const frames: unknown[] = [];
	const unsubscribe = pair.client.onValue!((value) => {
		frames.push(value);
	});
	const subscription: ConversationProjectionSubscription = runtime.conversationProjectionFeed.attach({
		write: (value) => pair.server.write(value),
		buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
			conversation: { workspaceName: "workspace", sessionId: runtime.session.sessionId },
			state: buildRpcSessionState(runtime.session),
			transcript: {
				sessionId: runtime.session.sessionId,
				items: [],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch,
				head: null,
			},
			activeAssistant,
			activeWorkflows: [],
		}),
	});
	await subscription.ready;
	const ready = deferred();
	const mode = runRpcMode(runtime, {
		transport: pair.server,
		onReady: ready.resolve,
		disposeRuntimeOnClose: false,
		orderedConversation: {
			get subscriptionId() {
				return subscription.subscriptionId;
			},
			get branchEpoch() {
				return subscription.branchEpoch;
			},
			subscribeAuthorityChanges: (listener) => subscription.subscribeAuthorityChanges(listener),
			enqueueControl: (value) => subscription.enqueueControl(value),
			requestCheckpoint: (command) =>
				subscription.requestCheckpoint({
					requestId: command.id,
					lastAppliedCursor: command.lastAppliedCursor,
					reason: command.reason,
					assistantPosition: command.assistantPosition,
				}),
			publishExternal: (event) => runtime.conversationProjectionFeed.publishExternal(event),
		},
		requireConversationAuthority: true,
	});
	await Promise.race([ready.promise, mode]);
	const client = new RpcTransportClient({ transport: pair.client });
	await client.start();
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		subscription.detach();
		unsubscribe();
		await client.stop();
		await mode;
	};
	connections.push(close);
	return { client, frames, close, subscription };
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	vi.useRealTimers();
	for (const close of connections.splice(0)) await close();
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#421 authoritative timing on ordered reconnect", () => {
	it.each(["compaction", "retry"] as const)(
		"restores the operation during %s and after continuation",
		async (kind) => {
			let now = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const recovery = deferred();
			const releaseRecovery = deferred();
			const continued = deferred();
			const releaseContinuation = deferred();
			releases.push(releaseRecovery.resolve, releaseContinuation.resolve);
			const harness = await createHarness({
				tools: [],
				settings: {
					lsp: { enabled: false },
					compaction: { enabled: kind === "compaction", keepRecentTokens: 1 },
					retry: { enabled: kind === "retry", maxRetries: 1, baseDelayMs: 60_000 },
				},
				extensionFactories: [
					(volt) => {
						volt.on("session_before_compact", async (event) => {
							recovery.resolve();
							await releaseRecovery.promise;
							return {
								compaction: {
									summary: "Continue",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.setSessionName("Reconnect timing regression");
			const runtime = new AgentSessionRuntime(
				harness.session,
				{
					cwd: harness.tempDir,
					projectCwd: harness.tempDir,
					lexicalProjectCwd: harness.tempDir,
					agentDir: harness.tempDir,
					authStorage: harness.authStorage,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
					resourceLoader: harness.session.resourceLoader,
					gitContextProvider: harness.session.gitContextProvider,
					diagnostics: [],
				},
				async () => {
					throw new Error("No replacement expected");
				},
			);
			runtimes.push(runtime);
			const initial = await connect(runtime);
			harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start") {
					vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
					recovery.resolve();
				}
			});
			harness.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: kind === "compaction" ? "prompt is too long" : "overloaded_error",
				}),
				async () => {
					continued.resolve();
					await releaseContinuation.promise;
					return fauxAssistantMessage("recovered");
				},
			]);
			const prompt = harness.session.prompt("Keep the timer");
			await recovery.promise;
			await initial.subscription.flush();
			const startedAt = harness.eventsOfType("agent_start")[0]!.startedAt;
			expect(initial.frames).toContainEqual(expect.objectContaining({ type: "agent_start", startedAt }));
			await initial.close();
			now += 10_000;
			const during = await connect(runtime);
			expect(during.frames[0]).toMatchObject({
				type: "conversation_bootstrap",
				state: {
					activeAgentRun: { startedAt },
					isStreaming: true,
					isCompacting: kind === "compaction",
				},
			});
			expect(await during.client.getState()).toMatchObject({ activeAgentRun: { startedAt }, isStreaming: true });
			await during.close();
			if (kind === "retry") {
				await vi.advanceTimersByTimeAsync(60_000);
				vi.useRealTimers();
			} else releaseRecovery.resolve();
			await continued.promise;
			const after = await connect(runtime);
			expect(after.frames[0]).toMatchObject({
				type: "conversation_bootstrap",
				state: {
					activeAgentRun: { startedAt },
					isStreaming: true,
					isCompacting: false,
				},
			});
			expect(await after.client.getState()).toMatchObject({ activeAgentRun: { startedAt }, isStreaming: true });
			expect(harness.eventsOfType("agent_start").map((event) => event.startedAt)).toEqual([startedAt, startedAt]);
			releaseContinuation.resolve();
			await prompt;
			await after.subscription.flush();
			expect(after.frames).toContainEqual(expect.objectContaining({ type: "agent_settled" }));
			expect((await after.client.getState()).activeAgentRun).toBeUndefined();
			await after.close();
			const settled = await connect(runtime);
			expect(settled.frames[0]).toMatchObject({ type: "conversation_bootstrap", state: { isStreaming: false } });
			expect(settled.frames[0]).not.toHaveProperty("state.activeAgentRun");
		},
	);
});
