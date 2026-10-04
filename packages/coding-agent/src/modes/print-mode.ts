/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `volt -p "prompt"` - text output
 * - `volt --mode json "prompt"` - JSON event stream
 */

import { randomUUID } from "node:crypto";
import type { AssistantMessage, ImageContent } from "@hansjm10/volt-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { type ProjectionDiagnostic, StreamProjector } from "../core/rpc/stream-projection.ts";
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
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	/** Set when the runtime ended because its session lost its log: a commit it could not confirm. */
	let conversationLoss: string | undefined;
	let streamProjector: StreamProjector | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];
	const extensionClientId = randomUUID();

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		reportProjectionDiagnostics("json-print", streamProjector?.endStream().diagnostics ?? []);
		streamProjector = undefined;
		await runtimeHost.dispose();
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

	void runtimeHost.lost.then((error) => {
		conversationLoss ??= `Volt stopped session ${runtimeHost.session.sessionId} because its saved state could not be confirmed: ${error.message}`;
	});

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.attachExtensionClient({
			id: extensionClientId,
			mode: mode === "json" ? "json" : "print",
			commandContextActions: {
				waitForIdle: () => session.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled, seeded: result.seeded };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		}).ready;

		unsubscribe?.();
		reportProjectionDiagnostics("json-print", streamProjector?.endStream().diagnostics ?? []);
		const projector = new StreamProjector();
		streamProjector = projector;
		unsubscribe = session.subscribe(
			(event) => {
				if (mode === "json") {
					const batch = projector.push(event);
					reportProjectionDiagnostics("json-print", batch.diagnostics);
					for (const frame of batch.frames) {
						writeRawStdout(`${JSON.stringify(frame)}\n`);
					}
				}
			},
			{ monitorGitContext: false },
		);
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			if (conversationLoss) break;
			await session.prompt(message);
		}

		if (conversationLoss) {
			console.error(conversationLoss);
			return 1;
		}

		if (mode === "text") {
			const state = session.state;
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

function reportProjectionDiagnostics(boundary: string, diagnostics: readonly ProjectionDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		console.error(`[stream-projection:${boundary}] ${diagnostic.code}: ${diagnostic.message}`, diagnostic);
	}
}
