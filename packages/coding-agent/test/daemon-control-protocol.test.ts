import { Buffer } from "node:buffer";
import {
	CONTROL_EVENT_SCHEMAS,
	CONTROL_REQUEST_SCHEMAS,
	CONTROL_RESPONSE_SCHEMAS,
	ControlEventSchema,
	ControlRequestSchema,
	ControlResponseSchema,
} from "@hansjm10/volt-protocol/daemon-control";
import {
	IrohRemoteHelloSchema,
	IrohRemoteHelloWireSchema,
	IrohRemoteWorkingDirectorySchema,
} from "@hansjm10/volt-protocol/remote-handshake";
import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import {
	IrohRemoteHandshakeError,
	isIrohRemoteWorkspaceName,
	parseIrohRemoteHello,
} from "../src/core/remote/iroh/handshake.ts";
import {
	DEFAULT_IROH_REMOTE_ALLOW_TOOLS,
	IROH_REMOTE_ALPN,
	IROH_REMOTE_HELLO_TYPE,
	isIrohRemoteWorkingDirectory,
} from "../src/core/remote/iroh/protocol.ts";
import {
	admitControlRequest,
	CONTROL_MAX_LINE_BYTES,
	type ControlEvent,
	ControlFrameTooLargeError,
	ControlLineDecoder,
	type ControlRequest,
	type ControlResponse,
	ControlValidators,
	createControlClientStatus,
	encodeControlLine,
	type HelloAck,
	type HelloMessage,
	PROTOCOL_VERSION,
	type RelayPreamble,
} from "../src/daemon/control-protocol.ts";

const RPC_GRANT = {
	schemaVersion: 1 as const,
	revision: 1,
	capabilities: ["conversation.observe.v1" as const],
};

const HOST_NODE_ID = "a".repeat(64);
const HEAD_OID = "0123456789abcdef0123456789abcdef01234567";

function roundTrip(message: object): unknown {
	const decoder = new ControlLineDecoder();
	const messages = decoder.push(encodeControlLine(message));
	expect(messages).toHaveLength(1);
	return messages[0];
}

type ByType<T extends { type: string }> = { [K in T["type"]]: Extract<T, { type: K }> };

const PUSH_TARGET = {
	provider: "fcm" as const,
	platform: "ios" as const,
	pushTargetId: "target-1",
	pushTargetAuthToken: "token-1",
	enabled: true,
};

// One valid sample per message type. The mapped types make a missing type a compile error.
const REQUESTS: ByType<ControlRequest> = {
	status: { type: "status", id: "1" },
	shutdown: { type: "shutdown", id: "2" },
	lease_acquire: { type: "lease_acquire", id: "3", workspaceName: "volt", sessionId: "s-1", force: true },
	lease_release: {
		type: "lease_release",
		id: "4",
		workspaceName: "volt",
		sessionId: "s-1",
		reason: "workspace_unregistered",
	},
	change_observe: {
		type: "change_observe",
		id: "5",
		workspaceName: "volt",
		sessionId: "s-1",
		gitContext: { repository: "Volt", branch: "feature/work", headOid: HEAD_OID, baseRef: "main" },
	},
	pair_request: { type: "pair_request", id: "6", access: "coding" },
	pair_cancel: { type: "pair_cancel", id: "7", requestId: "pair-1" },
	clients_list: { type: "clients_list", id: "8" },
	relay_credential_revoke: { type: "relay_credential_revoke", id: "9" },
	relay_credential_check: { type: "relay_credential_check", id: "10" },
	client_access_update: {
		type: "client_access_update",
		id: "11",
		clientNodeId: "n-1",
		expectedRevision: 1,
		access: "review",
	},
	client_revoke: { type: "client_revoke", id: "12", clientNodeId: "n-1" },
	client_approve_repair: { type: "client_approve_repair", id: "13", clientNodeId: "n-1" },
	workspace_register: { type: "workspace_register", id: "14", name: "volt", path: "/tmp/volt" },
	workspace_unregister: { type: "workspace_unregister", id: "15", name: "volt" },
	worktree_create: {
		type: "worktree_create",
		id: "16",
		workspaceName: "volt",
		worktreeName: "fix-login",
		branch: "volt/fix-login",
		baseRef: "main",
	},
	worktree_adopt: { type: "worktree_adopt", id: "17", workspaceName: "volt", path: "/tmp/wt", baseRef: "main" },
	worktree_list: { type: "worktree_list", id: "18", workspaceName: "volt" },
	worktree_remove: { type: "worktree_remove", id: "19", workspaceName: "volt", worktreeId: "x", force: true },
	worktree_prune: { type: "worktree_prune", id: "20", workspaceName: "volt", purgeRecovery: true },
	worktree_resolve: { type: "worktree_resolve", id: "21", path: "/tmp/wt/src" },
	worktree_restore: {
		type: "worktree_restore",
		id: "22",
		path: "/checkout",
		sessionRef: { sessionDirectory: "/sessions", storeId: "store", sessionId: "session", sessionGeneration: "gen" },
	},
	worktree_bind: {
		type: "worktree_bind",
		id: "23",
		workspaceName: "volt",
		worktreeId: "x",
		sessionId: "s-1",
		acquireLease: true,
	},
	theme_set: { type: "theme_set", id: "24", theme: "dark" },
	keep_awake_set: { type: "keep_awake_set", id: "25", enabled: false },
	viewer_abort: { type: "viewer_abort", id: "26", viewerFeedId: "vf-1" },
	relay_rpc: {
		type: "relay_rpc",
		id: "27",
		relayId: "rl-1",
		clientNodeId: "n-1",
		workspaceName: "volt",
		sessionId: "s-1",
		frame: { type: "register_push_target", intentId: "i-1", input: PUSH_TARGET },
	},
	relay_notification_delivery: {
		type: "relay_notification_delivery",
		id: "28",
		clientNodeId: "n-1",
		workspaceName: "volt",
		sessionId: "s-1",
		notification: {
			eventId: "plan:s-1:run-1:ready",
			hostNodeId: HOST_NODE_ID,
			kind: "plan_ready",
			title: "Your plan is ready",
			body: "Open Volt to review and approve it.",
			sessionId: "s-1",
			workspaceName: "volt",
			planId: "plan-1",
		},
	},
};

const REVIEW_NOTIFICATION = {
	eventId: "review:one:completed",
	hostNodeId: HOST_NODE_ID,
	kind: "review_completed",
	title: "Your review is ready",
	body: "PR #151 completed with 4 findings.",
	sessionId: "s-1",
	workspaceName: "volt",
	workflowId: "review:one",
};

// Type-specific rejections; every closed message also rejects an unknown field and a missing or wrong type.
const INVALID_REQUESTS: { [K in ControlRequest["type"]]?: Array<Record<string, unknown>> } = {
	lease_acquire: [{ sessionId: undefined }, { force: "yes" }],
	lease_release: [{ reason: undefined }, { reason: "rekey" }, { reason: "workspace_removed" }],
	change_observe: [
		{ gitContext: { repository: "repo", branch: "feature/work", headOid: "not-an-oid" } },
		{ gitContext: { repository: "repo", branch: "feature/work\npoison", headOid: HEAD_OID } },
		{ gitContext: { repository: "", branch: "main", headOid: HEAD_OID } },
		{ gitContext: { repository: "repo", branch: "main", headOid: HEAD_OID, path: "/home/me/repo" } },
		{ workspaceName: "" },
		{ workspaceName: "w".repeat(257) },
		{ sessionId: "s".repeat(129) },
		{ gitContext: undefined },
	],
	pair_request: [
		{ workspaceName: 42 },
		{ access: "admin" },
		{ access: "coding", allowedTools: [], rpcCapabilities: [] },
		{ access: undefined, allowedTools: ["read"] },
		{ access: undefined, allowedTools: [], rpcCapabilities: ["root.v1"] },
		{ access: undefined, allowedTools: [], rpcCapabilities: ["host.manage.v1", "host.manage.v1"] },
	],
	pair_cancel: [{ requestId: undefined }],
	client_access_update: [
		{ access: undefined },
		{ expectedRevision: 0 },
		{ expectedRevision: 1.5 },
		{ expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
		{ access: undefined, allowedTools: ["read"], rpcCapabilities: "host.manage.v1" },
	],
	client_revoke: [{ clientNodeId: 42 }],
	client_approve_repair: [{ clientNodeId: undefined }],
	workspace_register: [{ path: undefined }],
	workspace_unregister: [{ name: undefined }],
	worktree_create: [{ workspaceName: undefined }, { branch: 42 }],
	worktree_adopt: [{ path: undefined }, { path: 42 }],
	worktree_list: [{ workspaceName: 42 }],
	worktree_remove: [{ worktreeId: undefined }, { force: "yes" }],
	worktree_prune: [{ purgeRecovery: "yes" }],
	worktree_resolve: [{ path: undefined }],
	worktree_restore: [
		{ sessionRef: undefined },
		{ sessionRef: { sessionDirectory: "/sessions", storeId: "store", sessionId: "", sessionGeneration: "gen" } },
	],
	worktree_bind: [{ sessionId: undefined }, { acquireLease: "yes" }],
	theme_set: [{ theme: undefined }],
	keep_awake_set: [{ enabled: "yes" }, { enabled: undefined }],
	viewer_abort: [{ viewerFeedId: undefined }, { viewerFeedId: 42 }],
	relay_rpc: [
		{ frame: undefined },
		{ frame: { intentId: "i-1", input: PUSH_TARGET } },
		{ frame: "register_push_target" },
		// The legacy RPC command envelope.
		{ frame: undefined, command: { type: "register_push_target", id: "rpc-1", args: PUSH_TARGET } },
		{ frame: { type: "register_push_target", intentId: "i-1" } },
		{ frame: { type: "register_push_target", intentId: "", input: PUSH_TARGET } },
		{ frame: { type: "register_push_target", intentId: "i-1", input: { ...PUSH_TARGET, provider: "apns" } } },
		{ frame: { type: "register_push_target", intentId: "i-1", input: PUSH_TARGET, unexpected: true } },
	],
	relay_notification_delivery: [
		{ notification: { eventId: "e-1", kind: "conversation_completed", title: "Volt finished" } },
		{ notification: { ...REVIEW_NOTIFICATION, planId: "plan-1" } },
		{ notification: { ...REVIEW_NOTIFICATION, workflowId: undefined } },
		{ notification: { ...REVIEW_NOTIFICATION, kind: "secret_kind" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review\nready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review  ready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: " Review ready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review\u200bready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "r".repeat(129) } },
		{ notification: { ...REVIEW_NOTIFICATION, body: "Open /Users/private/review.diff" } },
		{ notification: { ...REVIEW_NOTIFICATION, workspaceName: "private/path" } },
		{ notification: { ...REVIEW_NOTIFICATION, workflowId: "w".repeat(129) } },
		{ notification: { ...REVIEW_NOTIFICATION, workflowId: "review one" } },
		{ notification: { ...REVIEW_NOTIFICATION, eventId: "e".repeat(513) } },
		{ notification: { ...REVIEW_NOTIFICATION, hostNodeId: "A".repeat(64) } },
		{ notification: { ...REVIEW_NOTIFICATION, workspaceName: undefined, workspace: "volt" } },
	],
};

const STATUS_RESULT: Extract<ControlResponse, { type: "status_result" }> = {
	type: "status_result",
	id: "6",
	version: "1.0.0",
	protocolVersion: PROTOCOL_VERSION,
	pid: 42,
	startedAtMs: 1000,
	environment: { source: "inherited", reason: "not resolved" },
	capabilities: ["pair_cancel"],
	leases: [{ workspaceName: "volt", sessionId: "s-1", state: "tui-owned", relayCount: 1, streamCount: 0 }],
	phoneConnections: 1,
	remoteTransport: { state: "ready", wrapperVersion: "1.1.1-volt.2" },
	relayCredential: { state: "subscription_inactive", expiresAt: 2_000, nextRefreshAt: 3_000 },
	workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: ["read", "bash"] }],
	clients: [
		{
			clientNodeId: "n-1",
			label: "phone",
			pairedAtMs: 5,
			lastSeenAtMs: 10,
			allowedTools: ["read"],
			usesDefaultTools: false,
			rpcGrant: RPC_GRANT,
		},
	],
	revokedClients: [
		{ clientNodeId: "n-2", label: "old phone", pairedAtMs: 1, lastSeenAtMs: 2, revokedAtMs: 3, rpcGrant: RPC_GRANT },
	],
	remotePolicy: { allowTools: ["read", "bash"], detachedRuntimeTtlMs: 1_800_000 },
	keepAwake: { enabled: true, state: "active", method: "caffeinate" },
};

const WORKTREE = {
	id: "x",
	workspaceName: "volt",
	path: "/tmp/wt",
	branch: "volt/x",
	createdAt: 1,
	sessionIds: ["s-1"],
	available: true,
	dirty: false,
	aheadBehind: { ahead: 1, behind: 0 },
};

const RESPONSES: ByType<ControlResponse> = {
	ok: { type: "ok", id: "1" },
	error: { type: "error", id: "2", code: "not_held", message: "lease not held" },
	lease_granted: { type: "lease_granted", id: "3", workspaceName: "volt", sessionId: "s-1", handoff: "warm" },
	lease_pending: { type: "lease_pending", id: "4", viewerFeedId: "vf-1" },
	lease_denied: { type: "lease_denied", id: "5", reason: "held_by_tui" },
	status_result: STATUS_RESULT,
	keep_awake_result: {
		type: "keep_awake_result",
		id: "7",
		keepAwake: { enabled: true, state: "degraded", reason: "caffeinate exited" },
	},
	clients_result: { type: "clients_result", id: "8", clients: [] },
	client_access_updated: {
		type: "client_access_updated",
		id: "9",
		client: { clientNodeId: "n-1", pairedAtMs: 5, allowedTools: ["read"], rpcGrant: { ...RPC_GRANT, revision: 2 } },
	},
	worktree_result: { type: "worktree_result", id: "10", worktree: WORKTREE },
	worktrees_result: { type: "worktrees_result", id: "11", worktrees: [WORKTREE] },
	worktree_resolve_result: {
		type: "worktree_resolve_result",
		id: "12",
		workspaceName: "volt",
		workspacePath: "/tmp/volt",
		worktreeId: "x",
		worktreePath: "/tmp/wt",
	},
	worktree_prune_result: {
		type: "worktree_prune_result",
		id: "13",
		results: [{ workspaceName: "volt", removedRecords: ["x"], orphanCheckouts: [], purgedRecoveryCheckouts: [] }],
	},
	pair_started: { type: "pair_started", id: "14", requestId: "pr-1" },
	relay_rpc_result: {
		type: "relay_rpc_result",
		id: "15",
		frame: { type: "accepted", intentId: "i-1", ordinals: [], result: { registered: true } },
	},
	relay_push_delivery_result: { type: "relay_push_delivery_result", id: "16", status: "sent" },
};

const INVALID_RESPONSES: { [K in ControlResponse["type"]]?: Array<Record<string, unknown>> } = {
	error: [{ code: undefined }],
	lease_granted: [{ handoff: "hot" }],
	lease_pending: [{ viewerFeedId: undefined }],
	lease_denied: [{ reason: "other" }],
	status_result: [
		{ remoteTransport: undefined },
		{ remoteTransport: { state: "healthy" } },
		{ remoteTransport: { state: "unavailable", reasonCode: "secret" } },
		{ keepAwake: undefined },
		{ environment: { source: "magic" } },
		{ leases: [{ workspaceName: "volt", sessionId: "s-1", state: "rekeying", relayCount: 0, streamCount: 0 }] },
		{ relayCredential: { state: "unknown" } },
		{ relayCredential: { state: ["active"] } },
		...[0, -1, 1.5, "15", null, Number.MAX_SAFE_INTEGER + 1].map((nextRefreshAt) => ({
			relayCredential: { state: "subscription_inactive", nextRefreshAt },
		})),
		{ relayCredential: { state: "expired", expiresAt: -1 } },
		{ clients: [{ clientNodeId: "n-1", pairedAtMs: 5, rpcGrant: { ...RPC_GRANT, revision: 0 } }] },
	],
	keep_awake_result: [{ keepAwake: { enabled: true, state: "on" } }],
	clients_result: [{ clients: {} }],
	client_access_updated: [{ client: { clientNodeId: "n-1" } }],
	worktree_result: [{ worktree: { id: "x" } }, { worktree: "x" }],
	worktrees_result: [{ worktrees: {} }],
	worktree_resolve_result: [{ worktreePath: undefined }],
	worktree_prune_result: [{ results: {} }],
	pair_started: [{ requestId: undefined }],
	relay_rpc_result: [
		{ frame: undefined },
		{ frame: "accepted" },
		// The legacy RPC response envelope.
		{ frame: undefined, response: { type: "response", command: "register_push_target", success: true } },
		{ frame: { type: "accepted", intentId: "i-1" } },
		{ frame: { type: "rejected", intentId: "i-1", reason: { code: "nope", message: "x" } } },
		{ frame: { type: "query_error", queryId: "q-1", reason: { code: "stale", message: "x" } } },
		// Only an outcome frame answers a relayed frame.
		{ frame: { type: "changed", catalog: "host" } },
		{ frame: { type: "fatal", code: "revoked" } },
	],
	relay_push_delivery_result: [{ status: "maybe" }],
};

const EVENTS: ByType<ControlEvent> = {
	relay_offer: {
		type: "relay_offer",
		relayId: "rl-1",
		relayToken: "tok",
		workspaceName: "volt",
		sessionId: "s-1",
		clientNodeId: "n-1",
		connectionId: "ic-1",
		streamId: "st-1",
	},
	relay_closed: { type: "relay_closed", relayId: "rl-1", reason: "phone_disconnected" },
	viewer_end: { type: "viewer_end", viewerFeedId: "vf-1", reason: "granted" },
	theme_snapshot: { type: "theme_snapshot", themeName: "dark", tokens: { accent: "#ff0000" } },
	keep_awake_changed: {
		type: "keep_awake_changed",
		keepAwake: { enabled: true, state: "active", method: "caffeinate" },
	},
	pairing_progress: { type: "pairing_progress", requestId: "pr-1", phase: "waiting" },
	daemon_shutdown: { type: "daemon_shutdown" },
};

const INVALID_EVENTS: { [K in ControlEvent["type"]]?: Array<Record<string, unknown>> } = {
	relay_offer: [{ relayToken: undefined }],
	relay_closed: [{ reason: "other" }],
	viewer_end: [{ reason: "drained" }],
	theme_snapshot: [{ tokens: { accent: 1 } }],
	keep_awake_changed: [{ keepAwake: undefined }],
	pairing_progress: [{ phase: "scanning" }, { qrLines: "line" }],
};

/** Apply a patch and decode it as the wire would: `undefined` removes a field at any depth. */
function mutate(sample: object, patch: Record<string, unknown>): unknown {
	return roundTrip({ ...sample, ...patch });
}

/** Valid and mutated cases for one message family, checked against one compiled validator. */
function checkFamily(
	samples: Record<string, object>,
	invalid: Record<string, Array<Record<string, unknown>> | undefined>,
	check: (value: unknown) => boolean,
	options: { correlated: boolean },
): void {
	for (const [type, sample] of Object.entries(samples)) {
		const decoded = roundTrip(sample);
		expect(decoded, type).toEqual(sample);
		expect(check(decoded), `${type} valid`).toBe(true);
		expect(check(mutate(sample, { unexpected: true })), `${type} with an unknown field`).toBe(false);
		expect(check(mutate(sample, { type: undefined })), `${type} without type`).toBe(false);
		expect(check(mutate(sample, { type: `${type}_v2` })), `${type} renamed`).toBe(false);
		if (options.correlated) {
			expect(check(mutate(sample, { id: undefined })), `${type} without id`).toBe(false);
			expect(check(mutate(sample, { id: 7 })), `${type} with a numeric id`).toBe(false);
		}
		for (const patch of invalid[type] ?? []) {
			expect(check(mutate(sample, patch)), `${type} ${JSON.stringify(patch)}`).toBe(false);
		}
	}
}

describe("daemon control contract", () => {
	it("has one schema per message type, and each union is exactly its schema map", () => {
		const families = [
			{ map: CONTROL_REQUEST_SCHEMAS, union: ControlRequestSchema, samples: REQUESTS },
			{ map: CONTROL_RESPONSE_SCHEMAS, union: ControlResponseSchema, samples: RESPONSES },
			{ map: CONTROL_EVENT_SCHEMAS, union: ControlEventSchema, samples: EVENTS },
		];
		for (const { map, union, samples } of families) {
			expect(union.anyOf).toEqual(Object.values(map));
			expect(Object.keys(samples).sort()).toEqual(Object.keys(map).sort());
			for (const [type, schema] of Object.entries(map)) {
				for (const variant of "anyOf" in schema ? schema.anyOf : [schema]) {
					expect(variant.properties.type.const, type).toBe(type);
				}
			}
		}
	});

	it("admits every request type and rejects mutated requests", () => {
		checkFamily(REQUESTS, INVALID_REQUESTS, admitControlRequest, { correlated: true });
	});

	it("accepts every response type and rejects mutated responses", () => {
		checkFamily(RESPONSES, INVALID_RESPONSES, (value) => ControlValidators.response.Check(value), {
			correlated: true,
		});
	});

	it("accepts every event type and rejects mutated events", () => {
		checkFamily(EVENTS, INVALID_EVENTS, (value) => ControlValidators.event.Check(value), { correlated: false });
	});

	it("admits the default, preset, and explicit pairing access selections", () => {
		expect(admitControlRequest({ type: "pair_request", id: "1" })).toBe(true);
		expect(admitControlRequest({ type: "pair_request", id: "1", workspaceName: "volt" })).toBe(true);
		expect(
			admitControlRequest({
				type: "pair_request",
				id: "1",
				allowedTools: ["read"],
				rpcCapabilities: ["conversation.observe.v1"],
			}),
		).toBe(true);
		expect(
			admitControlRequest({
				type: "client_access_update",
				id: "1",
				clientNodeId: "n-1",
				expectedRevision: 3,
				allowedTools: [],
				rpcCapabilities: [],
			}),
		).toBe(true);
	});

	it("admits a null Git context and a branch without a base", () => {
		const request = REQUESTS.change_observe;
		expect(admitControlRequest({ ...request, gitContext: null })).toBe(true);
		expect(admitControlRequest({ ...request, gitContext: { repository: "r", branch: "b", headOid: HEAD_OID } })).toBe(
			true,
		);
		expect(admitControlRequest({ ...request, workspaceName: "w".repeat(256), sessionId: "s".repeat(128) })).toBe(
			true,
		);
	});

	it("admits a canonical notification at its UTF-8 budget and rejects one byte over", () => {
		const request = REQUESTS.relay_notification_delivery;
		const title = "é".repeat(64);
		expect(Buffer.byteLength(title)).toBe(128);
		expect(admitControlRequest({ ...request, notification: { ...request.notification, title } })).toBe(true);
		expect(admitControlRequest({ ...request, notification: { ...request.notification, title: `${title}a` } })).toBe(
			false,
		);
		expect(
			admitControlRequest(
				mutate(request, {
					notification: { ...REVIEW_NOTIFICATION, kind: "conversation_completed", workflowId: undefined },
				}),
			),
		).toBe(true);
	});

	it("rejects the removed lease rekey messages", () => {
		for (const type of ["lease_rekey_prepare", "lease_rekey_commit", "lease_rekey_rollback", "lease_rekey_dispose"]) {
			expect(
				admitControlRequest({ type, id: "5", workspaceName: "volt", oldSessionId: "s-1", newSessionId: "s-2" }),
				type,
			).toBe(false);
		}
		expect(ControlValidators.response.Check({ type: "lease_rekey_prepared", id: "5a", transactionId: "tx-1" })).toBe(
			false,
		);
	});

	it("rejects the removed viewer feed subscription messages", () => {
		for (const type of ["viewer_subscribe", "viewer_unsubscribe"]) {
			expect(admitControlRequest({ type, id: "5", viewerFeedId: "vf-1" }), type).toBe(false);
		}
		expect(
			ControlValidators.event.Check({
				type: "viewer_event",
				viewerFeedId: "vf-1",
				seq: 0,
				event: { type: "agent_end" },
			}),
		).toBe(false);
	});

	it("relays exactly the daemon-executed intents and queries, as the phone sent them", () => {
		const relay = (frame: object) => ({ ...REQUESTS.relay_rpc, frame });
		const relayed: object[] = [
			{ type: "register_push_target", intentId: "i-1", input: PUSH_TARGET },
			{ type: "unregister_workspace", intentId: "i-2", input: { workspaceName: "volt" } },
			{ type: "create_worktree", intentId: "i-3", input: { worktreeName: "fix-login", baseRef: "main" } },
			{ type: "create_worktree", intentId: "i-4", expectedOrdinal: 3 },
			{ type: "set_keep_awake", intentId: "i-5", input: { enabled: true } },
			{ type: "set_web_search_key", intentId: "i-6", input: { apiKey: null } },
			{ type: "query", queryId: "q-1", query: "sessions", params: { limit: 5, cursor: "10" } },
			{ type: "query", queryId: "q-2", query: "worktrees" },
			{ type: "query", queryId: "q-3", query: "host_status", params: {} },
			{ type: "query", queryId: "q-4", query: "web_search_status" },
		];
		for (const frame of relayed) {
			expect(admitControlRequest(roundTrip(relay(frame))), JSON.stringify(frame)).toBe(true);
		}
		const local: object[] = [
			// Conversation intents and management-stream intents stay with the TUI or the daemon's stream.
			{ type: "prompt", intentId: "i-1", expectedOrdinal: 0, input: { message: "hi" } },
			{ type: "remove_worktree", intentId: "i-2", input: { worktreeId: "x" } },
			{
				type: "prepare_pr_review",
				intentId: "i-3",
				input: {
					number: "7",
					sessionId: "review-7",
					expectedPullRequest: { url: "https://github.com/o/r/pull/7", headRefOid: HEAD_OID },
				},
			},
			{ type: "extension.command.deploy", intentId: "i-4" },
			{ type: "query", queryId: "q-1", query: "models" },
			{ type: "query", queryId: "q-2", query: "work_output", params: { workId: "j-1" } },
			{ type: "query", queryId: "q-3", query: "agent_options" },
			// Malformed relayed frames.
			{ type: "set_keep_awake", intentId: "i-5", input: { enabled: "yes" } },
			{ type: "unregister_workspace", intentId: "i-6" },
			{ type: "query", queryId: "q-4", query: "sessions", params: { limit: 0 } },
			{ type: "query", queryId: "q-5", query: "worktrees", params: { workspaceName: "volt" } },
			{ type: "query", query: "host_status" },
		];
		for (const frame of local) {
			expect(admitControlRequest(roundTrip(relay(frame))), JSON.stringify(frame)).toBe(false);
		}
	});

	it("answers a relayed frame with each outcome frame", () => {
		const outcomes: object[] = [
			{ type: "accepted", intentId: "i-1", ordinals: [4, 5], conversation: "s-2" },
			{
				type: "rejected",
				intentId: "i-1",
				reason: { code: "not_allowed", message: "denied", requiredCapability: "host.manage.v1" },
			},
			{ type: "rejected", intentId: "i-1", reason: { code: "busy", message: "draining", retryAfterMs: 1_000 } },
			{ type: "result", queryId: "q-1", data: { worktrees: [] } },
			{ type: "query_error", queryId: "q-1", reason: { code: "unavailable", message: "no" } },
		];
		for (const frame of outcomes) {
			expect(
				ControlValidators.response.Check(roundTrip({ type: "relay_rpc_result", id: "1", frame })),
				JSON.stringify(frame),
			).toBe(true);
		}
	});
});

describe("control version negotiation", () => {
	const controlHello: HelloMessage = {
		type: "hello",
		role: "control",
		protocolVersion: PROTOCOL_VERSION,
		pid: 4242,
		version: "0.9.0",
		client: "tui",
		controlToken: "token",
		capabilities: ["worktrees"],
	};
	const relayHello: HelloMessage = {
		type: "hello",
		role: "relay",
		protocolVersion: PROTOCOL_VERSION,
		relayId: "rl-7",
		relayToken: "tK",
	};

	it("accepts control and relay hellos, ignoring fields from other protocol versions", () => {
		for (const hello of [controlHello, relayHello]) {
			expect(ControlValidators.hello.Check(roundTrip(hello))).toBe(true);
			expect(ControlValidators.hello.Check({ ...hello, protocolVersion: 3, futureField: { nested: true } })).toBe(
				true,
			);
		}
	});

	it("rejects malformed hellos", () => {
		for (const hello of [
			{ type: "hello", role: "control" },
			{ type: "nope" },
			{ ...controlHello, role: "viewer" },
			{ ...controlHello, pid: undefined },
			{ ...controlHello, client: "web" },
			{ ...controlHello, capabilities: [1] },
			{ ...controlHello, controlToken: 1 },
			{ ...controlHello, protocolVersion: "2" },
			{ ...relayHello, relayToken: undefined },
			{ ...relayHello, relayId: 7 },
		]) {
			expect(ControlValidators.hello.Check(JSON.parse(JSON.stringify(hello))), JSON.stringify(hello)).toBe(false);
		}
	});

	it("reads acks and fatals from any protocol version", () => {
		const ack: HelloAck = { type: "hello_ack", ok: true, connectionId: "c-1", version: "0.9.0", protocolVersion: 2 };
		expect(ControlValidators.helloAck.Check(roundTrip(ack))).toBe(true);
		expect(
			ControlValidators.helloAck.Check({
				type: "hello_ack",
				ok: false,
				error: "protocol_mismatch",
				protocolVersion: 3,
			}),
		).toBe(true);
		expect(ControlValidators.helloAck.Check({ ...ack, futureField: true })).toBe(true);
		expect(ControlValidators.helloAck.Check({ type: "hello_ack" })).toBe(false);
		expect(ControlValidators.helloAck.Check({ type: "hello_ack", ok: false, error: "future_reason" })).toBe(true);
		expect(ControlValidators.helloAck.Check({ type: "hello_ack", ok: false, error: 7 })).toBe(false);
		expect(ControlValidators.helloAck.Check({ type: "hello_ack", ok: "no" })).toBe(false);
		expect(ControlValidators.fatal.Check({ type: "fatal", error: "invalid_hello" })).toBe(true);
		expect(ControlValidators.fatal.Check({ type: "fatal", error: "future_reason", detail: 1 })).toBe(true);
		expect(ControlValidators.fatal.Check({ type: "fatal" })).toBe(false);
	});
});

describe("relay preamble", () => {
	const preamble: RelayPreamble = {
		type: "relay_preamble",
		relayId: "rl-7",
		handshake: {
			hello: {
				type: IROH_REMOTE_HELLO_TYPE,
				protocol: IROH_REMOTE_ALPN,
				workspace: "volt",
				clientLabel: "phone",
				mode: "conversation",
				conversation: { target: "session", sessionId: "s-abc" },
			},
			response: {
				type: "volt_iroh_handshake",
				success: true,
				workspace: "volt",
				hostNodeId: "n-host",
				clientNodeId: "n-1",
				features: ["multi_streams.v1", "conversation_streams.v1"],
				sessionId: "s-abc",
				conversation: { target: "session", sessionId: "s-abc", selection: "resumed" },
			},
			initialInput: [104, 105, 10],
		},
		authorization: {
			clientNodeId: "n-1",
			workspaceName: "volt",
			workspacePath: "/tmp/volt",
			workspaceNames: ["volt"],
			workspaces: [
				{ name: "volt", status: "available" },
				{ name: "offline", status: "missing" },
			],
			allowedTools: "read",
			rpcGrant: RPC_GRANT,
			worktreeId: "x",
			worktreePath: "/tmp/wt",
		},
		hostNodeId: "n-host",
		relayMode: "production",
		relayUrls: ["https://relay.example.com"],
		connectionId: "ic-3",
		streamId: "st-9",
		resolvedTarget: {
			sessionId: "s-abc",
			selection: "resumed",
			requestedSessionId: "s-abc",
			workspaceName: "volt",
			workspacePath: "/tmp/volt",
			worktreeId: "x",
			workingDirectory: "packages/app",
		},
	};

	it("accepts a preamble and rejects malformed authorization, targets, and handshakes", () => {
		expect(ControlValidators.relayPreamble.Check(roundTrip(preamble))).toBe(true);
		const { handshake, authorization, resolvedTarget } = preamble;
		for (const invalid of [
			{ ...preamble, unexpected: true },
			// A session id never aliases another conversation.
			{ ...preamble, resolvedTarget: { ...resolvedTarget, sessionId: "s-def", selection: "session_rekeyed" } },
			{ ...preamble, authorization: { ...authorization, rpcGrant: undefined } },
			{ ...preamble, authorization: { ...authorization, rpcGrant: { ...RPC_GRANT, capabilities: ["root.v1"] } } },
			{ ...preamble, authorization: { ...authorization, workspaceNames: undefined } },
			{ ...preamble, authorization: { ...authorization, workspaces: [{ name: "volt", status: "unknown" }] } },
			{ ...preamble, authorization: { ...authorization, unexpected: true } },
			{ ...preamble, handshake: { ...handshake, hello: { ...handshake.hello, clientInfo: { label: "x" } } } },
			{ ...preamble, handshake: { ...handshake, hello: { ...handshake.hello, mode: "workspaceDiscovery" } } },
			{ ...preamble, handshake: { ...handshake, response: { ...handshake.response, success: false } } },
			{ ...preamble, handshake: { ...handshake, initialInput: [256] } },
			{ ...preamble, relayMode: "relayed" },
		]) {
			expect(ControlValidators.relayPreamble.Check(JSON.parse(JSON.stringify(invalid)))).toBe(false);
		}
	});
});

describe("Iroh remote hello admission", () => {
	const helloWire = Compile(IrohRemoteHelloWireSchema);
	const parsedHello = Compile(IrohRemoteHelloSchema);
	const base = { type: IROH_REMOTE_HELLO_TYPE, protocol: IROH_REMOTE_ALPN, workspace: "volt" };

	const hellos: unknown[] = [
		{ ...base, conversation: { target: "last" } },
		{ ...base, secret: "s", clientLabel: "phone", clientNodeId: "n", conversation: { target: "last" } },
		{ ...base, mode: "conversation", futureField: [1], conversation: { target: "last" } },
		{ ...base, conversation: { target: "new", sessionId: "new-session", worktreeId: "fix-login" } },
		{ ...base, conversation: { target: "new", sessionId: "new-session", workingDirectory: "packages/app" } },
		{ ...base, conversation: { target: "session", sessionId: "abc_123-id" } },
		{ ...base, workspaceDiscovery: { purpose: "review" } },
		{ ...base, workspaceManagement: { purpose: "manage_worktrees" } },
		null,
		[],
		{ ...base, type: "wrong", conversation: { target: "last" } },
		{ ...base, protocol: "volt-rpc/0", conversation: { target: "last" } },
		{ ...base, workspace: "", conversation: { target: "last" } },
		{ ...base, workspace: "bad\nworkspace", conversation: { target: "last" } },
		{ ...base, workspace: "w".repeat(256), conversation: { target: "last" } },
		base,
		{ ...base, conversation: { target: "last" }, workspaceDiscovery: { purpose: "list_sessions" } },
		{ ...base, conversation: null },
		{ ...base, conversation: { target: "last", sessionId: "abc" } },
		{ ...base, conversation: { target: "last", worktreeId: "fix-login" } },
		{ ...base, conversation: { target: "session", sessionId: "abc", workingDirectory: "app" } },
		{ ...base, conversation: { target: "new" } },
		{ ...base, conversation: { target: "new", sessionId: "ABC" } },
		{ ...base, conversation: { target: "new", sessionId: "s", worktreeId: "UPPER" } },
		{ ...base, conversation: { target: "new", sessionId: "s", workingDirectory: "../app" } },
		{ ...base, conversation: { target: "new", sessionId: "s", workingDirectory: "a".repeat(4097) } },
		{ ...base, conversation: { target: "new", sessionId: "s", extra: true } },
		{ ...base, conversation: { target: "unknown" } },
		{ ...base, workspaceDiscovery: { purpose: "unknown" } },
		{ ...base, workspaceDiscovery: { purpose: "list_sessions", extra: true } },
		{ ...base, workspaceManagement: { purpose: "manage_everything" } },
		{ ...base, secret: "", conversation: { target: "last" } },
		{ ...base, clientNodeId: 7, conversation: { target: "last" } },
	];

	function tryParse(value: unknown): { ok: true } | { ok: false; error: unknown } {
		try {
			const parsed = parseIrohRemoteHello(value);
			expect(parsedHello.Check(parsed), JSON.stringify(value)).toBe(true);
			return { ok: true };
		} catch (error) {
			return { ok: false, error };
		}
	}

	it("admits exactly the hellos the contract schema accepts within the path budgets", () => {
		for (const hello of hellos) {
			const conversation = (hello as { conversation?: { workingDirectory?: unknown } } | null)?.conversation;
			const withinBudget =
				conversation?.workingDirectory === undefined || isIrohRemoteWorkingDirectory(conversation.workingDirectory);
			expect(tryParse(hello).ok, JSON.stringify(hello)).toBe(helloWire.Check(hello) && withinBudget);
		}
	});

	it("attributes each rejection to its handshake outcome", () => {
		const outcomeOf = (value: unknown): string | undefined => {
			const result = tryParse(value);
			if (result.ok) throw new Error("expected rejection");
			return result.error instanceof IrohRemoteHandshakeError ? result.error.outcome : undefined;
		};
		expect(outcomeOf({ ...base, type: "wrong", conversation: { target: "last" } })).toBeUndefined();
		expect(outcomeOf({ ...base, protocol: "volt-rpc/0", conversation: { target: "last" } })).toBeUndefined();
		expect(outcomeOf({ ...base, workspace: "bad\nworkspace", conversation: { target: "last" } })).toBe(
			"invalid_workspace",
		);
		expect(outcomeOf({ ...base, workspace: "bad\nworkspace", conversation: { target: "bogus" } })).toBe(
			"invalid_workspace",
		);
		expect(outcomeOf(base)).toBe("invalid_conversation_target");
		expect(outcomeOf({ ...base, conversation: { target: "new", sessionId: "ABC" } })).toBe(
			"invalid_conversation_target",
		);
		expect(outcomeOf({ ...base, workspaceManagement: { purpose: "manage_everything" } })).toBe(
			"invalid_conversation_target",
		);
		expect(outcomeOf({ ...base, secret: "", conversation: { target: "last" } })).toBeUndefined();
	});

	it("keeps workspace names and working directories equivalent to their host rules", () => {
		const nameCases: Array<[string, boolean]> = [
			["volt", true],
			["", false],
			["a\tb", false],
			["a\u007fb", false],
			["w".repeat(255), true],
			["w".repeat(256), false],
			["😀".repeat(255), true],
			["e\u0301".repeat(127), true],
			["e\u0301".repeat(128), false],
		];
		for (const [name, valid] of nameCases) {
			expect(isIrohRemoteWorkspaceName(name), name).toBe(valid);
		}
		const workingDirectory = Compile(IrohRemoteWorkingDirectorySchema);
		for (const path of [
			"packages/app",
			"a/b/c",
			"...",
			".gitignore",
			"a/.github",
			"",
			".",
			"..",
			"../app",
			"/tmp",
			"//server",
			"packages/../app",
			"packages//app",
			"packages/",
			"packages/.git",
			"packages/.GIT/x",
			"a\\b",
			"C:/repo",
			"c:repo",
			"packages/\tapp",
			"nul\u0000byte",
		]) {
			expect(workingDirectory.Check(path), path).toBe(isIrohRemoteWorkingDirectory(path));
		}
	});
});

describe("control line framing", () => {
	it("buffers partial lines across pushes", () => {
		const decoder = new ControlLineDecoder();
		const line = encodeControlLine({ type: "status", id: "1" });
		const first = line.subarray(0, 5);
		const second = line.subarray(5);
		expect(decoder.push(first)).toEqual([]);
		expect(decoder.push(Buffer.concat([second, encodeControlLine({ type: "ok", id: "2" })]))).toEqual([
			{ type: "status", id: "1" },
			{ type: "ok", id: "2" },
		]);
	});

	it("skips blank lines and exposes the raw remainder", () => {
		const decoder = new ControlLineDecoder();
		const messages = decoder.push(Buffer.from('\n{"type":"ok","id":"1"}\nRAWBYTES', "utf8"));
		expect(messages).toEqual([{ type: "ok", id: "1" }]);
		expect(decoder.drainRemainder().toString("utf8")).toBe("RAWBYTES");
		expect(decoder.drainRemainder().length).toBe(0);
	});

	it("enforces the 8 MiB line cap", () => {
		const decoder = new ControlLineDecoder();
		const oversized = Buffer.alloc(CONTROL_MAX_LINE_BYTES + 2, 0x61);
		expect(() => decoder.push(oversized)).toThrow(ControlFrameTooLargeError);

		const withNewline = Buffer.concat([Buffer.alloc(CONTROL_MAX_LINE_BYTES + 1, 0x61), Buffer.from("\n")]);
		const freshDecoder = new ControlLineDecoder();
		expect(() => freshDecoder.push(withNewline)).toThrow(ControlFrameTooLargeError);
	});
});

describe("createControlClientStatus", () => {
	const baseClient = {
		nodeId: "client-node",
		label: "phone",
		allowedWorkspaces: [],
		rpcGrant: RPC_GRANT,
		pairedAt: 100,
		lastSeenAt: 200,
	};

	it("reports a tracking client as the resolved default with usesDefaultTools", () => {
		const status = createControlClientStatus(baseClient);
		expect(status.allowedTools).toEqual(DEFAULT_IROH_REMOTE_ALLOW_TOOLS.split(","));
		expect(status.usesDefaultTools).toBe(true);
		expect(status).toMatchObject({ clientNodeId: "client-node", label: "phone", pairedAtMs: 100, lastSeenAtMs: 200 });
		expect(ControlValidators.response.Check(roundTrip({ type: "clients_result", id: "1", clients: [status] }))).toBe(
			true,
		);
	});

	it("reports a pinned client's exact grant without the default marker", () => {
		const status = createControlClientStatus({ ...baseClient, allowedTools: "read,grep" });
		expect(status.allowedTools).toEqual(["read", "grep"]);
		expect(status.usesDefaultTools).toBe(false);
	});

	it("reports a deny-all client as an empty grant, never the default", () => {
		const status = createControlClientStatus({ ...baseClient, allowedTools: "" });
		expect(status.allowedTools).toEqual([]);
		expect(status.usesDefaultTools).toBe(false);
	});
});
