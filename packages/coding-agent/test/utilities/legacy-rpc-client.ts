/**
 * A client of the legacy RPC command wire in the same process, for tests of
 * that wire while it serves the remote path: the legacy mode on one end of a
 * loopback pair, the legacy client on the other. Local clients speak protocol
 * frames (`createLoopbackClient`).
 */

import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/rpc/index.ts";
import { runLegacyRemoteRpcMode } from "../../src/modes/rpc/legacy-remote-rpc-mode.ts";
import type { RpcClientEvent } from "../../src/modes/rpc/rpc-client-base.ts";
import { RpcTransportClient } from "../../src/modes/rpc/rpc-transport-client.ts";

export type LegacyRpcClientEventListener = (event: RpcClientEvent, client: LegacyRpcClient) => void;

export interface LegacyRpcClientOptions {
	/** Milliseconds to wait for a command response. Defaults to 30 seconds. */
	requestTimeoutMs?: number;
	/**
	 * Defaults to true. The client anchors its conversation: stopping it closes
	 * the conversation, and createLegacyRpcClient takes over closing it from
	 * the call on. Set false when another owner keeps the conversation open after
	 * this loopback client stops.
	 */
	anchor?: boolean;
	/** Initial event listener registered before startup completes. */
	onEvent?: LegacyRpcClientEventListener;
}

interface LegacyRpcClientConstructorOptions extends LegacyRpcClientOptions {
	host: ConversationHost;
	conversation: HostedConversation;
}

/**
 * RPC client backed by runLegacyRemoteRpcMode in the same Node.js process, attached to a
 * hosted conversation.
 *
 * stop() closes the client transport and waits for RPC mode shutdown. By default
 * the client anchors the conversation, and shutdown closes it.
 */
export class LegacyRpcClient extends RpcTransportClient {
	private readonly modeClosed: Promise<void>;
	private readonly modeReady: Promise<void>;

	constructor(options: LegacyRpcClientConstructorOptions) {
		const pair = createLoopbackRpcTransportPair();
		super({ transport: pair.client, requestTimeoutMs: options.requestTimeoutMs });

		const initialEventListener = options.onEvent;
		if (initialEventListener) {
			this.onEvent((event) => {
				initialEventListener(event, this);
			});
		}

		let readySettled = false;
		let resolveReady: () => void = () => {};
		let rejectReady: (error: unknown) => void = () => {};
		this.modeReady = new Promise<void>((resolve, reject) => {
			resolveReady = () => {
				readySettled = true;
				resolve();
			};
			rejectReady = (error) => {
				readySettled = true;
				reject(error);
			};
		});
		void this.modeReady.catch(() => {});

		this.modeClosed = runLegacyRemoteRpcMode(options.host, options.conversation, {
			transport: pair.server,
			...(options.anchor === undefined ? {} : { anchor: options.anchor }),
			exitProcess: false,
			onReady: () => {
				void options.conversation.startRecoveredClientInputs().catch(() => undefined);
				resolveReady();
			},
		});
		void this.modeClosed.catch((error: unknown) => {
			if (!readySettled) {
				rejectReady(error);
			}
			void pair.server.close();
		});
	}

	async start(): Promise<void> {
		await super.start();
		await this.modeReady;
	}

	async stop(): Promise<void> {
		await super.stop();
		await this.modeClosed;
	}
}

export async function createLegacyRpcClient(
	host: ConversationHost,
	conversation: HostedConversation,
	options: LegacyRpcClientOptions = {},
): Promise<LegacyRpcClient> {
	const anchor = options.anchor ?? true;
	let client: LegacyRpcClient;
	try {
		client = new LegacyRpcClient({ host, conversation, ...options, anchor });
	} catch (constructionError) {
		if (!anchor) {
			throw constructionError;
		}
		try {
			await host.close(conversation);
		} catch (cleanupError) {
			throw new AggregateError(
				[constructionError, cleanupError],
				"In-process RPC construction failed and conversation cleanup did not complete",
			);
		}
		throw constructionError;
	}

	try {
		await client.start();
		return client;
	} catch (startupError) {
		try {
			await client.stop();
		} catch (cleanupError) {
			if (cleanupError !== startupError) {
				throw new AggregateError(
					[startupError, cleanupError],
					"In-process RPC startup failed and cleanup did not complete",
				);
			}
		}
		throw startupError;
	}
}
