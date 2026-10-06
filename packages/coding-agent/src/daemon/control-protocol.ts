import { Buffer } from "node:buffer";
import { type BinaryLike, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	type ControlClientStatus,
	ControlEventSchema,
	ControlFatalSchema,
	ControlHelloAckSchema,
	ControlHelloChallengeSchema,
	ControlHelloSchema,
	ControlRelayPreambleSchema,
	type ControlRequest,
	ControlRequestSchema,
	ControlResponseSchema,
	type HelloProof,
	type RemoteTransportHealth,
	type RemoteTransportReasonCode,
	WORKER_REQUEST_TYPES,
	type WorkerRequestType,
} from "@hansjm10/volt-protocol/daemon-control";
import {
	type IrohRemotePushNotification,
	IrohRemotePushNotificationSchema,
	MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES,
	MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES,
	MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES,
	MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES,
	MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES,
} from "@hansjm10/volt-protocol/push";
import { Compile } from "typebox/compile";
import { parseIrohRemoteRpcGrant } from "../core/remote/iroh/access-grant.ts";
import { IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE, parseIrohRemoteAllowTools } from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteClient } from "../core/remote/iroh/state.ts";

/**
 * Framing and admission for the voltd control plane: JSONL over the unix
 * socket ~/.volt/agent/daemon/voltd.sock, shared by the daemon, the TUI, and
 * the CLI. The message schemas live in @hansjm10/volt-protocol/daemon-control;
 * every check here is a validator compiled from them.
 */

export type {
	ControlClientKind,
	ControlClientStatus,
	ControlEvent,
	ControlFatal,
	ControlHelloChallenge,
	ControlKeepAwakeStatus,
	ControlLeaseStatus,
	ControlRelayCredentialStatus,
	ControlRequest,
	ControlResponse,
	ControlRevokedClientStatus,
	ControlWorkerOrigin,
	ControlWorkerState,
	ControlWorkerStatus,
	ControlWorkspaceStatus,
	ControlWorktreeStatus,
	DaemonRemotePolicyStatus,
	HelloAck,
	HelloMessage,
	HelloProof,
	LeaseReleaseReason,
	LeaseState,
	RelayCloseReason,
	RelayPreamble,
	RemoteTransportHealth,
	RemoteTransportReasonCode,
	WorkerAuthorityLoss,
	WorkerHostKind,
	WorkerRelayAuthority,
	WorkerSpawnSpec,
	WorkerStopReason,
} from "@hansjm10/volt-protocol/daemon-control";

export const PROTOCOL_VERSION = 5;

/** Hard cap per JSONL line; longer lines close the connection with a fatal frame. */
export const CONTROL_MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Control-hello capability advertised by TUIs that can serve worktree-bound
 * conversations over the byte relay (worktree-cwd sanitization). The daemon
 * never offers worktree-session relays to control clients without it.
 */
export const CONTROL_WORKTREES_CAPABILITY = "worktrees";
/** Status capability for cancellable, immediately-invalidated pairing tickets. */
export const CONTROL_PAIR_CANCEL_CAPABILITY = "pair_cancel";
/** TUI/CLI understands per-device tool + RPC grant control messages and relay preambles. */
export const CONTROL_RPC_GRANTS_CAPABILITY = "rpc_grants";

/** Single mapping from a persisted client record to its control-socket status. */
export function createControlClientStatus(client: IrohRemoteClient): ControlClientStatus {
	return {
		clientNodeId: client.nodeId,
		label: client.label,
		pairedAtMs: client.pairedAt,
		lastSeenAtMs: client.lastSeenAt,
		allowedTools: parseIrohRemoteAllowTools(client.allowedTools),
		usesDefaultTools: client.allowedTools === undefined,
		rpcGrant: parseIrohRemoteRpcGrant(client.rpcGrant, "client rpcGrant"),
	};
}

/** Safe operator-facing guidance for each remote transport reason code. */
export const REMOTE_TRANSPORT_REASON_MESSAGES: Readonly<Record<RemoteTransportReasonCode, string>> = {
	extension_missing: "Phone transport is not enabled in this daemon.",
	native_binding_missing:
		"Phone transport is unavailable on this platform. Reinstall Volt without `--omit=optional` on a supported platform.",
	endpoint_start_failed: "Phone transport failed to start. Check `volt daemon logs`.",
	host_storage_full: IROH_REMOTE_HOST_STORAGE_FULL_MESSAGE,
};

/** The guidance for `native_binding_missing` in a standalone binary, which never bundles the binding. */
export const STANDALONE_REMOTE_TRANSPORT_MESSAGE =
	"Phone transport is not included in the standalone binary. Install Volt from npm on a supported platform to pair a phone.";

export function isRemoteTransportPairingAvailable(health: RemoteTransportHealth | undefined): boolean {
	return health?.state === "ready" || (health?.state === "degraded" && health.reasonCode === "host_storage_full");
}

// ============================================================================
// Hello proofs
// ============================================================================

/** Whose secret a hello proves: the pidfile token, a spawn's worker token, or an offer's relay token. */
export type HelloRole = "control" | "worker" | "relay";

/**
 * What every proof on a connection is bound to: the challenge the daemon
 * greeted it with, and the socket path the client dialed (the daemon's own
 * listen path). A proof is good for that connection only: it cannot be
 * replayed on another connection, nor relayed from a socket name someone
 * else holds to the daemon's. The path is compared as a string: a client
 * dials exactly the path the daemon published (its pidfile, or the
 * bootstrap a worker was given), never a resolved or respelled one.
 */
export interface HelloBinding {
	readonly challenge: string;
	readonly socketPath: string;
}

/** A fresh challenge for the daemon's greeting. */
export function createHelloChallenge(): string {
	return randomBytes(32).toString("base64url");
}

/** The HMAC of a hello's `nonce` under its role's secret and the connection's binding, for the client or the daemon. */
function helloMac(
	role: HelloRole,
	secret: BinaryLike,
	party: "client" | "daemon",
	binding: HelloBinding,
	nonce: string,
): string {
	return createHmac("sha256", secret)
		.update(JSON.stringify(["volt-hello", role, party, binding.socketPath, binding.challenge, nonce]))
		.digest("base64url");
}

function macMatches(expected: string, presented: string | undefined): boolean {
	if (presented === undefined) return false;
	const wanted = Buffer.from(expected, "utf8");
	const actual = Buffer.from(presented, "utf8");
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * A hello's proof that its client holds `secret`, bound to the connection.
 * The secret itself never crosses the socket, so an endpoint that is not the
 * daemon (a stale Windows pipe name someone else took) learns nothing it can
 * use, there or anywhere else.
 */
export function createHelloProof(role: HelloRole, secret: BinaryLike, binding: HelloBinding): HelloProof {
	const nonce = randomBytes(32).toString("base64url");
	return { nonce, mac: helloMac(role, secret, "client", binding, nonce) };
}

/** Whether a hello's proof shows its client holds `secret`, on this connection. */
export function helloProofMatches(
	role: HelloRole,
	secret: BinaryLike,
	binding: HelloBinding,
	proof: HelloProof | undefined,
): boolean {
	return proof !== undefined && macMatches(helloMac(role, secret, "client", binding, proof.nonce), proof.mac);
}

/** The daemon's answer to a verified proof: its own proof of `secret`, on the same connection and nonce. */
export function createDaemonProof(
	role: HelloRole,
	secret: BinaryLike,
	binding: HelloBinding,
	proof: HelloProof,
): string {
	return helloMac(role, secret, "daemon", binding, proof.nonce);
}

/** Whether an answer to a hello proves its endpoint holds `secret`: the daemon, not whoever holds its socket name. */
export function daemonProofMatches(
	role: HelloRole,
	secret: BinaryLike,
	binding: HelloBinding,
	proof: HelloProof,
	daemonProof: string | undefined,
): boolean {
	return macMatches(helloMac(role, secret, "daemon", binding, proof.nonce), daemonProof);
}

// ============================================================================
// Admission
// ============================================================================

function compileOnFirstUse<T>(compile: () => T): () => T {
	let validator: T | undefined;
	return () => {
		validator ??= compile();
		return validator;
	};
}

const helloValidator = compileOnFirstUse(() => Compile(ControlHelloSchema));
const helloAckValidator = compileOnFirstUse(() => Compile(ControlHelloAckSchema));
const helloChallengeValidator = compileOnFirstUse(() => Compile(ControlHelloChallengeSchema));
const fatalValidator = compileOnFirstUse(() => Compile(ControlFatalSchema));
const requestValidator = compileOnFirstUse(() => Compile(ControlRequestSchema));
const responseValidator = compileOnFirstUse(() => Compile(ControlResponseSchema));
const eventValidator = compileOnFirstUse(() => Compile(ControlEventSchema));
const relayPreambleValidator = compileOnFirstUse(() => Compile(ControlRelayPreambleSchema));
const notificationValidator = compileOnFirstUse(() => Compile(IrohRemotePushNotificationSchema));

/**
 * Validators compiled from the daemon-control contract schemas on first use,
 * so processes that never touch the control plane do not pay for them.
 * Requests are admitted only through `admitControlRequest`.
 */
export const ControlValidators = {
	get hello() {
		return helloValidator();
	},
	get helloAck() {
		return helloAckValidator();
	},
	/** The daemon's greeting: the challenge every proof on the connection covers. */
	get helloChallenge() {
		return helloChallengeValidator();
	},
	get fatal() {
		return fatalValidator();
	},
	get response() {
		return responseValidator();
	},
	get event() {
		return eventValidator();
	},
	get relayPreamble() {
		return relayPreambleValidator();
	},
	/** A relayed push notification intent, without its UTF-8 budgets. */
	get notification() {
		return notificationValidator();
	},
};

/** The notification fields' `x-volt-max-utf8-bytes` budgets, which JSON Schema cannot check. */
const NOTIFICATION_UTF8_BUDGETS: Readonly<Record<string, number>> = {
	eventId: MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES,
	title: MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES,
	body: MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES,
	sessionId: MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES,
	workspaceName: MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES,
	planId: MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES,
	workId: MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES,
};

function isWithinNotificationBudgets(notification: IrohRemotePushNotification): boolean {
	const fields: Record<string, unknown> = notification;
	return Object.entries(NOTIFICATION_UTF8_BUDGETS).every(([field, budget]) => {
		const value = fields[field];
		return typeof value !== "string" || Buffer.byteLength(value, "utf8") <= budget;
	});
}

const WORKER_REQUESTS: ReadonlySet<string> = new Set(WORKER_REQUEST_TYPES);

/** Whether `type` is a request only a worker connection may send. */
export function isWorkerRequestType(type: string): type is WorkerRequestType {
	return WORKER_REQUESTS.has(type);
}

/**
 * Whether a connection of `client` may send a request of `type`: a worker
 * sends worker requests and its conversations' Git observations
 * (`change_observe`, which the daemon authorizes per session), and nothing
 * else; a control client sends no worker request.
 */
export function isRequestAllowedFor(client: "tui" | "cli" | "worker", type: string): boolean {
	return type === "change_observe" || (client === "worker") === isWorkerRequestType(type);
}

/** A request the contract schema accepts, with a relayed notification inside its UTF-8 budgets. */
export function admitControlRequest(value: unknown): value is ControlRequest {
	return (
		requestValidator().Check(value) &&
		((value.type !== "relay_notification_delivery" && value.type !== "worker_notification_delivery") ||
			isWithinNotificationBudgets(value.notification))
	);
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
