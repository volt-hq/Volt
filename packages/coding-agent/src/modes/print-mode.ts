/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `volt -p "prompt"` - text output
 * - `volt --mode json "prompt"` - the conversation as protocol frames on the
 *   local profile (docs/json.md): a snapshot, then its entries and live lane
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent } from "@hansjm10/volt-ai";
import type { AgentSession } from "../core/agent-session.ts";
import type { ConversationHost } from "../core/host/conversation-host.ts";
import type { HostedConversation } from "../core/host/hosted-conversation.ts";
import { openFork, openNewSession, openStoredSession } from "../core/host/session-intents.ts";
import type { HostClient } from "../core/host/targets.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { localProfile } from "../core/protocol/profiles.ts";
import { Subscription, type SubscriptionEnd } from "../core/protocol/server/subscription.ts";
import { killTrackedDetachedChildren } from "../utils/shell.ts";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode: a client that anchors `conversation`,
 * sends the prompts, outputs the result, and closes the conversation it ends
 * on. Extension session changes move it in place.
 */
export async function runPrintMode(
	host: ConversationHost,
	conversation: HostedConversation,
	options: PrintModeOptions,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let current = conversation;
	/** Set when the session the run is on lost its log: a commit it could not confirm. */
	let conversationLoss: string | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const session = (): AgentSession => current.session;

	/** JSON mode: the conversation the run is on as one subscription's frames, from a snapshot. */
	let subscription: Subscription | undefined;
	let subscriptions = 0;
	const subscribe = (): void => {
		if (mode !== "json") return;
		subscription = new Subscription({
			subscriptionId: `json-${++subscriptions}`,
			liveClientId: `${client.id}:json-${subscriptions}`,
			conversation: current,
			profile: localProfile,
			sink: { send: (frame) => writeRawStdout(`${JSON.stringify(frame)}\n`) },
			live: true,
			accepts: () => false,
		});
		subscription.start("snapshot");
	};
	const endSubscription = (end: SubscriptionEnd): void => {
		subscription?.end(end);
		subscription = undefined;
	};

	const observeLoss = (observed: HostedConversation): void => {
		void observed.lost.then((error) => {
			if (observed !== current) return;
			conversationLoss ??= `Volt stopped session ${observed.id} because its saved state could not be confirmed: ${error.message}`;
		});
	};

	const client: HostClient = {
		id: randomUUID(),
		anchor: true,
		surface: {
			commandContextActions: {
				waitForIdle: () => session().waitForIdle(),
				newSession: (newSessionOptions) => openNewSession(host, client, newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await openFork(host, client, entryId, forkOptions);
					return result.cancelled
						? result
						: { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session().navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionRef, switchOptions) => openStoredSession(host, client, sessionRef, switchOptions),
				reload: () => session().reload(),
			},
			onError: (err) => {
				// JSON mode tells its reader on the live lane, as RPC clients are told.
				if (subscription) subscription.notice("error", `${err.event}: ${err.error}`, err.extensionPath);
				else console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		},
		move: {
			kind: "in_place",
			prepare: (to) => {
				current = to;
			},
			onMoved: (to) => {
				observeLoss(to);
				endSubscription({ reason: "moved", target: to.id });
				subscribe();
			},
		},
	};

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		endSubscription({ reason: "closed" });
		await (host.conversationOf(client) ? host.detach(client) : host.close(current));
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();
	observeLoss(conversation);

	try {
		await host.attach(client, conversation);
		subscribe();

		if (initialMessage) {
			await session().prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			if (conversationLoss) break;
			await session().prompt(message);
		}

		if (conversationLoss) {
			console.error(conversationLoss);
			return 1;
		}

		if (mode === "text") {
			const state = session().state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.error?.message || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(conversationLoss ?? (error instanceof Error ? error.message : String(error)));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}
