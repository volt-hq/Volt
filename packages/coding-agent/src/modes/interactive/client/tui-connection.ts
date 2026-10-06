/**
 * What InteractiveMode connects its protocol client through (architecture
 * rewrite §10): the host the TUI runs its conversations in. In process until
 * Phase 7, where `TuiHost` (host/tui-host.ts) is that host; the TUI reaches it
 * only through this connection and the protocol client it hands out.
 */

import type { HostRequestKind } from "@hansjm10/volt-protocol";
import type { ProtocolClient, ProtocolClientOptions } from "../../../client/protocol-client.ts";
import type { ExtensionClient } from "../../../core/session/extension-binding.ts";

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
	readonly onClient?: (client: ProtocolClient) => void;
	/**
	 * What the TUI's terminal offers the conversation's extensions beyond the
	 * protocol: its themes and the request_user_input dialog. In process only,
	 * until a host request kind and a directive carry them (Phase 7).
	 */
	readonly terminal?: Pick<ExtensionClient, "themes" | "userInput">;
}

/** The TUI's connection to its host. */
export interface TuiConnection {
	/**
	 * Connect the TUI's client on the local profile; it anchors its
	 * conversation. Resolves once the client caught up with the log and the
	 * host serves it.
	 */
	connect(options?: TuiConnectOptions): Promise<ProtocolClient>;
	/** The TUI quits, or the conversation it shows lost its log: the host stops serving others through it. */
	stopServing(): void;
	/**
	 * Close the conversation the TUI shows, with its client still attached so
	 * its `session_shutdown` reaches the client (`beforeDispose` runs after
	 * that), then the host. Later calls join the first.
	 */
	dispose(options?: { beforeDispose?: () => void }): Promise<void>;
	/** The daemon workspace of the conversation the TUI shows, once resolved. */
	daemonWorkspaceName(): string | undefined;
	/** A theme the daemon broadcast to its TUIs. */
	onThemeSnapshot(listener: (themeName: string) => void): () => void;
}
