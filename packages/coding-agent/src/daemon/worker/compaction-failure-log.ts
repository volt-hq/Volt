import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import type { DaemonLogger } from "../log.ts";

const MAX_LOGGED_ERROR_LENGTH = 500;

/**
 * Write one daemon log line per failed compaction in a hosted conversation. Clients only see
 * `compaction_end` while connected, so this is the host's only record of why
 * compaction failed. Logs metadata and the error message only, never
 * conversation content.
 */
export function observeCompactionFailures(
	conversation: Pick<HostedConversation, "session">,
	workspace: string,
	log: ReturnType<DaemonLogger["child"]>,
): () => void {
	const session = conversation.session;
	return session.subscribe(
		(event: AgentSessionEvent) => {
			if (event.type !== "compaction_end" || event.aborted || event.errorMessage === undefined) return;
			const model = session.model;
			const error =
				event.errorMessage.length > MAX_LOGGED_ERROR_LENGTH
					? `${event.errorMessage.slice(0, MAX_LOGGED_ERROR_LENGTH)}...`
					: event.errorMessage;
			log("warn", "compaction failed", {
				sessionId: session.sessionId,
				workspace,
				reason: event.reason,
				...(model === undefined ? {} : { model: `${model.provider}/${model.id}` }),
				error,
			});
		},
		{ monitorGitContext: false },
	);
}
