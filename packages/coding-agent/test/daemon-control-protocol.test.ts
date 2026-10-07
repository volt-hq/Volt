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
	createHelloProof,
	encodeControlLine,
	type HelloAck,
	type HelloMessage,
	isRequestAllowedFor,
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

const SPAWN_OPTIONS = {
	env: { PATH: "/usr/bin", HOME: "/home/user" },
	config: {
		trust: true,
		extensions: ["/home/user/ext.ts", "npm:@scope/ext"],
		tools: ["read", "bash"],
		flags: { "my-flag": "on", verbose: true },
	},
	cwd: "/home/user/project",
	persist: true,
	session: { provider: "anthropic", model: "sonnet:high", plan: true },
	modelScopePatterns: ["sonnet*"],
};

// One valid sample per message type. The mapped types make a missing type a compile error.
const REQUESTS: ByType<ControlRequest> = {
	status: { type: "status", id: "1" },
	shutdown: { type: "shutdown", id: "2" },
	change_observe: {
		type: "change_observe",
		id: "5",
		workspaceName: "volt",
		sessionId: "s-1",
		gitContext: { repository: "Volt", branch: "feature/work", headOid: HEAD_OID, baseRef: "main" },
	},
	pair_request: { type: "pair_request", id: "6", workspaceName: "volt", access: "coding" },
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
	},
	theme_set: { type: "theme_set", id: "24", theme: "dark" },
	keep_awake_set: { type: "keep_awake_set", id: "25", enabled: false },
	conversation_open: {
		type: "conversation_open",
		id: "42",
		target: { kind: "session", sessionId: "s-1", sessionDir: "/sessions" },
		spawn: SPAWN_OPTIONS,
		clientKey: "tui-1",
	},
	conversation_host_response: {
		type: "conversation_host_response",
		id: "43",
		requestId: "hq-1",
		response: { value: "Trust" },
	},
	worker_host_request: {
		type: "worker_host_request",
		id: "44",
		sessionId: "s-1",
		request: { kind: "select", title: "Trust project folder?", options: ["Trust", "Do not trust"] },
	},
	worker_ready: { type: "worker_ready", id: "29", sessionId: "s-1" },
	worker_open_failed: {
		type: "worker_open_failed",
		id: "30",
		sessionId: "s-1",
		outcome: "conversation_locked",
		message: "conversation is open in another Volt process on the host",
	},
	worker_activity: { type: "worker_activity", id: "31", activeSessionIds: ["s-1", "s-2"] },
	worker_hosts: { type: "worker_hosts", id: "32", sessionId: "s-2", kind: "child", parentSessionId: "s-1" },
	worker_released: { type: "worker_released", id: "33", sessionId: "s-2" },
	worker_stop_result: { type: "worker_stop_result", id: "34", stopId: "stop-1", outcome: "refused_active" },
	worker_close_result: { type: "worker_close_result", id: "35", closeId: "close-1", outcome: "closed" },
	worker_worktree_restore: {
		type: "worker_worktree_restore",
		id: "40",
		path: "/agent/worktrees/ws/amber-basin",
		sessionRef: { sessionDirectory: "/sessions", storeId: "store", sessionId: "session", sessionGeneration: "gen" },
	},
	worker_worktree_release: { type: "worker_worktree_release", id: "41", pinId: "pin-1" },
	worker_forward: {
		type: "worker_forward",
		id: "35",
		relayId: "rl-1",
		frame: { type: "register_push_target", intentId: "i-2", input: PUSH_TARGET },
	},
	worker_notification_delivery: {
		type: "worker_notification_delivery",
		id: "36",
		relayId: "rl-1",
		notification: {
			eventId: "review:one:completed",
			hostNodeId: HOST_NODE_ID,
			kind: "work_finished",
			title: "Your review is ready",
			body: "PR #151 completed with 4 findings.",
			sessionId: "s-1",
			workspaceName: "volt",
			workId: "review:one",
			workKind: "review",
		},
	},
	worker_moved: { type: "worker_moved", id: "37", from: "s-1", to: "s-2" },
	worker_last_session: { type: "worker_last_session", id: "38", relayId: "rl-1", sessionId: "s-2" },
	worker_authority: { type: "worker_authority", id: "39", relayId: "rl-1" },
};

const REVIEW_NOTIFICATION = {
	eventId: "review:one:completed",
	hostNodeId: HOST_NODE_ID,
	kind: "work_finished",
	title: "Your review is ready",
	body: "PR #151 completed with 4 findings.",
	sessionId: "s-1",
	workspaceName: "volt",
	workId: "review:one",
	workKind: "review",
};

// Type-specific rejections; every closed message also rejects an unknown field and a missing or wrong type.
const INVALID_REQUESTS: { [K in ControlRequest["type"]]?: Array<Record<string, unknown>> } = {
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
		{ workspaceName: undefined },
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
	worktree_bind: [{ sessionId: undefined }, { acquireLease: true }],
	theme_set: [{ theme: undefined }],
	keep_awake_set: [{ enabled: "yes" }, { enabled: undefined }],
	worker_forward: [
		{ relayId: 1 },
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
	worker_notification_delivery: [
		{ notification: { eventId: "e-1", kind: "conversation_completed", title: "Volt finished" } },
		{ notification: { ...REVIEW_NOTIFICATION, planId: "plan-1" } },
		{ notification: { ...REVIEW_NOTIFICATION, workId: undefined } },
		{ notification: { ...REVIEW_NOTIFICATION, workKind: undefined } },
		{ notification: { ...REVIEW_NOTIFICATION, workKind: "ext:Bad/kind" } },
		{ notification: { ...REVIEW_NOTIFICATION, kind: "secret_kind" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review\nready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review  ready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: " Review ready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "Review\u200bready" } },
		{ notification: { ...REVIEW_NOTIFICATION, title: "r".repeat(129) } },
		{ notification: { ...REVIEW_NOTIFICATION, body: "Open /Users/private/review.diff" } },
		{ notification: { ...REVIEW_NOTIFICATION, workspaceName: "private/path" } },
		{ notification: { ...REVIEW_NOTIFICATION, workId: "w".repeat(129) } },
		{ notification: { ...REVIEW_NOTIFICATION, workId: "review one" } },
		{ notification: { ...REVIEW_NOTIFICATION, eventId: "e".repeat(513) } },
		{ notification: { ...REVIEW_NOTIFICATION, hostNodeId: "A".repeat(64) } },
		{ notification: { ...REVIEW_NOTIFICATION, workspaceName: undefined, workspace: "volt" } },
	],
	conversation_open: [
		{ clientKey: "" },
		{ target: { kind: "fork" } },
		{ target: { kind: "session", sessionId: "s 1" } },
		{ spawn: { ...SPAWN_OPTIONS, persist: undefined } },
		// An environment variable's name has no `=`, and no value carries NUL.
		{ spawn: { ...SPAWN_OPTIONS, env: { "A=B": "x" } } },
		{ spawn: { ...SPAWN_OPTIONS, env: { A: "x\u0000y" } } },
		{ spawn: { ...SPAWN_OPTIONS, config: { ...SPAWN_OPTIONS.config, unexpected: true } } },
		{ spawn: { ...SPAWN_OPTIONS, session: { model: "sonnet", thinking: "huge" } } },
		{ spawn: { ...SPAWN_OPTIONS, config: { flags: { "a=b": true } } } },
		{ workspaceRegistration: "public" },
	],
	conversation_host_response: [{ requestId: undefined }, { response: { value: 1 } }, { requestId: "x".repeat(65) }],
	// A worker asks a TUI only questions in words: never its editor's text, a sign-in, or a dialog.
	worker_host_request: [
		{ request: { kind: "editor_text" } },
		{ request: { kind: "provider_auth", provider: "p", flow: "browser" } },
		{ request: { kind: "select", title: "t", options: [] } },
		{ sessionId: undefined },
	],
	worker_ready: [{ sessionId: undefined }, { sessionId: 1 }],
	worker_open_failed: [{ message: "x".repeat(1025) }, { message: 1 }, { sessionId: undefined }],
	worker_activity: [
		{ activeSessionIds: "s-1" },
		{ activeSessionIds: Array.from({ length: 257 }, (_, i) => `s-${i}`) },
	],
	worker_hosts: [{ kind: "primary" }, { sessionId: undefined }],
	worker_released: [{ sessionId: 1 }],
	worker_stop_result: [{ outcome: "maybe" }, { stopId: undefined }],
	worker_close_result: [{ outcome: "stopped" }, { closeId: undefined }],
	worker_worktree_restore: [{ path: "" }, { path: "p".repeat(4097) }, { sessionRef: undefined }],
	worker_worktree_release: [{ pinId: "p".repeat(65) }, { pinId: undefined }],
	worker_moved: [{ to: undefined }],
	worker_last_session: [{ sessionId: undefined }],
	worker_authority: [{ relayId: undefined }],
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
	workers: [
		{
			workerId: "w-1",
			pid: 4242,
			state: "live",
			origin: "phone",
			workspaceName: "volt",
			sessionIds: ["s-1", "s-2"],
			clients: { local: 0, remote: 1 },
		},
	],
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
	error: { type: "error", id: "2", code: "not_hosted", message: "the worker does not host that conversation" },
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
	relay_push_delivery_result: { type: "relay_push_delivery_result", id: "16", status: "sent" },
	workspace_confirmation_required: {
		type: "workspace_confirmation_required",
		id: "21",
		directory: "/home/user",
		reason: "home",
	},
	conversation_opened: {
		type: "conversation_opened",
		id: "20",
		relayId: "rl-2",
		relayToken: "tok",
		sessionId: "s-1",
		selection: "resumed",
		workspaceName: "volt",
		spawned: false,
		ignoredOptions: ["extensions", "trust"],
	},
	worker_host_response: { type: "worker_host_response", id: "21", response: { cancelled: true } },
	worker_forward_result: {
		type: "worker_forward_result",
		id: "17",
		frame: { type: "accepted", intentId: "i-2", ordinals: [], result: { registered: true } },
	},
	worker_authority_result: { type: "worker_authority_result", id: "18", authority: "current" },
	worker_worktree_pinned: { type: "worker_worktree_pinned", id: "19", pinId: "pin-1" },
};

const INVALID_RESPONSES: { [K in ControlResponse["type"]]?: Array<Record<string, unknown>> } = {
	conversation_opened: [{ ignoredOptions: ["env"] }, { selection: "created_after_missing" }, { spawned: undefined }],
	workspace_confirmation_required: [{ reason: "sensitive" }, { directory: undefined }],
	error: [{ code: undefined }],
	status_result: [
		{ remoteTransport: undefined },
		{ remoteTransport: { state: "healthy" } },
		{ remoteTransport: { state: "unavailable", reasonCode: "secret" } },
		{ keepAwake: undefined },
		{ environment: { source: "magic" } },
		{ leases: [] },
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
	worker_forward_result: [
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
	worker_host_response: [{ response: { value: "x", extra: true } }],
	worker_authority_result: [{ authority: "lost" }],
	worker_worktree_pinned: [{ pinId: undefined }],
};

const EVENTS: ByType<ControlEvent> = {
	relay_offer: {
		type: "relay_offer",
		clientKind: "phone",
		relayId: "rl-1",
		relayToken: "tok",
		workspaceName: "volt",
		sessionId: "s-1",
		clientNodeId: "n-1",
		connectionId: "ic-1",
		streamId: "st-1",
	},
	relay_closed: { type: "relay_closed", relayId: "rl-1", reason: "worker_disconnected" },
	theme_snapshot: { type: "theme_snapshot", themeName: "dark", tokens: { accent: "#ff0000" } },
	keep_awake_changed: {
		type: "keep_awake_changed",
		keepAwake: { enabled: true, state: "active", method: "caffeinate" },
	},
	pairing_progress: { type: "pairing_progress", requestId: "pr-1", phase: "waiting" },
	daemon_shutdown: { type: "daemon_shutdown" },
	conversation_host_request: {
		type: "conversation_host_request",
		requestId: "hq-1",
		sessionId: "s-1",
		request: { kind: "confirm", title: "Trust project?", message: "/tmp/volt" },
	},
	worker_open: {
		type: "worker_open",
		spec: {
			workerId: "w-1",
			origin: "phone",
			workspace: { name: "volt", path: "/tmp/volt", generation: 3 },
			session: { sessionDirectory: "/sessions", storeId: "store", sessionId: "s-1", sessionGeneration: "gen" },
			cwd: "/tmp/volt/src",
			root: "/tmp/volt",
			projectCwd: "/tmp/volt",
			toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
			projectTrusted: false,
		},
	},
	worker_stop: { type: "worker_stop", stopId: "stop-1", reason: "retention", force: false },
	worker_close: { type: "worker_close", closeId: "close-1", sessionId: "s-1", reason: "retention", force: false },
	relay_authority: { type: "relay_authority", relayId: "rl-1", loss: "revoked" },
};

const INVALID_EVENTS: { [K in ControlEvent["type"]]?: Array<Record<string, unknown>> } = {
	relay_offer: [{ relayToken: undefined }, { clientKind: "tui" }],
	relay_closed: [{ reason: "other" }],
	theme_snapshot: [{ tokens: { accent: 1 } }],
	keep_awake_changed: [{ keepAwake: undefined }],
	pairing_progress: [{ phase: "scanning" }, { qrLines: "line" }],
	conversation_host_request: [{ request: { kind: "editor_text" } }, { requestId: undefined }],
	worker_open: [{ spec: { workerId: "w-1" } }],
	worker_stop: [{ reason: "bored" }, { force: undefined }],
	worker_close: [{ sessionId: undefined }, { force: undefined }, { reason: "bored" }],
	relay_authority: [{ loss: "current" }],
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

	it("offers a worker a TUI's stream without a phone's identity, and spawns a TUI's worker with its options", () => {
		const offer = {
			type: "relay_offer",
			clientKind: "local",
			relayId: "rl-2",
			relayToken: "tok",
			workspaceName: "volt",
			sessionId: "s-1",
		};
		expect(ControlValidators.event.Check(roundTrip(offer))).toBe(true);
		expect(ControlValidators.event.Check(roundTrip({ ...offer, clientNodeId: "n-1" }))).toBe(false);
		const spawn = {
			type: "worker_open",
			spec: {
				workerId: "w-1",
				origin: "tui",
				workspace: { name: "volt", path: "/tmp/volt", generation: 3 },
				session: { sessionId: "s-1", inMemory: true },
				cwd: "/tmp/volt",
				root: "/tmp/volt",
				projectCwd: "/tmp/volt",
				config: SPAWN_OPTIONS.config,
				sessionOptions: SPAWN_OPTIONS.session,
				clientKey: "tui-1",
			},
		};
		expect(ControlValidators.event.Check(roundTrip(spawn))).toBe(true);
		// A TUI's spawn carries no tool policy, its environment is the worker process's own, and it names its opener.
		const { clientKey: _clientKey, ...withoutOpener } = spawn.spec;
		for (const spec of [
			{ ...spawn.spec, toolPolicy: { tools: [], allowUnlistedExtensionTools: false } },
			{ ...spawn.spec, env: SPAWN_OPTIONS.env },
			{ ...spawn.spec, session: { sessionId: "s-1", inMemory: false } },
			withoutOpener,
		]) {
			expect(ControlValidators.event.Check(roundTrip({ ...spawn, spec }))).toBe(false);
		}
	});

	it("lets only a TUI open a conversation and answer its worker's questions, and only a worker ask them or observe Git state", () => {
		expect(isRequestAllowedFor("tui", "conversation_open")).toBe(true);
		expect(isRequestAllowedFor("cli", "conversation_open")).toBe(false);
		expect(isRequestAllowedFor("worker", "conversation_open")).toBe(false);
		expect(isRequestAllowedFor("worker", "change_observe")).toBe(true);
		expect(isRequestAllowedFor("tui", "change_observe")).toBe(false);
		expect(isRequestAllowedFor("cli", "change_observe")).toBe(false);
		expect(isRequestAllowedFor("tui", "conversation_host_response")).toBe(true);
		expect(isRequestAllowedFor("cli", "conversation_host_response")).toBe(false);
		expect(isRequestAllowedFor("worker", "conversation_host_response")).toBe(false);
		expect(isRequestAllowedFor("worker", "worker_host_request")).toBe(true);
		expect(isRequestAllowedFor("tui", "worker_host_request")).toBe(false);
		expect(isRequestAllowedFor("cli", "worker_host_request")).toBe(false);
	});

	it("admits the default, preset, and explicit pairing access selections", () => {
		expect(admitControlRequest({ type: "pair_request", id: "1", workspaceName: "volt" })).toBe(true);
		expect(
			admitControlRequest({
				type: "pair_request",
				id: "1",
				workspaceName: "volt",
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
		const request = REQUESTS.worker_notification_delivery;
		const title = "é".repeat(64);
		expect(Buffer.byteLength(title)).toBe(128);
		expect(admitControlRequest({ ...request, notification: { ...request.notification, title } })).toBe(true);
		expect(admitControlRequest({ ...request, notification: { ...request.notification, title: `${title}a` } })).toBe(
			false,
		);
		expect(
			admitControlRequest(
				mutate(request, {
					notification: {
						...REVIEW_NOTIFICATION,
						kind: "conversation_completed",
						workId: undefined,
						workKind: undefined,
					},
				}),
			),
		).toBe(true);
		expect(admitControlRequest(mutate(request, { notification: REVIEW_NOTIFICATION }))).toBe(true);
		expect(
			admitControlRequest(
				mutate(request, { notification: { ...REVIEW_NOTIFICATION, workKind: "ext:swarm-review/run" } }),
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

	it("relays exactly the daemon-executed intents and queries, as the phone sent them", () => {
		const relay = (frame: object) => ({ ...REQUESTS.worker_forward, frame });
		const relayed: object[] = [
			{ type: "register_push_target", intentId: "i-1", input: PUSH_TARGET },
			{ type: "unregister_workspace", intentId: "i-2", input: { workspaceName: "volt" } },
			{ type: "create_worktree", intentId: "i-3", input: { worktreeName: "fix-login", baseRef: "main" } },
			{ type: "create_worktree", intentId: "i-4", expectedOrdinal: 3 },
			{ type: "set_keep_awake", intentId: "i-5", input: { enabled: true } },
			{ type: "set_web_search_key", intentId: "i-6", input: { apiKey: null } },
			{ type: "upload_device_logs", intentId: "i-7", input: { fileName: "phone.log", content: "line\n" } },
			{ type: "query", queryId: "q-1", query: "sessions", params: { limit: 5, cursor: "10" } },
			{ type: "query", queryId: "q-2", query: "worktrees" },
			{ type: "query", queryId: "q-3", query: "host_status", params: {} },
			{ type: "query", queryId: "q-4", query: "web_search_status" },
		];
		for (const frame of relayed) {
			expect(admitControlRequest(roundTrip(relay(frame))), JSON.stringify(frame)).toBe(true);
		}
		const local: object[] = [
			// Conversation intents and management-stream intents stay with the worker or the daemon's stream.
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
				ControlValidators.response.Check(roundTrip({ type: "worker_forward_result", id: "1", frame })),
				JSON.stringify(frame),
			).toBe(true);
		}
	});
});

describe("control version negotiation", () => {
	const binding = { challenge: "C".repeat(43), socketPath: "/tmp/voltd-test.sock" };
	const controlHello: HelloMessage = {
		type: "hello",
		role: "control",
		protocolVersion: PROTOCOL_VERSION,
		pid: 4242,
		version: "0.9.0",
		client: "tui",
		controlProof: createHelloProof("control", "token", binding),
		capabilities: ["worktrees"],
	};
	const relayHello: HelloMessage = {
		type: "hello",
		role: "relay",
		protocolVersion: PROTOCOL_VERSION,
		relayId: "rl-7",
		relayProof: createHelloProof("relay", "tK", binding),
	};
	const workerHello: HelloMessage = {
		type: "hello",
		role: "worker",
		protocolVersion: PROTOCOL_VERSION,
		workerId: "w-1",
		workerProof: createHelloProof("worker", "tW", binding),
		pid: 4243,
		version: "0.9.0",
	};

	it("accepts control, relay, and worker hellos, ignoring fields from other protocol versions", () => {
		for (const hello of [controlHello, relayHello, workerHello]) {
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
			{ ...controlHello, controlProof: "token" },
			{ ...controlHello, controlProof: { nonce: "n" } },
			{ ...controlHello, protocolVersion: "2" },
			{ ...relayHello, relayProof: undefined },
			{ ...relayHello, relayProof: "tK" },
			{ ...relayHello, relayId: 7 },
			{ ...workerHello, workerProof: undefined },
			{ ...workerHello, workerId: 7 },
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
		kind: "phone",
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

	it("accepts a TUI's local preamble, which carries no phone's identity or grant", () => {
		const local: RelayPreamble = {
			type: "relay_preamble",
			kind: "local",
			relayId: "rl-8",
			sessionId: "s-abc",
			clientKey: "tui-1",
			modelScopePatterns: ["sonnet*"],
			apply: { model: "sonnet", thinking: "high" },
		};
		expect(ControlValidators.relayPreamble.Check(roundTrip(local))).toBe(true);
		for (const invalid of [
			{ ...local, authorization: preamble.authorization },
			{ ...local, handshake: preamble.handshake },
			{ ...local, clientKey: "" },
			{ ...local, kind: "tui" },
		]) {
			expect(ControlValidators.relayPreamble.Check(JSON.parse(JSON.stringify(invalid)))).toBe(false);
		}
	});

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
