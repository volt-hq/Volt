/**
 * What tests read of an AgentSession that clients now read from the
 * protocol (the client fold and the live lane): the last assistant text, the
 * user messages a fork can start from, and the queue the session publishes
 * as `queue_update`; and shell operations that produce a given result, for
 * recording one through `runUserBash`.
 */

import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import type { AgentSession, AgentSessionEvent } from "../../src/core/agent-session.ts";
import { extractUserMessageText } from "../../src/core/session/session-info.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";

/** The text of the last assistant message, skipping aborted empty ones; undefined when there is none. */
export function lastAssistantText(session: { readonly messages: readonly AgentMessage[] }): string | undefined {
	const last = [...session.messages]
		.reverse()
		.find(
			(message): message is AssistantMessage =>
				message.role === "assistant" &&
				!(
					(message as AssistantMessage).stopReason === "aborted" &&
					(message as AssistantMessage).content.length === 0
				),
		);
	if (!last) return undefined;
	let text = "";
	for (const content of last.content) {
		if (content.type === "text") text += content.text;
	}
	return text.trim() || undefined;
}

/** Every user message entry of the session's log with text, as a fork can start from it. */
export function userMessagesForForking(session: {
	readonly sessionManager: Pick<SessionManager, "getEntries">;
}): Array<{ entryId: string; text: string }> {
	const result: Array<{ entryId: string; text: string }> = [];
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractUserMessageText(entry.message.content);
		if (text) result.push({ entryId: entry.id, text });
	}
	return result;
}

/** The queue a session publishes: its steering and follow-up input, and the notices of finished work. */
export type QueueView = Omit<Extract<AgentSessionEvent, { type: "queue_update" }>, "type">;

/**
 * The queue `session` publishes as `queue_update`, as it stands now. Read in
 * place rather than from the events: a test subscribes after the session
 * published the queue it recovered at startup.
 */
export function queueOf(session: AgentSession): QueueView {
	return (session as unknown as { _clientInputs: { queueView(): QueueView } })._clientInputs.queueView();
}

/** Shell operations whose command writes `output` and exits with `exitCode`: `runUserBash` records that result. */
export function bashResultOperations(result: { output: string; exitCode: number | null }): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			if (result.output.length > 0) onData(Buffer.from(result.output));
			return { exitCode: result.exitCode };
		},
	};
}
