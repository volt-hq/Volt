/**
 * The daemon's services for a paired device's intents and queries
 * (src/daemon/remote-intents.ts): the workspace session listing, workspace
 * unregistering, keep-awake and the web search key, device log uploads,
 * worktrees, pull request review answers, session contexts, the intents and
 * queries each workspace stream purpose serves, and the admission of work on
 * a phone's conversation. Wire behavior runs over protocol 1 frames on the
 * remote profile, as the daemon serves its workspace streams and as a worker
 * serves a phone's conversation, relaying the daemon's intents and queries.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ControlRelayFrame,
	type ControlRelayOutcome,
	type HostFrame,
	type PrReviewPrepareResponse,
	type PrReviewResolveResponse,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { intentRegistry } from "../src/core/protocol/intents/index.ts";
import {
	type IntentContext,
	type IntentKeepAwakeService,
	type IntentWebSearchKeyService,
	WorkspaceIntentError,
} from "../src/core/protocol/intents/types.ts";
import { queryRegistry } from "../src/core/protocol/queries/index.ts";
import { queryErrorReason, rejectionReason } from "../src/core/protocol/server/connection.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { type IrohRemotePrReviewRpcBackend, PrReviewPreparationError } from "../src/core/remote/iroh/pr-review-rpc.ts";
import type {
	IrohRemoteSessionContext,
	IrohRemoteSessionContextsRpcBackend,
} from "../src/core/remote/iroh/session-contexts.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorktreeRpcBackend, IrohRemoteWorktreeSummary } from "../src/core/remote/iroh/worktree-rpc.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import type { KeepAwakeStatus } from "../src/daemon/keep-awake.ts";
import {
	admitRemoteIntent,
	LEASE_DRAINING_RETRY_AFTER_MS,
	listRemoteWorkspaceSessions,
	type RemoteIntentHost,
	type RemoteIntentServicesOptions,
	type RemoteSessionRuntimeState,
	type RemoteStreamScope,
	remoteIntentServices,
	remoteStreamAllows,
	toRemoteKeepAwakeStatus,
} from "../src/daemon/remote-intents.ts";
import { createSessionManagerTestOwner, type SessionManagerTestOwner } from "./session-manager-owner.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";
import { seedSession } from "./utilities/seed-log.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
type WorkspaceScope = Extract<RemoteStreamScope, { kind: "discovery" | "management" }>;
type HostOverrides = Partial<Omit<RemoteIntentHost, "agentDir" | "auditLogger">>;

const GRANT: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };
const T0 = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";
const PR_URL = "https://github.com/volt-hq/volt/pull/42";

interface FakeHost extends RemoteIntentHost {
	/** Every audit event the services logged, in order. */
	readonly audit: IrohRemoteAuditEvent[];
}

/** The daemon's backends as fakes: each test supplies the ones it exercises; the rest fail if called. */
function fakeHost(agentDir: string, overrides: HostOverrides = {}): FakeHost {
	const audit: IrohRemoteAuditEvent[] = [];
	const unexpected = (what: string) => (): never => {
		throw new Error(`${what} is not part of this test`);
	};
	return {
		agentDir,
		audit,
		auditLogger: new IrohRemoteAuditLogger({
			now: () => 0,
			sink: {
				write: (event) => {
					audit.push(event);
				},
			},
		}),
		stateManager: new IrohRemoteHostStateManager(),
		pushTargets: () => ({ register: unexpected("push targets") }),
		worktrees: unexpected("worktrees"),
		agentOptions: unexpected("agent options"),
		sessionContexts: unexpected("session contexts"),
		prReviews: unexpected("pull request reviews"),
		unregisterWorkspace: unexpected("unregistering"),
		...overrides,
	};
}

function authorizationFor(
	workspacePath: string,
	options: { workspaceGeneration?: number } = {},
): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: GRANT,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		...(options.workspaceGeneration === undefined ? {} : { workspaceGeneration: options.workspaceGeneration }),
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

/** A stored session of the workspace: one prompt and answer at `at`. */
async function storeSession(
	sessionDir: string,
	options: { id: string; cwd: string; at: number; firstMessage?: string; name?: string; origin?: "subagent" },
): Promise<void> {
	const manager = await SessionManager.create(options.cwd, sessionDir, {
		id: options.id,
		...(options.origin === undefined ? {} : { origin: options.origin }),
	});
	await seedSession(
		manager,
		(seed) => {
			seed.user(options.firstMessage ?? `${options.id} prompt`);
			seed.assistant("done");
			if (options.name !== undefined) seed.sessionName(options.name);
		},
		{ at: options.at },
	);
}

function byId<T extends { sessionId: string }>(items: readonly T[]): Map<string, T> {
	return new Map(items.map((item) => [item.sessionId, item]));
}

/** The relay a phone's conversation stream is relayed over, kept by a workspace unregister. */
const RELAY_ID = "relay-1";

/**
 * Run a relayed phone frame as the daemon runs a worker's `worker_forward`:
 * with the relay's authorization and the relay scope of the conversation.
 */
function relayToDaemon(
	host: RemoteIntentHost,
	authorization: IrohRemoteClientAuthorizationSuccess,
	sessionId: string,
): (frame: ControlRelayFrame) => Promise<ControlRelayOutcome> {
	return async (frame) => {
		const ctx: IntentContext = {
			services: remoteIntentServices(
				host,
				authorization,
				{ kind: "relay", sessionId },
				{ keep: { relayIds: new Set([RELAY_ID]) } },
			),
			profile: { name: "remote", grant: GRANT },
		};
		if (frame.type === "query") {
			try {
				return {
					type: "result",
					queryId: frame.queryId,
					data: await queryRegistry.runFrame(ctx, frame.query, frame.params),
				};
			} catch (error) {
				return { type: "query_error", queryId: frame.queryId, reason: queryErrorReason(error) };
			}
		}
		try {
			const invocation = await intentRegistry.invokeFrame(ctx, frame.type, frame.input);
			return {
				type: "accepted",
				intentId: frame.intentId,
				ordinals: invocation.ordinals,
				...(invocation.result === undefined ? {} : { result: invocation.result }),
			};
		} catch (error) {
			return { type: "rejected", intentId: frame.intentId, reason: rejectionReason(error) };
		}
	};
}

describe("listRemoteWorkspaceSessions", () => {
	let root: string;
	let workspacePath: string;
	let agentDir: string;
	let worktreePath: string;
	let owner: SessionManagerTestOwner;

	beforeAll(async () => {
		root = mkdtempSync(join(tmpdir(), "volt-remote-sessions-"));
		workspacePath = join(root, "repo");
		agentDir = join(root, "agent");
		worktreePath = join(agentDir, "worktrees", "--ws--", "fix-login");
		for (const path of [
			join(workspacePath, "packages", "app"),
			join(root, "elsewhere"),
			join(worktreePath, "packages", "coding-agent"),
		]) {
			mkdirSync(path, { recursive: true });
		}
		owner = createSessionManagerTestOwner();
		owner.start();
		const sessionDir = getDefaultSessionDir(workspacePath, agentDir);
		await storeSession(sessionDir, { id: "s-root", cwd: workspacePath, at: T0 });
		await storeSession(sessionDir, {
			id: "s-sub",
			cwd: join(workspacePath, "packages", "app"),
			at: T0 + MINUTE,
			name: "Subfolder work",
		});
		await storeSession(sessionDir, { id: "s-outside", cwd: join(root, "elsewhere"), at: T0 + 2 * MINUTE });
		await storeSession(sessionDir, { id: "s-subagent", cwd: workspacePath, at: T0 + 3 * MINUTE, origin: "subagent" });
		await storeSession(sessionDir, {
			id: "s-worktree",
			cwd: join(worktreePath, "packages", "coding-agent"),
			at: T0 + 4 * MINUTE,
		});
		await storeSession(sessionDir, { id: "s-worktree-root", cwd: worktreePath, at: T0 + 5 * MINUTE });
		await storeSession(sessionDir, {
			id: "s-long",
			cwd: workspacePath,
			at: T0 + 6 * MINUTE,
			firstMessage: "🧪".repeat(200),
			name: "n".repeat(200),
		});
	});

	afterAll(async () => {
		await owner.drain();
		rmSync(root, { recursive: true, force: true });
	});

	it("lists the workspace's stored sessions newest first, with working directories relative to the workspace", async () => {
		const sessions = await listRemoteWorkspaceSessions(
			{ agentDir, stateManager: new IrohRemoteHostStateManager() },
			authorizationFor(workspacePath),
			"s-sub",
		);

		expect(sessions.map((session) => session.sessionId)).toEqual([
			"s-long",
			"s-worktree-root",
			"s-worktree",
			"s-subagent",
			"s-outside",
			"s-sub",
			"s-root",
		]);
		const sessionsById = byId(sessions);
		// The relayed conversation's session is the current one.
		expect(sessions.filter((session) => session.current).map((session) => session.sessionId)).toEqual(["s-sub"]);
		expect(sessionsById.get("s-sub")).toMatchObject({
			sessionName: "Subfolder work",
			firstMessage: "s-sub prompt",
			messageCount: 2,
			workingDirectory: "packages/app",
			modifiedAt: expect.any(String),
			createdAt: expect.any(String),
		});
		// At the workspace root, and outside the workspace, a session has no working directory.
		expect(sessionsById.get("s-root")).not.toHaveProperty("workingDirectory");
		expect(sessionsById.get("s-outside")).not.toHaveProperty("workingDirectory");
		expect(sessionsById.get("s-subagent")?.origin).toBe("subagent");
		expect(sessionsById.get("s-root")).not.toHaveProperty("origin");
		// No host path reaches the listing.
		expect(JSON.stringify(sessions)).not.toContain(root);
	});

	it("attributes worktree sessions to their worktree and registered working directory, never the checkout path", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: workspacePath });
		await stateManager.upsertWorktree({
			id: "fix-login",
			workspaceName: "ws",
			path: worktreePath,
			sourceRootRelativePath: "Volt",
			branch: "volt/fix-login",
			createdAt: 1,
			sessionIds: [],
		});
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-worktree");
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-worktree-root");
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-unlisted");

		const sessionsById = byId(
			await listRemoteWorkspaceSessions({ agentDir, stateManager }, authorizationFor(workspacePath)),
		);

		expect(sessionsById.get("s-worktree")).toMatchObject({
			worktreeId: "fix-login",
			workingDirectory: "Volt/packages/coding-agent",
		});
		expect(sessionsById.get("s-worktree-root")).toMatchObject({ worktreeId: "fix-login", workingDirectory: "Volt" });
		expect(sessionsById.get("s-root")).not.toHaveProperty("worktreeId");
		expect(sessionsById.has("s-unlisted")).toBe(false);
		expect(JSON.stringify([...sessionsById.values()])).not.toContain(agentDir);
	});

	it("joins the daemon's runtime state and its work association for the stream's workspace generation", async () => {
		const runtimeStates = new Map<string, RemoteSessionRuntimeState>([
			["s-root", "tui-owned"],
			["s-sub", "daemon-active"],
			["s-outside", "daemon-detached"],
			["s-subagent", "daemon-draining"],
			["s-gone", "daemon-active"],
		]);
		const listRuntimeStates = vi.fn(() => runtimeStates);
		const getChangeContext = vi.fn((_workspaceName: string, _generation: number, sessionId: string) =>
			sessionId === "s-sub"
				? {
						changeId: "change-1",
						repository: "Volt",
						branch: "feature/work",
						resolutionState: "resolved" as const,
						pullRequest: {
							provider: "github",
							number: 42,
							title: "Work",
							status: "open" as const,
							stale: false,
							// Fields the work store must never project; the listing drops them anyway.
							url: "https://github.com/owner/volt/pull/42",
						},
						checkoutPath: "/host/checkout",
					}
				: undefined,
		);
		const host = { agentDir, stateManager: new IrohRemoteHostStateManager(), listRuntimeStates, getChangeContext };

		const sessions = await listRemoteWorkspaceSessions(
			host,
			authorizationFor(workspacePath, { workspaceGeneration: 7 }),
		);
		const sessionsById = byId(sessions);

		expect(listRuntimeStates).toHaveBeenCalledWith("ws");
		expect(sessionsById.get("s-root")?.runtimeState).toBe("tui-owned");
		expect(sessionsById.get("s-sub")?.runtimeState).toBe("daemon-active");
		expect(sessionsById.get("s-outside")?.runtimeState).toBe("daemon-detached");
		expect(sessionsById.get("s-subagent")?.runtimeState).toBe("daemon-draining");
		expect(sessionsById.get("s-long")).not.toHaveProperty("runtimeState");
		expect(sessionsById.has("s-gone")).toBe(false);

		expect(getChangeContext).toHaveBeenCalledTimes(sessions.length);
		for (const session of sessions) expect(getChangeContext).toHaveBeenCalledWith("ws", 7, session.sessionId);
		expect(sessionsById.get("s-sub")?.changeContext).toEqual({
			changeId: "change-1",
			repository: "Volt",
			branch: "feature/work",
			resolutionState: "resolved",
			pullRequest: { provider: "github", number: 42, title: "Work", status: "open", stale: false },
		});
		expect(sessionsById.get("s-root")).not.toHaveProperty("changeContext");

		// Without the workspace's registration generation, no work association is looked up.
		getChangeContext.mockClear();
		const withoutGeneration = await listRemoteWorkspaceSessions(host, authorizationFor(workspacePath));
		expect(getChangeContext).not.toHaveBeenCalled();
		expect(withoutGeneration.some((session) => session.changeContext !== undefined)).toBe(false);
	});

	it("bounds session titles and first messages to 160 Unicode scalars", async () => {
		const sessionsById = byId(
			await listRemoteWorkspaceSessions(
				{ agentDir, stateManager: new IrohRemoteHostStateManager() },
				authorizationFor(workspacePath),
			),
		);
		const long = sessionsById.get("s-long");
		expect(Array.from(long?.firstMessage ?? "")).toEqual(Array.from("🧪".repeat(160)));
		expect(long?.sessionName).toBe("n".repeat(160));
	});

	it("redacts titles before it cuts them, so no part of a root survives the cut", async () => {
		// Under the suite's root, removed once the session store drained.
		const cutRoot = join(root, "titles");
		const cutWorkspace = join(cutRoot, "repo");
		const cutAgentDir = join(cutRoot, "agent");
		const checkout = join(cutAgentDir, "worktrees", "--ws--", "fix-login");
		mkdirSync(cutWorkspace, { recursive: true });
		// The 160-scalar cut lands inside the workspace root and inside a worktree checkout.
		await storeSession(getDefaultSessionDir(cutWorkspace, cutAgentDir), {
			id: "s-cut-root",
			cwd: cutWorkspace,
			at: T0,
			firstMessage: `${"x".repeat(160 - Math.floor(cutWorkspace.length / 2) - 1)} ${cutWorkspace}/src/index.ts`,
			name: `${"y".repeat(160 - Math.floor(checkout.length / 2) - 1)} ${checkout}/src/index.ts`,
		});
		const [cut] = await listRemoteWorkspaceSessions(
			{ agentDir: cutAgentDir, stateManager: new IrohRemoteHostStateManager() },
			authorizationFor(cutWorkspace),
		);
		expect(cut?.firstMessage).toContain(" /workspace/");
		expect(cut?.sessionName).toContain(" /workspace/");
		// Without redaction first, the cut would have left the first half of each root.
		expect(JSON.stringify(cut)).not.toContain(cutWorkspace.slice(0, Math.floor(cutWorkspace.length / 2)));
		expect(JSON.stringify(cut)).not.toContain(checkout.slice(0, Math.floor(checkout.length / 2)));
	});

	it("keeps the listing when worktree attribution or runtime presence fails", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		vi.spyOn(stateManager, "listWorktrees").mockRejectedValue(new Error("state unavailable"));
		const sessions = await listRemoteWorkspaceSessions(
			{
				agentDir,
				stateManager,
				listRuntimeStates: () => {
					throw new Error("lease broker unavailable");
				},
			},
			authorizationFor(workspacePath),
		);
		expect(sessions).toHaveLength(7);
		expect(sessions.some((session) => session.worktreeId !== undefined || session.runtimeState !== undefined)).toBe(
			false,
		);
	});
});

describe("remote intent services over protocol frames", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "volt-remote-intents-"));
		cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
		return dir;
	}

	/** A workspace stream of `scope`, served as the daemon serves it. */
	async function workspaceStream(
		host: RemoteIntentHost,
		authorization: IrohRemoteClientAuthorizationSuccess,
		scope: WorkspaceScope,
		options: Partial<RemoteIntentServicesOptions> = {},
	): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const allows = remoteStreamAllows(scope);
		const connection = serveIrohRemoteConnection({
			stream: pair.host,
			grant: GRANT,
			redaction: { workspacePath: authorization.workspace.path, remoteWorkspacePath: "/workspace" },
			services: () =>
				remoteIntentServices(host, authorization, scope, { keep: { streamId: "stream-1" }, ...options }),
			...(allows === undefined ? {} : { allows }),
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		const welcome = await phone.hello();
		expect(welcome).not.toHaveProperty("conversation");
		return phone;
	}

	interface Admission {
		shuttingDown: boolean;
		draining: boolean;
		subagent: boolean;
	}

	interface ConversationSetup {
		harness: HostHarness;
		conversation: HostedConversation;
		workspacePath: string;
		agentDir: string;
	}

	/** A worker-hosted conversation whose session lives in a subfolder of the workspace, stored with the workspace's sessions. */
	async function hostedConversation(): Promise<ConversationSetup> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const workspacePath = join(harness.tempDir, "repo");
		const agentDir = join(harness.tempDir, "agent");
		const cwd = join(workspacePath, "packages", "app");
		mkdirSync(cwd, { recursive: true });
		const sessionManager = await SessionManager.create(cwd, getDefaultSessionDir(workspacePath, agentDir));
		const opened = await harness.host.open({ kind: "adopt", sessionManager });
		if (opened.cancelled) throw new Error("Opening the conversation was cancelled");
		return { harness, conversation: opened.conversation, workspacePath, agentDir };
	}

	/**
	 * A phone's conversation stream, served as the worker hosting the
	 * conversation serves it (servePhoneRelay): the daemon's intents and
	 * queries are relayed to the daemon, and the rest are the conversation's own.
	 */
	async function conversationStream(
		setup: ConversationSetup,
		host: RemoteIntentHost,
		options: { admission?: Admission; authorization?: IrohRemoteClientAuthorizationSuccess } = {},
	): Promise<RemotePhone> {
		const { harness, conversation } = setup;
		const authorization = options.authorization ?? authorizationFor(setup.workspacePath);
		const admission = options.admission ?? { shuttingDown: false, draining: false, subagent: false };
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: GRANT,
			redaction: { workspacePath: authorization.workspace.path, remoteWorkspacePath: "/workspace" },
			redirect: {},
			services: () => ({ workspace: { name: authorization.workspace.name } }),
			relay: relayToDaemon(host, authorization, conversation.id),
			admit: (intent) => admitRemoteIntent(intent, admission),
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		expect(await phone.hello()).toMatchObject({ conversation: conversation.id, profile: "remote" });
		return phone;
	}

	it("answers the relayed sessions query with the workspace's stored sessions, the conversation's current", async () => {
		const setup = await hostedConversation();
		const { conversation, workspacePath, agentDir } = setup;
		const owner = createSessionManagerTestOwner();
		owner.start();
		cleanups.push(() => owner.drain());
		await storeSession(getDefaultSessionDir(workspacePath, agentDir), { id: "s-root", cwd: workspacePath, at: T0 });
		await conversation.session.prompt("hello from the phone");

		const phone = await conversationStream(setup, fakeHost(agentDir));
		const first = await phone.query("sessions", { limit: 1 });
		expect(first).toMatchObject({
			type: "result",
			data: {
				sessions: [
					{
						sessionId: conversation.id,
						current: true,
						firstMessage: "hello from the phone",
						workingDirectory: "packages/app",
					},
				],
				hasMore: true,
				nextCursor: "1",
			},
		});
		const rest = await phone.query("sessions", { cursor: "1" });
		expect(rest).toMatchObject({
			type: "result",
			data: { sessions: [{ sessionId: "s-root", current: false }], hasMore: false, nextCursor: null },
		});
		// The open conversation is listed once, from its log.
		const all = (await phone.query("sessions")) as Frame<"result">;
		const listed = (all.data as { sessions: Array<{ sessionId: string }> }).sessions.map((item) => item.sessionId);
		expect(listed).toEqual([conversation.id, "s-root"]);
		expect(await phone.query("sessions", { cursor: "later" })).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(JSON.stringify(phone.frames)).not.toContain(setup.harness.tempDir);
	});

	it("unregisters only the stream's workspace, keeping the requesting relay, audits each outcome, and ends the stream", async () => {
		const setup = await hostedConversation();
		const unregisterWorkspace = vi
			.fn<RemoteIntentHost["unregisterWorkspace"]>()
			.mockRejectedValueOnce(new WorkspaceIntentError("workspace_has_worktrees", { worktreeCount: 1 }))
			.mockResolvedValueOnce({ closedStreamCount: 2, stoppedRuntimeCount: 1 });
		const host = fakeHost(setup.agentDir, { unregisterWorkspace });
		const phone = await conversationStream(setup, host);

		expect(await phone.intent("unregister_workspace", { workspaceName: "other" })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input", message: "session_mismatch" },
		});
		expect(unregisterWorkspace).not.toHaveBeenCalled();
		expect(host.audit).toEqual([]);

		expect(await phone.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "workspace_has_worktrees" },
		});
		const from = phone.frames.length;
		expect(await phone.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "accepted",
			result: { workspaceName: "ws", unregistered: true },
		});
		expect(unregisterWorkspace).toHaveBeenCalledWith("ws", { relayIds: new Set([RELAY_ID]) });
		// The accepted answer is the stream's last frame before it ends.
		await phone.waitFor(
			(frame): frame is Frame<"fatal"> => frame.type === "fatal" && frame.code === "workspace_unregistered",
			{ from },
		);
		expect(host.audit).toEqual([
			{
				type: "workspace_unregistered",
				timestamp: 0,
				clientNodeId: "n-phone",
				workspace: "ws",
				success: false,
				error: "workspace_has_worktrees",
				details: { source: "remote_rpc", worktreeCount: 1 },
			},
			{
				type: "workspace_unregistered",
				timestamp: 0,
				clientNodeId: "n-phone",
				workspace: "ws",
				success: true,
				details: { closedStreamCount: 2, stoppedRuntimeCount: 1, source: "remote_rpc" },
			},
		]);
	});

	it("begins and ends a workspace stream's own unregister around the registry change, keeping that stream", async () => {
		const workspacePath = tempDir();
		const unregisterWorkspace = vi
			.fn<RemoteIntentHost["unregisterWorkspace"]>()
			.mockRejectedValueOnce(new WorkspaceIntentError("workspace_has_worktrees", { worktreeCount: 1 }))
			.mockResolvedValueOnce({ closedStreamCount: 0, stoppedRuntimeCount: 0 });
		const host = fakeHost(join(workspacePath, "agent"), { unregisterWorkspace });
		const lifecycle: string[] = [];
		const phone = await workspaceStream(
			host,
			authorizationFor(workspacePath),
			{ kind: "management", purpose: "unregister_workspace" },
			{
				workspaceUnregister: {
					begin: () => lifecycle.push("begin"),
					end: (succeeded) => lifecycle.push(`end:${succeeded}`),
				},
			},
		);

		expect(await phone.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "workspace_has_worktrees" },
		});
		expect(await phone.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "accepted",
			result: { workspaceName: "ws", unregistered: true },
		});
		expect(unregisterWorkspace).toHaveBeenCalledWith("ws", { streamId: "stream-1" });
		expect(lifecycle).toEqual(["begin", "end:false", "begin", "end:true"]);
		expect(host.audit.map((event) => [event.success, event.details?.source])).toEqual([
			[false, "remote_workspace_management_stream"],
			[true, "remote_workspace_management_stream"],
		]);
	});

	it("sets keep-awake and the web search key through the daemon, never echoing the key or the host mechanism", async () => {
		const setup = await hostedConversation();
		let keepAwake: KeepAwakeStatus = { enabled: false, state: "disabled" };
		const keepAwakeService: IntentKeepAwakeService = {
			status: () => toRemoteKeepAwakeStatus(keepAwake),
			setEnabled: (enabled) => {
				keepAwake = enabled
					? { enabled, state: "active", method: "systemd-inhibit" }
					: { enabled, state: "disabled", method: "systemd-inhibit" };
				return toRemoteKeepAwakeStatus(keepAwake);
			},
		};
		const keys: Array<string | null> = [];
		let stored: string | null = null;
		const webSearchKey: IntentWebSearchKeyService = {
			get configured() {
				return stored !== null;
			},
			set(apiKey) {
				keys.push(apiKey);
				stored = apiKey;
			},
		};
		const host = fakeHost(setup.agentDir, {
			keepAwake: keepAwakeService,
			webSearchKey,
			hostTheme: () => ({ themeName: "dark", tokens: { accent: "#123456" } }),
		});
		const phone = await conversationStream(setup, host);

		const from = phone.frames.length;
		expect(await phone.intent("set_keep_awake", { enabled: true })).toMatchObject({
			type: "accepted",
			result: { enabled: true, state: "active" },
		});
		await phone.waitFor((frame): frame is Frame<"changed"> => frame.type === "changed" && frame.catalog === "host", {
			from,
		});
		expect(await phone.query("host_status")).toMatchObject({
			type: "result",
			data: {
				keepAwake: { enabled: true, state: "active" },
				theme: { themeName: "dark", tokens: { accent: "#123456" } },
			},
		});

		expect(await phone.intent("set_web_search_key", { apiKey: "  brave-key-123  " })).toMatchObject({
			type: "accepted",
			result: { configured: true },
		});
		expect(await phone.query("web_search_status")).toMatchObject({
			type: "result",
			data: { webSearch: { configured: true } },
		});
		for (const input of [{ apiKey: "   " }, { apiKey: null }, {}]) {
			expect(await phone.intent("set_web_search_key", input)).toMatchObject({
				type: "accepted",
				result: { configured: false },
			});
		}
		expect(await phone.intent("set_web_search_key", { apiKey: 42 })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});
		expect(keys).toEqual(["brave-key-123", null, null, null]);

		const wire = JSON.stringify(phone.frames);
		expect(wire).not.toContain("brave-key-123");
		expect(wire).not.toContain("systemd-inhibit");
	});

	it("reports keep-awake and the web search key unsupported where the daemon has no such service", async () => {
		const setup = await hostedConversation();
		const phone = await conversationStream(setup, fakeHost(setup.agentDir));
		expect(await phone.intent("set_keep_awake", { enabled: true })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable", message: "unsupported_remote_command" },
		});
		expect(await phone.intent("set_web_search_key", { apiKey: "key" })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable", message: "unsupported_remote_command" },
		});
		for (const query of ["host_status", "web_search_status"]) {
			expect(await phone.query(query)).toMatchObject({
				type: "query_error",
				reason: { code: "unavailable", message: "unsupported_remote_command" },
			});
		}
	});

	it("uploads device logs under the workspace through the daemon, which audits each upload", async () => {
		const setup = await hostedConversation();
		const host = fakeHost(setup.agentDir);
		const phone = await conversationStream(setup, host);

		expect(await phone.intent("upload_device_logs", { fileName: "phone.log", content: "line one\n" })).toMatchObject({
			type: "accepted",
			result: { path: ".volt/device-logs/phone.log", byteCount: 9 },
		});
		expect(readFileSync(join(setup.workspacePath, ".volt", "device-logs", "phone.log"), "utf8")).toBe("line one\n");

		const refused = await phone.intent("upload_device_logs", { fileName: ".hidden", content: "x" });
		expect(refused).toMatchObject({ type: "rejected", reason: { code: "failed" } });
		const error = refused.type === "rejected" ? refused.reason.message : "";
		expect(error).toMatch(/^"fileName" must/);
		expect(existsSync(join(setup.workspacePath, ".volt", "device-logs", ".hidden"))).toBe(false);

		expect(host.audit).toEqual([
			{
				type: "device_log_uploaded",
				timestamp: 0,
				clientNodeId: "n-phone",
				workspace: "ws",
				success: true,
				details: { path: ".volt/device-logs/phone.log", byteCount: 9 },
			},
			{
				type: "device_log_uploaded",
				timestamp: 0,
				clientNodeId: "n-phone",
				workspace: "ws",
				success: false,
				error,
			},
		]);
	});

	it("admits work on the host's terms, relayed intents too: draining is busy, shutdown refuses work, subagents only stop", async () => {
		const setup = await hostedConversation();
		const keepAwake: IntentKeepAwakeService = {
			status: () => ({ enabled: false, state: "disabled" }),
			setEnabled: (enabled) => ({ enabled, state: enabled ? "active" : "disabled" }),
		};
		const admission: Admission = { shuttingDown: false, draining: true, subagent: false };
		const phone = await conversationStream(setup, fakeHost(setup.agentDir, { keepAwake }), { admission });
		await phone.subscribe(setup.conversation.id);

		expect(await phone.intent("prompt", { message: "while draining" })).toMatchObject({
			type: "rejected",
			reason: { code: "busy", retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS },
		});
		// Settings and observation are not work: they run while the conversation hands off.
		expect(await phone.intent("set_keep_awake", { enabled: true })).toMatchObject({ type: "accepted" });

		admission.draining = false;
		admission.shuttingDown = true;
		for (const [type, input] of [
			["prompt", { message: "during shutdown" }],
			["skill.review", { arguments: "" }],
		] as const) {
			expect(await phone.intent(type, input)).toMatchObject({
				type: "rejected",
				reason: { code: "host_shutdown" },
			});
		}
		expect(await phone.intent("abort")).toMatchObject({ type: "accepted" });

		admission.shuttingDown = false;
		admission.subagent = true;
		for (const [type, input] of [
			["prompt", { message: "into a delegated run" }],
			["set_keep_awake", { enabled: false }],
		] as const) {
			expect(await phone.intent(type, input)).toMatchObject({ type: "rejected", reason: { code: "read_only" } });
		}
		expect(await phone.intent("abort")).toMatchObject({ type: "accepted" });

		// No refused prompt reached the conversation.
		expect(setup.conversation.session.messages).toEqual([]);
	});

	it("serves worktree creation and listing on conversation streams but keeps removal and review preparation off them", async () => {
		const setup = await hostedConversation();
		const backend: IrohRemoteWorktreeRpcBackend = {
			createWorktree: vi.fn(async () => ({
				ok: true as const,
				worktree: { id: "fix-login", branch: "volt/fix-login", createdAt: 1, sessionIds: [] },
			})),
			listWorktrees: vi.fn(async () => ({ ok: true as const, worktrees: [] })),
			removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 0, closedStreamCount: 0 })),
		};
		const prReviews = vi.fn<RemoteIntentHost["prReviews"]>();
		const host = fakeHost(setup.agentDir, { worktrees: () => backend, prReviews });
		const phone = await conversationStream(setup, host);

		expect(await phone.intent("create_worktree", { worktreeName: "fix-login" })).toMatchObject({
			type: "accepted",
			result: { worktree: { id: "fix-login" } },
		});
		expect(await phone.query("worktrees")).toMatchObject({ type: "result", data: { worktrees: [] } });
		expect(await phone.intent("remove_worktree", { worktreeId: "fix-login" })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable", message: "unsupported_remote_command" },
		});
		expect(
			await phone.intent("prepare_pr_review", {
				sessionId: "s-review",
				expectedPullRequest: { url: PR_URL, headRefOid: HEAD_OID },
			}),
		).toMatchObject({ type: "rejected", reason: { code: "unavailable" } });
		expect(backend.removeWorktree).not.toHaveBeenCalled();
		expect(prReviews).not.toHaveBeenCalled();
		expect(host.audit.map((event) => event.details?.source)).toEqual(["remote_rpc"]);
	});

	it("manages worktrees with summaries that carry no checkout path, and audits each change", async () => {
		const root = tempDir();
		const workspacePath = join(root, "repo");
		const agentDir = join(root, "agent");
		const checkout = join(agentDir, "worktrees", "--ws--", "fix-login");
		// The backend's records carry host fields; only the summary's fields may reach the device.
		const record = {
			id: "fix-login",
			workspaceName: "ws",
			path: checkout,
			sourceRootRelativePath: "Volt",
			branch: "volt/fix-login",
			baseRef: "main",
			createdAt: 1,
			sessionIds: ["s-1"],
			disposable: true,
		};
		const listed = { ...record, available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } };
		const summary: IrohRemoteWorktreeSummary = {
			id: "fix-login",
			branch: "volt/fix-login",
			baseRef: "main",
			createdAt: 1,
			sessionIds: ["s-1"],
		};
		const backend: IrohRemoteWorktreeRpcBackend = {
			createWorktree: vi
				.fn<IrohRemoteWorktreeRpcBackend["createWorktree"]>()
				.mockResolvedValueOnce({ ok: true, worktree: record })
				.mockResolvedValueOnce({ ok: false, error: "worktree_exists", detail: `${checkout} exists` }),
			listWorktrees: vi.fn(async () => ({ ok: true as const, worktrees: [listed] })),
			removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 1, closedStreamCount: 2 })),
		};
		const host = fakeHost(agentDir, { worktrees: () => backend });
		const phone = await workspaceStream(host, authorizationFor(workspacePath), {
			kind: "management",
			purpose: "manage_worktrees",
		});

		const created = await phone.intent("create_worktree", { worktreeName: "fix-login", baseRef: "main" });
		expect(created).toMatchObject({ type: "accepted" });
		expect(created.type === "accepted" ? created.result : undefined).toEqual({ worktree: summary });
		expect(backend.createWorktree).toHaveBeenCalledWith("ws", { id: "fix-login", baseRef: "main" });

		const worktrees = await phone.query("worktrees");
		expect(worktrees.type === "result" ? worktrees.data : undefined).toEqual({
			worktrees: [{ ...summary, available: true, dirty: false, aheadBehind: { ahead: 1, behind: 0 } }],
		});

		expect(await phone.intent("create_worktree", { worktreeName: "fix-login" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "worktree_exists" },
		});
		expect(await phone.intent("remove_worktree", { worktreeId: "fix-login", force: true })).toMatchObject({
			type: "accepted",
			result: { worktreeId: "fix-login", removed: true, stoppedRuntimeCount: 1, closedStreamCount: 2 },
		});
		expect(backend.removeWorktree).toHaveBeenCalledWith("ws", "fix-login", true);

		const source = "remote_workspace_management_stream";
		expect(host.audit).toEqual([
			expect.objectContaining({
				type: "worktree_created",
				success: true,
				details: { worktreeId: "fix-login", branch: "volt/fix-login", source },
			}),
			expect.objectContaining({
				type: "worktree_created",
				success: false,
				error: "worktree_exists",
				details: { source },
			}),
			expect.objectContaining({
				type: "worktree_removed",
				success: true,
				details: { worktreeId: "fix-login", force: true, stoppedRuntimeCount: 1, source },
			}),
		]);
		const wire = JSON.stringify(phone.frames);
		expect(wire).not.toContain("worktrees/--ws--");
		expect(wire).not.toContain("sourceRootRelativePath");
		expect(wire).not.toContain("disposable");
	});

	it("serves each workspace stream its purpose only", async () => {
		const workspacePath = tempDir();
		const host = fakeHost(join(workspacePath, "agent"));
		const sessions = await workspaceStream(host, authorizationFor(workspacePath), {
			kind: "discovery",
			purpose: "list_sessions",
		});
		expect(await sessions.query("sessions")).toMatchObject({
			type: "result",
			data: { sessions: [], hasMore: false },
		});
		for (const query of ["agent_options", "worktrees", "host_status", "intents"]) {
			expect(await sessions.query(query)).toMatchObject({ type: "query_error", reason: { code: "unavailable" } });
		}
		expect(await sessions.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});

		const unregister = await workspaceStream(host, authorizationFor(workspacePath), {
			kind: "management",
			purpose: "unregister_workspace",
		});
		expect(await unregister.intent("create_worktree", { worktreeName: "fix-login" })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
		expect(await unregister.query("sessions")).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
	});

	describe("pull request review answers", () => {
		const pullRequest = {
			provider: "github" as const,
			url: PR_URL,
			number: 42,
			title: "Fix login",
			repository: "volt-hq/volt",
			headRefName: "fix-login",
			headRefOid: HEAD_OID,
		};

		it("resolves a review only when the answer matches the request", async () => {
			const workspacePath = tempDir();
			const answers: Array<() => Promise<PrReviewResolveResponse>> = [
				// A backend answer carries more than the pull request summary; the device gets the summary.
				async () =>
					({
						workspaceName: "ws",
						pullRequest: { ...pullRequest, body: "secret", checkoutPath: workspacePath },
					}) as PrReviewResolveResponse,
				async () => ({ workspaceName: "other", pullRequest }),
				async () => ({ workspaceName: "ws", pullRequest: { ...pullRequest, number: 43 } }),
				async () => ({ workspaceName: "ws", pullRequest: { ...pullRequest, url: "http://insecure.example/pr" } }),
				async () => Promise.reject(new PrReviewPreparationError("review_preparation_stale")),
				async () => Promise.reject(new Error(`gh pr view failed in ${workspacePath}`)),
			];
			const resolvePrReview = vi.fn<IrohRemotePrReviewRpcBackend["resolvePrReview"]>(() => {
				const next = answers.shift();
				if (!next) throw new Error("No answer left");
				return next();
			});
			const prReviews = vi.fn<RemoteIntentHost["prReviews"]>(() => ({
				resolvePrReview,
				preparePrReview: () => Promise.reject(new Error("not part of this test")),
			}));
			const phone = await workspaceStream(
				fakeHost(join(workspacePath, "agent"), { prReviews }),
				authorizationFor(workspacePath),
				{
					kind: "discovery",
					purpose: "review",
				},
			);

			const resolved = await phone.query("pr_review", { number: "42" });
			expect(resolved.type === "result" ? resolved.data : undefined).toEqual({ workspaceName: "ws", pullRequest });
			expect(resolvePrReview).toHaveBeenCalledWith("ws", { number: "42" });
			for (const expected of [
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_stale",
				"review_preparation_failed",
			]) {
				expect(await phone.query("pr_review", { number: "42" })).toMatchObject({
					type: "query_error",
					reason: { code: "failed", message: expected },
				});
			}
			expect(JSON.stringify(phone.frames)).not.toContain("gh pr view");
			expect(JSON.stringify(phone.frames)).not.toContain("secret");
			expect(
				await phone.intent("prepare_pr_review", {
					sessionId: "s-review",
					expectedPullRequest: { url: PR_URL, headRefOid: HEAD_OID },
				}),
			).toMatchObject({ type: "rejected", reason: { code: "unavailable" } });
		});

		it("prepares a review only when the answer matches the request", async () => {
			const workspacePath = tempDir();
			const request = {
				sessionId: "s-review",
				number: "42",
				expectedPullRequest: { url: PR_URL, headRefOid: HEAD_OID },
			};
			const prepared: PrReviewPrepareResponse = {
				workspaceName: "ws",
				sessionId: "s-review",
				worktreeId: "pr-42",
				workingDirectory: "packages/app",
				pullRequest,
				disposition: "created",
			};
			const answers: Array<() => Promise<PrReviewPrepareResponse>> = [
				async () => prepared,
				async () => ({ ...prepared, sessionId: "s-other" }),
				async () => ({ ...prepared, workspaceName: "other" }),
				async () => ({ ...prepared, pullRequest: { ...pullRequest, headRefOid: "f".repeat(40) } }),
				async () => ({ ...prepared, pullRequest: { ...pullRequest, url: `${PR_URL}0` } }),
				async () => ({ ...prepared, pullRequest: { ...pullRequest, number: 7 } }),
				async () => ({ ...prepared, workingDirectory: "../escape" }),
				async () => Promise.reject(new PrReviewPreparationError("worktree_limit_reached")),
				async () => Promise.reject(new Error(`git worktree add failed at ${workspacePath}`)),
			];
			const preparePrReview = vi.fn<IrohRemotePrReviewRpcBackend["preparePrReview"]>(() => {
				const next = answers.shift();
				if (!next) throw new Error("No answer left");
				return next();
			});
			const signals: Array<AbortSignal | undefined> = [];
			const prReviews = vi.fn<RemoteIntentHost["prReviews"]>((_authorization, signal) => {
				signals.push(signal);
				return { resolvePrReview: () => Promise.reject(new Error("not part of this test")), preparePrReview };
			});
			const controller = new AbortController();
			const phone = await workspaceStream(
				fakeHost(join(workspacePath, "agent"), { prReviews }),
				authorizationFor(workspacePath),
				{ kind: "management", purpose: "manage_worktrees" },
				{ signal: controller.signal },
			);

			const accepted = await phone.intent("prepare_pr_review", request);
			expect(accepted.type === "accepted" ? accepted.result : undefined).toEqual(prepared);
			expect(preparePrReview).toHaveBeenCalledWith("ws", request);
			expect(signals).toEqual([controller.signal]);
			for (const expected of [
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_failed",
				"review_preparation_failed",
				"worktree_limit_reached",
				"review_preparation_failed",
			]) {
				expect(await phone.intent("prepare_pr_review", request)).toMatchObject({
					type: "rejected",
					reason: { code: "failed", message: expected },
				});
			}
			expect(JSON.stringify(phone.frames)).not.toContain("git worktree add");
		});
	});

	it("answers session contexts only when each context matches the request, in order", async () => {
		const workspacePath = tempDir();
		const context = (sessionId: string): IrohRemoteSessionContext => ({
			sessionId,
			startingGitContext: null,
			changeContext: null,
		});
		const answers: IrohRemoteSessionContext[][] = [
			[context("s-a"), context("s-b")],
			[context("s-b"), context("s-a")],
			[context("s-a")],
			[context("s-a"), context("s-b"), context("s-c")],
			[context("s-a"), { ...context("s-b"), changeContext: { changeId: "c" } as never }],
		];
		const getSessionContexts = vi.fn<IrohRemoteSessionContextsRpcBackend["getSessionContexts"]>(async () => {
			const next = answers.shift();
			if (!next) throw new Error("No answer left");
			return next;
		});
		const phone = await workspaceStream(
			fakeHost(join(workspacePath, "agent"), { sessionContexts: () => ({ getSessionContexts }) }),
			authorizationFor(workspacePath),
			{ kind: "discovery", purpose: "session_contexts" },
		);

		const answered = await phone.query("session_contexts", { sessionIds: ["s-a", "s-b"] });
		expect(answered.type === "result" ? answered.data : undefined).toEqual({
			contexts: [context("s-a"), context("s-b")],
		});
		expect(getSessionContexts).toHaveBeenCalledWith("ws", ["s-a", "s-b"]);
		for (let attempt = 0; attempt < 4; attempt++) {
			expect(await phone.query("session_contexts", { sessionIds: ["s-a", "s-b"] })).toMatchObject({
				type: "query_error",
				reason: { code: "failed", message: "request_failed" },
			});
		}
	});
});

describe("remoteStreamAllows", () => {
	it("leaves streams a TUI relays unrestricted", () => {
		expect(remoteStreamAllows({ kind: "relay", sessionId: "s-1" })).toBeUndefined();
	});

	it("serves each workspace stream purpose its own intents and queries only", () => {
		const purposes: Array<{ scope: WorkspaceScope; intents: string[]; queries: string[] }> = [
			{ scope: { kind: "discovery", purpose: "list_sessions" }, intents: [], queries: ["sessions"] },
			{ scope: { kind: "discovery", purpose: "agent_options" }, intents: [], queries: ["agent_options"] },
			{ scope: { kind: "discovery", purpose: "session_contexts" }, intents: [], queries: ["session_contexts"] },
			{ scope: { kind: "discovery", purpose: "review" }, intents: [], queries: ["pr_review"] },
			{
				scope: { kind: "management", purpose: "unregister_workspace" },
				intents: ["unregister_workspace"],
				queries: [],
			},
			{
				scope: { kind: "management", purpose: "list_workspace_directories" },
				intents: [],
				queries: ["workspace_directories"],
			},
			{
				scope: { kind: "management", purpose: "manage_worktrees" },
				intents: ["create_worktree", "remove_worktree", "prepare_pr_review"],
				queries: ["worktrees"],
			},
		];
		const intents = new Set([...purposes.flatMap((purpose) => purpose.intents), "prompt", "set_keep_awake"]);
		const queries = new Set([...purposes.flatMap((purpose) => purpose.queries), "intents", "host_status", "history"]);
		for (const { scope, intents: served, queries: answered } of purposes) {
			const allows = remoteStreamAllows(scope);
			if (!allows) throw new Error(`${scope.purpose} streams must be restricted`);
			for (const intent of intents)
				expect(allows("intent", intent), `${scope.purpose}: ${intent}`).toBe(served.includes(intent));
			for (const query of queries)
				expect(allows("query", query), `${scope.purpose}: ${query}`).toBe(answered.includes(query));
		}
	});
});

describe("admitRemoteIntent", () => {
	const open = { shuttingDown: false, draining: false, subagent: false };
	const WORK = [
		"prompt",
		"steer",
		"follow_up",
		"bash",
		"compact",
		"new_session",
		"switch_session",
		"fork",
		"clone",
		"plan_execute",
		"review_uncommitted",
		"review_branch",
		"review_pr",
		"review_commit",
		"review_rerun",
		"review_open_session",
		"review_start_discussions",
		"review_reset_discussion",
		"open_work",
		"resume_work",
		"start_subagent",
		"extension.command.deploy",
		"prompt.template.fix",
		"skill.review",
	];

	it("admits everything on an open conversation", () => {
		for (const intent of [...WORK, "abort", "cancel_work", "set_model", "set_keep_awake"]) {
			expect(admitRemoteIntent(intent, open)).toBeUndefined();
		}
	});

	it("answers work busy with a retry hint while the conversation hands off to a desktop TUI", () => {
		for (const intent of WORK) {
			expect(admitRemoteIntent(intent, { ...open, draining: true })).toEqual({
				code: "busy",
				message: "Handing off to the desktop TUI; retry shortly.",
				retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
			});
		}
		expect(LEASE_DRAINING_RETRY_AFTER_MS).toBe(1000);
		for (const intent of ["abort", "set_model", "set_session_name", "set_keep_awake"]) {
			expect(admitRemoteIntent(intent, { ...open, draining: true })).toBeUndefined();
		}
	});

	it("refuses new work once the host is shutting down, before a draining hint", () => {
		for (const intent of WORK) {
			expect(admitRemoteIntent(intent, { ...open, shuttingDown: true, draining: true })).toMatchObject({
				code: "host_shutdown",
			});
		}
		// Stopping work is admitted while the host shuts down.
		for (const intent of ["abort", "abort_retry", "abort_bash", "cancel_work", "set_model"]) {
			expect(admitRemoteIntent(intent, { ...open, shuttingDown: true })).toBeUndefined();
		}
	});

	it("leaves subagent conversations observe-only: only stopping them is admitted", () => {
		const subagent = { ...open, subagent: true, shuttingDown: true, draining: true };
		for (const intent of [...WORK, "set_model", "set_session_name", "set_keep_awake"]) {
			expect(admitRemoteIntent(intent, subagent)).toEqual({
				code: "read_only",
				message: "Subagent sessions are observe-only; prompt the parent agent instead.",
			});
		}
		for (const intent of ["abort", "abort_retry", "abort_bash"]) {
			expect(admitRemoteIntent(intent, { ...open, subagent: true })).toBeUndefined();
		}
	});
});

describe("toRemoteKeepAwakeStatus", () => {
	it("never names the host mechanism", () => {
		expect(toRemoteKeepAwakeStatus({ enabled: true, state: "active", method: "caffeinate" })).toEqual({
			enabled: true,
			state: "active",
		});
		expect(
			toRemoteKeepAwakeStatus({
				enabled: true,
				state: "degraded",
				method: "systemd-inhibit",
				reason: "Keep-awake is unavailable on this host",
			}),
		).toEqual({ enabled: true, state: "degraded", reason: "Keep-awake is unavailable on this host" });
	});
});
