/**
 * The in-process connector (architecture rewrite §10): the conversations of a
 * `ConversationHost` in the client's own process, for SDK embedders and tests.
 * There is no daemon, no phone, and no background: the conversations live as
 * long as the host.
 *
 * Each `open` serves the client over a loopback connection on the local
 * profile. The client follows its moves by redirect and anchors its
 * conversation: a structural intent opens the target in this host (a stored
 * session a switch resumes too), redirects the client there, and closes the
 * conversation it left, as an anchor's move does; the client opens the target
 * through the connector again. Every connection carries the connector's
 * client key, so an intent the client retries after it reconnected answers as
 * it did, and an extension's fork leaves its editor text for the connection
 * the client reconnects on. Once the client attached to a conversation, the
 * conversation's durable queued input is recovered before the client's own
 * input runs. `dispose` closes the conversation the client shows, then the
 * host; until then, a process exit closes the language server traces of the
 * conversations the host serves.
 */

import { randomUUID } from "node:crypto";
import { ClientScope } from "../core/host/client-scope.ts";
import type { ConversationHost } from "../core/host/conversation-host.ts";
import type { HostedConversation } from "../core/host/hosted-conversation.ts";
import type { HostedRedirect } from "../core/host/targets.ts";
import { localProfile } from "../core/protocol/profiles.ts";
import { serveConnection } from "../core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../core/protocol/transport/loopback-transport.ts";
import type {
	ConnectorOpenOptions,
	ConnectorTarget,
	ConversationConnector,
	OpenedConversation,
} from "./conversation-connector.ts";

export interface InProcessConnectorOptions {
	readonly host: ConversationHost;
	/** The conversation the client opens on (`{kind: "startup"}`). */
	readonly conversation: HostedConversation;
	/** The model scope patterns the client started with (`--models`), which a profile switch keeps. */
	readonly modelScopePatterns?: readonly string[];
}

/** A target the host opened for the client: it waits there until the client reconnects. */
const HOSTED_HERE: HostedRedirect = { async commit() {}, async abort() {} };

export class InProcessConnector implements ConversationConnector {
	readonly host: ConversationHost;
	private readonly startup: HostedConversation;
	private readonly modelScopePatterns: readonly string[] | undefined;
	/** Who the client is across its connections. */
	private readonly clientKey = randomUUID();
	/** The conversation the client shows: the one it is on, or the one a move redirected it to. */
	private shown: HostedConversation;
	private exitHook = false;
	private disposing: Promise<void> | undefined;

	private constructor(options: InProcessConnectorOptions) {
		this.host = options.host;
		this.startup = options.conversation;
		this.shown = options.conversation;
		this.modelScopePatterns = options.modelScopePatterns;
	}

	/** Serve the client the conversations of `options.host`, starting with `options.conversation`. */
	static start(options: InProcessConnectorOptions): InProcessConnector {
		return new InProcessConnector(options);
	}

	/** The conversation the client shows: the one it is on, the one a move redirected it to, or the last one it was on. */
	get conversation(): HostedConversation {
		return this.shown;
	}

	/** A process exit stops the language server traces of the conversations the host serves, synchronously. */
	private readonly closeLspTraces = (): void => {
		for (const conversation of this.host.list()) {
			try {
				conversation.session.closeLspTraceSync();
			} catch {
				// The process is exiting: each trace closes on its own.
			}
		}
	};

	/**
	 * Serve `target` to the client over a loopback connection on the local
	 * profile: the startup conversation, or an open one by id (where a move
	 * led the client). Rejects when the conversation is not open here.
	 */
	async open(target: ConnectorTarget, options: ConnectorOpenOptions = {}): Promise<OpenedConversation> {
		const conversation = target.kind === "startup" ? this.startup : this.host.get(target.sessionId);
		if (!conversation || conversation.closed) {
			throw new Error(
				`Conversation ${target.kind === "startup" ? this.startup.id : target.sessionId} is not open in this host`,
			);
		}
		if (!this.exitHook) {
			this.exitHook = true;
			process.on("exit", this.closeLspTraces);
		}
		const pair = createLoopbackRpcTransportPair();
		serveConnection(pair.server, localProfile, {
			host: this.host,
			conversation,
			anchor: true,
			redirect: {
				hostTarget: async () => HOSTED_HERE,
				hostsClientMoves: true,
				hostsStoredSessions: true,
				onRedirected: (sessionId) => {
					const to = this.host.get(sessionId);
					if (to) this.shown = to;
				},
			},
			clientKey: this.clientKey,
			// The client's prompts reach extensions as interactive input.
			inputSource: "interactive",
			services: () => ({
				// The client's abort is the user's interrupt key: it stops the run without delivering its queued input.
				abortRun: (session) => session.abort("keyboard_interrupt"),
				...(this.modelScopePatterns === undefined ? {} : { modelScopePatterns: this.modelScopePatterns }),
			}),
			beforeServing: (served) => this.serve(served),
			...(options.onShutdownRequested === undefined ? {} : { onShutdownRequested: options.onShutdownRequested }),
			onLost: (_conversation, error) => options.onLost?.(error),
		});
		this.shown = conversation;
		const workspaceName = this.daemonWorkspaceName();
		return {
			transport: pair.client,
			sessionId: conversation.id,
			...(workspaceName === undefined ? {} : { workspaceName }),
			notices: [],
		};
	}

	/** The client attached to `conversation`: its durable queued input starts replaying before the client's own input runs. */
	private async serve(conversation: HostedConversation): Promise<void> {
		if (conversation.closed) return;
		// Recovered turns belong to no client, whoever the client reconnected for.
		void ClientScope.exit(() => conversation.startRecoveredClientInputs()).catch(() => undefined);
	}

	/** Nothing to stop: the host serves only this client, until `dispose`. */
	stopServing(): void {}

	daemonWorkspaceName(): string | undefined {
		return undefined;
	}

	onThemeSnapshot(_listener: (themeName: string) => void): () => void {
		return () => {};
	}

	/**
	 * Close the conversation the client shows, with its client still attached
	 * so its `session_shutdown` reaches the client; `beforeDispose` runs after
	 * that, before the session is disposed. Then dispose the host. Later calls
	 * join the first.
	 */
	dispose(options: { beforeDispose?: () => void } = {}): Promise<void> {
		this.disposing ??= (async () => {
			try {
				await this.host.close(this.shown, {
					reason: "quit",
					...(options.beforeDispose === undefined ? {} : { beforeDispose: options.beforeDispose }),
				});
				await this.host.dispose();
			} finally {
				process.off("exit", this.closeLspTraces);
			}
		})();
		return this.disposing;
	}
}
