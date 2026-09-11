import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
} from "../../../src/core/remote/iroh/access-grant.ts";
import { createIrohRemoteOutboundFilteredRpcTransport } from "../../../src/core/remote/iroh/outbound-filter.ts";
import { createIrohRemoteFilteredRpcTransport } from "../../../src/core/remote/iroh/rpc-transport.ts";
import type { ConversationProjectionSubscription } from "../../../src/core/rpc/conversation-projection-feed.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/loopback-transport.ts";
import { buildRpcSessionState } from "../../../src/core/rpc/session-state.ts";
import type { RpcConversationAuthority } from "../../../src/core/rpc/types.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import type { RpcClientEvent } from "../../../src/modes/rpc/rpc-client-base.ts";
import { type RpcModeOptions, runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
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
const workers: Array<ReturnType<typeof deferred>> = [];
const connections: Array<() => Promise<void>> = [];

function services(harness: Harness): AgentSessionServices {
	return {
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
	};
}

async function setup() {
	const executions = new Map<string, { signal?: AbortSignal; output(text: string): void; finish(): void }>();
	const operations: BashOperations = {
		exec: async (command, _cwd, options) => {
			const finish = deferred();
			workers.push(finish);
			executions.set(command, {
				signal: options.signal,
				output: (text) => options.onData(Buffer.from(text)),
				finish: finish.resolve,
			});
			options.onData(Buffer.from(`output for ${command}\n`));
			await finish.promise;
			if (options.signal?.aborted) throw new Error("worker cancelled");
			return { exitCode: 0 };
		},
	};
	const original = nativeTools.createAllToolDefinitions;
	vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
		original(cwd, { ...options, bash: { ...options?.bash, operations } }),
	);
	const options = {
		initialActiveToolNames: ["bash", "jobs"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false }, retry: { enabled: false } },
	};
	const harness = await createHarness(options);
	harnesses.push(harness);
	harness.session.setSessionName("RPC Jobs test");
	const runtime = new AgentSessionRuntime(harness.session, services(harness), async ({ sessionManager }) => {
		const next = await createHarness({ ...options, sessionManager });
		harnesses.push(next);
		return {
			session: next.session,
			services: services(next),
			diagnostics: [],
			extensionsResult: next.session.resourceLoader.getExtensions(),
		};
	});
	runtimes.push(runtime);
	return { harness, runtime, executions };
}

async function connect(runtime: AgentSessionRuntime, ordered = false, observeOnly = false) {
	const pair = createLoopbackRpcTransportPair();
	const frames: object[] = [];
	const detachValues = pair.client.onValue!((value) => {
		frames.push(value as object);
	});
	const outbound = createIrohRemoteOutboundFilteredRpcTransport({
		transport: pair.server,
		workspacePath: runtime.cwd,
	});
	let subscription: ConversationProjectionSubscription | undefined;
	if (ordered) {
		subscription = runtime.conversationProjectionFeed.attach({
			write: (value) => outbound.write(value),
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
	}
	const grant = observeOnly
		? createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant
		: createIrohRemotePresetAccess("coding").rpcGrant;
	const transport = ordered
		? createIrohRemoteFilteredRpcTransport({
				transport: outbound,
				rpcGrant: grant,
				writeRejectedResponse: (value) => subscription!.enqueueControl(value),
			})
		: pair.server;
	const binding: RpcModeOptions["orderedConversation"] = subscription
		? {
				get subscriptionId() {
					return subscription!.subscriptionId;
				},
				get branchEpoch() {
					return subscription!.branchEpoch;
				},
				subscribeAuthorityChanges: (listener) => subscription!.subscribeAuthorityChanges(listener),
				enqueueControl: (value) => subscription!.enqueueControl(value),
				requestCheckpoint: (command) =>
					subscription!.requestCheckpoint({
						requestId: command.id,
						lastAppliedCursor: command.lastAppliedCursor,
						reason: command.reason,
						assistantPosition: command.assistantPosition,
					}),
				publishExternal: (event) => runtime.conversationProjectionFeed.publishExternal(event),
			}
		: undefined;
	const ready = deferred();
	const mode = runRpcMode(runtime, {
		transport,
		onReady: ready.resolve,
		disposeRuntimeOnClose: false,
		orderedConversation: binding,
		requireConversationAuthority: ordered,
	});
	await Promise.race([ready.promise, mode]);
	const client = new RpcTransportClient({ transport: pair.client });
	await client.start();
	const events: RpcClientEvent[] = [];
	client.onEvent((event) => events.push(event));
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		subscription?.detach();
		detachValues();
		await client.stop();
		await mode;
	};
	connections.push(close);
	return {
		client,
		events,
		frames,
		close,
		subscription,
		authority(): RpcConversationAuthority {
			return {
				sessionId: runtime.session.sessionId,
				subscriptionId: subscription!.subscriptionId,
				branchEpoch: subscription!.branchEpoch,
			};
		},
	};
}

async function startJob(harness: Harness, command = "first") {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command, background: true }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Foreground finished."),
	]);
	await harness.session.prompt(`Launch ${command}`);
	return harness.session.backgroundJobs.list().find((job) => job.label === command)!;
}

afterEach(async () => {
	for (const worker of workers.splice(0)) worker.resolve();
	for (const close of connections.splice(0)) await close();
	for (const runtime of runtimes.splice(0)) await runtime.dispose();
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("RPC background jobs", () => {
	it("lists and reads live output after foreground settlement without consuming results or running inference", async () => {
		const { harness, runtime, executions } = await setup();
		const rpc = await connect(runtime);
		const job = await startJob(harness);
		const state = await rpc.client.getState();
		expect(state).toMatchObject({
			isStreaming: false,
			isBusy: false,
			backgroundJobs: [{ id: job.id, status: "running" }],
		});
		expect(state.backgroundJobs[0]).not.toHaveProperty("output");
		expect((await rpc.client.listJobs()).jobs).toEqual(state.backgroundJobs);
		expect((await rpc.client.readJob(job.id)).job.output).toContain("output for first");
		executions.get("first")!.output("\u001b[31mnew output\u001b[0m\r\n\u0000");
		await vi.waitFor(() => expect(rpc.events.some((event) => event.type === "background_jobs_changed")).toBe(true));
		await vi.waitFor(async () => expect((await rpc.client.readJob(job.id)).job.output).toContain("new output\n"));
		expect((await rpc.client.readJob(job.id)).job.output).not.toContain("\u001b");
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		const completed = await rpc.client.readJob(job.id);
		expect(completed.job.status).toBe("completed");
		expect(await rpc.client.readJob(job.id)).toEqual(completed);
		expect(harness.session.backgroundJobs.listUncollected()).toHaveLength(1);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("cancels only one job and reports cancelling until cleanup finishes", async () => {
		const { harness, runtime, executions } = await setup();
		const rpc = await connect(runtime);
		const first = await startJob(harness);
		const second = await startJob(harness, "second");
		expect((await rpc.client.cancelJob(first.id)).job.status).toBe("cancelling");
		expect(executions.get("first")!.signal?.aborted).toBe(true);
		expect(executions.get("second")!.signal?.aborted).toBe(false);
		expect((await rpc.client.readJob(first.id)).job.status).toBe("cancelling");
		executions.get("first")!.finish();
		await vi.waitFor(async () => expect((await rpc.client.readJob(first.id)).job.status).toBe("cancelled"));
		expect((await rpc.client.readJob(second.id)).job.status).toBe("running");
		expect((await rpc.client.cancelJob(first.id)).job.status).toBe("cancelled");
	});

	it("keeps the native cancel action enabled while only jobs remain", async () => {
		const { harness, runtime, executions } = await setup();
		const rpc = await connect(runtime);
		await startJob(harness);
		expect((await rpc.client.getUiActions()).find((action) => action.id === "run.cancel")?.enabled).toBe(true);
		const cancel = rpc.client.invokeUiAction("run.cancel");
		await vi.waitFor(() => expect(executions.get("first")!.signal?.aborted).toBe(true));
		executions.get("first")!.finish();
		await expect(cancel).resolves.toMatchObject({ status: "completed" });
		expect((await rpc.client.getUiActions()).find((action) => action.id === "run.cancel")?.enabled).toBe(false);
	});

	it.each(["jobs", "bash"])("hides and rejects jobs when the %s tool grant is removed", async (removed) => {
		const { harness, runtime, executions } = await setup();
		const rpc = await connect(runtime);
		const job = await startJob(harness);
		harness.session.setActiveToolsByName(["bash", "jobs"].filter((name) => name !== removed));
		expect((await rpc.client.listJobs()).jobs).toEqual([]);
		expect((await rpc.client.getState()).backgroundJobs).toEqual([]);
		await expect(rpc.client.readJob(job.id)).rejects.toThrow("inaccessible");
		await expect(rpc.client.cancelJob(job.id)).rejects.toThrow("inaccessible");
		expect(executions.get("first")!.signal?.aborted).toBe(true);
	});

	it("reconnects to retained jobs and publishes metadata to both ordered subscribers", async () => {
		const { harness, runtime, executions } = await setup();
		const job = await startJob(harness);
		const first = await connect(runtime, true);
		const second = await connect(runtime, true, true);
		for (const rpc of [first, second]) {
			expect(rpc.frames[0]).toMatchObject({
				type: "conversation_bootstrap",
				state: { backgroundJobs: [{ id: job.id }] },
			});
			expect((await rpc.client.readJob(job.id)).job.status).toBe("running");
		}
		const denied = await connect(runtime, true, true);
		await expect(denied.client.cancelJob(job.id, { conversationAuthority: denied.authority() })).rejects.toThrow();
		await denied.close();
		expect(executions.get("first")!.signal?.aborted).toBe(false);
		await first.close();
		expect(harness.session.hasBackgroundJobs).toBe(true);
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		await vi.waitFor(() =>
			expect(second.events).toContainEqual(
				expect.objectContaining({
					type: "background_jobs_changed",
					jobs: [expect.objectContaining({ id: job.id, status: "completed" })],
				}),
			),
		);
		const update = second.events.find((event) => event.type === "background_jobs_changed");
		expect(update).toHaveProperty("delivery");
		if (update?.type === "background_jobs_changed") expect(update.jobs[0]).not.toHaveProperty("output");
		const third = await connect(runtime, true);
		expect(third.frames[0]).toMatchObject({ state: { backgroundJobs: [{ id: job.id, status: "completed" }] } });
	});

	it("requires the current ordered subscription authority before cancelling a job", async () => {
		const { harness, runtime, executions } = await setup();
		const job = await startJob(harness);
		const first = await connect(runtime, true);
		const second = await connect(runtime, true);
		await expect(first.client.cancelJob(job.id)).rejects.toThrow("authority is stale");
		await expect(first.client.cancelJob(job.id, { conversationAuthority: second.authority() })).rejects.toThrow(
			"authority is stale",
		);
		const stale = first.authority();
		runtime.conversationProjectionFeed.rotateForBranchRebase();
		await first.subscription!.flush();
		await expect(first.client.cancelJob(job.id, { conversationAuthority: stale })).rejects.toThrow(
			"authority is stale",
		);
		expect(executions.get("first")!.signal?.aborted).toBe(false);
		await expect(first.client.cancelJob(job.id, { conversationAuthority: first.authority() })).resolves.toMatchObject(
			{ branchEpoch: first.authority().branchEpoch, job: { status: "cancelling" } },
		);
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		expect((await first.client.readJob(job.id)).job.status).toBe("cancelled");
	});

	it("bounds multibyte output reads without putting the output into state", async () => {
		const { harness, runtime, executions } = await setup();
		const job = await startJob(harness);
		const rpc = await connect(runtime, true);
		executions.get("first")!.output("界".repeat(25_000));
		// Native Bash coalesces progress before it reaches the job manager.
		await vi.waitFor(() => expect(harness.session.backgroundJobs.get(job.id).outputTruncated).toBe(true));
		const snapshot = (await rpc.client.readJob(job.id)).job;
		expect(snapshot.outputTruncated).toBe(true);
		expect(Buffer.byteLength(snapshot.output, "utf8")).toBeLessThanOrEqual(50 * 1024);
		expect(snapshot.output).not.toContain("\ufffd");
		expect((await rpc.client.getState()).backgroundJobs[0]).not.toHaveProperty("output");
	});

	it("clears job handles on runtime replacement rather than reconstructing them from history", async () => {
		const { harness, runtime, executions } = await setup();
		const rpc = await connect(runtime);
		const job = await startJob(harness);
		executions.get("first")!.finish();
		await harness.session.waitForBackgroundJobs();
		await rpc.client.newSession();
		expect((await rpc.client.getState()).backgroundJobs).toEqual([]);
		await expect(rpc.client.readJob(job.id)).rejects.toThrow("inaccessible");
	});
});
