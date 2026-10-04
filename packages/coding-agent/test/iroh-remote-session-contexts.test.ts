import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	REMOTE_CAPABILITIES,
	type RemoteCapability,
	type RpcGitContext,
	type RpcSessionWorkContext,
} from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	IrohRemoteAuditLogger,
	type IrohRemoteClientAuthorizationSuccess,
	IrohRemoteHostStateManager,
	serveIrohRemoteConnection,
} from "../src/core/remote/iroh/index.ts";
import {
	createIrohRemoteSessionContextsRpcBackend,
	type IrohRemoteSessionContextsRpcBackend,
} from "../src/core/remote/iroh/session-contexts.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type RemoteIntentHost, remoteIntentServices, remoteStreamAllows } from "../src/daemon/remote-intents.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const WORKSPACE_PATH = "/Users/private/workspace";

const authorization: IrohRemoteClientAuthorizationSuccess = {
	ok: true,
	allowTools: "read",
	client: {
		nodeId: "n-phone",
		label: "phone",
		allowedWorkspaces: ["volt"],
		allowedTools: "read",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		pairedAt: 1,
		lastSeenAt: 2,
	},
	paired: false,
	pairingSecretConsumed: false,
	workspace: { name: "volt", path: WORKSPACE_PATH },
	workspaceNames: ["volt"],
	workspaces: [{ name: "volt", status: "available" }],
};

const gitContext: RpcGitContext = {
	repository: "Volt",
	head: { kind: "branch", name: "feature/work", oid: "0123456789abcdef0123456789abcdef01234567" },
	upstream: null,
	base: null,
	status: {
		staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		untracked: 0,
		conflicted: 0,
		total: 0,
		clean: true,
	},
	operation: null,
	revision: 1,
	observedAt: "2026-08-30T00:00:00.000Z",
	stale: false,
};

const workContext: RpcSessionWorkContext = {
	changeId: "change-a",
	repository: "Volt",
	branch: "feature/work",
	resolutionState: "none",
};

function backend(): IrohRemoteSessionContextsRpcBackend {
	return {
		getSessionContexts: async (_workspaceName, sessionIds) =>
			sessionIds.map((sessionId, index) => ({
				sessionId,
				startingGitContext: index === 0 ? gitContext : null,
				workContext: index === 0 ? workContext : null,
			})),
	};
}

/** The daemon's backends a discovery stream reaches; only session contexts are used here. */
function remoteHost(sessionContexts: IrohRemoteSessionContextsRpcBackend, requested: string[][]): RemoteIntentHost {
	const unused = (): never => {
		throw new Error("Not used by a session_contexts stream");
	};
	return {
		agentDir: "/tmp/volt-agent",
		auditLogger: new IrohRemoteAuditLogger(),
		stateManager: new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() }),
		pushTargets: unused,
		worktrees: unused,
		agentOptions: unused,
		sessionContexts: () => ({
			getSessionContexts: (workspaceName, sessionIds) => {
				requested.push([workspaceName, ...sessionIds]);
				return sessionContexts.getSessionContexts(workspaceName, sessionIds);
			},
		}),
		prReviews: unused,
		unregisterWorkspace: unused,
	};
}

const cleanups: Array<() => Promise<void>> = [];

/** A phone on a `session_contexts` workspace discovery stream the daemon serves. */
async function phone(
	sessionContexts: IrohRemoteSessionContextsRpcBackend,
	capabilities: readonly RemoteCapability[] = REMOTE_CAPABILITIES,
): Promise<{ device: RemotePhone; requested: string[][] }> {
	const requested: string[][] = [];
	const scope = { kind: "discovery", purpose: "session_contexts" } as const;
	const pair = createIrohStreamPair();
	const allows = remoteStreamAllows(scope);
	const connection = serveIrohRemoteConnection({
		stream: pair.host,
		grant: { schemaVersion: 1, revision: 1, capabilities: [...capabilities] },
		redaction: { workspacePath: WORKSPACE_PATH, remoteWorkspacePath: "/workspace" },
		services: () => remoteIntentServices(remoteHost(sessionContexts, requested), authorization, scope, { keep: {} }),
		...(allows === undefined ? {} : { allows }),
	});
	const device = connectRemotePhone(pair.phone);
	cleanups.push(async () => {
		await connection.close().catch(() => undefined);
		await device.close();
	});
	await device.hello();
	return { device, requested };
}

const temporaryDirectories: string[] = [];
const managerOwner = createSessionManagerTestOwner();

beforeEach(() => managerOwner.start());

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	await managerOwner.drain();
	vi.restoreAllMocks();
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("session_contexts workspace discovery", () => {
	test("returns one ordered explicit nullable result per requested id", async () => {
		const { device, requested } = await phone(backend());
		expect(await device.query("session_contexts", { sessionIds: ["session-a", "session-b"] })).toMatchObject({
			type: "result",
			data: {
				contexts: [
					{ sessionId: "session-a", startingGitContext: gitContext, workContext },
					{ sessionId: "session-b", startingGitContext: null, workContext: null },
				],
			},
		});
		// The stream's workspace is implied: the backend is asked for the authorized one.
		expect(requested).toEqual([["volt", "session-a", "session-b"]]);
	});

	test("rejects malformed, duplicate, oversized, and cross-workspace requests", async () => {
		const { device, requested } = await phone(backend());
		const invalidParams = [
			{ sessionIds: [] },
			{ sessionIds: ["session-a", "session-a"] },
			{ sessionIds: ["BAD"] },
			{ sessionIds: ["session-a"], extra: true },
			{ sessionIds: ["session-a"], workspaceName: "other" },
			{ sessionIds: Array.from({ length: 65 }, (_, index) => `session-${index}`) },
			undefined,
		];
		for (const params of invalidParams) {
			expect(await device.query("session_contexts", params), JSON.stringify(params)).toMatchObject({
				type: "query_error",
				reason: { code: "invalid_input" },
			});
		}
		expect(requested).toEqual([]);
	});

	test("redacts workspace paths from the contexts a device receives", async () => {
		const { device } = await phone({
			getSessionContexts: async () => [
				{
					sessionId: "session-a",
					startingGitContext: { ...gitContext, repository: WORKSPACE_PATH },
					workContext: { ...workContext, repository: WORKSPACE_PATH },
				},
			],
		});
		const answer = await device.query("session_contexts", { sessionIds: ["session-a"] });
		expect(answer).toMatchObject({
			type: "result",
			data: {
				contexts: [
					{
						sessionId: "session-a",
						startingGitContext: { repository: "/workspace" },
						workContext: { repository: "/workspace" },
					},
				],
			},
		});
		expect(JSON.stringify(device.frames)).not.toContain(WORKSPACE_PATH);
	});

	test("contains malformed or reordered backend output", async () => {
		const { device } = await phone({
			getSessionContexts: async () => [
				{ sessionId: "session-b", startingGitContext: null, workContext: null },
				{ sessionId: "session-a", startingGitContext: null, workContext: null },
			],
		});
		expect(await device.query("session_contexts", { sessionIds: ["session-a", "session-b"] })).toMatchObject({
			type: "query_error",
			reason: { code: "failed", message: "request_failed" },
		});
	});

	test("backend combines live, targeted persisted, and Work-store context without all-session listing", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-session-context-backend-"));
		temporaryDirectories.push(directory);
		const persistedId = "session-persisted";
		const persisted = await SessionManager.create("/workspace", directory, { id: persistedId });
		await persisted.logWriter.recordStartingGitContext(gitContext);
		const listSpy = vi.spyOn(SessionManager, "list");
		const workLookups: string[] = [];
		const sessionBackend = createIrohRemoteSessionContextsRpcBackend({
			workspaceName: "volt",
			sessionDirectory: directory,
			getLiveStartingGitContext: (sessionId) => (sessionId === "session-live" ? gitContext : undefined),
			getWorkContext: (sessionId) => {
				workLookups.push(sessionId);
				return sessionId === persistedId ? workContext : undefined;
			},
		});

		await expect(
			sessionBackend.getSessionContexts("volt", ["session-live", persistedId, "session-missing"]),
		).resolves.toEqual([
			{ sessionId: "session-live", startingGitContext: gitContext, workContext: null },
			{ sessionId: persistedId, startingGitContext: gitContext, workContext },
			{ sessionId: "session-missing", startingGitContext: null, workContext: null },
		]);
		expect(workLookups).toEqual(["session-live", persistedId, "session-missing"]);
		expect(listSpy).not.toHaveBeenCalled();
	});

	test("targeted starting Git lookup ignores unrelated SQLite sessions and validates requested ids", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-session-contexts-"));
		temporaryDirectories.push(directory);
		const sessionId = "session-a";
		const target = await SessionManager.create("/workspace", directory, { id: sessionId });
		await target.logWriter.recordStartingGitContext(gitContext);
		const unrelated = await SessionManager.create("/workspace", directory, { id: "session-unrelated" });
		await unrelated.logWriter.recordStartingGitContext(null);
		const listSpy = vi.spyOn(SessionManager, "list");

		const contexts = await SessionManager.readStartingGitContexts(directory, [sessionId, "session-missing"]);
		expect(contexts).toEqual(
			new Map([
				[sessionId, gitContext],
				["session-missing", null],
			]),
		);
		expect(listSpy).not.toHaveBeenCalled();
		await expect(SessionManager.readStartingGitContexts(directory, ["-bad"])).rejects.toThrow(/Session id/);
	});

	test("requires conversation observation authority", async () => {
		const { device, requested } = await phone(
			backend(),
			REMOTE_CAPABILITIES.filter((capability) => capability !== "conversation.observe.v1"),
		);
		expect(await device.query("session_contexts", { sessionIds: ["session-a"] })).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
		expect(requested).toEqual([]);
	});
});
