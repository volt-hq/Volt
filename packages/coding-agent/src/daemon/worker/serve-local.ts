/**
 * A local TUI relayed to the worker hosting its conversation (Phase 7 plan
 * §1, "Open and attach"): the daemon admitted the TUI's control connection
 * and its `conversation_open`, and hands the worker the stream with a local
 * preamble. The worker serves it on the local profile as the in-process
 * connector serves its TUI, with the TUI's client key (its retried intents
 * answer as they did, across its connections), its prompts as interactive
 * input, and its abort as the user's interrupt key. The TUI follows its
 * structural intents by redirect; the moves an extension starts for it open
 * here (D1). Once it attached, an open that found the worker live has its
 * session-level options applied, as session commands, and the conversation's
 * durable queued input is recovered before the TUI's own input runs.
 */

import type { Duplex } from "node:stream";
import { ClientScope } from "../../core/host/client-scope.ts";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { resolveCliModel } from "../../core/model-resolver.ts";
import { localProfile } from "../../core/protocol/profiles.ts";
import {
	type ProtocolConnection,
	type ServeConnectionOptions,
	serveConnection,
} from "../../core/protocol/server/connection.ts";
import { createJsonlStreamRpcTransport } from "../../core/protocol/transport/transport.ts";
import type { ReviewDiscussionService } from "../../core/review-discussions.ts";
import type { LocalRelayPreamble, WorkerSessionOptions } from "../control-protocol.ts";

/** A relay redeemed for a local TUI: its preamble and stream. */
export interface OpenedLocalRelay {
	readonly preamble: LocalRelayPreamble;
	readonly stream: Duplex;
	/** The relay ended here. */
	finished(): void;
}

export interface ServeLocalRelayOptions {
	readonly host: ConversationHost;
	/** The conversation the relay was offered for. */
	readonly conversation: HostedConversation;
	readonly relay: OpenedLocalRelay;
	/** How the TUI follows its structural intents and the moves its commands start. */
	readonly redirect: ServeConnectionOptions["redirect"];
	/** The worker's own admission of the TUI's intents. */
	readonly admit?: ServeConnectionOptions["admit"];
	readonly reviewDiscussions?: ReviewDiscussionService;
	/** The connection serving the TUI, once it exists: the worker ends it on shutdown. */
	readonly onConnection?: (connection: ProtocolConnection) => void;
}

/**
 * Apply an open's session-level options to `conversation`, as `set_model`,
 * `set_thinking_level`, and `set_agent_mode` do. What cannot apply (a model
 * no provider offers, plan mode while a turn runs) is left, and logged.
 */
async function applySessionOptions(conversation: HostedConversation, options: WorkerSessionOptions): Promise<void> {
	const { session } = conversation;
	const resolved = resolveCliModel({
		cliProvider: options.provider,
		cliModel: options.model,
		cliThinking: options.thinking,
		modelRegistry: session.modelRegistry,
	});
	for (const problem of [resolved.warning, resolved.error]) {
		if (problem !== undefined) console.error(`worker: ${problem}`);
	}
	try {
		if (resolved.model) await session.setModel(resolved.model, { persistDefault: false });
		const thinking = options.thinking ?? resolved.thinkingLevel;
		if (thinking !== undefined) await session.setThinkingLevel(thinking, { persistDefault: false });
		if (options.plan) await session.setAgentMode("plan");
	} catch (error) {
		console.error(
			`worker: the open's session options did not apply: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Serve a relayed TUI from `conversation` on the local profile until its
 * stream ends. A preamble for another session is refused.
 */
export async function serveLocalRelay(options: ServeLocalRelayOptions): Promise<void> {
	const { host, conversation, relay } = options;
	const { preamble, stream } = relay;
	if (conversation.closed || preamble.sessionId !== conversation.id) {
		stream.destroy();
		relay.finished();
		return;
	}
	const transport = createJsonlStreamRpcTransport({ input: stream, output: stream, closeOutput: true });
	let applied = preamble.apply === undefined;
	let connection: ProtocolConnection | undefined;
	try {
		connection = serveConnection(transport, localProfile, {
			host,
			conversation,
			anchor: false,
			redirect: options.redirect,
			clientKey: preamble.clientKey,
			// The TUI's prompts reach extensions as interactive input.
			inputSource: "interactive",
			services: () => ({
				// The TUI's abort is the user's interrupt key: it stops the run without delivering its queued input.
				abortRun: (session) => session.abort("keyboard_interrupt"),
				...(preamble.modelScopePatterns === undefined ? {} : { modelScopePatterns: preamble.modelScopePatterns }),
				...(options.reviewDiscussions === undefined ? {} : { reviewDiscussions: options.reviewDiscussions }),
			}),
			beforeServing: async (served) => {
				if (!applied && preamble.apply !== undefined && served === conversation) {
					applied = true;
					await applySessionOptions(served, preamble.apply);
				}
				// Recovered turns belong to no client.
				void ClientScope.exit(() => served.startRecoveredClientInputs()).catch(() => undefined);
			},
			...(options.admit === undefined ? {} : { admit: options.admit }),
			// An extension's `ctx.shutdown()` ends its invoking TUI's connection; the conversation stays.
			onShutdownRequested: () => void connection?.shutdown().catch(() => undefined),
		});
		options.onConnection?.(connection);
		// The redeemed socket was handed over paused.
		stream.resume();
		await connection.closed;
	} catch {
		// The relay's end reaches the TUI as its stream's end.
	} finally {
		stream.destroy();
		relay.finished();
	}
}
