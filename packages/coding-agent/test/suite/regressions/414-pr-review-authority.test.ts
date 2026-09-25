import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../../src/core/agent-session.ts";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { createIrohRemoteRpcGrant, type IrohRemoteRpcCapability } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import type { IrohBiStreamLike } from "../../../src/core/rpc/iroh-transport.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import { IntegratedRuntimeRegistry } from "../../../src/daemon/integrated-runtimes.ts";
import type { IrohIncomingLike, IrohModuleLike, IrohNodeIdLike } from "../../../src/daemon/iroh-native.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import type { VoltdRuntimeServices } from "../../../src/daemon/main.ts";
import { getDaemonPaths } from "../../../src/daemon/paths.ts";
import { PrReviewCheckoutManager, type PrReviewPreparationAuthority } from "../../../src/daemon/pr-review-checkout.ts";
import * as reviewGit from "../../../src/daemon/pr-review-git.ts";
import { VoltdStateStore } from "../../../src/daemon/state.ts";
import type { WorkAssociationService } from "../../../src/daemon/work-association.ts";
import { getWorktreesRoot, WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";

const HOST = "a".repeat(64);
const PHONE = "b".repeat(64);
const SECRET = "synthetic-credential-never-send-414";
const capabilities: IrohRemoteRpcCapability[] = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"worktrees.manage.v1",
];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Same injected native boundary as daemon-relay-credential-recovery; no daemon/socket/native binding. */
function fakeIroh() {
	let incoming = deferred<IrohIncomingLike | undefined>();
	const module: IrohModuleLike = {
		bindingCapabilities: () => ({ connectedHomeRelayWatch: true, reconnectRelay: true }),
		Endpoint: {
			builder: () => ({
				relayMode() {},
				secretKey() {},
				alpns() {},
				async bind() {
					return {
						id: () => ({ toString: () => HOST }),
						addr: () => ({
							id: () => ({ toString: () => HOST }),
							relayUrl: () => null,
							directAddresses: () => [],
						}),
						secretKey: () => ({ toBytes: () => Array<number>(32).fill(7) }),
						async online() {},
						async close() {
							incoming.resolve(undefined);
						},
						acceptNext: () => incoming.promise,
					};
				},
			}),
		},
		EndpointAddr: class {
			id: () => IrohNodeIdLike;
			relayUrl: () => string | null;
			directAddresses: () => string[];
			constructor(id: IrohNodeIdLike, relayUrl?: string | null, addresses: string[] = []) {
				this.id = () => id;
				this.relayUrl = () => relayUrl ?? null;
				this.directAddresses = () => addresses;
			}
		},
		EndpointTicket: { fromAddr: () => ({ toString: () => "fake-native-ticket" }) },
		RelayMap: { empty: () => ({ insert() {} }) },
		RelayMode: { disabled() {}, custom() {}, customFromUrls() {} },
		presetMinimal() {},
		presetN0() {},
		presetN0DisableRelay() {},
	};
	return {
		module,
		open(command: { type: string } & Record<string, unknown>) {
			const frames: Record<string, unknown>[] = [];
			const settled = deferred<void>();
			const closed = deferred<void>();
			let delivered = false;
			let opened = false;
			const stream: IrohBiStreamLike = {
				recv: {
					async read() {
						if (delivered) return undefined;
						delivered = true;
						const hello = {
							type: "volt_iroh_hello",
							protocol: "volt-rpc/0",
							workspace: "project",
							...(command.type === "resolve_pr_review"
								? { workspaceDiscovery: { purpose: "review" } }
								: { workspaceManagement: { purpose: "manage_worktrees" } }),
						};
						return Buffer.from(`${JSON.stringify(hello)}\n${JSON.stringify(command)}\n`);
					},
					async stop() {},
				},
				send: {
					async writeAll(bytes) {
						frames.push(JSON.parse(Buffer.from(bytes).toString("utf8")));
					},
					async finish() {
						settled.resolve();
					},
					async reset() {
						settled.resolve();
					},
				},
			};
			const next = incoming;
			incoming = deferred<IrohIncomingLike | undefined>();
			next.resolve({
				async refuse() {},
				async accept() {
					return {
						async connect() {
							return {
								remoteId: () => ({ toString: () => PHONE }),
								setMaxConcurrentBiStreams() {},
								close() {
									closed.resolve();
								},
								closed: () => closed.promise,
								async acceptBi() {
									if (!opened) {
										opened = true;
										return stream;
									}
									await closed.promise;
									throw new Error("done");
								},
							};
						},
					};
				},
			});
			return { frames, settled: settled.promise };
		},
	};
}

async function fixture(grant = capabilities) {
	vi.stubEnv("VOLT_IROH_RELAY_AUTH_TOKEN", undefined);
	vi.stubEnv("VOLT_IROH_RELAY_URLS", undefined);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network request"));
	const harness = await createHarness({ settings: { lsp: { enabled: false } } });
	cleanups.push(() => harness.cleanupAsync());
	const root = realpathSync(harness.tempDir);
	const source = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(source);
	git(source, "init", "--initial-branch=main");
	git(source, "config", "user.name", "Test");
	git(source, "config", "user.email", "test@example.test");
	git(source, "config", "commit.gpgsign", "false");
	writeFileSync(join(source, "value.txt"), "unchanged\n");
	git(source, "add", "value.txt");
	git(source, "commit", "-m", "base");
	const head = git(source, "rev-parse", "HEAD");
	git(source, "update-ref", "refs/pull/414/head", head);
	const target: ResolvedPullRequestCheckout = {
		pullRequest: {
			provider: "github",
			url: "https://github.com/owner/project/pull/414",
			number: 414,
			title: `private ${root} ${SECRET}`,
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
			owner: "owner",
			name: "project",
			canonicalId: "github:github.com/owner/project",
		},
		remote: "origin",
		remoteUrl: source,
		headRef: "refs/pull/414/head",
	};
	const provider = vi
		.spyOn(githubCliCodeHostProvider, "resolvePullRequestCheckout")
		.mockImplementation(async () => ({ ok: true, target: structuredClone(target) }));
	const state = new VoltdStateStore({ agentDir, statePath: join(agentDir, "state.json") });
	await state.load();
	state.updateSettings({ worktreeCleanup: { pruneOnStart: false }, relayAuthToken: SECRET });
	state.setHostState({
		...state.getHostState(),
		hostSecretKey: Array<number>(32).fill(7),
		clients: [
			{
				nodeId: PHONE,
				label: "phone",
				allowedWorkspaces: ["project"],
				allowedTools: "read",
				rpcGrant: createIrohRemoteRpcGrant(grant),
				pairedAt: 1,
				lastSeenAt: 1,
			},
		],
		workspaces: [{ name: "project", path: source }],
		workspaceGenerationCounter: 1,
		workspaceGenerations: [{ workspaceName: "project", generation: 1 }],
	});
	await state.flush();
	cleanups.push(() => state.close());
	const stateManager = new IrohRemoteHostStateManager({
		store: {
			read: () => state.getHostState(),
			write: (snapshot) => state.persistHostState(snapshot),
		},
	});
	const log = vi.fn();
	const services: VoltdRuntimeServices = {
		agentDir,
		state,
		stateManager,
		paths: getDaemonPaths(agentDir),
		logger: { log, child: () => log },
		auditLogger: new IrohRemoteAuditLogger(),
		controlServer: {
			socketPath: "unused",
			connections: () => [],
			sendTo: () => false,
			broadcast() {},
			async close() {},
			async quiesce() {},
		},
		// Streams record client activity for PR status polling; nothing else may touch Work.
		work: new Proxy(
			{},
			{
				get(_target, property) {
					if (property === "retainClientActivity") return () => () => {};
					throw new Error("utility must not start work observation");
				},
			},
		) as unknown as WorkAssociationService,
		get keepAwake(): never {
			throw new Error("utility must not start keep-awake");
		},
		webSearchKey: {
			configured: false,
			set() {
				throw new Error("unexpected credential write");
			},
		},
		requestShutdown() {
			throw new Error("unexpected shutdown request");
		},
	};
	const native = fakeIroh();
	const service = createIrohDaemonService(
		{ relayMode: "disabled" },
		{ loadIrohModule: () => ({ iroh: native.module }) },
	)(services);
	cleanups.push(async () => {
		await service.quiesce?.({ reason: "cli" });
		await service.dispose?.({ reason: "cli", signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 });
	});
	await expect.poll(() => service.statusExtras?.().remoteTransport?.state).toBe("ready");
	const createWorktree = vi.spyOn(WorktreeManager.prototype, "create");
	const createSession = vi.spyOn(SessionManager, "create");
	const openRuntime = vi.spyOn(IntegratedRuntimeRegistry.prototype, "getOrCreateEntry");
	const prompt = vi.spyOn(AgentSession.prototype, "prompt");
	const runGit = vi.spyOn(reviewGit, "runPrReviewGit");
	const before = {
		worktrees: git(source, "worktree", "list", "--porcelain"),
		refs: git(source, "show-ref"),
		status: git(source, "status", "--porcelain"),
	};
	const command = {
		id: "authority-414",
		type: "prepare_pr_review",
		workspaceName: "project",
		sessionId: "review-414",
		expectedPullRequest: { url: target.pullRequest.url, headRefOid: head },
	};
	return {
		state,
		source,
		root,
		target,
		provider,
		native,
		command,
		runGit,
		createWorktree,
		async expectNoEffects(allowFetch = false) {
			expect(createWorktree).not.toHaveBeenCalled();
			expect(createSession).not.toHaveBeenCalled();
			expect(openRuntime).not.toHaveBeenCalled();
			expect(prompt).not.toHaveBeenCalled();
			expect(harness.eventsOfType("agent_start")).toEqual([]);
			expect(fetch).not.toHaveBeenCalled();
			expect(state.getHostState().worktrees).toEqual([]);
			expect(existsSync(getWorktreesRoot(agentDir))).toBe(false);
			expect(git(source, "worktree", "list", "--porcelain")).toBe(before.worktrees);
			expect(git(source, "status", "--porcelain")).toBe(before.status);
			if (!allowFetch) {
				expect(git(source, "show-ref")).toBe(before.refs);
				expect(runGit.mock.calls.some(([args]) => args[0] === "fetch")).toBe(false);
			}
			expect(await SessionManager.list(source, getDefaultSessionDirPath(source, agentDir))).toEqual([]);
			expect(service.statusExtras?.().leases).toEqual([]);
		},
	};
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const mutations = [
	"client revoked",
	"grant replaced",
	"workspace access removed",
	"workspace replaced",
	"client tools changed",
	"workspace tools changed",
] as const;
function invalidate(f: Fixture, kind: (typeof mutations)[number]) {
	const state = structuredClone(f.state.getHostState());
	if (kind === "client revoked") state.clients = [];
	if (kind === "grant replaced") state.clients[0].rpcGrant = createIrohRemoteRpcGrant(capabilities, 2);
	if (kind === "workspace access removed") state.clients[0].allowedWorkspaces = ["other-workspace"];
	if (kind === "workspace replaced") {
		state.workspaceGenerationCounter = 2;
		state.workspaceGenerations = [{ workspaceName: "project", generation: 2 }];
	}
	if (kind === "client tools changed") state.clients[0].allowedTools = "";
	if (kind === "workspace tools changed") state.workspaces[0].allowedTools = "read";
	// Deliberately do not close/abort the stream: only the live daemon callback can fence these effects.
	f.state.setHostState(state);
}

function observeAuthority(kind: "resolve" | "prepare") {
	let authority: PrReviewPreparationAuthority | undefined;
	const checks = vi.fn<() => void>();
	const observe = (current: PrReviewPreparationAuthority) => {
		authority = current;
		checks.mockImplementation(current.assertCurrent);
		return { ...current, assertCurrent: checks };
	};
	if (kind === "resolve") {
		const original = PrReviewCheckoutManager.prototype.resolve;
		vi.spyOn(PrReviewCheckoutManager.prototype, "resolve").mockImplementation(function (
			this: PrReviewCheckoutManager,
			workspace,
			request,
			current,
		) {
			return original.call(this, workspace, request, observe(current));
		});
	} else {
		const original = PrReviewCheckoutManager.prototype.prepare;
		vi.spyOn(PrReviewCheckoutManager.prototype, "prepare").mockImplementation(function (
			this: PrReviewCheckoutManager,
			workspace,
			request,
			current,
		) {
			return original.call(this, workspace, request, observe(current));
		});
	}
	return {
		checks,
		get authority() {
			return authority;
		},
	};
}

function expectNoLeak(f: Fixture, frames: Record<string, unknown>[]) {
	const wire = JSON.stringify(frames);
	expect(wire).not.toContain(f.root);
	expect(wire).not.toContain(f.source);
	expect(wire).not.toContain(SECRET);
	expect(frames.filter((frame) => frame.type === "response")).toEqual([]);
}

describe("#414 daemon PR authority effect boundaries", () => {
	it.each(["conversation.control.v1", "worktrees.manage.v1"] as const)(
		"denies preparation without %s before any host effects",
		async (missing) => {
			const f = await fixture(capabilities.filter((capability) => capability !== missing));
			const stream = f.native.open(f.command);
			await stream.settled;
			expect(stream.frames).toMatchObject([
				{ success: true },
				{
					type: "response",
					command: "prepare_pr_review",
					success: false,
					error: { code: "rpc_capability_denied", requiredCapability: missing },
				},
			]);
			expect(f.provider).not.toHaveBeenCalled();
			expect(f.runGit).not.toHaveBeenCalled();
			expect(JSON.stringify(stream.frames)).not.toContain(f.root);
			expect(JSON.stringify(stream.frames)).not.toContain(SECRET);
			await f.expectNoEffects();
		},
	);

	for (const kind of ["resolve", "prepare"] as const) {
		it.each(mutations)(`fences ${kind} after asynchronous PR resolution when %s`, async (mutation) => {
			const f = await fixture();
			const observed = observeAuthority(kind);
			const entered = deferred<void>();
			const release = deferred<void>();
			f.provider.mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return { ok: true, target: structuredClone(f.target) };
			});
			const stream = f.native.open(
				kind === "prepare" ? f.command : { id: "resolve-414", type: "resolve_pr_review", workspaceName: "project" },
			);
			try {
				await entered.promise;
				invalidate(f, mutation);
				expect(observed.authority?.signal?.aborted).toBe(false);
			} finally {
				release.resolve();
			}
			await stream.settled;
			expect(observed.checks.mock.results.at(-1)?.type).toBe("throw");
			expectNoLeak(f, stream.frames);
			await f.expectNoEffects();
		});
	}

	it.each(mutations)("fences worktree creation after asynchronous fetch when %s", async (mutation) => {
		const f = await fixture();
		const observed = observeAuthority("prepare");
		const entered = deferred<void>();
		const release = deferred<void>();
		f.runGit.mockRestore();
		const realGit = reviewGit.runPrReviewGit;
		vi.spyOn(reviewGit, "runPrReviewGit").mockImplementation(async (...args) => {
			const result = await realGit(...args);
			if (args[0][0] === "fetch") {
				entered.resolve();
				await release.promise;
			}
			return result;
		});
		const stream = f.native.open(f.command);
		try {
			await entered.promise;
			invalidate(f, mutation);
			expect(observed.authority?.signal?.aborted).toBe(false);
		} finally {
			release.resolve();
		}
		await stream.settled;
		expect(observed.checks.mock.results.at(-1)?.type).toBe("throw");
		expectNoLeak(f, stream.frames);
		// The fetch completed while authorized; no subsequent checkout/session/inference is admitted.
		await f.expectNoEffects(true);
	});
});
