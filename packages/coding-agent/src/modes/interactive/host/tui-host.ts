/**
 * The TUI's host (architecture rewrite §10): the conversation host the TUI
 * process runs, its daemon leases, and the TUI's one client of it. Phase 7
 * lifts this seam into a conversation worker.
 *
 * The TUI's client speaks the protocol over a loopback connection
 * (`connect`). Once the client shows its conversation (`clientReady`), the
 * host takes the conversation's daemon lease, serves the phones relayed into
 * it, follows the client's moves with the lease, and recovers the
 * conversation's durable queued input; a move recovers the input of the
 * conversation the client moved to. `dispose` closes the conversation,
 * disposes the host, then gives the lease back once the relayed phones heard
 * where to reconnect.
 */

import type { HostRequestKind } from "@hansjm10/volt-protocol";
import { LoopbackClient, type ProtocolClientOptions } from "../../../client/protocol-client.ts";
import type { ConversationHost } from "../../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../../core/host/hosted-conversation.ts";
import type { HostClient } from "../../../core/host/targets.ts";
import { localProfile } from "../../../core/protocol/profiles.ts";
import { type ServeConnectionOptions, serveConnection } from "../../../core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../../core/protocol/transport/loopback-transport.ts";
import type { AcquireOutcome, DaemonLeases } from "./daemon-link.ts";

export interface TuiHostOptions {
	readonly host: ConversationHost;
	/** The conversation the TUI opens on. */
	readonly conversation: HostedConversation;
	/** The daemon leases, whose open gate the host was built with. Without them, the TUI runs without the daemon. */
	readonly daemon?: DaemonLeases;
	/** The model scope patterns the TUI started with (`--models`), which a profile switch keeps. */
	readonly modelScopePatterns?: readonly string[];
}

export interface TuiConnectOptions {
	/** The host request kinds the TUI answers. */
	readonly hostRequests?: readonly HostRequestKind[];
	/** Milliseconds to wait for an intent's or query's answer. */
	readonly requestTimeoutMs?: number;
	/** Observes every host frame from the first. */
	readonly onFrame?: ProtocolClientOptions["onFrame"];
	/** An extension asked to shut down (`ctx.shutdown()`). */
	readonly onShutdownRequested?: () => void;
	/** The conversation the client is on lost its log. */
	readonly onLost?: (error: Error) => void;
	/** Called with the client before it says hello, so the TUI observes its changes from the first. */
	readonly onClient?: (client: LoopbackClient) => void;
	/** What the TUI's terminal offers the conversation's extensions beyond the protocol: themes and the user-input dialog. */
	readonly terminal?: ServeConnectionOptions["terminal"];
}

const NO_LEASE: AcquireOutcome = { kind: "noop" };

export class TuiHost {
	readonly host: ConversationHost;
	private readonly startup: HostedConversation;
	private readonly daemon: DaemonLeases | undefined;
	private readonly modelScopePatterns: readonly string[] | undefined;
	/** The conversation the TUI's client is attached to, if any. */
	private clientConversation: (() => HostedConversation | undefined) | undefined;
	private connectedClient: HostClient | undefined;
	private shown: HostedConversation;
	private ready: Promise<void> | undefined;
	private disposing: Promise<void> | undefined;
	/** The TUI quits or its conversation lost its log: lease handovers and relay offers stop. */
	private stopped = false;

	private constructor(options: TuiHostOptions) {
		this.host = options.host;
		this.startup = options.conversation;
		this.shown = options.conversation;
		this.daemon = options.daemon;
		this.modelScopePatterns = options.modelScopePatterns;
	}

	/** Host the TUI's conversations in `options.host`, starting with `options.conversation`. */
	static start(options: TuiHostOptions): TuiHost {
		return new TuiHost(options);
	}

	/** The conversation the TUI shows: the one its client is on, or the last one it was on. */
	get conversation(): HostedConversation {
		const current = this.clientConversation?.();
		if (current) this.shown = current;
		return this.shown;
	}

	/**
	 * The TUI's client as the host knows it, once it connected. The TUI's
	 * commands that still act in process (until the end of Phase 6) act as
	 * this client, so the moves they make reach the client as `ended{moved}`.
	 */
	get hostClient(): HostClient {
		if (!this.connectedClient) throw new Error("The TUI's client is not connected");
		return this.connectedClient;
	}

	/**
	 * Connect the TUI's client over a loopback connection on the local
	 * profile; it anchors its conversation. Resolves once the client caught up
	 * with the log and the host serves it (`clientReady`).
	 */
	async connect(options: TuiConnectOptions = {}): Promise<LoopbackClient> {
		if (this.clientConversation) throw new Error("The TUI host already has its client");
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, {
			host: this.host,
			conversation: this.startup,
			anchor: true,
			// The TUI's prompts reach extensions as interactive input.
			inputSource: "interactive",
			services: () => ({
				// The TUI's abort is the user's interrupt key: it stops the run without delivering its queued input.
				abortRun: (session) => session.abort("keyboard_interrupt"),
				...(this.modelScopePatterns === undefined ? {} : { modelScopePatterns: this.modelScopePatterns }),
			}),
			...(options.onShutdownRequested === undefined ? {} : { onShutdownRequested: options.onShutdownRequested }),
			onLost: (_conversation, error) => {
				this.stopServing();
				options.onLost?.(error);
			},
			...(options.terminal === undefined ? {} : { terminal: options.terminal }),
		});
		this.clientConversation = () => connection.conversation;
		this.connectedClient = connection.client;
		const client = new LoopbackClient(
			{
				name: "volt-tui",
				...(options.hostRequests === undefined ? {} : { hostRequests: options.hostRequests }),
				...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
				...(options.onFrame === undefined ? {} : { onFrame: options.onFrame }),
			},
			connection.closed,
		);
		options.onClient?.(client);
		try {
			await client.connect(pair.client);
			await connection.ready;
		} catch (error) {
			await client.stop();
			throw error;
		}
		// The daemon lease and recovered input never keep the TUI from starting.
		await this.clientReady().catch(() => undefined);
		return client;
	}

	/**
	 * The TUI's client shows its conversation: take the conversation's daemon
	 * lease, serve the phones relayed into it, and follow the client's moves.
	 * Once the daemon's ownership decision is in place, the conversation's
	 * durable queued input is recovered before the client's own input can
	 * overtake it; a lease another TUI holds leaves it queued. Resolves once
	 * the recovered input ran. Later calls join the first.
	 */
	clientReady(): Promise<void> {
		this.ready ??= (async () => {
			const outcome = this.daemon
				? await this.daemon.start({
						host: this.host,
						shown: () => this.conversation,
						serving: () => !this.stopped,
					})
				: NO_LEASE;
			if (outcome.kind === "granted" || outcome.kind === "noop") {
				await this.conversation.startRecoveredClientInputs();
			}
		})();
		return this.ready;
	}

	/**
	 * The TUI quits, or the conversation it shows lost its log: the daemon
	 * lease stops following the client's moves, and relay offers are refused.
	 */
	stopServing(): void {
		this.stopped = true;
	}

	/** Phones relayed into the conversation the TUI shows. */
	relayCount(): number {
		return this.daemon?.relayCount() ?? 0;
	}

	onRelayCountChange(listener: (count: number) => void): () => void {
		return this.daemon?.onRelayCountChange(listener) ?? (() => {});
	}

	/** The daemon workspace of the conversation the TUI shows, once resolved. */
	daemonWorkspaceName(): string | undefined {
		return this.daemon?.workspaceName();
	}

	/** A theme the daemon broadcast to its TUIs. */
	onThemeSnapshot(listener: (themeName: string) => void): () => void {
		return (
			this.daemon?.onEvent((event) => {
				if (event.type === "theme_snapshot") listener(event.themeName);
			}) ?? (() => {})
		);
	}

	/**
	 * Close the conversation the TUI shows, with its client still attached so
	 * its `session_shutdown` reaches the client; `beforeDispose` runs after
	 * that, before the session is disposed. Then dispose the host, and give
	 * the lease back once the phones relayed into the conversation heard where
	 * to reconnect: the daemon gets the session back only once it is written
	 * and its lock released. Later calls join the first.
	 */
	dispose(options: { beforeDispose?: () => void } = {}): Promise<void> {
		this.stopServing();
		this.disposing ??= (async () => {
			const conversation = this.conversation;
			try {
				await this.host.close(conversation, {
					reason: "quit",
					...(options.beforeDispose === undefined ? {} : { beforeDispose: options.beforeDispose }),
				});
				await this.host.dispose();
			} finally {
				await this.daemon?.dispose();
			}
		})();
		return this.disposing;
	}
}
