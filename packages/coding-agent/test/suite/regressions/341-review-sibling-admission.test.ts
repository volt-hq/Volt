import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import { registerReviewHandoffAliases } from "../../../src/core/review-links.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getCanonicalReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	type ControlEvent,
	type ControlResponse,
	createHelloProof,
	PROTOCOL_VERSION,
	type WorkerHostKind,
} from "../../../src/daemon/control-protocol.ts";
import { type WorkerDaemonClient, WorkerRequestError } from "../../../src/daemon/worker/daemon-client.ts";
import { WorkerConversations } from "../../../src/daemon/worker/hosted.ts";
import type { LaunchedWorker, WorkerExit, WorkerLaunchRequest } from "../../../src/daemon/worker-launcher.ts";
import { type LiveWorker, WorkerRegistry, type WorkerRegistryOptions } from "../../../src/daemon/worker-registry.ts";
import { openTestHost } from "../../utilities/host-client.ts";
import { anchorLiveReviewRun, anchorReviewRun } from "../../utilities/review-runs.ts";
import { createHarness } from "../harness.ts";

/**
 * Review finding discussions open beside their source, in the source's
 * conversation worker, each claimed from the daemon's worker registry
 * (`worker_hosts`, kind `sibling`) before it opens; an unloaded review source
 * is claimed for the length of a write. The registry here is the daemon's;
 * the worker is driven in this test, its conversations hosted by
 * `WorkerConversations` as `runWorker` hosts them.
 */

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

/** A worker process the registry launched: the test speaks its control connection. */
interface FakeLaunch {
	readonly request: WorkerLaunchRequest;
	readonly connectionId: string;
}

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-341-admission-"));
	const sessionDir = join(root, "sessions");
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			tools: ["read"],
			disableMcp: true,
		});
		return {
			...created,
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				gitContextProvider: created.session.gitContextProvider,
				releaseGitContextProvider: () => {},
				diagnostics: [],
			},
			diagnostics: [],
		};
	};

	// The daemon's registry, its workers launched by the test.
	const generations = new Map<string, number>([["ws", 1]]);
	const launches: FakeLaunch[] = [];
	const exits: Array<(exit: WorkerExit) => void> = [];
	const registryOptions: WorkerRegistryOptions & {
		sessionInWorkspace(workspaceName: string, sessionId: string): Promise<boolean>;
	} = {
		launcher: {
			launch(request: WorkerLaunchRequest): LaunchedWorker {
				const exited = Promise.withResolvers<WorkerExit>();
				launches.push({ request, connectionId: `worker-connection-${launches.length + 1}` });
				exits.push(exited.resolve);
				return { pid: 4242, exited: exited.promise, kill: () => exited.resolve({ reason: "crashed" }) };
			},
		},
		agentDir: root,
		socketPath: () => join(root, "voltd.sock"),
		sendTo: (_connectionId: string, _event: ControlEvent) => true,
		currentGeneration: (workspaceName: string) => generations.get(workspaceName),
		detachedRuntimeTtlMs: () => 60_000,
		// Every claim here names a session of the workspace's store.
		sessionInWorkspace: async () => true,
		audit: () => {},
	};
	const registry = new WorkerRegistry(registryOptions);
	let requestId = 0;
	const send = async (connectionId: string, request: Record<string, unknown>): Promise<ControlResponse> =>
		registry.handleWorkerRequest(connectionId, { ...request, id: `${++requestId}` } as Parameters<
			WorkerRegistry["handleWorkerRequest"]
		>[1]);

	/**
	 * Spawn a worker for `ref`, as a phone's open does: launched, admitted, and
	 * ready; with `attached`, the phone stays attached to it.
	 */
	const spawn = async (
		ref: SessionReference,
		options: { attached?: boolean } = {},
	): Promise<{ launch: FakeLaunch; worker: LiveWorker; exit: (exit: WorkerExit) => void }> => {
		const index = launches.length;
		const generation = generations.get("ws") ?? 0;
		const opening = registry.open(
			{ workspaceName: "ws", workspaceGeneration: generation, sessionId: ref.sessionId },
			{
				origin: "phone",
				prepare: async () => ({
					origin: "phone",
					workspace: { name: "ws", path: root, generation },
					session: ref,
					cwd: root,
					root,
					projectCwd: root,
					toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
					projectTrusted: false,
				}),
				attach: (worker) => {
					if (options.attached) worker.attach("remote");
					return worker;
				},
			},
		);
		await waitUntil(() => launches.length > index);
		const launch = launches[index]!;
		const binding = { challenge: "C".repeat(43), socketPath: "/tmp/voltd-test.sock" };
		const admitted = registry.admitWorker(
			{
				type: "hello",
				role: "worker",
				protocolVersion: PROTOCOL_VERSION,
				workerId: launch.request.workerId,
				workerProof: createHelloProof("worker", launch.request.workerToken, binding),
				pid: 4242,
				version: "test",
			},
			binding,
			launch.connectionId,
		);
		if (!admitted) throw new Error("The worker was not admitted");
		expect(await send(launch.connectionId, { type: "worker_ready", sessionIds: [ref.sessionId] })).toMatchObject({
			type: "ok",
		});
		return { launch, worker: await opening, exit: exits[index]! };
	};

	// The source conversation, in the worker a phone's open spawned for it.
	const sourceManager = await SessionManager.create(root, sessionDir);
	const sourceRef = sourceManager.getSessionRef()!;
	const { launch, worker } = await spawn(sourceRef);
	const source = await openTestHost(factory, {
		sessionManager: sourceManager,
		cwd: root,
		agentDir: root,
		extensionMode: "rpc",
		whenUnattached: "keep",
	});
	// The worker's daemon client: its claims and releases are the registry's requests.
	const claim = async (sessionId: string, kind: WorkerHostKind, parentSessionId?: string) => {
		const response = await send(launch.connectionId, {
			type: "worker_hosts",
			sessionId,
			kind,
			...(parentSessionId === undefined ? {} : { parentSessionId }),
		});
		if (response.type === "error") throw new WorkerRequestError(response.code, response.message);
		return response;
	};
	const release = async (sessionId: string) => {
		const response = await send(launch.connectionId, { type: "worker_released", sessionId });
		if (response.type === "error") throw new WorkerRequestError(response.code, response.message);
		return response;
	};
	const client = {
		hosts: vi.fn(claim),
		released: vi.fn(release),
		changeObserve: vi.fn(async (): Promise<ControlResponse> => ({ type: "ok", id: "observed" })),
	};
	const hosted = new WorkerConversations({
		client: client as unknown as WorkerDaemonClient,
		workspaceName: "ws",
		log: () => {},
	});
	hosted.adoptPrimary(source.host, source.conversation);

	const record: ReviewRunRecord = {
		schemaVersion: 1,
		runId: "run",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "revision",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "findings",
			overallExplanation: "evidence",
			findings: [1, 2, 3, 4].map((n) => ({
				id: `f${n}`,
				fingerprint: `fp${n}`,
				status: "open",
				title: `Finding ${n}`,
				body: "evidence",
				trigger: "input",
				impact: "wrong",
				category: "correctness",
				rootCauseKey: `cause${n}`,
				priority: 2,
				confidence: 1,
				changeLocation: { path: "file.ts", side: "head", startLine: 1, endLine: 1 },
				evidenceLocations: [],
				verification: { outcome: "accepted", method: "read", rationale: "evidence", confidence: 1 },
			})),
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
		},
	};
	await anchorLiveReviewRun(source.conversation.session, record.runId);
	await appendReviewRunDurably(source.conversation.session.sessionWriter, record);
	cleanups.push(async () => {
		hosted.beginStopping();
		await source.host.dispose();
		for (const exit of exits) exit({ reason: "stopped" });
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		sessionDir,
		factory,
		registry,
		generations,
		launches,
		spawn,
		worker,
		source,
		hosted,
		client,
		claim,
		/** The source's review discussion service, as the worker serves it. */
		reviews: hosted.reviewDiscussions(source.conversation),
		harness,
		record,
	};
}

describe("Regression #341 review siblings claimed in the source's worker", () => {
	it("opens four discussions as claimed siblings in the source's worker without replacing the source", async () => {
		const f = await fixture();
		f.harness.setResponses([1, 2, 3, 4].map(() => fauxAssistantMessage("answer")));
		const result = await f.reviews.start("run", ["f1", "f2", "f3", "f4"], "start");
		expect(result.results.every((row) => row.outcome === "created")).toBe(true);
		const ids = result.results.map((row) => row.discussion!.sessionId);
		const [status] = f.registry.list();
		expect(status!.sessionIds).toHaveLength(5);
		expect(status!.sessionIds).toEqual(expect.arrayContaining([f.source.conversation.id, ...ids]));
		for (const row of result.results) {
			const id = row.discussion!.sessionId;
			expect(f.registry.host("ws", id)).toEqual({ workerId: f.worker.workerId, kind: "sibling" });
			const child = f.hosted.get(id)!;
			expect(child.kind).toBe("sibling");
			expect(child.host).toBe(f.source.host);
			const session = child.conversation.session;
			expect(session.sessionManager.getSessionName()).toBe(`Review: Finding ${row.findingId.slice(1)}`);
			await session.waitForIdle();
			expect(session.getActiveToolNames()).toEqual(["read"]);
			await session.setAgentMode("plan");
			await session.setAgentMode("build");
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(child.conversation.summary().reviewDiscussion).not.toHaveProperty("readOnly");
		}
		expect(f.hosted.primary.conversation).toBe(f.source.conversation);
		expect(f.launches).toHaveLength(1);
	});

	it("does not borrow conversation state from another worker", async () => {
		const f = await fixture();
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const first = (await f.reviews.start("run", ["f1"], "start")).results[0]!.discussion!;
		const local = f.hosted.get(first.sessionId)!;
		await local.conversation.session.waitForIdle();
		const ref = local.conversation.session.sessionRef!;
		await local.host.close(local.conversation);
		await vi.waitFor(() => expect(f.registry.host("ws", ref.sessionId)).toBeUndefined());
		// A phone's open of the discussion spawns a worker of its own for it.
		const other = await f.spawn(ref);
		expect(f.registry.host("ws", ref.sessionId)).toEqual({ workerId: other.worker.workerId, kind: "primary" });
		const foreign = await openTestHost(f.factory, {
			sessionManager: await SessionManager.open(ref),
			cwd: f.root,
			agentDir: f.root,
			extensionMode: "rpc",
			whenUnattached: "keep",
		});
		cleanups.push(() => foreign.host.dispose());
		const busy = vi.spyOn(foreign.conversation.session, "isBusy", "get").mockReturnValue(true);
		try {
			expect((await f.reviews.list("run")).discussions[0]!.status).toBe("completed");
		} finally {
			busy.mockRestore();
		}
	});

	it("fails a discussion whose claim the daemon refuses, opening nothing, and retries the same durable child", async () => {
		const f = await fixture();
		f.client.hosts.mockRejectedValueOnce(new WorkerRequestError("claimed", "another worker hosts that conversation"));
		const failed = await f.reviews.start("run", ["f1"], "start");
		expect(failed.results[0]!.outcome).toBe("failed");
		const id = failed.results[0]!.discussion!.sessionId;
		expect(f.hosted.get(id)).toBeUndefined();
		expect(f.registry.host("ws", id)).toBeUndefined();
		f.harness.setResponses([fauxAssistantMessage("retry")]);
		const retried = await f.reviews.start("run", ["f1"], "retry");
		expect(retried.results[0]).toMatchObject({ outcome: "existing", discussion: { sessionId: id } });
		expect(f.registry.host("ws", id)).toEqual({ workerId: f.worker.workerId, kind: "sibling" });
		await f.hosted.get(id)!.conversation.session.waitForIdle();
	});

	it("refuses sibling claims once the workspace authority changed, leaking no claim", async () => {
		const f = await fixture();
		f.generations.set("ws", 2);
		const result = await f.reviews.start("run", ["f1"], "start");
		expect(result.results[0]!.outcome).toBe("failed");
		const id = result.results[0]!.discussion!.sessionId;
		expect(f.client.hosts.mock.settledResults).toEqual([
			{ type: "rejected", value: expect.objectContaining({ code: "fenced" }) },
		]);
		expect(f.hosted.get(id)).toBeUndefined();
		expect(f.registry.host("ws", id)).toBeUndefined();
		expect(f.registry.list()[0]!.sessionIds).toEqual([f.source.conversation.id]);
	});

	it("claims nothing once the worker stops", async () => {
		const f = await fixture();
		f.hosted.beginStopping();
		await expect(f.reviews.start("run", ["f1"], "start")).rejects.toThrow("ownership changed");
		expect(f.client.hosts).not.toHaveBeenCalled();
		expect(f.registry.list()[0]!.sessionIds).toEqual([f.source.conversation.id]);
	});

	it("releases the claim when the sibling fails to open, and retries the same durable child", async () => {
		const f = await fixture();
		vi.spyOn(f.source.host, "open").mockRejectedValueOnce(new Error("activation failed"));
		const result = await f.reviews.start("run", ["f1"], "start");
		expect(result.results[0]!.outcome).toBe("failed");
		const id = result.results[0]!.discussion!.sessionId;
		expect(f.client.released).toHaveBeenCalledWith(id);
		expect(f.hosted.get(id)).toBeUndefined();
		expect(f.registry.host("ws", id)).toBeUndefined();
		f.harness.setResponses([fauxAssistantMessage("retry")]);
		expect((await f.reviews.start("run", ["f1"], "retry")).results[0]!.outcome).toBe("existing");
		await f.hosted.get(id)!.conversation.session.waitForIdle();
	});

	it("does not seed a discussion another worker hosts", async () => {
		const f = await fixture();
		f.client.hosts.mockRejectedValueOnce(new WorkerRequestError("not_live", "the worker is not live"));
		const first = await f.reviews.start("run", ["f1"], "start");
		expect(first.results[0]!.outcome).toBe("failed");
		const id = first.results[0]!.discussion!.sessionId;
		const ref = await SessionManager.findForResume(f.sessionDir, id);
		// A phone opened the discussion first: a worker of its own hosts it, with the phone attached.
		const other = await f.spawn(ref!, { attached: true });
		const otherManager = await SessionManager.open(ref!);
		try {
			expect(otherManager.getEntries()).toHaveLength(0);
			expect((await f.reviews.start("run", ["f1"], "retry")).results[0]!.outcome).toBe("failed");
			expect(f.client.hosts.mock.settledResults.at(-1)).toEqual({
				type: "rejected",
				value: expect.objectContaining({ code: "claimed" }),
			});
			// Had the source's worker seeded the discussion, this writer's revision would be stale.
			await otherManager.logWriter.appendSessionInfo("The other worker owns initialization");
			expect(f.hosted.get(id)).toBeUndefined();
			expect(f.registry.host("ws", id)).toEqual({ workerId: other.worker.workerId, kind: "primary" });
		} finally {
			await otherManager.closePersistence();
		}
	});

	it("gives a pending sibling launch up and releases its claim when the worker stops", async () => {
		const f = await fixture();
		const claiming = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		f.client.hosts.mockImplementationOnce(async (sessionId, kind, parentSessionId) => {
			claiming.resolve();
			await proceed.promise;
			return f.claim(sessionId, kind, parentSessionId);
		});
		const starting = f.reviews.start("run", ["f1"], "start");
		await claiming.promise;
		const id = f.client.hosts.mock.calls[0]![0];
		f.hosted.beginStopping();
		proceed.resolve();
		expect((await starting).results[0]).toMatchObject({ outcome: "failed", errorCode: "launch_failed" });
		expect(f.hosted.get(id)).toBeUndefined();
		expect(f.client.released).toHaveBeenCalledWith(id);
		expect(f.registry.host("ws", id)).toBeUndefined();
	});

	it("keeps reset idle-only and hosts the reset child as a claimed sibling", async () => {
		const f = await fixture();
		let finishTurn!: () => void;
		f.harness.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					finishTurn = resolve;
				});
				return fauxAssistantMessage("answer");
			},
		]);
		const first = (await f.reviews.start("run", ["f1"], "start")).results[0]!.discussion!;
		await vi.waitFor(() => expect(finishTurn).toBeTypeOf("function"));
		expect((await f.reviews.reset(first.discussionId, first.sessionId, "busy-reset")).status).toBe("busy");
		finishTurn();
		await f.hosted.get(first.sessionId)!.conversation.session.waitForIdle();
		const reset = await f.reviews.reset(first.discussionId, first.sessionId, "reset");
		expect(reset.status).toBe("reset");
		const resetId = reset.discussion.currentSessionId;
		expect(resetId).not.toBe(first.sessionId);
		expect(f.registry.host("ws", resetId)).toEqual({ workerId: f.worker.workerId, kind: "sibling" });
		const child = f.hosted.get(resetId)!;
		expect(child.kind).toBe("sibling");
		expect(child.conversation.session.isBusy).toBe(false);
		expect(child.conversation.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
	});

	it("claims an unloaded canonical source for an outcome write, and leaves one another worker hosts", async () => {
		const f = await fixture();
		const canonical = await SessionManager.create(f.root, f.sessionDir);
		const canonicalRef = canonical.getSessionRef()!;
		const originalId = canonical.getSessionId();
		const coldRecord = { ...f.record, runId: "cold-run" };
		await anchorReviewRun(canonical, "cold-run");
		await appendReviewRunDurably(canonical.logWriter, coldRecord);
		await appendReviewRun(f.source.conversation.session.sessionWriter, coldRecord);
		await registerReviewHandoffAliases(canonical, f.source.conversation.session.sessionWriter, ["cold-run"]);
		await canonical.closePersistence();
		const open = SessionManager.open.bind(SessionManager);
		const writing = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		vi.spyOn(SessionManager, "open").mockImplementationOnce(async (ref, ...rest) => {
			writing.resolve();
			await proceed.promise;
			return open(ref, ...rest);
		});
		const recorded = f.reviews.recordOutcome({ runId: "cold-run", findingId: "f1", status: "fixed" });
		await writing.promise;
		// The write holds the source's claim: a phone's open of it reaches this worker, not a worker of its own.
		expect(f.registry.host("ws", originalId)).toEqual({ workerId: f.worker.workerId, kind: "sibling" });
		const routed = await f.registry.open(
			{ workspaceName: "ws", workspaceGeneration: 1, sessionId: originalId },
			{
				origin: "phone",
				prepare: () => Promise.reject(new Error("unexpected spawn")),
				attach: (worker) => worker.workerId,
			},
		);
		expect(routed).toBe(f.worker.workerId);
		proceed.resolve();
		await recorded;
		expect(f.client.released).toHaveBeenCalledWith(originalId);
		expect(f.registry.host("ws", originalId)).toBeUndefined();
		expect(
			(await getCanonicalReviewRun(f.source.conversation.session.sessionManager, "cold-run"))?.result?.findings[0]
				?.status,
		).toBe("fixed");
		// Once a worker of its own hosts the source with a client attached, this worker no longer writes it.
		const other = await f.spawn(canonicalRef, { attached: true });
		await expect(
			f.reviews.recordOutcome({ runId: "cold-run", findingId: "f1", status: "dismissed" }),
		).rejects.toMatchObject({ code: "claimed" });
		expect(f.registry.host("ws", originalId)).toEqual({ workerId: other.worker.workerId, kind: "primary" });
		expect(
			(await getCanonicalReviewRun(f.source.conversation.session.sessionManager, "cold-run"))?.result?.findings[0]
				?.status,
		).toBe("fixed");
		expect(f.launches).toHaveLength(2);
	});

	it("retires a detached, idle worker that keeps the canonical source, then writes the outcome", async () => {
		const f = await fixture();
		const canonical = await SessionManager.create(f.root, f.sessionDir);
		const canonicalRef = canonical.getSessionRef()!;
		const originalId = canonical.getSessionId();
		const coldRecord = { ...f.record, runId: "cold-run" };
		await anchorReviewRun(canonical, "cold-run");
		await appendReviewRunDurably(canonical.logWriter, coldRecord);
		await appendReviewRun(f.source.conversation.session.sessionWriter, coldRecord);
		await registerReviewHandoffAliases(canonical, f.source.conversation.session.sessionWriter, ["cold-run"]);
		await canonical.closePersistence();
		// The phone left the source's worker (a client move): detached and idle until its TTL runs.
		const other = await f.spawn(canonicalRef);

		const recorded = f.reviews.recordOutcome({ runId: "cold-run", findingId: "f1", status: "fixed" });
		// The claim retires that worker as its TTL would, and waits for its exit.
		await waitUntil(() =>
			f.registry.list().some((worker) => worker.workerId === other.worker.workerId && worker.state === "retiring"),
		);
		other.exit({ reason: "stopped" });
		await recorded;
		expect(f.client.released).toHaveBeenCalledWith(originalId);
		expect(f.registry.host("ws", originalId)).toBeUndefined();
		expect(
			(await getCanonicalReviewRun(f.source.conversation.session.sessionManager, "cold-run"))?.result?.findings[0]
				?.status,
		).toBe("fixed");
	});

	it("keeps the worker active while a sibling launch is pending, so a retention stop is refused", async () => {
		const f = await fixture();
		const claiming = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		f.client.hosts.mockImplementationOnce(async (sessionId, kind, parentSessionId) => {
			claiming.resolve();
			await proceed.promise;
			return f.claim(sessionId, kind, parentSessionId);
		});
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const starting = f.reviews.start("run", ["f1"], "start");
		await claiming.promise;
		// What `runWorker` reports to the registry and checks before it answers a stop.
		expect(f.hosted.active()).toBe(true);
		proceed.resolve();
		const result = await starting;
		expect(result.results[0]!.outcome).toBe("created");
		const child = f.hosted.get(result.results[0]!.discussion!.sessionId)!;
		await child.conversation.session.waitForIdle();
		await vi.waitFor(() => expect(f.hosted.active()).toBe(false));
	});

	it("routes a phone's open of a discussion being launched to the source's worker", async () => {
		const f = await fixture();
		const opening = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		const open = f.source.host.open.bind(f.source.host);
		vi.spyOn(f.source.host, "open").mockImplementationOnce(async (...args) => {
			opening.resolve();
			await proceed.promise;
			return open(...args);
		});
		f.harness.setResponses([fauxAssistantMessage("answer")]);
		const starting = f.reviews.start("run", ["f1"], "start");
		await opening.promise;
		const id = (await f.reviews.list("run")).discussions[0]!.sessionId;
		const routed = await f.registry.open(
			{ workspaceName: "ws", workspaceGeneration: 1, sessionId: id },
			{
				origin: "phone",
				prepare: () => Promise.reject(new Error("unexpected spawn")),
				attach: (worker) => worker.workerId,
			},
		);
		expect(routed).toBe(f.worker.workerId);
		proceed.resolve();
		const started = await starting;
		expect(started.results[0]!.outcome).toBe("created");
		await f.hosted.get(id)!.conversation.session.waitForIdle();
		expect(f.launches).toHaveLength(1);
	});
});
