/**
 * A phone relayed to the host of its conversation (daemon-hosted
 * conversations design §4.3): the daemon authenticates the phone, resolves
 * its session target, and hands the conversation's host the stream through a
 * byte relay. The host writes the handshake response itself and serves the
 * stream on the remote profile with the daemon's authorization subset, its
 * sanitizer roots, and its notification routing; intents and queries the
 * daemon's state backs, completion pushes, and the relay's authority go to
 * the daemon. A conversation worker serves its relays this way.
 */

import type { Duplex } from "node:stream";
import type { ControlRelayFrame, ControlRelayOutcome } from "@hansjm10/volt-protocol";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import type {
	AuthorityLoss,
	ProtocolConnection,
	ServeConnectionOptions,
} from "../../core/protocol/server/connection.ts";
import { parseIrohRemoteRpcGrant } from "../../core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../../core/remote/iroh/connection.ts";
import { writeIrohRemoteHandshakeResponse } from "../../core/remote/iroh/handshake-reader.ts";
import type {
	IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationIntent,
} from "../../core/remote/iroh/push.ts";
import type { ReviewDiscussionService } from "../../core/review-discussions.ts";
import type { PhoneRelayPreamble } from "../control-protocol.ts";
import {
	createIntegratedConversationHandshakeResponse,
	type IntegratedConversationSessionSelection,
} from "../handshake-responses.ts";
import { adaptRelaySocketToIrohStream } from "../relay-stream.ts";
import { getWorktreesRoot } from "../worktree-manager.ts";

/** Rehydrate the daemon-authorized relay snapshot without recomputing its workspace scope. */
export function createRelayAuthorization(
	authorization: PhoneRelayPreamble["authorization"],
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
 * Sanitizer roots for serving a relayed conversation: a worktree-bound
 * conversation sanitizes with the worktree checkout as the root, and the
 * parent checkout plus the worktrees root must ALSO redact (bash output like
 * `git worktree list` prints both). §5.2.3.
 */
export function getRelaySanitizerOptions(
	authorization: PhoneRelayPreamble["authorization"],
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

/** What a relayed phone gets from the daemon through the host serving it. */
export interface RelayedPhoneDaemon {
	/** Run a daemon-backed intent or query with the relay's grant; undefined when the daemon is unavailable. */
	forward(frame: ControlRelayFrame): Promise<ControlRelayOutcome | undefined>;
	deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
	/** Re-read the relay's authority before a frame of the phone acts; false is a revocation. */
	revalidate?(): Promise<boolean>;
	/** Whether the relay's workspace owns the stored session `sessionId`, as the phone's `sessions` query lists it. */
	ownsSession?(sessionId: string): Promise<boolean>;
	/** The phone's accepted `unregister_workspace` was answered and its stream ended. */
	unregistered?(): Promise<void>;
}

/** A relay redeemed for a phone: its preamble and stream. */
export interface OpenedPhoneRelay {
	readonly preamble: PhoneRelayPreamble;
	readonly stream: Duplex;
	/** The relay ended here. */
	finished(): void;
}

export interface ServePhoneRelayOptions {
	readonly host: ConversationHost;
	/** The conversation the relay was offered for. */
	readonly conversation: HostedConversation;
	readonly relay: OpenedPhoneRelay;
	readonly daemon: RelayedPhoneDaemon;
	/** The agent directory, whose worktrees root the sanitizer redacts. */
	readonly agentDir: string;
	/** How the phone follows its structural intents: it is redirected; by default every target opens where it reconnects. */
	readonly redirect?: ServeConnectionOptions["redirect"];
	/** The host's own admission of the phone's intents. */
	readonly admit?: ServeConnectionOptions["admit"];
	/** The relay's authority as the daemon last pushed it, checked before every frame. */
	readonly authority?: () => AuthorityLoss | undefined;
	readonly reviewDiscussions?: ReviewDiscussionService;
	/** The connection serving the phone, once it exists: the host ends it on shutdown or authority loss. */
	readonly onConnection?: (connection: ProtocolConnection) => void;
}

/**
 * Serve a relayed phone from `conversation` on the remote profile until the
 * stream ends. A preamble for another session, or without the daemon's node
 * id, is refused. The phone follows its structural intents by redirect. Once
 * the phone is attached, the conversation's queued input is recovered.
 */
export async function servePhoneRelay(options: ServePhoneRelayOptions): Promise<void> {
	const { host, conversation, relay, daemon } = options;
	const relayedStream = adaptRelaySocketToIrohStream(relay.stream);
	const preamble = relay.preamble;
	const hostNodeId = preamble.hostNodeId;
	// Serve only the session the daemon authorized the phone for, with the
	// daemon's identity: the phone verifies the saved host node id in the
	// handshake response and every notification destination.
	if (conversation.closed || preamble.resolvedTarget.sessionId !== conversation.id || hostNodeId === undefined) {
		relayedStream.close();
		relay.finished();
		return;
	}
	const handshake = preamble.handshake;
	const authorizationSubset = preamble.authorization;
	const authorization = createRelayAuthorization(authorizationSubset);
	const sessionSelection: IntegratedConversationSessionSelection =
		preamble.resolvedTarget.selection === "created"
			? { kind: "created", sessionId: preamble.resolvedTarget.sessionId }
			: {
					kind: preamble.resolvedTarget.selection,
					requestedSessionId: preamble.resolvedTarget.requestedSessionId ?? preamble.resolvedTarget.sessionId,
					sessionId: preamble.resolvedTarget.sessionId,
				};
	let unregistered = false;
	const revalidate = daemon.revalidate;
	const ownsSession = daemon.ownsSession;
	try {
		// The serving host writes the handshake success response itself.
		const handshakeResponse = createIntegratedConversationHandshakeResponse(
			{ hello: handshake.hello, response: handshake.response },
			authorization,
			conversation.id,
			sessionSelection,
			{ hostNodeId, relayMode: preamble.relayMode, relayUrls: preamble.relayUrls },
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
			redaction: getRelaySanitizerOptions(authorizationSubset, options.agentDir),
			redirect: options.redirect ?? {},
			// The host's services are the daemon's, reached through `relay`.
			services: () => ({
				workspace: {
					name: authorization.workspace.name,
					...(ownsSession === undefined
						? {}
						: { ownsSession: (sessionId: string) => ownsSession.call(daemon, sessionId) }),
				},
				...(options.reviewDiscussions === undefined ? {} : { reviewDiscussions: options.reviewDiscussions }),
			}),
			relay: async (frame) => {
				const outcome = await daemon.forward(frame);
				if (!outcome) throw new Error("daemon_unavailable");
				// An accepted unregister ends the connection after its answer.
				if (frame.type === "unregister_workspace" && outcome.type === "accepted") unregistered = true;
				return outcome;
			},
			...(options.authority === undefined ? {} : { authority: options.authority }),
			...(revalidate === undefined ? {} : { revalidate: () => revalidate.call(daemon) }),
			...(options.admit === undefined ? {} : { admit: options.admit }),
			notifications: {
				hostNodeId,
				clientNodeId: authorizationSubset.clientNodeId,
				workspaceName: authorization.workspace.name,
				delivery: { deliverNotification: (notification) => daemon.deliverNotification(notification) },
			},
		});
		options.onConnection?.(connection);
		void connection.ready.then(
			() => void conversation.startRecoveredClientInputs().catch(() => undefined),
			() => undefined,
		);
		await connection.closed;
	} catch {
		// Relay teardown surfaces to the phone via the daemon's close reason.
	} finally {
		if (unregistered) await daemon.unregistered?.().catch(() => undefined);
		relayedStream.close();
		relay.finished();
	}
}
