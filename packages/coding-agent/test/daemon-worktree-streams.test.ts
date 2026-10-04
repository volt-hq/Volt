/**
 * Workspace management streams: protocol connections without a conversation
 * on the device's remote profile, each serving the intents and queries of its
 * purpose through the daemon's remote services (src/daemon/remote-intents.ts),
 * as the daemon's Iroh service serves them.
 */

import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFrame, IrohRemoteWorkspaceManagementTarget } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceIntentError } from "../src/core/protocol/intents/types.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	getIrohRemoteStreamCapability,
	type IrohRemoteRpcGrant,
} from "../src/core/remote/iroh/access-grant.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { IrohRemoteWorktreeRpcBackend, IrohRemoteWorktreeSummary } from "../src/core/remote/iroh/worktree-rpc.ts";
import {
	type RemoteIntentHost,
	type RemoteStreamScope,
	remoteIntentServices,
	remoteStreamAllows,
} from "../src/daemon/remote-intents.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type IntentOutcome, type RemotePhone } from "./utilities/remote-phone.ts";

const HOST_WORKSPACE_PATH = "/home/user/projects/repo";
const HOST_WORKTREES_ROOT = "/home/user/.volt/agent/worktrees";
const HOST_CHECKOUT_PATH = `${HOST_WORKTREES_ROOT}/--home-user-projects-repo--/fix-login`;

function createHostRecord(): IrohRemoteWorkspaceWorktree {
	return {
		id: "fix-login",
		workspaceName: "ws",
		path: HOST_CHECKOUT_PATH,
		branch: "volt/fix-login",
		baseRef: "main",
		createdAt: 1_751_900_000_000,
		sessionIds: ["s-abc"],
	};
}

function createBackend(): IrohRemoteWorktreeRpcBackend {
	// Backend results intentionally carry host-record shapes (with `path` and
	// `workspaceName`) to prove the remote services strip them from the wire.
	const record = createHostRecord() as IrohRemoteWorktreeSummary;
	return {
		createWorktree: vi.fn(async () => ({ ok: true as const, worktree: record })),
		listWorktrees: vi.fn(async () => ({
			ok: true as const,
			worktrees: [
				{
					...createHostRecord(),
					available: true,
					dirty: false,
					aheadBehind: { ahead: 3, behind: 1 },
				} as IrohRemoteWorktreeSummary,
			],
		})),
		removeWorktree: vi.fn(async () => ({ ok: true as const, stoppedRuntimeCount: 1, closedStreamCount: 1 })),
	};
}

function createAuthorization(
	rpcGrant: IrohRemoteRpcGrant = createIrohRemotePresetAccess("full").rpcGrant,
): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: HOST_WORKSPACE_PATH },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

/** Recursively assert that no wire payload carries filesystem paths. */
function assertNoFilesystemPaths(value: unknown): void {
	if (typeof value === "string") {
		expect(value).not.toContain(HOST_WORKSPACE_PATH);
		expect(value).not.toContain(HOST_WORKTREES_ROOT);
		expect(value).not.toContain(HOST_CHECKOUT_PATH);
		return;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			assertNoFilesystemPaths(entry);
		}
		return;
	}
	if (typeof value === "object" && value !== null) {
		for (const [key, entry] of Object.entries(value)) {
			expect(key).not.toBe("path");
			expect(key).not.toBe("workspacePath");
			assertNoFilesystemPaths(entry);
		}
	}
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function unexpected(name: string): never {
	throw new Error(`${name} is not served on a workspace management stream`);
}

interface WorkspaceStreamOptions {
	purpose: IrohRemoteWorkspaceManagementTarget["purpose"];
	authorization?: IrohRemoteClientAuthorizationSuccess;
	backend?: IrohRemoteWorktreeRpcBackend;
	unregisterWorkspace?: RemoteIntentHost["unregisterWorkspace"];
	revalidate?: () => Promise<boolean>;
	/** Bytes the device sent after its handshake line. */
	initialInput?: Buffer;
}

interface WorkspaceStream {
	phone: RemotePhone;
	backend: IrohRemoteWorktreeRpcBackend;
	auditEvents: IrohRemoteAuditEvent[];
	/** Settles once the host ended the connection. */
	closed: Promise<void>;
	/** Every frame the host wrote after `welcome`. */
	frames(): HostFrame[];
	/** A workspace intent: host-scoped, so it carries no branch position. */
	intent(type: string, input?: unknown): Promise<IntentOutcome>;
}

/** A workspace management stream as the daemon serves one (IrohDaemonService.runWorkspaceStream). */
function serveWorkspaceStream(options: WorkspaceStreamOptions): WorkspaceStream {
	const authorization = options.authorization ?? createAuthorization();
	const backend = options.backend ?? createBackend();
	const auditEvents: IrohRemoteAuditEvent[] = [];
	const host: RemoteIntentHost = {
		agentDir: "/home/user/.volt/agent",
		auditLogger: new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } }),
		stateManager: new IrohRemoteHostStateManager(),
		pushTargets: () => unexpected("pushTargets"),
		worktrees: () => backend,
		agentOptions: () => unexpected("agentOptions"),
		sessionContexts: () => unexpected("sessionContexts"),
		prReviews: () => unexpected("prReviews"),
		unregisterWorkspace: options.unregisterWorkspace ?? (async () => unexpected("unregisterWorkspace")),
	};
	const scope: RemoteStreamScope = { kind: "management", purpose: options.purpose };
	const allows = remoteStreamAllows(scope);
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		stream: pair.host,
		...(options.initialInput === undefined ? {} : { initialInput: options.initialInput }),
		grant: authorization.client.rpcGrant,
		redaction: {
			workspacePath: authorization.workspace.path,
			remoteWorkspacePath: "/workspace",
			...(options.purpose === "manage_worktrees" ? { additionalRedactedPaths: [HOST_WORKTREES_ROOT] } : {}),
		},
		services: () => remoteIntentServices(host, authorization, scope, { keep: { streamId: "st-1" } }),
		...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
		...(allows === undefined ? {} : { allows }),
	});
	const phone = connectRemotePhone(pair.phone);
	cleanups.push(async () => {
		await connection.close().catch(() => undefined);
		await phone.close();
	});
	return {
		phone,
		backend,
		auditEvents,
		closed: connection.closed,
		frames: () => phone.frames.filter((frame) => frame.type !== "welcome"),
		intent: (type, input) => phone.intent(type, input, { expectedOrdinal: null }),
	};
}

async function worktreeStream(options: Omit<WorkspaceStreamOptions, "purpose"> = {}): Promise<WorkspaceStream> {
	const stream = serveWorkspaceStream({ ...options, purpose: "manage_worktrees" });
	expect(await stream.phone.hello()).not.toHaveProperty("conversation");
	return stream;
}

describe("worktree intents on a manage_worktrees stream", () => {
	it("rejects any input field outside the schema (including inbound paths and workspace names) with invalid_input", async () => {
		const stream = await worktreeStream();
		for (const [type, input] of [
			["create_worktree", { path: "/etc" }],
			["create_worktree", { workspacePath: "/etc" }],
			["create_worktree", { bogus: true }],
			["create_worktree", { workspaceName: "other" }],
			["remove_worktree", { worktreeId: "fix-login", path: "/etc" }],
			["remove_worktree", { worktreeId: "fix-login", workspaceName: "other" }],
		] as const) {
			expect(await stream.intent(type, input)).toMatchObject({
				type: "rejected",
				reason: { code: "invalid_input" },
			});
		}
		expect(await stream.phone.query("worktrees", { force: true })).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
		expect(stream.backend.listWorktrees).not.toHaveBeenCalled();
		expect(stream.backend.removeWorktree).not.toHaveBeenCalled();
	});

	it("validates create/remove field types before touching the backend", async () => {
		const stream = await worktreeStream();
		for (const [type, input] of [
			["create_worktree", { worktreeName: "UPPER" }],
			["create_worktree", { branch: 42 }],
			["create_worktree", { baseRef: 42 }],
			["create_worktree", { workingDirectory: "../escape" }],
			["remove_worktree", { worktreeId: "../evil" }],
			["remove_worktree", { worktreeId: "fix-login", force: "yes" }],
		] as const) {
			expect(await stream.intent(type, input)).toMatchObject({
				type: "rejected",
				reason: { code: "invalid_input" },
			});
		}
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
		expect(stream.backend.removeWorktree).not.toHaveBeenCalled();
	});

	it("passes relative workingDirectory to the create backend on the stream's workspace", async () => {
		const stream = await worktreeStream();
		expect(
			await stream.intent("create_worktree", { worktreeName: "fix-login", workingDirectory: "packages/app" }),
		).toMatchObject({ type: "accepted" });
		expect(stream.backend.createWorktree).toHaveBeenCalledExactlyOnceWith("ws", {
			id: "fix-login",
			workingDirectory: "packages/app",
		});
	});

	it("maps backend failures to stable rejections without detail leakage, and audits them", async () => {
		const backend: IrohRemoteWorktreeRpcBackend = {
			...createBackend(),
			createWorktree: async () => ({
				ok: false,
				error: "worktree_branch_conflict",
				detail: `branch exists in ${HOST_WORKSPACE_PATH}`,
			}),
		};
		const stream = await worktreeStream({ backend });
		const outcome = await stream.intent("create_worktree", {});
		expect(outcome).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "worktree_branch_conflict" },
		});
		assertNoFilesystemPaths(outcome);
		expect(stream.auditEvents).toMatchObject([
			{
				type: "worktree_created",
				clientNodeId: "n-phone",
				workspace: "ws",
				success: false,
				error: "worktree_branch_conflict",
			},
		]);
	});

	it("returns wire summaries with no filesystem paths on create/list/remove", async () => {
		const stream = await worktreeStream();
		const create = await stream.intent("create_worktree", { worktreeName: "fix-login", baseRef: "main" });
		expect(create).toMatchObject({
			type: "accepted",
			result: { worktree: { id: "fix-login", branch: "volt/fix-login", baseRef: "main" } },
		});
		const list = await stream.phone.query("worktrees");
		expect(list).toMatchObject({
			type: "result",
			data: {
				worktrees: [
					{
						id: "fix-login",
						available: true,
						dirty: false,
						sessionIds: ["s-abc"],
						// Merge-back guidance (§5.3) crosses the wire; paths still don't.
						aheadBehind: { ahead: 3, behind: 1 },
					},
				],
			},
		});
		const remove = await stream.intent("remove_worktree", { worktreeId: "fix-login", force: true });
		expect(remove).toMatchObject({
			type: "accepted",
			result: { worktreeId: "fix-login", removed: true, stoppedRuntimeCount: 1, closedStreamCount: 1 },
		});
		expect(stream.backend.removeWorktree).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", true);
		for (const frame of [create, list, remove]) {
			assertNoFilesystemPaths(frame);
		}
	});
});

describe("manage_worktrees management stream", () => {
	it("serves create/list/remove and keeps the stream open", async () => {
		const stream = await worktreeStream();
		expect(await stream.intent("create_worktree", { worktreeName: "fix-login" })).toMatchObject({
			type: "accepted",
		});
		expect(await stream.phone.query("worktrees")).toMatchObject({ type: "result" });
		expect(await stream.intent("remove_worktree", { worktreeId: "fix-login", force: true })).toMatchObject({
			type: "accepted",
		});
		expect(stream.frames().map((frame) => frame.type)).toEqual(["accepted", "result", "accepted"]);
		// Audit: create + remove, never list.
		expect(stream.auditEvents.map((event) => event.type)).toEqual(["worktree_created", "worktree_removed"]);
		expect(stream.auditEvents[0]).toMatchObject({
			clientNodeId: "n-phone",
			workspace: "ws",
			success: true,
			details: { source: "remote_workspace_management_stream", worktreeId: "fix-login" },
		});
		// Still open: a later request is answered.
		expect(await stream.phone.query("worktrees")).toMatchObject({ type: "result" });
	});

	it("does not dispatch an unterminated intent", async () => {
		const hello = {
			type: "hello",
			protocol: 1,
			client: { name: "phone", version: "1" },
			accepts: { hostRequests: [] },
		};
		const stream = serveWorkspaceStream({
			purpose: "manage_worktrees",
			initialInput: Buffer.from(
				`${JSON.stringify(hello)}\n${JSON.stringify({ type: "create_worktree", intentId: "partial", input: {} })}`,
			),
		});
		await stream.phone.waitFor((frame): frame is HostFrame => frame.type === "welcome");
		// The device finishes its side with the intent's line unterminated.
		await stream.phone.close();
		await stream.closed;
		expect(stream.frames()).toEqual([]);
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
	});

	it("ends with fatal{revoked} before the next intent when the persisted grant becomes stale", async () => {
		let checks = 0;
		const stream = await worktreeStream({ revalidate: async () => ++checks === 1 });
		expect(await stream.phone.query("worktrees")).toMatchObject({ type: "result" });
		stream.phone.send({ type: "create_worktree", intentId: "after-revocation", input: {} });
		await stream.phone.ended;
		expect(stream.frames().map((frame) => frame.type)).toEqual(["result", "fatal"]);
		expect(stream.phone.frames.at(-1)).toMatchObject({ type: "fatal", code: "revoked" });
		expect(stream.backend.listWorktrees).toHaveBeenCalledOnce();
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
	});

	it("ends with fatal{revoked} before an intent when the workspace was removed without changing the client grant", async () => {
		const authorization = createAuthorization();
		const stateManager = new IrohRemoteHostStateManager({
			initialState: {
				workspaces: [authorization.workspace],
				worktrees: [],
				clients: [authorization.client],
			},
		});
		await stateManager.unregisterWorkspace(authorization.workspace.name);

		const stream = await worktreeStream({
			authorization,
			revalidate: () => stateManager.isAuthorizationCurrent(authorization),
		});
		stream.phone.send({ type: "create_worktree", intentId: "c-1", input: {} });
		await stream.phone.ended;
		expect(stream.frames()).toEqual([
			{ type: "fatal", code: "revoked", message: "The device's access changed; reconnect" },
		]);
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
	});

	it("denies worktree intents without the required capability", async () => {
		const stream = await worktreeStream({
			authorization: createAuthorization(createIrohRemotePresetAccess("coding").rpcGrant),
		});
		expect(await stream.intent("create_worktree", {})).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "worktrees.manage.v1" },
		});
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
	});

	it("never puts filesystem paths on the wire", async () => {
		const stream = await worktreeStream();
		await stream.intent("create_worktree", {});
		await stream.phone.query("worktrees");
		await stream.intent("remove_worktree", { worktreeId: "fix-login" });
		expect(stream.frames()).toHaveLength(3);
		for (const frame of stream.phone.frames) {
			assertNoFilesystemPaths(frame);
		}
	});

	it("answers intents and queries of other purposes unavailable", async () => {
		const unregisterWorkspace = vi.fn(async () => ({ closedStreamCount: 0, stoppedRuntimeCount: 0 }));
		const stream = await worktreeStream({ unregisterWorkspace });
		expect(await stream.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
		expect(await stream.phone.query("sessions")).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
		expect(unregisterWorkspace).not.toHaveBeenCalled();
		expect(stream.backend.createWorktree).not.toHaveBeenCalled();
		expect(stream.auditEvents).toEqual([]);
	});

	it("ends the stream with fatal{invalid_frame} on a frame that is not JSON", async () => {
		const raw = serveWorkspaceStream({
			purpose: "manage_worktrees",
			initialInput: Buffer.from(
				`${JSON.stringify({ type: "hello", protocol: 1, client: { name: "phone", version: "1" }, accepts: { hostRequests: [] } })}\nnot json\n`,
			),
		});
		await raw.phone.ended;
		expect(raw.frames()).toEqual([{ type: "fatal", code: "invalid_frame", message: "A frame is one line of JSON" }]);
	});
});

describe("workspace unregister management stream", () => {
	it("rejects and audits workspace_has_worktrees without closing the stream", async () => {
		const unregisterWorkspace = vi.fn(async () => {
			throw new WorkspaceIntentError("workspace_has_worktrees", { worktreeCount: 1, worktreeIds: ["fix-login"] });
		});
		const stream = serveWorkspaceStream({ purpose: "unregister_workspace", unregisterWorkspace });
		await stream.phone.hello();
		expect(await stream.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "workspace_has_worktrees" },
		});
		expect(unregisterWorkspace).toHaveBeenCalledExactlyOnceWith("ws", { streamId: "st-1" });
		expect(stream.auditEvents).toEqual([
			{
				timestamp: expect.any(Number),
				type: "workspace_unregistered",
				clientNodeId: "n-phone",
				workspace: "ws",
				success: false,
				error: "workspace_has_worktrees",
				details: {
					source: "remote_workspace_management_stream",
					worktreeCount: 1,
					worktreeIds: ["fix-login"],
				},
			},
		]);
		// Still open: a retry is answered.
		expect(await stream.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "workspace_has_worktrees" },
		});
		expect(stream.phone.frames.some((frame) => frame.type === "fatal")).toBe(false);
	});

	it("refuses another workspace's name without unregistering anything", async () => {
		const unregisterWorkspace = vi.fn(async () => ({ closedStreamCount: 0, stoppedRuntimeCount: 0 }));
		const stream = serveWorkspaceStream({ purpose: "unregister_workspace", unregisterWorkspace });
		await stream.phone.hello();
		expect(await stream.intent("unregister_workspace", { workspaceName: "other" })).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input", message: "session_mismatch" },
		});
		expect(unregisterWorkspace).not.toHaveBeenCalled();
	});
});

describe("read-only workspace directory management stream", () => {
	it.each(["coding", "full"] as const)(
		"lists folders using %s access and rejects workspace removal",
		async (preset) => {
			const root = await mkdtemp(join(tmpdir(), "volt-directory-stream-"));
			try {
				await mkdir(join(root, "packages", "app"), { recursive: true });
				const authorization = createAuthorization(createIrohRemotePresetAccess(preset).rpcGrant);
				authorization.workspace = { name: "ws", path: root };
				const unregisterWorkspace = vi.fn(async () => ({ closedStreamCount: 0, stoppedRuntimeCount: 0 }));
				const stream = serveWorkspaceStream({
					purpose: "list_workspace_directories",
					authorization,
					unregisterWorkspace,
				});
				await stream.phone.hello();
				expect(await stream.phone.query("workspace_directories", { path: "packages" })).toMatchObject({
					type: "result",
					data: { path: "packages", directories: [{ name: "app", path: "packages/app" }] },
				});
				expect(await stream.phone.query("workspace_directories", { workspaceName: "other" })).toMatchObject({
					type: "query_error",
					reason: { code: "invalid_input" },
				});
				expect(await stream.phone.query("workspace_directories", { path: "../" })).toMatchObject({
					type: "query_error",
					reason: { code: "invalid_input" },
				});
				expect(await stream.intent("unregister_workspace", { workspaceName: "ws" })).toMatchObject({
					type: "rejected",
					reason: { code: "unavailable" },
				});
				expect(unregisterWorkspace).not.toHaveBeenCalled();
				expect(JSON.stringify(stream.phone.frames)).not.toContain(root);
				expect(
					getIrohRemoteStreamCapability({ mode: "workspaceManagement", purpose: "list_workspace_directories" }),
				).toBe("conversation.observe.v1");
				expect(
					getIrohRemoteStreamCapability({ mode: "workspaceManagement", purpose: "unregister_workspace" }),
				).toBe("workspace.manage.v1");
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		},
	);

	it("denies folder reads without observation authority", async () => {
		const stream = serveWorkspaceStream({
			purpose: "list_workspace_directories",
			authorization: createAuthorization(createIrohRemoteExplicitAccess([], []).rpcGrant),
		});
		await stream.phone.hello();
		expect(await stream.phone.query("workspace_directories")).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
	});
});
