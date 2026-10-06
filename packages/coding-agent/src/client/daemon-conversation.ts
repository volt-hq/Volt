/**
 * A conversation a TUI opens through the daemon (Phase 7 plan §1, "Open and
 * attach"): its `conversation_open` on the TUI's control connection, then
 * its end of the relayed stream to the worker hosting the conversation, as
 * the JSONL transport its protocol client connects on. The daemon connector
 * opens each conversation of the TUI this way.
 */

import type { Duplex } from "node:stream";
import { createJsonlStreamRpcTransport, type RpcTransport } from "../core/protocol/transport/transport.ts";
import type { DaemonClient } from "../daemon/control-client.ts";
import type { ControlRequest, ControlResponse, WorkerSpawnOnlyOption } from "../daemon/control-protocol.ts";

export type ConversationOpenRequest = Omit<Extract<ControlRequest, { type: "conversation_open" }>, "type" | "id">;
export type ConversationOpened = Extract<ControlResponse, { type: "conversation_opened" }>;

/** The daemon refused an open, with its control error code (a handshake outcome such as `conversation_locked`). */
export class DaemonConversationOpenError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "DaemonConversationOpenError";
		this.code = code;
	}
}

/** A JSONL transport over a relay's raw stream, which reads once the first line handler is attached. */
function relayTransport(stream: Duplex): RpcTransport {
	const transport = createJsonlStreamRpcTransport({ input: stream, output: stream, closeOutput: true });
	return {
		...transport,
		onLine(handler) {
			const off = transport.onLine(handler);
			// The relay's socket is handed over paused, with what arrived after the ack unshifted.
			stream.resume();
			return off;
		},
		close: async () => {
			await transport.close();
			stream.destroy();
		},
	};
}

/**
 * Open a conversation through the daemon `client` is connected to (as a TUI)
 * and dial the TUI's end of its stream. Rejects with the daemon's refusal.
 */
export async function openDaemonConversation(
	client: DaemonClient,
	request: ConversationOpenRequest,
): Promise<{ readonly opened: ConversationOpened; readonly transport: RpcTransport }> {
	const response = await client.request({ type: "conversation_open", ...request });
	if (response.type === "error") throw new DaemonConversationOpenError(response.code, response.message);
	if (response.type !== "conversation_opened") throw new Error(`The daemon answered ${response.type}`);
	const stream = await client.openConversationRelay({ relayId: response.relayId, relayToken: response.relayToken });
	return { opened: response, transport: relayTransport(stream) };
}

/** The CLI arguments each spawn-only option comes from. */
const OPTION_FLAGS: Readonly<Record<WorkerSpawnOnlyOption, string>> = {
	trust: "--approve/--no-approve",
	profile: "--profile",
	extensions: "--extension",
	noExtensions: "--no-extensions",
	skills: "--skill",
	noSkills: "--no-skills",
	promptTemplates: "--prompt-template",
	noPromptTemplates: "--no-prompt-templates",
	themes: "--theme",
	noThemes: "--no-themes",
	noContextFiles: "--no-context-files",
	systemPrompt: "--system-prompt",
	appendSystemPrompt: "--append-system-prompt",
	tools: "--tools",
	noTools: "--no-tools",
	noBuiltinTools: "--no-builtin-tools",
	excludeTools: "--exclude-tools",
	allowUnlistedExtensionTools: "--allow-unlisted-extension-tools",
	lsp: "--lsp",
	apiKey: "--api-key",
	flags: "extension flags",
};

/** What an open that attached to a running conversation tells its user: the options it kept its own of. */
export function openNotices(opened: ConversationOpened): string[] {
	if (opened.ignoredOptions.length === 0) return [];
	const flags = opened.ignoredOptions.map((option) => OPTION_FLAGS[option]).join(", ");
	return [`The conversation was already running; it keeps its own ${flags}.`];
}
