import { Buffer } from "node:buffer";

/**
 * Wire types and framing for the voltd control plane: JSONL over the unix
 * socket ~/.volt/agent/daemon/voltd.sock. Shared by the daemon, the TUI, and
 * the CLI. Zero runtime deps beyond node:buffer.
 */

export const PROTOCOL_VERSION = 1;

/** Hard cap per JSONL line; longer lines close the connection with a fatal frame. */
export const CONTROL_MAX_LINE_BYTES = 8 * 1024 * 1024;

export type LeaseState = "unowned" | "daemon-active" | "daemon-detached" | "daemon-draining" | "tui-owned";

export type ControlClientKind = "tui" | "cli";

/**
 * Control-hello capability advertised by TUIs that can serve worktree-bound
 * conversations over the byte relay (worktree-cwd sanitization). The daemon
 * never offers worktree-session relays to control clients without it.
 */
export const CONTROL_WORKTREES_CAPABILITY = "worktrees";

export type HelloMessage =
	| {
			type: "hello";
			role: "control";
			protocolVersion: number;
			pid: number;
			version: string;
			client: ControlClientKind;
			/** Optional client capabilities (e.g. "worktrees"); absent for old clients. */
			capabilities?: string[];
	  }
	| {
			type: "hello";
			role: "relay";
			protocolVersion: number;
			relayId: string;
			relayToken: string;
	  };

export interface HelloAck {
	type: "hello_ack";
	ok: boolean;
	error?: "protocol_mismatch" | "shutting_down" | "bad_relay_token";
	/** daemon-assigned, present when ok (control role) */
	connectionId?: string;
	/** daemon package version */
	version?: string;
	protocolVersion?: number;
}

// ============================================================================
// Requests and responses (control role)
// ============================================================================

export type ControlRequest =
	| { type: "status"; id: string }
	| { type: "shutdown"; id: string }
	| {
			type: "lease_acquire";
			id: string;
			workspaceName: string;
			sessionId: string;
			/** reserved; true => lease_denied{force_unsupported} */
			force?: boolean;
	  }
	| { type: "lease_release"; id: string; workspaceName: string; sessionId: string }
	| { type: "lease_rekey"; id: string; workspaceName: string; oldSessionId: string; newSessionId: string }
	| { type: "pair_request"; id: string; workspaceName?: string } // progress arrives as pairing_progress events
	| { type: "clients_list"; id: string }
	| { type: "client_revoke"; id: string; clientNodeId: string }
	| { type: "client_approve_repair"; id: string; clientNodeId: string }
	| { type: "workspace_register"; id: string; name: string; path: string }
	| { type: "workspace_unregister"; id: string; name: string }
	| {
			type: "worktree_create";
			id: string;
			workspaceName: string;
			worktreeName?: string;
			branch?: string;
			baseRef?: string;
	  }
	| { type: "worktree_list"; id: string; workspaceName?: string }
	| { type: "worktree_remove"; id: string; workspaceName: string; worktreeId: string; force?: boolean }
	| { type: "worktree_prune"; id: string; workspaceName?: string }
	/** Resolve a filesystem path to the daemon-managed worktree containing it. */
	| { type: "worktree_resolve"; id: string; path: string }
	/** Bind a session id to a worktree (TUI-created worktree sessions). */
	| { type: "worktree_bind"; id: string; workspaceName: string; worktreeId: string; sessionId: string }
	| { type: "theme_set"; id: string; theme: string } // name; daemon resolves + broadcasts
	| { type: "keep_awake_set"; id: string; enabled: boolean } // hold/release the host sleep-prevention assertion
	| { type: "viewer_subscribe"; id: string; viewerFeedId: string }
	| { type: "viewer_unsubscribe"; id: string; viewerFeedId: string }
	| { type: "viewer_abort"; id: string; viewerFeedId: string }
	| {
			type: "relay_rpc";
			id: string;
			/** paired phone client the relayed conversation belongs to */
			clientNodeId: string;
			workspaceName: string;
			/** the TUI's current session id for the relayed conversation */
			sessionId: string;
			/**
			 * Verbatim phone RPC command forwarded from a TUI-owned conversation.
			 * The daemon executes it against its real state (push targets, live
			 * activities, workspace registry) and returns the RPC response in
			 * relay_rpc_result.
			 */
			command: Record<string, unknown> & { type: string };
	  };

/** RPC command types the daemon executes on behalf of a TUI relay. */
export const RELAY_RPC_COMMAND_TYPES: ReadonlySet<string> = new Set([
	"register_push_target",
	"register_live_activity",
	"unregister_live_activity",
	"unregister_workspace",
	"set_keep_awake",
	"get_keep_awake",
	"set_web_search_key",
	"get_web_search_status",
]);

/** Host keep-awake assertion state as reported over the control plane. */
export interface ControlKeepAwakeStatus {
	/** Desired (persisted) state. */
	enabled: boolean;
	/** Actual state; `degraded` means enabled but the assertion is not held. */
	state: "disabled" | "active" | "degraded";
	method?: string;
	reason?: string;
}

export interface ControlLeaseStatus {
	workspaceName: string;
	sessionId: string;
	state: LeaseState;
	relayCount: number;
	streamCount: number;
}

export interface ControlWorkspaceStatus {
	name: string;
	path: string;
}

/**
 * Worktree status over the LOCAL control socket. Unlike the iroh wire, the
 * control plane is trusted (same user), so checkout paths are included for
 * display.
 */
export interface ControlWorktreeStatus {
	id: string;
	workspaceName: string;
	path: string;
	branch: string;
	baseRef?: string;
	createdAt: number;
	sessionIds: string[];
	available?: boolean;
	dirty?: boolean;
	/** Branch commits vs the base ref (merge-back guidance). */
	aheadBehind?: { ahead: number; behind: number };
}

export interface ControlClientStatus {
	clientNodeId: string;
	label?: string;
	pairedAtMs: number;
}

export type ControlResponse =
	| { type: "ok"; id: string }
	| { type: "error"; id: string; code: string; message: string }
	| { type: "lease_granted"; id: string; workspaceName: string; sessionId: string; handoff: "cold" | "warm" | "none" }
	| { type: "lease_pending"; id: string; viewerFeedId: string }
	// lease_pending is provisional; the terminal response for the same id arrives
	// when the drain completes (lease_granted) or fails (error{drain_failed})
	| { type: "lease_denied"; id: string; reason: "held_by_tui" | "force_unsupported" | "draining_elsewhere" }
	| {
			type: "status_result";
			id: string;
			version: string;
			protocolVersion: number;
			pid: number;
			startedAtMs: number;
			leases: ControlLeaseStatus[];
			phoneConnections: number;
			workspaces: ControlWorkspaceStatus[];
			clients: ControlClientStatus[];
			keepAwake: ControlKeepAwakeStatus;
	  }
	| { type: "keep_awake_result"; id: string; keepAwake: ControlKeepAwakeStatus }
	| { type: "clients_result"; id: string; clients: ControlClientStatus[] }
	| { type: "worktree_result"; id: string; worktree: ControlWorktreeStatus }
	| { type: "worktrees_result"; id: string; worktrees: ControlWorktreeStatus[] }
	| {
			type: "worktree_resolve_result";
			id: string;
			/** Parent workspace the worktree belongs to. */
			workspaceName: string;
			/** Parent workspace checkout path (control plane is local/trusted). */
			workspacePath: string;
			worktreeId: string;
			worktreePath: string;
	  }
	| {
			type: "worktree_prune_result";
			id: string;
			results: Array<{ workspaceName: string; removedRecords: string[]; orphanCheckouts: string[] }>;
	  }
	| { type: "pair_started"; id: string; requestId: string }
	| {
			type: "relay_rpc_result";
			id: string;
			/** verbatim RPC response object for the TUI to forward to the phone */
			response: Record<string, unknown>;
			/** refreshed workspace metadata after a successful unregister_workspace */
			workspaceMetadata?: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> };
	  };

// ============================================================================
// Unsolicited events (daemon -> control clients)
// ============================================================================

export type RelayCloseReason =
	| "phone_disconnected"
	| "tui_disconnected"
	| "lease_transferred"
	| "session_rekeyed_reconnect"
	| "workspace_unregistered"
	| "host_shutdown"
	| "error";

export type ControlEvent =
	| {
			type: "relay_offer";
			relayId: string;
			/** single-use, 10s expiry */
			relayToken: string;
			workspaceName: string;
			sessionId: string;
			clientNodeId: string;
			connectionId: string;
			streamId: string;
	  }
	| { type: "relay_closed"; relayId: string; reason: RelayCloseReason }
	| {
			type: "viewer_event";
			viewerFeedId: string;
			seq: number;
			/** AgentSessionEvent JSON, or {kind:"truncated"} when the buffer overflowed */
			event: unknown;
	  }
	| { type: "viewer_end"; viewerFeedId: string; reason: "granted" | "cancelled" | "error" }
	| { type: "theme_snapshot"; themeName: string; tokens: Record<string, string> }
	| { type: "keep_awake_changed"; keepAwake: ControlKeepAwakeStatus }
	| {
			type: "pairing_progress";
			requestId: string;
			phase: "ticket" | "qr" | "waiting" | "completed" | "failed";
			ticket?: string;
			qrLines?: string[];
			clientNodeId?: string;
			error?: string;
	  }
	| { type: "daemon_shutdown" };

export interface ControlFatal {
	type: "fatal";
	error: string;
}

export type ControlMessage = HelloMessage | HelloAck | ControlRequest | ControlResponse | ControlEvent | ControlFatal;

/** One JSONL relay preamble line follows a successful relay hello_ack. */
export interface RelayPreamble {
	type: "relay_preamble";
	relayId: string;
	/** verbatim phone handshake JSON as received (parsed object, re-serialized) */
	handshake: unknown;
	/** authorization subset — everything the TUI needs to serve the stream */
	authorization: {
		clientNodeId: string;
		workspaceName: string;
		workspacePath: string;
		/** Present when the conversation is bound to a daemon-managed worktree. */
		worktreeId?: string;
		/** Worktree checkout path — the TUI sanitizes with this as the root. */
		worktreePath?: string;
	};
	/**
	 * The daemon's Iroh node id: the TUI writes it into the handshake response
	 * so the phone's saved-host identity verification passes over the relay.
	 */
	hostNodeId?: string;
	relayMode?: "disabled" | "development" | "production";
	relayUrls?: string[];
	connectionId: string;
	streamId: string;
	resolvedTarget: {
		sessionId: string;
		sessionFilePath?: string;
		selection: "created" | "created_after_missing" | "resumed";
		requestedSessionId?: string;
		workspaceName: string;
		workspacePath: string;
		worktreeId?: string;
	};
}

// ============================================================================
// Framing
// ============================================================================

export function encodeControlLine(message: object): Buffer {
	return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

export class ControlFrameTooLargeError extends Error {
	constructor(byteLength: number) {
		super(`control frame of ${byteLength} bytes exceeds the ${CONTROL_MAX_LINE_BYTES} byte cap`);
		this.name = "ControlFrameTooLargeError";
	}
}

/**
 * Incremental JSONL decoder with the 8 MiB line cap. Feed raw socket chunks;
 * complete lines come back parsed. Throws ControlFrameTooLargeError when the
 * buffered partial line exceeds the cap (callers must close the connection).
 */
export class ControlLineDecoder {
	private buffered: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.buffered = this.buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
		const messages: unknown[] = [];
		while (true) {
			const newlineIndex = this.buffered.indexOf(0x0a);
			if (newlineIndex === -1) {
				if (this.buffered.length > CONTROL_MAX_LINE_BYTES) {
					throw new ControlFrameTooLargeError(this.buffered.length);
				}
				return messages;
			}
			if (newlineIndex > CONTROL_MAX_LINE_BYTES) {
				throw new ControlFrameTooLargeError(newlineIndex);
			}
			const line = this.buffered.subarray(0, newlineIndex).toString("utf8");
			this.buffered = this.buffered.subarray(newlineIndex + 1);
			if (line.trim().length === 0) {
				continue;
			}
			messages.push(JSON.parse(line));
		}
	}

	/**
	 * Parse complete lines one at a time, invoking handle per message. When
	 * handle returns "stop" (relay handoff), decoding halts immediately and any
	 * bytes past the consumed line stay buffered for drainRemainder(). Unlike
	 * push(), bytes arriving after a stop are never JSON-decoded — required for
	 * relay hellos, where everything after the hello line is opaque payload.
	 */
	pushEach(chunk: Buffer, handle: (message: unknown) => "continue" | "stop"): void {
		this.buffered = this.buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffered, chunk]);
		while (true) {
			const newlineIndex = this.buffered.indexOf(0x0a);
			if (newlineIndex === -1) {
				if (this.buffered.length > CONTROL_MAX_LINE_BYTES) {
					throw new ControlFrameTooLargeError(this.buffered.length);
				}
				return;
			}
			if (newlineIndex > CONTROL_MAX_LINE_BYTES) {
				throw new ControlFrameTooLargeError(newlineIndex);
			}
			const line = this.buffered.subarray(0, newlineIndex).toString("utf8");
			this.buffered = this.buffered.subarray(newlineIndex + 1);
			if (line.trim().length === 0) {
				continue;
			}
			if (handle(JSON.parse(line)) === "stop") {
				return;
			}
		}
	}

	/** Bytes buffered past the last complete line (used when switching a relay conn to raw mode). */
	drainRemainder(): Buffer {
		const remainder = this.buffered;
		this.buffered = Buffer.alloc(0);
		return remainder;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHelloMessage(value: unknown): HelloMessage | undefined {
	if (!isRecord(value) || value.type !== "hello") {
		return undefined;
	}
	if (typeof value.protocolVersion !== "number") {
		return undefined;
	}
	if (value.role === "control") {
		if (
			typeof value.pid !== "number" ||
			typeof value.version !== "string" ||
			(value.client !== "tui" && value.client !== "cli")
		) {
			return undefined;
		}
		if (
			value.capabilities !== undefined &&
			(!Array.isArray(value.capabilities) || !value.capabilities.every((entry) => typeof entry === "string"))
		) {
			return undefined;
		}
		return {
			type: "hello",
			role: "control",
			protocolVersion: value.protocolVersion,
			pid: value.pid,
			version: value.version,
			client: value.client,
			...(value.capabilities === undefined ? {} : { capabilities: value.capabilities as string[] }),
		};
	}
	if (value.role === "relay") {
		if (typeof value.relayId !== "string" || typeof value.relayToken !== "string") {
			return undefined;
		}
		return {
			type: "hello",
			role: "relay",
			protocolVersion: value.protocolVersion,
			relayId: value.relayId,
			relayToken: value.relayToken,
		};
	}
	return undefined;
}

export function isControlRequest(value: unknown): value is ControlRequest {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
		return false;
	}
	switch (value.type) {
		case "status":
		case "shutdown":
		case "pair_request":
		case "clients_list":
			return true;
		case "lease_acquire":
		case "lease_release":
			return typeof value.workspaceName === "string" && typeof value.sessionId === "string";
		case "lease_rekey":
			return (
				typeof value.workspaceName === "string" &&
				typeof value.oldSessionId === "string" &&
				typeof value.newSessionId === "string"
			);
		case "client_revoke":
		case "client_approve_repair":
			return typeof value.clientNodeId === "string";
		case "workspace_register":
			return typeof value.name === "string" && typeof value.path === "string";
		case "workspace_unregister":
			return typeof value.name === "string";
		case "worktree_create":
			return (
				typeof value.workspaceName === "string" &&
				(value.worktreeName === undefined || typeof value.worktreeName === "string") &&
				(value.branch === undefined || typeof value.branch === "string") &&
				(value.baseRef === undefined || typeof value.baseRef === "string")
			);
		case "worktree_list":
		case "worktree_prune":
			return value.workspaceName === undefined || typeof value.workspaceName === "string";
		case "worktree_remove":
			return (
				typeof value.workspaceName === "string" &&
				typeof value.worktreeId === "string" &&
				(value.force === undefined || typeof value.force === "boolean")
			);
		case "worktree_resolve":
			return typeof value.path === "string";
		case "worktree_bind":
			return (
				typeof value.workspaceName === "string" &&
				typeof value.worktreeId === "string" &&
				typeof value.sessionId === "string"
			);
		case "theme_set":
			return typeof value.theme === "string";
		case "keep_awake_set":
			return typeof value.enabled === "boolean";
		case "viewer_subscribe":
		case "viewer_unsubscribe":
		case "viewer_abort":
			return typeof value.viewerFeedId === "string";
		case "relay_rpc":
			return (
				typeof value.clientNodeId === "string" &&
				typeof value.workspaceName === "string" &&
				typeof value.sessionId === "string" &&
				isRecord(value.command) &&
				typeof value.command.type === "string"
			);
		default:
			return false;
	}
}

export function isControlResponse(value: unknown): value is ControlResponse {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.id !== "string") {
		return false;
	}
	switch (value.type) {
		case "ok":
		case "error":
		case "lease_granted":
		case "lease_pending":
		case "lease_denied":
		case "status_result":
		case "clients_result":
		case "pair_started":
			return true;
		case "worktree_result":
			return isRecord(value.worktree);
		case "worktrees_result":
			return Array.isArray(value.worktrees);
		case "worktree_prune_result":
			return Array.isArray(value.results);
		case "worktree_resolve_result":
			return (
				typeof value.workspaceName === "string" &&
				typeof value.workspacePath === "string" &&
				typeof value.worktreeId === "string" &&
				typeof value.worktreePath === "string"
			);
		case "keep_awake_result":
			return isRecord(value.keepAwake);
		case "relay_rpc_result":
			return isRecord(value.response);
		default:
			return false;
	}
}

export function isControlEvent(value: unknown): value is ControlEvent {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}
	switch (value.type) {
		case "relay_offer":
		case "relay_closed":
		case "viewer_event":
		case "viewer_end":
		case "theme_snapshot":
		case "pairing_progress":
		case "daemon_shutdown":
			return true;
		case "keep_awake_changed":
			return isRecord(value.keepAwake);
		default:
			return false;
	}
}

export function isHelloAck(value: unknown): value is HelloAck {
	return isRecord(value) && value.type === "hello_ack" && typeof value.ok === "boolean";
}

export function isRelayPreamble(value: unknown): value is RelayPreamble {
	return (
		isRecord(value) &&
		value.type === "relay_preamble" &&
		typeof value.relayId === "string" &&
		isRecord(value.authorization) &&
		isRecord(value.resolvedTarget)
	);
}
