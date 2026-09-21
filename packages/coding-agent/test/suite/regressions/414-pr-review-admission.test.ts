import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { readPrReviewBinding } from "../../../src/core/pr-review-binding.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../../../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { createIrohRemoteHandshakeSuccess, type IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { createEmptyIrohRemoteHostState, writeIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { prepareReviewWorkflow } from "../../../src/core/review.ts";
import { getReviewGeneral } from "../../../src/core/review-general.ts";
import { createReviewSeedMessage } from "../../../src/core/review-presentation.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { IntegratedRuntimeRegistry } from "../../../src/daemon/integrated-runtimes.ts";
import { PrReviewCheckoutManager, type PrReviewPreparationRequest } from "../../../src/daemon/pr-review-checkout.ts";
import { createSessionManagerTargetStore, resolveIrohRemoteSessionTarget } from "../../../src/daemon/session-target.ts";
import * as daemonSpawn from "../../../src/daemon/spawn.ts";
import { WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let gitSeed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	gitSeed = createPrReviewGitSeed("parent\n", "PR head");
});
afterAll(() => gitSeed?.dispose());

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	// This fixture owns daemon runtimes in-process, not in a separately spawned
	// daemon whose state file would not contain the fixture's worktrees.
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
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
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
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const registries: IntegratedRuntimeRegistry[] = [];
	function host() {
		const state = new IrohRemoteHostStateManager({ statePath });
		const worktrees = new WorktreeManager({ agentDir, stateManager: state, auditLogger: audit });
		const checkouts = new PrReviewCheckoutManager({
			agentDir,
			stateManager: state,
			worktrees,
			provider,
			hasActiveSession: (name, id) => registries.some((registry) => registry.findOwner(name, id) !== undefined),
		});
		const createRuntime = vi.fn<
			NonNullable<ConstructorParameters<typeof IntegratedRuntimeRegistry>[0]["createRuntime"]>
		>(async (options) => {
			const selected = options.conversationTarget;
			if (!selected) throw new Error("Expected conversation target");
			const resolved = await resolveIrohRemoteSessionTarget(
				selected.target === "last"
					? { kind: "last", resumeSessionId: selected.resumeSessionId }
					: { kind: selected.target, sessionId: selected.sessionId! },
				workspace,
				createSessionManagerTargetStore(options.cwd, options.sessionDir!, {
					listAll: true,
					preserveSessionCwd: true,
				}),
			);
			await options.validateCwd?.(resolved.sessionManager.getCwd());
			const runtime = await createAgentSessionRuntime(factory, {
				sessionManager: resolved.sessionManager,
				cwd: resolved.sessionManager.getCwd(),
				agentDir,
			});
			return {
				runtime,
				sessionSelection:
					resolved.selection === "created"
						? { kind: "created", sessionId: resolved.sessionId }
						: {
								kind: resolved.selection,
								sessionId: resolved.sessionId,
								requestedSessionId: resolved.requestedSessionId ?? resolved.sessionId,
							},
			};
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: audit,
			stateManager: state,
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getProjectTrustedForWorkspace: () => true,
			setClientLastSessionId: (node, name, id) => state.setClientLastSessionId(node, name, id),
			createRuntime,
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
			withReviewSourceWrite: async (_parent, _ref, write) => write(),
		});
		registries.push(registry);
		const response = createIrohRemoteHandshakeSuccess({
			workspace: workspace.name,
			hostNodeId: "host",
			clientNodeId: "phone",
		});
		function open(
			conversation: Extract<IrohRemoteHello, { mode: "conversation" }>["conversation"],
			signal?: AbortSignal,
		) {
			const hello: IrohRemoteHello = {
				type: "volt_iroh_hello",
				protocol: "volt-rpc/0",
				workspace: workspace.name,
				mode: "conversation",
				conversation,
			};
			return registry.getOrCreateEntry({ hello, response }, authorization, { signal });
		}
		async function attach(conversation: Parameters<typeof open>[0]) {
			const opened = await open(conversation);
			try {
				await registry.commitEntry(opened.entry, opened.sessionSelection, authorization, opened.attachClaim);
			} finally {
				opened.attachClaim.release();
			}
			return opened;
		}
		return { state, worktrees, checkouts, registry, createRuntime, open, attach };
	}
	cleanups.push(async () => {
		for (const registry of registries) await registry.stopAll("test_cleanup");
		await harness.cleanupAsync();
		await audit.flush();
		rmSync(root, { recursive: true, force: true });
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
	vi.spyOn(host.checkouts, "bind").mockImplementationOnce(async (_workspace, manager, placement) => {
		if (persistBinding) {
			manager.recordPrReviewBinding(placement);
			await manager.flush();
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
	expect(host.registry.size).toBe(0);
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

describe("#414 PR review admission and runtime lifecycle", () => {
	for (const nested of [false, true]) {
		it.each([
			{ target: "session", persistBinding: false },
			{ target: "last", persistBinding: false },
			{ target: "session", persistBinding: true },
			{ target: "last", persistBinding: true },
		] as const)(
			`recovers an interrupted launch before publication (nested: ${nested}): %j`,
			async ({ target, persistBinding }) => {
				const f = await fixture(nested);
				const { prepared, ref, placement } = await interruptedLaunch(f, persistBinding);
				f.authorization.client.lastSessionIdByWorkspace = { [f.workspace.name]: prepared.sessionId };
				const restarted = f.host();
				const opened = await restarted.open(
					target === "last" ? { target } : { target, sessionId: prepared.sessionId },
				);
				let published = false;
				try {
					expect(opened.sessionSelection.kind).toBe("resumed");
					expect(opened.entry.runtime.session.sessionRef).toEqual(ref);
					expect(opened.entry.runtime.cwd).toBe(placement.cwd);
					expect(opened.entry.worktreeId).toBe(prepared.worktreeId);
					// A separate store reader must see the binding before ownership publication.
					const reader = await SessionManager.open(ref);
					try {
						expect(await readPrReviewBinding(reader)).toEqual(placement);
					} finally {
						await reader.closePersistence();
					}
					const launch = (await restarted.state.listWorktrees())[0]!.prReviewLaunches![0];
					expect(launch).toMatchObject({ sessionGeneration: ref.sessionGeneration, storeId: ref.storeId });
					await restarted.registry.commitEntry(
						opened.entry,
						opened.sessionSelection,
						f.authorization,
						opened.attachClaim,
					);
					published = true;
				} finally {
					if (!published)
						await restarted.registry.abortPreparedEntry(
							opened.entry,
							opened.sessionSelection,
							opened.attachClaim,
						);
					opened.attachClaim.release();
				}
				const capture = vi
					.spyOn(githubCliCodeHostProvider, "capturePullRequestContext")
					.mockRejectedValue(new Error("unexpected ordinary PR resolution"));
				await expect(
					prepareReviewWorkflow({
						target: { kind: "pr", number: "415" },
						cwd: placement.cwd,
						sessionManager: opened.entry.runtime.session.sessionManager,
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
		"rejects %s drift on interrupted-session resume without publication",
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
			expect(restarted.createRuntime).not.toHaveBeenCalled();
			expect(restarted.registry.size).toBe(0);
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
		expect(restarted.createRuntime).not.toHaveBeenCalled();
		expect(restarted.registry.size).toBe(0);
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("full").rpcGrant;
		await restarted.attach({ target: "session", sessionId: prepared.sessionId });
		await restarted.registry.stopAll("restart");
		writeFileSync(join(placement.cwd, "value.txt"), "requested edit\n");
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("review").rpcGrant;
		const resumed = await f.host().attach({ target: "session", sessionId: prepared.sessionId });
		expect(await readPrReviewBinding(resumed.entry.runtime.session.sessionManager)).toEqual(placement);
		expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested edit\n");
	});

	it("does not publish a resumed runtime when binding persistence fails and permits retry", async () => {
		const f = await fixture();
		const { prepared, placement } = await interruptedLaunch(f);
		const restarted = f.host();
		const record = vi.spyOn(SessionManager.prototype, "recordPrReviewBinding").mockImplementationOnce(() => {
			throw new Error("binding persistence failed");
		});
		await expect(restarted.open({ target: "session", sessionId: prepared.sessionId })).rejects.toThrow(
			"binding persistence failed",
		);
		expect(restarted.registry.size).toBe(0);
		expect(restarted.worktrees.isRuntimePreparing(f.workspace.name, prepared.worktreeId)).toBe(false);
		record.mockRestore();
		const resumed = await restarted.attach({ target: "session", sessionId: prepared.sessionId });
		expect(await readPrReviewBinding(resumed.entry.runtime.session.sessionManager)).toEqual(placement);
	});

	it("leaves ordinary resumed sessions unbound", async () => {
		const f = await fixture();
		const manager = await SessionManager.create(f.source, f.sessionDir, { id: "ordinary" });
		await manager.closePersistence();
		f.authorization.client.rpcGrant = createIrohRemotePresetAccess("review").rpcGrant;
		const resumed = await f.host().attach({ target: "session", sessionId: "ordinary" });
		expect(await readPrReviewBinding(resumed.entry.runtime.session.sessionManager)).toBeUndefined();
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
		const opened = await host.attach({ target: "session", sessionId: f.request.sessionId });
		expect(opened.entry.runtime.session.sessionRef).toEqual(ref);
		expect(opened.entry.runtime.cwd).toBe(placement.cwd);
		expect(await readPrReviewBinding(opened.entry.runtime.session.sessionManager)).toEqual(placement);
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
			const opened = await host.attach(target === "last" ? { target } : { target, sessionId: f.request.sessionId });
			expect(opened.sessionSelection.kind).toBe(target === "new" ? "created" : "resumed");
			expect(opened.entry.runtime.session.sessionId).toBe(f.request.sessionId);
			expect(opened.entry.runtime.cwd).toBe(f.source);
			expect(await readPrReviewBinding(opened.entry.runtime.session.sessionManager)).toBeUndefined();
			expect(f.provider.resolvePullRequestCheckout).not.toHaveBeenCalled();
		},
	);

	it.each(["dirty", "head", "remote"] as const)(
		"rejects %s drift before the first runtime factory or session creation",
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
			expect(host.createRuntime).not.toHaveBeenCalled();
			expect(host.registry.size).toBe(0);
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
			const placement = opened.entry.runtime.session.sessionManager.getPrReviewBinding()!;
			expect(opened.sessionSelection).toMatchObject({ kind: "created", sessionId: prepared.sessionId });
			expect(first.createRuntime).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: placement.cwd, projectCwd: placement.cwd, sessionDir: f.sessionDir }),
			);
			expect(opened.entry).toMatchObject({ worktreeId: prepared.worktreeId, worktreePath: placement.cwd });
			expect(opened.entry.workingDirectory).toBe(prepared.workingDirectory);
			expect(placement.cwd).not.toBe(f.source);
			expect(git(placement.cwd, "rev-parse", "HEAD")).toBe(f.head);
			const ref = opened.entry.runtime.session.sessionRef;
			await first.registry.stopAll("restart");
			// Requested edits must survive retries/resumes; only first admission requires a pristine checkout.
			writeFileSync(join(placement.cwd, "value.txt"), "requested edit\n");
			const restarted = f.host();
			const retry = await restarted.attach(conversation);
			expect(retry.sessionSelection.kind).toBe("resumed");
			expect(retry.entry.runtime.session.sessionRef).toEqual(ref);
			expect(retry.entry.runtime.session.sessionManager.getPrReviewBinding()).toEqual(placement);
			await restarted.registry.stopAll("restart_again");
			const resumed = await f.host().attach({ target: "session", sessionId: prepared.sessionId });
			expect(resumed.entry.runtime.cwd).toBe(placement.cwd);
			expect(resumed.entry.runtime.session.sessionManager.getCwd()).toBe(placement.cwd);
			expect(resumed.entry.runtime.session.sessionRef).toEqual(ref);
			expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested edit\n");
			expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		},
	);

	it("cancels an attach while asynchronous PR admission is pending without creating a session", async () => {
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
		expect(host.createRuntime).not.toHaveBeenCalled();
		expect(await SessionManager.findForResume(f.sessionDir, prepared.sessionId)).toBeUndefined();
		expect(host.registry.size).toBe(0);
	});

	it("keeps General, findings handoff, discussion creation/reset and requested faux writes in the PR checkout", async () => {
		const f = await fixture(true);
		const host = f.host();
		const prepared = await host.checkouts.prepare(f.workspace, f.request, f.authority);
		const { entry } = await host.attach({
			target: "new",
			sessionId: prepared.sessionId,
			worktreeId: prepared.worktreeId,
			workingDirectory: prepared.workingDirectory,
		});
		const runtime = entry.runtime;
		const placement = runtime.session.sessionManager.getPrReviewBinding()!;
		const sourceId = runtime.session.sessionId;
		const record = reviewRecord(f.source, f.base, f.target);
		await appendReviewRunDurably(runtime.session.sessionManager, record);
		await runtime.newSession({
			preserveReviewRunId: record.runId,
			replaceReviewGeneral: true,
			setup: async (manager) => {
				appendReviewRun(manager, record);
			},
		});
		expect(await getReviewGeneral(runtime.session.sessionManager, record.runId)).toMatchObject({
			sourceSessionId: sourceId,
			generalSessionId: runtime.session.sessionId,
			generalRevision: 1,
		});
		expect(await readPrReviewBinding(runtime.session.sessionManager)).toEqual(placement);
		const generalId = runtime.session.sessionId;
		await runtime.newSession({
			setup: async (manager) => {
				appendReviewRun(manager, record);
			},
			withSession: async (context) => {
				await context.sendMessage(createReviewSeedMessage(record, ["f1"]));
			},
		});
		expect(runtime.session.sessionId).not.toBe(generalId);
		expect(runtime.cwd).toBe(placement.cwd);
		expect(await readPrReviewBinding(runtime.session.sessionManager)).toEqual(placement);
		const api = runtime.reviewDiscussions!;
		f.harness.setResponses([fauxAssistantMessage("Finding discussion")]);
		const started = await api.start(record.runId, ["f1"], "start-414");
		expect(started.results).toMatchObject([{ outcome: "created" }]);
		const discussion = started.results[0]!.discussion!;
		const child = host.registry.findOwner(f.workspace.name, discussion.sessionId)!;
		await child.runtime.session.waitForIdle();
		expect(child.runtime.cwd).toBe(placement.cwd);
		expect(child.worktreeId).toBe(prepared.worktreeId);
		const reset = await api.reset(discussion.discussionId, discussion.sessionId, "reset-414");
		expect(reset.status).toBe("reset");
		const resetEntry = host.registry.findOwner(f.workspace.name, reset.discussion.currentSessionId)!;
		expect(resetEntry.runtime.cwd).toBe(placement.cwd);
		expect(resetEntry.runtime.session.sessionManager.getCwd()).toBe(placement.cwd);
		expect(resetEntry.worktreeId).toBe(prepared.worktreeId);
		expect(resetEntry.runtime.session.messages.some((message) => message.role === "user")).toBe(false);
		f.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "value.txt", content: "requested faux fix\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fixed the finding"),
		]);
		await resetEntry.runtime.session.prompt("Fix finding f1 by writing value.txt", {
			source: "rpc",
			clientMessageId: "fix-414",
		});
		expect(f.harness.getPendingResponseCount()).toBe(0);
		expect(readFileSync(join(placement.cwd, "value.txt"), "utf8")).toBe("requested faux fix\n");
		expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("parent\n");
		expect(git(f.source, "rev-parse", "HEAD")).toBe(f.base);
		expect(git(f.source, "status", "--porcelain")).toBe("");
		expect(getReviewRun(runtime.session.sessionManager, record.runId)?.result?.findings[0]?.status).toBe("open");
		const resetId = resetEntry.sessionId;
		await host.registry.stopAll("restart_discussion");
		const resumed = await f.host().attach({ target: "session", sessionId: resetId });
		expect(resumed.entry.runtime.cwd).toBe(placement.cwd);
		expect(resumed.entry.worktreeId).toBe(prepared.worktreeId);
		expect(resumed.entry.runtime.session.isReviewDiscussion).toBe(true);
		expect(resumed.entry.runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});
});
