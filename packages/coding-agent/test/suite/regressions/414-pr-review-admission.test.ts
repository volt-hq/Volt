import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { openNewSession } from "../../../src/core/host/session-intents.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { readPrReviewBinding } from "../../../src/core/pr-review-binding.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { createEmptyIrohRemoteHostState, writeIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { prepareReviewWorkflow } from "../../../src/core/review.ts";
import { getReviewGeneral } from "../../../src/core/review-links.ts";
import { createReviewSeedMessage } from "../../../src/core/review-presentation.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { LogWriter } from "../../../src/core/session-writer.ts";
import { type ConversationOpenServices, resolveConversationOpen } from "../../../src/daemon/conversation-open.ts";
import { PrReviewCheckoutManager, type PrReviewPreparationRequest } from "../../../src/daemon/pr-review-checkout.ts";
import * as daemonSpawn from "../../../src/daemon/spawn.ts";
import type { WorkerDaemonClient } from "../../../src/daemon/worker/daemon-client.ts";
import { WorkerConversations } from "../../../src/daemon/worker/hosted.ts";
import type { WorkerSpawnInput } from "../../../src/daemon/worker-registry.ts";
import { WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { openTestHost } from "../../utilities/host-client.ts";
import { anchorLiveReviewRun } from "../../utilities/review-runs.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let gitSeed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	gitSeed = createPrReviewGitSeed("parent\n", "PR head");
});
afterAll(() => gitSeed?.dispose());

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	// The fixture's workers run in this process with its daemon, as `InProcessWorkerLauncher`
	// runs them: a worktree session's restoration takes the daemon's own preparation.
	vi.spyOn(daemonSpawn, "ensureDaemonRunning").mockResolvedValue({
		healthy: true,
		state: "healthy",
		spawned: false,
		socketPath: "unused",
		pid: process.pid,
	});
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** A conversation worker, as the daemon spawns one: its primary conversation, and those it claims beside it. */
interface TestWorker {
	readonly spec: WorkerSpawnInput;
	readonly host: ConversationHost;
	readonly conversation: HostedConversation;
	readonly hosted: WorkerConversations;
}

/** A worker's daemon client whose claims the daemon grants. */
function grantingDaemonClient(): WorkerDaemonClient {
	const ok = async () => ({ type: "ok" as const, id: "granted" });
	return { hosts: ok, released: ok, changeObserve: ok } as unknown as WorkerDaemonClient;
}

type ConversationTarget = Extract<IrohRemoteHello, { mode: "conversation" }>["conversation"];

async function fixture(nested = false, workspaceName = "project") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-414-admission-")));
	const workspace = { name: workspaceName, path: join(root, "workspace") };
	const source = nested ? join(workspace.path, "nested") : workspace.path;
	const remote = join(root, "remote.git");
	const { base, head } = gitSeed.copyTo(source, remote);
	const agentDir = join(root, "agent");
	const sessionDir = getDefaultSessionDir(workspace.path, agentDir);
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read,write",
		client: {
			nodeId: "phone",
			label: "phone",
			allowedWorkspaces: [workspace.name],
			allowedTools: "read,write",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 1,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace,
		workspaceGeneration: 1,
		workspaceNames: [workspace.name],
		workspaces: [{ name: workspace.name, status: "available" }],
	};
	const statePath = join(root, "state.json");
	await writeIrohRemoteHostState(statePath, {
		...createEmptyIrohRemoteHostState(),
		workspaces: [workspace],
		clients: [authorization.client],
		workspaceGenerationCounter: 1,
		workspaceGenerations: [{ workspaceName: workspace.name, generation: 1 }],
	});
	const audit = new IrohRemoteAuditLogger({ path: join(root, "audit.jsonl") });
	const target: ResolvedPullRequestCheckout = {
		pullRequest: {
			provider: "github",
			url: "https://github.com/owner/project/pull/414",
			number: 414,
			title: "PR",
			repository: "owner/project",
			headRefName: "topic",
			headRefOid: head,
		},
		repository: {
			providerId: "github",
			host: "github.com",
			owner: "owner",
			name: "project",
			canonicalId: "github:github.com/owner/project",
		},
		headRepository: {
			providerId: "github",
			host: "github.com",
			owner: "contributor",
			name: "fork",
			canonicalId: "github:github.com/contributor/fork",
		},
		remote: "origin",
		remoteUrl: remote,
		headRef: "refs/pull/414/head",
	};
	const provider = {
		...githubCliCodeHostProvider,
		resolvePullRequestCheckout: vi.fn(async () => ({ ok: true as const, target: structuredClone(target) })),
	};
	const request: PrReviewPreparationRequest = {
		sessionId: "review-414",
		number: "414",
		...(nested ? { workingDirectory: "nested" } : {}),
		expectedPullRequest: { url: target.pullRequest.url, headRefOid: head },
	};
	const authority = { workspaceGeneration: 1, assertCurrent: () => {} };
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			model: harness.getModel(),
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			tools: ["read", "write"],
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
	/** Every running worker of the fixture's daemons. */
	const workers = new Set<TestWorker>();
	const stop = async (worker: TestWorker) => {
		if (!workers.delete(worker)) return;
		worker.hosted.beginStopping();
		await worker.host.dispose();
	};
	/** A daemon on the fixture's state: it opens a phone's conversation as `relayToWorker` does. */
	function host() {
		const state = new IrohRemoteHostStateManager({ statePath });
		const worktrees = new WorktreeManager({ agentDir, stateManager: state, auditLogger: audit });
		const checkouts = new PrReviewCheckoutManager({
			agentDir,
			stateManager: state,
			worktrees,
			provider,
			hasActiveSession: (name, id) =>
				[...workers].some((worker) => worker.spec.workspace.name === name && worker.hosted.get(id) !== undefined),
		});
		const services: ConversationOpenServices = {
			agentDir,
			toolPolicy: () => ({ tools: ["read", "write"], allowUnlistedExtensionTools: false }),
			projectTrusted: () => true,
			resolveWorktree: async (name, hello, id) => {
				if (hello.mode === "conversation" && hello.conversation.target === "new") {
					return hello.conversation.worktreeId
						? worktrees.findWorktree(name, hello.conversation.worktreeId)
						: undefined;
				}
				return id ? worktrees.resolveSessionWorktree(name, id) : undefined;
			},
			resolveWorkingDirectory: async ({ workspace, worktree, workingDirectory }) => {
				const result = worktree
					? await worktrees.resolveWorktreeWorkingDirectory(workspace, worktree, workingDirectory)
					: await worktrees.validateWorkingDirectory(workspace, workingDirectory);
				if (!result.ok) throw new Error(result.error);
				return result.directory;
			},
			prepareWorktreeRuntime: (name, id, sessionId) => worktrees.beginRuntimePreparation(name, id, sessionId),
			preparePrReviewSession: (auth, hello, signal) =>
				checkouts.prepareSession(auth, hello, { ...authority, signal }),
			bindWorktreeSession: (name, id, sessionId) => worktrees.bindSession(name, id, sessionId),
		};
		const started: TestWorker[] = [];
		/** A worker opens the stored conversation its spawn names, with the spawn's cwd. */
		const openWorker = vi.fn(async (spec: WorkerSpawnInput): Promise<TestWorker> => {
			const opened = await openTestHost(factory, {
				sessionManager: await SessionManager.open(spec.session),
				cwd: spec.cwd,
				agentDir,
				extensionMode: "rpc",
				whenUnattached: "keep",
			});
			const hosted = new WorkerConversations({
				client: grantingDaemonClient(),
				workspaceName: spec.workspace.name,
				log: () => {},
			});
			hosted.adoptPrimary(opened.host, opened.conversation);
			const worker = { spec, ...opened, hosted };
			workers.add(worker);
			started.push(worker);
			return worker;
		});
		/** The daemon's half of the open: the target resolved read-only, then the spawn prepared. */
		async function open(conversation: ConversationTarget, signal?: AbortSignal) {
			const hello: IrohRemoteHello = {
				type: "volt_iroh_hello",
				protocol: "volt/1",
				workspace: workspace.name,
				mode: "conversation",
				conversation,
			};
			const resolved = await resolveConversationOpen(hello, authorization, services, signal);
			const spec = await resolved.prepare(authorization.workspaceGeneration!, signal);
			return { resolved, spec };
		}
		/** Open, and spawn the worker that hosts the conversation. */
		async function attach(conversation: ConversationTarget) {
			const opened = await open(conversation);
			return { ...opened, worker: await openWorker(opened.spec) };
		}
		async function stopAll() {
			for (const worker of started.splice(0)) await stop(worker);
		}
		return { state, worktrees, checkouts, openWorker, open, attach, stop, stopAll };
	}
	cleanups.push(async () => {
		for (const worker of [...workers]) await stop(worker);
		await harness.cleanupAsync();
		await audit.flush();
		// Windows can release a stopped Git command's hold on a worktree after it exited. Unlike
		// rmSync, which retries only a directory it found non-empty, rm retries that EBUSY.
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});
	return {
		source,
		base,
		head,
		sessionDir,
		workspace,
		harness,
		target,
		provider,
		request,
		authority,
		authorization,
		host,
	};
}

async function interruptedLaunch(f: Awaited<ReturnType<typeof fixture>>, persistBinding = false) {
	const host = f.host();
	const prepared = await host.checkouts.prepare(f.workspace, f.request, f.authority);
	vi.spyOn(host.checkouts, "bind").mockImplementationOnce(async (_workspace, writer, placement) => {
		if (persistBinding) {
			await writer.recordPrReviewBinding(placement);
		}
		throw new Error("interrupted launch");
	});
	await expect(
		host.open({
			target: "new",
			sessionId: prepared.sessionId,
			worktreeId: prepared.worktreeId,
			workingDirectory: prepared.workingDirectory,
		}),
	).rejects.toThrow("interrupted launch");
	expect(host.openWorker).not.toHaveBeenCalled();
	expect(host.worktrees.isRuntimePreparing(f.workspace.name, prepared.worktreeId)).toBe(false);
	const ref = await SessionManager.findForResume(f.sessionDir, prepared.sessionId);
	if (!ref) throw new Error("missing interrupted session");
	const record = (await host.state.listWorktrees(f.workspace.name))[0]!;
	expect(record.sessionIds).toEqual([]);
	expect(record.prReviewLaunches![0].sessionGeneration).toBeUndefined();
	return { prepared, ref, placement: record.prReviewLaunches![0].placement };
}

function reviewRecord(source: string, base: string, target: ResolvedPullRequestCheckout): ReviewRunRecord {
	const head = target.pullRequest.headRefOid;
	return {
		schemaVersion: 1,
		runId: "run-414",
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #414",
			diffCommand: "git diff main...topic",
			identity: {
				kind: "pr",
				baseCommit: base,
				headCommit: head,
				baseTree: git(source, "rev-parse", `${base}^{tree}`),
				headTree: git(source, "rev-parse", `${head}^{tree}`),
				pullRequest: {
					providerId: "github",
					number: 414,
					title: target.pullRequest.title,
					body: "",
					url: target.pullRequest.url,
					baseRefName: "main",
					headRefName: "topic",
					baseRefOid: base,
					headRefOid: head,
				},
			},
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "Finding",
			overallExplanation: "Evidence",
			findings: [
				{
					id: "f1",
					fingerprint: "fingerprint-414",
					status: "open",
					title: "Incorrect value",
					body: "Immutable evidence",
					trigger: "Read value",
					impact: "Wrong result",
					category: "correctness",
					rootCauseKey: "value",
					priority: 2,
					confidence: 0.9,
					changeLocation: { path: "value.txt", side: "head", startLine: 1, endLine: 1 },
					evidenceLocations: [],
					verification: { outcome: "accepted", method: "inspection", rationale: "Evidence", confidence: 0.9 },
				},
			],
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
}

describe("#414 PR review admission and worker spawn", () => {
	for (const nested of [false, true]) {
		it.each([
			{ target: "session", persistBinding: false },
			{ target: "last", persistBinding: false },
			{ target: "session", persistBinding: true },
			{ target: "last", persistBinding: true },
		] as const)(
			`recovers an interrupted launch before a worker opens it (nested: ${nested}): %j`,
			async ({ target, persistBinding }) => {
				const f = await fixture(nested);
				const { prepared, ref, placement } = await interruptedLaunch(f, persistBinding);
				f.authorization.client.lastSessionIdByWorkspace = { [f.workspace.name]: prepared.sessionId };
				const restarted = f.host();
				const { resolved, spec } = await restarted.open(
					target === "last" ? { target } : { target, sessionId: prepared.sessionId },
				);
				expect(resolved.selection.kind).toBe("resumed");
				expect(resolved.worktree?.id).toBe(prepared.worktreeId);
				expect(spec.session).toEqual(ref);
				expect(spec.cwd).toBe(placement.cwd);
				// A separate store reader sees the binding before any worker opens the conversation.
				const reader = await SessionManager.openReadOnly(ref);
				try {
					expect(await readPrReviewBinding(reader)).toEqual(placement);
				} finally {
					await reader.closePersistence();
				}
				const launch = (await restarted.state.listWorktrees())[0]!.prReviewLaunches![0];
				expect(launch).toMatchObject({ sessionGeneration: ref.sessionGeneration, storeId: ref.storeId });
				const { conversation } = await restarted.openWorker(spec);
				expect(conversation.session.sessionRef).toEqual(ref);
				expect(conversation.cwd).toBe(placement.cwd);
				const capture = vi
					.spyOn(githubCliCodeHostProvider, "capturePullRequestContext")
					.mockRejectedValue(new Error("unexpected ordinary PR resolution"));
				await expect(
					prepareReviewWorkflow({
						target: { kind: "pr", number: "415" },
						cwd: placement.cwd,
						sessionManager: conversation.session.sessionManager,
						settingsManager: f.harness.settingsManager,
						modelRegistry: f.harness.session.modelRegistry,
						currentModel: f.harness.getModel(),
					}),
				).rejects.toThrow("different PR");
				expect(capture).not.toHaveBeenCalled();
				expect(f.harness.faux.state.callCount).toBe(0);
			},
		);
	}

	it.each(["dirty", "head", "remote"] as const)(
		"rejects %s drift on interrupted-session resume before any worker opens it",
		async (drift) => {
			const f = await fixture();
			const { prepared, ref, placement } = await interruptedLaunch(f);
			if (drift === "dirty") writeFileSync(join(placement.cwd, "value.txt"), "keep this edit\n");
			if (drift === "head") git(placement.cwd, "checkout", "--detach", f.base);
			if (drift === "remote") f.target.pullRequest.headRefOid = f.base;
			const restarted = f.host();
			await expect(restarted.open({ target: "session", sessionId: prepared.sessionId })).rejects.toMatchObject({
				code: "review_preparation_stale",
			});
			expect(restarted.openWorker).not.toHaveBeenCalled();
			const reader = await SessionManager.open(ref);
			try {
				expect(reader.getPrReviewBinding()).toBeUndefined();
			} finally {
				await reader.closePersistence();
			}
			if (drift === "dirty") expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("keep this edit\n");
			expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		},
	);

	it("requires preparation capabilities only while resume admission is pending", async () => {
		const f = await fixture();
		const { prepared, placement } = await interruptedLaunch(f);
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("review").rpcGrant;
		const restarted = f.host();
		await expect(restarted.open({ target: "session", sessionId: prepared.sessionId })).rejects.toThrow(
			"review_preparation_failed",
		);
		expect(restarted.openWorker).not.toHaveBeenCalled();
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("full").rpcGrant;
		await restarted.attach({ target: "session", sessionId: prepared.sessionId });
		await restarted.stopAll();
		writeFileSync(join(placement.cwd, "value.txt"), "requested edit\n");
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("review").rpcGrant;
		const { worker } = await f.host().attach({ target: "session", sessionId: prepared.sessionId });
		expect(await readPrReviewBinding(worker.conversation.session.sessionManager)).toEqual(placement);
		expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested edit\n");
	});

	it("spawns no worker when binding persistence fails, and permits retry", async () => {
		const f = await fixture();
		const { prepared, placement } = await interruptedLaunch(f);
		const restarted = f.host();
		const record = vi.spyOn(LogWriter.prototype, "recordPrReviewBinding").mockImplementationOnce(() => {
			throw new Error("binding persistence failed");
		});
		await expect(restarted.open({ target: "session", sessionId: prepared.sessionId })).rejects.toThrow(
			"binding persistence failed",
		);
		expect(restarted.openWorker).not.toHaveBeenCalled();
		expect(restarted.worktrees.isRuntimePreparing(f.workspace.name, prepared.worktreeId)).toBe(false);
		record.mockRestore();
		const { worker } = await restarted.attach({ target: "session", sessionId: prepared.sessionId });
		expect(await readPrReviewBinding(worker.conversation.session.sessionManager)).toEqual(placement);
	});

	it("leaves ordinary resumed sessions unbound", async () => {
		const f = await fixture();
		const manager = await SessionManager.create(f.source, f.sessionDir, { id: "ordinary" });
		await manager.closePersistence();
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("review").rpcGrant;
		const { worker } = await f.host().attach({ target: "session", sessionId: "ordinary" });
		expect(await readPrReviewBinding(worker.conversation.session.sessionManager)).toBeUndefined();
		expect(f.provider.resolvePullRequestCheckout).not.toHaveBeenCalled();
	});

	it("recovers a local pending launch despite a completed foreign launch with the same session ID", async () => {
		const foreign = await fixture(false, "other");
		const foreignHost = foreign.host();
		const prepared = await foreignHost.checkouts.prepare(foreign.workspace, foreign.request, foreign.authority);
		await foreignHost.attach({ target: "new", sessionId: prepared.sessionId, worktreeId: prepared.worktreeId });
		const f = await fixture();
		const host = f.host();
		await host.state.upsertWorkspace(foreign.workspace);
		await host.state.upsertWorktree((await foreignHost.state.listWorktrees(foreign.workspace.name))[0]!);
		const { ref, placement } = await interruptedLaunch(f);
		const { worker } = await host.attach({ target: "session", sessionId: f.request.sessionId });
		expect(worker.conversation.session.sessionRef).toEqual(ref);
		expect(worker.conversation.cwd).toBe(placement.cwd);
		expect(await readPrReviewBinding(worker.conversation.session.sessionManager)).toEqual(placement);
	});

	it.each(["new", "session", "last"] as const)(
		"ignores another workspace's pending launch during ordinary %s admission",
		async (target) => {
			const foreign = await fixture(false, "other");
			const foreignHost = foreign.host();
			await foreignHost.checkouts.prepare(foreign.workspace, foreign.request, foreign.authority);
			const f = await fixture();
			const host = f.host();
			await host.state.upsertWorkspace(foreign.workspace);
			await host.state.upsertWorktree((await foreignHost.state.listWorktrees(foreign.workspace.name))[0]!);
			if (target !== "new") {
				const manager = await SessionManager.create(f.source, f.sessionDir, { id: f.request.sessionId });
				await manager.closePersistence();
			}
			f.authorization.client.lastSessionIdByWorkspace = { [f.workspace.name]: f.request.sessionId };
			const { resolved, worker } = await host.attach(
				target === "last" ? { target } : { target, sessionId: f.request.sessionId },
			);
			expect(resolved.selection.kind).toBe(target === "new" ? "created" : "resumed");
			expect(worker.conversation.session.sessionId).toBe(f.request.sessionId);
			expect(worker.conversation.cwd).toBe(f.source);
			expect(await readPrReviewBinding(worker.conversation.session.sessionManager)).toBeUndefined();
			expect(f.provider.resolvePullRequestCheckout).not.toHaveBeenCalled();
		},
	);

	it.each(["dirty", "head", "remote"] as const)(
		"rejects %s drift before the session is created or a worker spawns",
		async (drift) => {
			const f = await fixture();
			const host = f.host();
			const prepared = await host.checkouts.prepare(f.workspace, f.request, f.authority);
			const checkout = (await host.state.listWorktrees())[0]!;
			if (drift === "dirty") writeFileSync(join(checkout.path, "value.txt"), "unrelated edit\n");
			if (drift === "head") git(checkout.path, "checkout", "--detach", f.base);
			if (drift === "remote") f.target.pullRequest.headRefOid = f.base;
			await expect(
				host.open({ target: "new", sessionId: prepared.sessionId, worktreeId: prepared.worktreeId }),
			).rejects.toMatchObject({ code: "review_preparation_stale" });
			expect(host.openWorker).not.toHaveBeenCalled();
			expect(await SessionManager.findForResume(f.sessionDir, prepared.sessionId)).toBeUndefined();
			expect(await SessionManager.listAll(f.sessionDir)).toEqual([]);
			expect(host.worktrees.isRuntimePreparing(f.workspace.name, checkout.id)).toBe(false);
			expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		},
	);

	it.each([false, true])(
		"retains prepared placement through named attach, restart retry, and resume (nested: %s)",
		async (nested) => {
			const f = await fixture(nested);
			const first = f.host();
			const prepared = await first.checkouts.prepare(f.workspace, f.request, f.authority);
			const conversation = {
				target: "new" as const,
				sessionId: prepared.sessionId,
				worktreeId: prepared.worktreeId,
				workingDirectory: prepared.workingDirectory,
			};
			const opened = await first.attach(conversation);
			const placement = opened.worker.conversation.session.sessionManager.getPrReviewBinding()!;
			expect(opened.resolved.selection).toMatchObject({ kind: "created", sessionId: prepared.sessionId });
			expect(opened.spec).toMatchObject({ cwd: placement.cwd, projectCwd: placement.cwd });
			expect(opened.spec.session.sessionDirectory).toBe(f.sessionDir);
			expect(opened.resolved.worktree).toMatchObject({ id: prepared.worktreeId, path: placement.cwd });
			expect(opened.resolved.workingDirectory).toBe(prepared.workingDirectory);
			expect(placement.cwd).not.toBe(f.source);
			expect(git(placement.cwd, "rev-parse", "HEAD")).toBe(f.head);
			const ref = opened.worker.conversation.session.sessionRef;
			await first.stopAll();
			// Requested edits must survive retries/resumes; only first admission requires a pristine checkout.
			writeFileSync(join(placement.cwd, "value.txt"), "requested edit\n");
			const restarted = f.host();
			const retry = await restarted.attach(conversation);
			expect(retry.resolved.selection.kind).toBe("resumed");
			expect(retry.worker.conversation.session.sessionRef).toEqual(ref);
			expect(retry.worker.conversation.session.sessionManager.getPrReviewBinding()).toEqual(placement);
			await restarted.stopAll();
			const resumed = (await f.host().attach({ target: "session", sessionId: prepared.sessionId })).worker;
			expect(resumed.conversation.cwd).toBe(placement.cwd);
			expect(resumed.conversation.session.sessionManager.getCwd()).toBe(placement.cwd);
			expect(resumed.conversation.session.sessionRef).toEqual(ref);
			expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested edit\n");
			expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		},
	);

	it("cancels an open while asynchronous PR admission is pending without creating a session", async () => {
		const f = await fixture();
		const host = f.host();
		const prepared = await host.checkouts.prepare(f.workspace, f.request, f.authority);
		const gate = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		f.provider.resolvePullRequestCheckout.mockImplementationOnce(async () => {
			started.resolve();
			await gate.promise;
			return { ok: true, target: structuredClone(f.target) };
		});
		const controller = new AbortController();
		const result = host
			.open({ target: "new", sessionId: prepared.sessionId, worktreeId: prepared.worktreeId }, controller.signal)
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		try {
			await started.promise;
			controller.abort();
		} finally {
			gate.resolve();
		}
		expect(await result).toBeInstanceOf(Error);
		expect(host.openWorker).not.toHaveBeenCalled();
		expect(await SessionManager.findForResume(f.sessionDir, prepared.sessionId)).toBeUndefined();
		expect(host.worktrees.isRuntimePreparing(f.workspace.name, prepared.worktreeId)).toBe(false);
	});

	it("keeps General, findings handoff, discussion creation/reset and requested faux writes in the PR checkout", async () => {
		const f = await fixture(true);
		const host = f.host();
		const prepared = await host.checkouts.prepare(f.workspace, f.request, f.authority);
		const { worker } = await host.attach({
			target: "new",
			sessionId: prepared.sessionId,
			worktreeId: prepared.worktreeId,
			workingDirectory: prepared.workingDirectory,
		});
		const source = worker.conversation;
		const placement = source.session.sessionManager.getPrReviewBinding()!;
		const sourceId = source.session.sessionId;
		const record = reviewRecord(f.source, f.base, f.target);
		await anchorLiveReviewRun(source.session, record.runId);
		await appendReviewRunDurably(source.session.sessionWriter, record);
		/**
		 * A phone's own structural intent on `from` redirects it, as a worker serves the phone: the
		 * target's log is written there, and the daemon spawns a worker for it when the phone reconnects.
		 */
		const reconnectAfter = async (
			from: TestWorker,
			move: (phone: HostClient) => ReturnType<typeof openNewSession>,
		): Promise<TestWorker> => {
			const redirects: string[] = [];
			const phone: HostClient = {
				id: `phone-${from.conversation.id}`,
				move: {
					kind: "redirect",
					redirect: (sessionId) => {
						redirects.push(sessionId);
					},
					hostTarget: (target) => from.hosted.hostMoved(from.conversation, target),
					hostsStoredSessions: true,
				},
			};
			await from.host.attach(phone, from.conversation);
			const moved = await move(phone);
			if (moved.cancelled) throw new Error("The move was cancelled");
			expect(redirects).toEqual([moved.sessionId]);
			// Client-started moves open nothing in the worker the phone left.
			expect(from.hosted.get(moved.sessionId)).toBeUndefined();
			return (await host.attach({ target: "session", sessionId: moved.sessionId })).worker;
		};
		const generalWorker = await reconnectAfter(worker, (phone) =>
			openNewSession(worker.host, phone, {
				preserveReviewRunId: record.runId,
				replaceReviewGeneral: true,
				setup: async (manager) => {
					await appendReviewRun(manager, record);
				},
			}),
		);
		const general = generalWorker.conversation;
		expect(await getReviewGeneral(general.session.sessionManager, record.runId)).toMatchObject({
			sourceSessionId: sourceId,
			generalSessionId: general.session.sessionId,
		});
		expect(general.cwd).toBe(placement.cwd);
		expect(await readPrReviewBinding(general.session.sessionManager)).toEqual(placement);
		const generalId = general.session.sessionId;
		const findingsWorker = await reconnectAfter(generalWorker, (phone) =>
			openNewSession(generalWorker.host, phone, {
				setup: async (manager) => {
					await appendReviewRun(manager, record);
					const message = createReviewSeedMessage(record, ["f1"]);
					await manager.appendCustomMessageEntry(
						message.customType,
						message.content,
						message.display,
						message.details,
					);
				},
			}),
		);
		const handoff = findingsWorker.conversation;
		expect(handoff.session.sessionId).not.toBe(generalId);
		expect(handoff.cwd).toBe(placement.cwd);
		expect(await readPrReviewBinding(handoff.session.sessionManager)).toEqual(placement);
		// The workers the phone left retire once detached and idle; the review source is then written unloaded.
		await host.stop(worker);
		await host.stop(generalWorker);
		const api = findingsWorker.hosted.reviewDiscussions(handoff);
		f.harness.setResponses([fauxAssistantMessage("Finding discussion")]);
		const started = await api.start(record.runId, ["f1"], "start-414");
		expect(started.results).toMatchObject([{ outcome: "created" }]);
		const discussion = started.results[0]!.discussion!;
		// A finding discussion opens beside its source, in the source's worker.
		const child = findingsWorker.hosted.get(discussion.sessionId)!;
		expect(child.kind).toBe("sibling");
		await child.conversation.session.waitForIdle();
		expect(child.conversation.cwd).toBe(placement.cwd);
		// The daemon places the discussion in the PR checkout when a phone opens it.
		expect((await host.worktrees.resolveSessionWorktree(f.workspace.name, discussion.sessionId))?.id).toBe(
			prepared.worktreeId,
		);
		const reset = await api.reset(discussion.discussionId, discussion.sessionId, "reset-414");
		expect(reset.status).toBe("reset");
		const resetChild = findingsWorker.hosted.get(reset.discussion.currentSessionId)!;
		expect(resetChild.kind).toBe("sibling");
		const resetConversation = resetChild.conversation;
		expect(resetConversation.cwd).toBe(placement.cwd);
		expect(resetConversation.session.sessionManager.getCwd()).toBe(placement.cwd);
		expect(
			(await host.worktrees.resolveSessionWorktree(f.workspace.name, reset.discussion.currentSessionId))?.id,
		).toBe(prepared.worktreeId);
		expect(resetConversation.session.messages.some((message) => message.role === "user")).toBe(false);
		f.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "value.txt", content: "requested faux fix\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fixed the finding"),
		]);
		await resetConversation.session.prompt("Fix finding f1 by writing value.txt", {
			source: "rpc",
			clientMessageId: "fix-414",
		});
		expect(f.harness.getPendingResponseCount()).toBe(0);
		expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested faux fix\n");
		expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		expect(git(f.source, "rev-parse", "HEAD")).toBe(f.base);
		expect(git(f.source, "status", "--porcelain")).toBe("");
		expect(getReviewRun(handoff.session.sessionManager, record.runId)?.result?.findings[0]?.status).toBe("open");
		const resetId = resetConversation.id;
		await host.stopAll();
		const resumed = await f.host().attach({ target: "session", sessionId: resetId });
		expect(resumed.worker.conversation.cwd).toBe(placement.cwd);
		expect(resumed.resolved.worktree?.id).toBe(prepared.worktreeId);
		expect(resumed.worker.conversation.session.isReviewDiscussion).toBe(true);
		expect(resumed.worker.conversation.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});
});
