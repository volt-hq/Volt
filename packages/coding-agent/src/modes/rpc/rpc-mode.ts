/**
 * RPC mode: one protocol connection on the process's stdio, on the local
 * profile (docs/rpc.md). The client writes protocol 1 frames as JSON lines on
 * stdin and reads the host's frames on stdout.
 *
 * The process ends when stdin closes, on SIGTERM or SIGHUP, when an extension
 * asks to shut down, or when the conversation the client is on loses its log.
 */

import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { startModelCatalogWatcher } from "../../core/model-catalog-watcher.ts";
import {
	flushRawStdout,
	restoreStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { localProfile } from "../../core/protocol/profiles.ts";
import { serveConnection } from "../../core/protocol/server/connection.ts";
import type { RpcTransport } from "../../core/rpc/transport.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";

export interface RpcModeOptions {
	/** Where frames travel; the process's stdin and stdout by default. */
	transport?: RpcTransport;
	/** Defaults to true on stdio and false on a given transport: the process exits when the mode ends. */
	exitProcess?: boolean;
	/** Called once the client said hello and the conversation's extensions are bound. */
	onReady?: () => void;
}

function createStdioTransport(): RpcTransport {
	return {
		write(value) {
			writeRawStdout(serializeJsonLine(value));
		},
		onLine(handler) {
			return attachJsonlLineReader(process.stdin, handler);
		},
		onClose(handler) {
			const onEnd = () => handler();
			const onError = (error: Error) => handler(error);
			process.stdin.on("end", onEnd);
			process.stdin.on("error", onError);
			return () => {
				process.stdin.off("end", onEnd);
				process.stdin.off("error", onError);
			};
		},
		waitForBackpressure: waitForRawStdoutBackpressure,
		flush: flushRawStdout,
		close() {
			process.stdin.pause();
		},
	};
}

/** Serve one protocol client on stdio (or `options.transport`) until it disconnects or the host shuts down. */
export async function runRpcMode(
	host: ConversationHost,
	conversation: HostedConversation,
	options: RpcModeOptions = {},
): Promise<void> {
	const stdio = options.transport === undefined;
	if (stdio) takeOverStdout();
	const exitProcess = options.exitProcess ?? stdio;
	const transport = options.transport ?? createStdioTransport();
	let exitCode = 0;
	let shuttingDown: Promise<void> | undefined;
	const connection = serveConnection(transport, localProfile, {
		host,
		conversation,
		onShutdownRequested: () => void shutdown(0),
		onLost: (lost, error) => {
			console.error(
				`Volt stopped session ${lost.id} because its saved state could not be confirmed: ${error.message}`,
			);
			void shutdown(1, "The conversation lost its log");
		},
	});
	const shutdown = (code: number, message?: string): Promise<void> => {
		exitCode = Math.max(exitCode, code);
		shuttingDown ??= connection.shutdown(message).catch(() => undefined);
		return shuttingDown;
	};

	const signalCleanups: Array<() => void> = [];
	if (exitProcess) {
		const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void shutdown(signal === "SIGHUP" ? 129 : 143);
			};
			process.on(signal, handler);
			signalCleanups.push(() => process.off(signal, handler));
		}
	}
	let stopWatcher = (): void => {};
	let readyFailure: { error: unknown } | undefined;
	void connection.ready.then(
		() => {
			try {
				// Logins and API keys saved by other volt processes change the selectable models.
				stopWatcher = startModelCatalogWatcher({
					agentDir: conversation.services.agentDir,
					getModelRegistry: () => (connection.conversation ?? conversation).session.modelRegistry,
					onCatalogChanged: () => connection.changed("models"),
				});
				options.onReady?.();
			} catch (error) {
				readyFailure = { error };
				void shutdown(1);
			}
		},
		() => undefined,
	);

	let failure: unknown;
	try {
		await connection.closed;
		if (readyFailure) throw readyFailure.error;
	} catch (error) {
		failure = error;
		exitCode = Math.max(exitCode, 1);
	} finally {
		stopWatcher();
		for (const cleanup of signalCleanups) cleanup();
		if (stdio && !exitProcess) restoreStdout();
	}
	if (exitProcess) process.exit(exitCode);
	if (failure !== undefined) throw failure;
}
