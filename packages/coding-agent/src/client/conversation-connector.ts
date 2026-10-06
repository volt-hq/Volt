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
 * it.
 */

import type { RpcTransport } from "../core/protocol/transport/transport.ts";
import type { ExtensionClient } from "../core/session/extension-binding.ts";
import { ProtocolClient, type ProtocolClientOptions } from "./protocol-client.ts";

/** What a connector opens for its client. */
export type ConnectorTarget =
	/** The conversation the connector serves first. */
	| { readonly kind: "startup" }
	/** A conversation by id, such as the one a move led the client to. */
	| { readonly kind: "session"; readonly sessionId: string };

/** What the client hears from the host of the conversations it opens beside the protocol. */
export interface ConnectorOpenOptions {
	/** An extension asked to shut down (`ctx.shutdown()`). */
	readonly onShutdownRequested?: () => void;
	/** The conversation the client is on lost its log. */
	readonly onLost?: (error: Error) => void;
	/**
	 * What the TUI's terminal offers the conversation's extensions beyond the
	 * protocol: its themes and the request_user_input dialog. In process only,
	 * until a host request kind and a directive carry them (Phase 7).
	 */
	readonly terminal?: Pick<ExtensionClient, "themes" | "userInput">;
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
export interface ConversationConnector {
	/** Open `target` for the client: the transport its host attaches the client there on. Rejects when it cannot. */
	open(target: ConnectorTarget, options?: ConnectorOpenOptions): Promise<OpenedConversation>;
	/** The client quits, or the conversation it shows lost its log: the host stops serving others through it. */
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

export interface ConnectThroughOptions extends Omit<ProtocolClientOptions, "followMoves">, ConnectorOpenOptions {
	/** Called with the client before it says hello, so the caller observes its changes from the first. */
	readonly onClient?: (client: ProtocolClient) => void;
	/** Called with each conversation the connector opened for the client: the startup one, then each one a move led to. */
	readonly onOpened?: (opened: OpenedConversation) => void;
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
	const { onClient, onOpened, onShutdownRequested, onLost, terminal, ...clientOptions } = options;
	const openOptions: ConnectorOpenOptions = {
		...(onShutdownRequested === undefined ? {} : { onShutdownRequested }),
		...(onLost === undefined ? {} : { onLost }),
		...(terminal === undefined ? {} : { terminal }),
	};
	const client = new ProtocolClient({ ...clientOptions, followMoves: "reconnect" });
	onClient?.(client);
	const follow = async (target: string): Promise<void> => {
		try {
			const opened = await connector.open({ kind: "session", sessionId: target }, openOptions);
			if (client.moving !== target) {
				// The client stopped, or moved on, meanwhile.
				await opened.transport.close();
				return;
			}
			onOpened?.(opened);
			await client.connect(opened.transport);
		} catch (error) {
			if (client.moving === target || client.conversation === target) {
				await client.stop(error instanceof Error ? error : new Error(String(error)));
			}
		}
	};
	client.onChange((change) => {
		if (change?.type === "ended" && change.reason === "moved") void follow(change.target);
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
