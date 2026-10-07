/**
 * How a client reaches the conversations of its host (architecture rewrite
 * §10; daemon-hosted conversations §6.3): a connector opens a conversation
 * for the client and hands back the transport to connect on. The TUI is built
 * from one. `InProcessConnector` serves the conversations of a host in the
 * client's own process.
 *
 * A connector's host follows the client's moves by redirect: a structural
 * intent answers `accepted{conversation}`, ends the client's subscription
 * `moved`, and ends its connection; the client opens the target through the
 * connector and connects again, subscribing to it from a snapshot
 * (`connectThrough`). The intents and queries the client sent around the move
 * go out again on the new connection; the host knows the client across its
 * connections (its client key) and answers a retried intent as it answered
 * it. The answer to an intent whose run moved its client before it ended (an
 * extension command's `ctx.newSession()`) is never written on the connection
 * the move ended: the command may wait for the client on the target (its
 * `withSession`), so the move cannot wait for the answer; the intent goes out
 * again on the new connection, and the host answers it from that window.
 *
 * A connector whose host runs elsewhere (`reconnects`, the daemon's workers)
 * resumes its client after a connection that ended unannounced: a worker
 * that exited, a daemon that restarted. The client keeps its transcript and
 * holds what the user sends; `connectThrough` opens the conversation again
 * with backoff, and the client resumes after its position, sending again
 * what was not answered.
 */

import type { RpcTransport } from "../core/protocol/transport/transport.ts";
import type { WorkspaceRegistration } from "../daemon/control-protocol.ts";
import type { DaemonProbeResult, EnsureDaemonResult, WaitForDaemonExitOptions } from "../daemon/spawn.ts";
import { ProtocolClient, type ProtocolClientDisconnected, type ProtocolClientOptions } from "./protocol-client.ts";

/** What a connector opens for its client. */
export type ConnectorTarget =
	/** The conversation the connector serves first. */
	| { readonly kind: "startup" }
	/**
	 * A conversation by id, such as the one a move led the client to; with
	 * `resume`, the one the client lost its connection to.
	 */
	| { readonly kind: "session"; readonly sessionId: string; readonly resume?: true };

/** What the client hears from the host of the conversations it opens beside the protocol, and what the host asks it. */
export interface ConnectorOpenOptions {
	/** An extension asked to shut down (`ctx.shutdown()`). */
	readonly onShutdownRequested?: () => void;
	/** The conversation the client is on lost its log. */
	readonly onLost?: (error: Error) => void;
	/** What an open waits for, for the client to show; undefined once it waits for nothing. */
	readonly onStatus?: (status: string | undefined) => void;
	/**
	 * The conversation's directory is sensitive (a filesystem root, the home
	 * directory, or one holding Volt's agent directory) and no workspace holds
	 * it: ask the user whether paired devices may reach it (`shared`) or not
	 * (`local`); undefined opens nothing.
	 */
	readonly askWorkspaceRegistration?: (directory: string) => Promise<WorkspaceRegistration | undefined>;
}

/**
 * The connector cannot open the conversation, and opening it again will not
 * help: it is gone (a `--no-session` conversation whose worker exited), or
 * its host refuses the client (another version, another client's).
 */
export class ConversationUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "ConversationUnavailableError";
	}
}

/** A conversation a connector opened for its client. */
export interface OpenedConversation {
	/** The transport to connect the client on: its host attaches the client to `sessionId`. */
	readonly transport: RpcTransport;
	readonly sessionId: string;
	/** The daemon workspace the conversation runs in, when the connector knows it. */
	readonly workspaceName?: string;
	/** What the client tells its user about the open, such as options its host did not apply. */
	readonly notices: readonly string[];
}

/** How the TUI reaches the conversations of its host. */
/**
 * How a client whose conversations run in the daemon's workers reaches the
 * daemon itself: `/remote` manages it, and `/worktree` asks it for checkouts.
 */
export interface ConnectorDaemon {
	/** The daemon of `agentDir`, started when none runs. */
	ensure(agentDir: string): Promise<EnsureDaemonResult>;
	probe(agentDir: string): Promise<DaemonProbeResult>;
	waitForExit(options: WaitForDaemonExitOptions): Promise<"exited" | "timeout">;
}

export interface ConversationConnector {
	/**
	 * Whether the client's conversations keep running after it quits (daemon
	 * workers): quitting while a turn runs offers to leave it running.
	 */
	readonly runsInBackground?: boolean;
	/** The daemon whose workers host the client's conversations; none for a host in the client's process. */
	readonly daemon?: ConnectorDaemon;
	/**
	 * Whether the host runs elsewhere and a connection can end unannounced:
	 * the client then resumes on a connection the connector opens again.
	 */
	readonly reconnects?: boolean;
	/**
	 * The host ended the client's connection shutting down: resolves whether
	 * the host itself stops (the client resumes once it is back) rather than
	 * ending the client's connection for it (an extension's `ctx.shutdown()`,
	 * after which the client quits).
	 */
	hostRestarting?(): Promise<boolean>;
	/** Open `target` for the client: the transport its host attaches the client there on. Rejects when it cannot. */
	open(target: ConnectorTarget, options?: ConnectorOpenOptions): Promise<OpenedConversation>;
	/** The client quits, or the conversation it shows lost its log: the connector opens nothing more for it. */
	stopServing(): void;
	/**
	 * Close the conversation the client shows, with its client still attached
	 * so its `session_shutdown` reaches the client (`beforeDispose` runs after
	 * that), then the host. Later calls join the first.
	 */
	dispose(options?: { beforeDispose?: () => void }): Promise<void>;
	/** The daemon workspace of the conversation the client shows, once resolved. */
	daemonWorkspaceName(): string | undefined;
	/** A theme the daemon broadcast to its TUIs. */
	onThemeSnapshot(listener: (themeName: string) => void): () => void;
}

/** A connection the client lost, and the attempt to resume it. */
export interface ReconnectAttempt {
	/** From 1. */
	readonly attempt: number;
	/** `shutdown`: the host restarts; `lost`: the connection ended unannounced. */
	readonly reason: ProtocolClientDisconnected["reason"];
	/** Why the previous attempt failed, after the first. */
	readonly error?: Error;
}

export interface ConnectThroughOptions
	extends Omit<ProtocolClientOptions, "followMoves" | "resumeAfterLoss">,
		ConnectorOpenOptions {
	/** Called with the client before it says hello, so the caller observes its changes from the first. */
	readonly onClient?: (client: ProtocolClient) => void;
	/** Called with each conversation the connector opened for the client: the startup one, then each one a move led to. */
	readonly onOpened?: (opened: OpenedConversation) => void;
	/** The client lost its connection, and the connector opens its conversation again: each attempt. */
	readonly onReconnecting?: (attempt: ReconnectAttempt) => void;
	/** The client resumed on a new connection. */
	readonly onReconnected?: () => void;
	/** A move's target could not be reached: the client goes back to the conversation it left. */
	readonly onMoveFailed?: (error: Error, target: string) => void;
	/** The client stopped for good: a move or a resume could not reach its conversation. */
	readonly onStopped?: (error: Error) => void;
}

/** How long a resume waits before each attempt: quick first, at most 5 s. */
function reconnectDelayMs(attempt: number): number {
	return Math.min(5_000, 250 * 2 ** Math.min(attempt - 1, 5));
}

/**
 * Connect a protocol client through `connector`: open the startup
 * conversation and connect, then follow each move by opening its target and
 * connecting again. Resolves once the client caught up with the startup
 * conversation. A move whose target cannot be opened or reached stops the
 * client with that failure; a stopped client follows no move.
 */
export async function connectThrough(
	connector: ConversationConnector,
	options: ConnectThroughOptions = {},
): Promise<ProtocolClient> {
	const {
		onClient,
		onOpened,
		onShutdownRequested,
		onLost,
		onStatus,
		askWorkspaceRegistration,
		onReconnecting,
		onReconnected,
		onMoveFailed,
		onStopped,
		...clientOptions
	} = options;
	const openOptions: ConnectorOpenOptions = {
		...(onShutdownRequested === undefined ? {} : { onShutdownRequested }),
		...(onLost === undefined ? {} : { onLost }),
		...(onStatus === undefined ? {} : { onStatus }),
		...(askWorkspaceRegistration === undefined ? {} : { askWorkspaceRegistration }),
	};
	const client = new ProtocolClient({
		...clientOptions,
		followMoves: "reconnect",
		...(connector.reconnects === true ? { resumeAfterLoss: true } : {}),
	});
	onClient?.(client);
	const stop = async (error: unknown): Promise<void> => {
		const cause = error instanceof Error ? error : new Error(String(error));
		await client.stop(cause);
		onStopped?.(cause);
	};
	/** Open `target` and connect the client there; resolves whether the client is connected. */
	const reach = async (target: ConnectorTarget, still: () => boolean): Promise<boolean> => {
		const opened = await connector.open(target, openOptions);
		if (!still()) {
			// The client stopped, or moved on, meanwhile.
			await opened.transport.close();
			return false;
		}
		onOpened?.(opened);
		await client.connect(opened.transport);
		return true;
	};
	/** The conversation the client showed last: where it goes back to when a move's target cannot be reached. */
	let shown: string | undefined;
	const follow = async (target: string): Promise<void> => {
		const source = shown;
		try {
			await reach({ kind: "session", sessionId: target }, () => client.moving === target);
		} catch (error) {
			// A lost connection to the target resumes there.
			if (client.disconnected || client.moving !== target) return;
			if (source === undefined || source === target) {
				await stop(error);
				return;
			}
			onMoveFailed?.(error instanceof Error ? error : new Error(String(error)), target);
			client.retarget(source);
			try {
				await reach({ kind: "session", sessionId: source }, () => client.moving === source);
			} catch (backError) {
				if (!client.disconnected && client.moving === source) await stop(backError);
			}
		}
	};
	/** Resume the client after its lost connection, with backoff, until it is connected or stopped. */
	const resume = async (lost: ProtocolClientDisconnected): Promise<void> => {
		if (lost.reason === "shutdown" && !(await connector.hostRestarting?.())) {
			// The host ended the client's connection for it: the client quits.
			await client.stop(lost.error);
			onShutdownRequested?.();
			return;
		}
		let error: Error | undefined;
		for (let attempt = 1; client.disconnected; attempt++) {
			const target = client.conversation;
			if (target === undefined) return;
			onReconnecting?.({ attempt, reason: lost.reason, ...(error === undefined ? {} : { error }) });
			await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(attempt)));
			if (!client.disconnected) return;
			try {
				const reopened = { kind: "session", sessionId: target, resume: true } as const;
				if (await reach(reopened, () => client.disconnected && client.conversation === target)) {
					onReconnected?.();
				}
			} catch (cause) {
				if (cause instanceof ConversationUnavailableError) {
					await stop(cause);
					return;
				}
				error = cause instanceof Error ? cause : new Error(String(cause));
			}
		}
	};
	/** Whether a resume runs: a connection lost again while it runs is resumed by the same loop. */
	let resuming = false;
	client.onChange((change) => {
		if (change?.type === "snapshot") shown = change.conversation;
		else if (change?.type === "ended" && change.reason === "moved") void follow(change.target);
		else if (change?.type === "disconnected" && !resuming) {
			resuming = true;
			void resume(change)
				.catch(() => undefined)
				.finally(() => {
					resuming = false;
				});
		}
	});
	const opened = await connector.open({ kind: "startup" }, openOptions);
	onOpened?.(opened);
	try {
		await client.connect(opened.transport);
	} catch (error) {
		await client.stop();
		throw error;
	}
	return client;
}
