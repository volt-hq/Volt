/**
 * Phones relayed through the TUI's host (live-shared session daemon design
 * §5.6 steps 7-9): the daemon authenticates a phone, resolves its session
 * target, and hands the TUI its stream through a byte relay. The TUI host
 * writes the handshake response itself and serves the stream on the remote
 * profile with the daemon's authorization subset, its sanitizer roots, and
 * its notification routing; intents and queries the daemon's state backs are
 * forwarded to the daemon, and a phone that unregisters the workspace retires
 * the session's lease.
 */

import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import type { ConversationHost } from "../../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../../core/host/hosted-conversation.ts";
import { DuplexWriteGate } from "../../../core/protocol/transport/duplex-write-gate.ts";
import type { IrohBiStreamLike, IrohBytes } from "../../../core/protocol/transport/iroh-transport.ts";
import { parseIrohRemoteRpcGrant } from "../../../core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../../../core/remote/iroh/connection.ts";
import { uploadIrohRemoteDeviceLog } from "../../../core/remote/iroh/device-log-rpc.ts";
import { writeIrohRemoteHandshakeResponse } from "../../../core/remote/iroh/handshake-reader.ts";
import type { RelayPreamble } from "../../../daemon/control-protocol.ts";
import {
	createIntegratedConversationHandshakeResponse,
	type IntegratedConversationSessionSelection,
} from "../../../daemon/handshake-responses.ts";
import { getWorktreesRoot } from "../../../daemon/worktree-manager.ts";
import type { DaemonLink, OpenedRelay } from "./daemon-link.ts";

export interface RelayedIrohStreamLike extends IrohBiStreamLike {
	/** Close both directions; maps to socket.destroy(). */
	close(reason?: string): void;
	readonly closed: Promise<{ reason?: string; error?: Error }>;
}

/**
 * Wrap a relay unix-socket Duplex in the Iroh stream shape consumed by
 * runIrohRemoteRpcMode. The adapter writes no close-reason trailer: a
 * TUI-initiated destroy surfaces as a generic closure. A stream that ends on
 * purpose writes its `remote_terminal` frame first and finishes gracefully.
 */
export function adaptRelaySocketToIrohStream(socket: Duplex): RelayedIrohStreamLike {
	const chunks: Buffer[] = [];
	const readers: Array<{ resolve(value: IrohBytes | undefined): void; reject(error: Error): void }> = [];
	const writeGate = new DuplexWriteGate(socket);
	let ended = false;
	let closeReason: string | undefined;
	let socketError: Error | undefined;
	let resolveClosed: (value: { reason?: string; error?: Error }) => void = () => {};
	const closed = new Promise<{ reason?: string; error?: Error }>((resolve) => {
		resolveClosed = resolve;
	});

	const flush = () => {
		while (readers.length > 0 && (chunks.length > 0 || ended || socketError)) {
			const reader = readers.shift();
			if (!reader) {
				return;
			}
			const chunk = chunks.shift();
			if (chunk) {
				reader.resolve(chunk);
				continue;
			}
			if (socketError) {
				reader.reject(socketError);
				continue;
			}
			reader.resolve(undefined);
		}
	};

	socket.on("data", (chunk: Buffer) => {
		chunks.push(Buffer.from(chunk));
		flush();
	});
	socket.on("end", () => {
		ended = true;
		flush();
	});
	socket.on("error", (error: Error) => {
		socketError = error;
		ended = true;
		flush();
	});
	socket.on("close", () => {
		ended = true;
		flush();
		writeGate.dispose();
		resolveClosed({
			...(closeReason === undefined ? {} : { reason: closeReason }),
			...(socketError === undefined ? {} : { error: socketError }),
		});
	});
	// The relay client hands the socket over explicitly paused (with the
	// post-preamble remainder unshifted); a data listener alone does not
	// un-pause an explicitly paused stream.
	socket.resume();

	return {
		recv: {
			read(sizeLimit: number): Promise<IrohBytes | undefined> {
				const queued = chunks.shift();
				if (queued) {
					if (queued.length > sizeLimit) {
						chunks.unshift(queued.subarray(sizeLimit));
						return Promise.resolve(queued.subarray(0, sizeLimit));
					}
					return Promise.resolve(queued);
				}
				if (socketError) {
					return Promise.reject(socketError);
				}
				if (ended) {
					return Promise.resolve(undefined);
				}
				return new Promise((resolve, reject) => {
					readers.push({ resolve, reject });
				});
			},
			stop(_errorCode: bigint): void {
				ended = true;
				flush();
				socket.destroy();
			},
		},
		send: {
			async writeAll(bytes: number[]): Promise<void> {
				await writeGate.write(Buffer.from(bytes));
			},
			async finish(): Promise<void> {
				await writeGate.end();
			},
		},
		close(reason?: string): void {
			closeReason = reason;
			socket.destroy();
		},
		closed,
	};
}

/**
 * A relayed phone unregistered the workspace of the session the TUI serves:
 * once the phone is answered, the TUI releases the session's lease.
 */
export interface RelayWorkspaceUnregisterRetirement {
	/** The daemon accepted the phone's unregister_workspace. */
	unregistered(): void;
	finalize(): Promise<void>;
}

export function createRelayWorkspaceUnregisterRetirement(
	link: Pick<DaemonLink, "release">,
	getSessionId: () => string,
): RelayWorkspaceUnregisterRetirement {
	let workspaceUnregistered = false;
	let releasePromise: Promise<void> | undefined;
	return {
		unregistered() {
			workspaceUnregistered = true;
		},
		async finalize() {
			if (!workspaceUnregistered) return;
			releasePromise ??= link.release(getSessionId(), "workspace_unregistered");
			await releasePromise;
		},
	};
}

/** Rehydrate the daemon-authorized relay snapshot without recomputing its workspace scope in the TUI. */
export function createTuiRelayAuthorization(
	authorization: RelayPreamble["authorization"],
): IrohRemoteClientAuthorizationSuccess {
	const rpcGrant = parseIrohRemoteRpcGrant(authorization.rpcGrant, "relay rpcGrant");
	return {
		ok: true,
		allowTools: authorization.allowedTools,
		client: {
			nodeId: authorization.clientNodeId,
			label: authorization.clientNodeId,
			allowedWorkspaces: authorization.workspaces.map((workspace) => workspace.name),
			allowedTools: authorization.allowedTools,
			rpcGrant,
			pairedAt: 0,
			lastSeenAt: 0,
		},
		paired: true,
		pairingSecretConsumed: false,
		workspace: { name: authorization.workspaceName, path: authorization.workspacePath },
		workspaceNames: [...authorization.workspaceNames],
		workspaces: authorization.workspaces.map((workspace) => ({ ...workspace })),
	};
}

/**
 * Sanitizer roots for serving a relayed conversation from the TUI: a
 * worktree-bound conversation sanitizes with the worktree checkout as the
 * root, and the parent checkout plus the worktrees root must ALSO redact
 * (bash output like `git worktree list` prints both). §5.2.3.
 */
export function getRelayServingSanitizerOptions(
	authorization: RelayPreamble["authorization"],
	agentDir: string,
): { remoteWorkspacePath?: string; workspacePath: string; additionalRedactedPaths?: string[] } {
	if (authorization.worktreePath === undefined) {
		return { workspacePath: authorization.workspacePath };
	}
	return {
		...(authorization.worktreeSourceRootRelativePath === undefined
			? {}
			: { remoteWorkspacePath: `/workspace/${authorization.worktreeSourceRootRelativePath}` }),
		workspacePath: authorization.worktreePath,
		additionalRedactedPaths: [authorization.workspacePath, getWorktreesRoot(agentDir)],
	};
}

export interface ServeRelayedPhoneOptions {
	readonly host: ConversationHost;
	/** The conversation the TUI shows, which the relay was offered for. */
	readonly conversation: HostedConversation;
	/** Redeem the relay offer: its preamble and the phone's stream. */
	readonly openRelay: () => Promise<OpenedRelay>;
	/** Where relay intents and queries, completion pushes, and an unregister's lease release go. */
	readonly link: Pick<DaemonLink, "forwardRelayRpc" | "relayNotificationDelivery" | "release">;
	/** The agent directory, whose worktrees root the sanitizer redacts. */
	readonly agentDir: string;
}

/**
 * Serve a relayed phone conversation from the TUI host's in-process
 * conversation on the remote profile, until the stream ends. The daemon has
 * already authenticated the phone and resolved the session target; a
 * preamble for another session, or without the daemon's node id, is refused.
 * The phone follows its structural intents by redirect: a session change the
 * phone asks for ends its stream with `ended{moved}` for the phone alone, and
 * when the TUI leaves the conversation the phone hears `ended{closed}` and
 * reconnects to the daemon. Once the phone is attached, the conversation's
 * queued input is recovered.
 */
export async function serveRelayedPhone(options: ServeRelayedPhoneOptions): Promise<void> {
	const { host, conversation, link } = options;
	// The conversation is closing: the TUI is leaving it.
	if (conversation.closed) return;
	let opened: OpenedRelay;
	try {
		opened = await options.openRelay();
	} catch {
		return;
	}
	const conversationSessionId = conversation.id;
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	const preamble = opened.preamble;
	const hostNodeId = preamble.hostNodeId;
	// Serve only the session the daemon authorized the phone for, with the
	// daemon's identity: the phone verifies the saved host node id in the
	// handshake response and every notification destination.
	if (preamble.resolvedTarget.sessionId !== conversationSessionId || hostNodeId === undefined) {
		relayedStream.close();
		opened.finished();
		return;
	}
	const handshake = preamble.handshake;
	const authorizationSubset = preamble.authorization;
	const authorization = createTuiRelayAuthorization(authorizationSubset);
	const responseContext = {
		hostNodeId,
		relayMode: preamble.relayMode,
		relayUrls: preamble.relayUrls,
	};
	const sessionSelection: IntegratedConversationSessionSelection =
		preamble.resolvedTarget.selection === "created"
			? { kind: "created", sessionId: preamble.resolvedTarget.sessionId }
			: {
					kind: preamble.resolvedTarget.selection,
					requestedSessionId: preamble.resolvedTarget.requestedSessionId ?? preamble.resolvedTarget.sessionId,
					sessionId: preamble.resolvedTarget.sessionId,
				};
	const workspaceUnregisterRetirement = createRelayWorkspaceUnregisterRetirement(link, () => conversationSessionId);
	try {
		// The TUI writes the handshake success response itself, keeping
		// construction identical to the daemon-owned path.
		const handshakeResponse = createIntegratedConversationHandshakeResponse(
			{ hello: handshake.hello, response: handshake.response },
			authorization,
			conversationSessionId,
			sessionSelection,
			responseContext,
			preamble.resolvedTarget.worktreeId,
			preamble.resolvedTarget.workingDirectory,
		);
		await writeIrohRemoteHandshakeResponse(relayedStream.send, handshakeResponse);
		const connection = serveIrohRemoteConnection({
			host,
			conversation,
			stream: relayedStream,
			initialInput: handshake.initialInput,
			grant: authorization.client.rpcGrant,
			clientKey: authorizationSubset.clientNodeId,
			redaction: getRelayServingSanitizerOptions(authorizationSubset, options.agentDir),
			// The phone stays on this conversation; a session change redirects it alone, to the daemon.
			redirect: {},
			// The phone's device logs are written under the workspace here; the rest of the host is the daemon's.
			services: () => ({
				workspace: {
					name: authorization.workspace.name,
					uploadDeviceLogs: (upload) =>
						uploadIrohRemoteDeviceLog(upload, { workspacePath: authorization.workspace.path }),
				},
			}),
			relay: async (frame) => {
				const outcome = await link.forwardRelayRpc(authorizationSubset.clientNodeId, conversationSessionId, frame);
				if (!outcome) throw new Error("daemon_unavailable");
				// An accepted unregister ends the connection after its answer.
				if (frame.type === "unregister_workspace" && outcome.type === "accepted") {
					workspaceUnregisterRetirement.unregistered();
				}
				return outcome;
			},
			notifications: {
				hostNodeId,
				clientNodeId: authorizationSubset.clientNodeId,
				workspaceName: authorization.workspace.name,
				delivery: {
					deliverNotification: (notification) =>
						link.relayNotificationDelivery.deliverNotification(
							authorizationSubset.clientNodeId,
							conversationSessionId,
							notification,
						),
				},
			},
		});
		void connection.ready.then(
			() => void conversation.startRecoveredClientInputs().catch(() => undefined),
			() => undefined,
		);
		await connection.closed;
	} catch {
		// Relay teardown surfaces to the phone via the daemon's close reason.
	} finally {
		await workspaceUnregisterRetirement.finalize();
		relayedStream.close();
		opened.finished();
	}
}
