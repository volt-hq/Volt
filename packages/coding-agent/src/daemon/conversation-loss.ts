import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";

/**
 * Call `onLost` once when a hosted runtime's session loses its log: a commit it
 * could not confirm (a fence conflict, a missing session, or an outcome that
 * could not be resolved) means it may no longer be the log's only writer.
 * Follows session replacement and runs after the failing write has unwound.
 */
export function observeConversationLoss(
	runtime: Pick<AgentSessionRuntime, "session" | "subscribeSessionReplaced">,
	onLost: () => void,
): () => void {
	let stopped = false;
	const bind = (session: AgentSessionRuntime["session"]): (() => void) =>
		session.sessionManager.subscribeConversationAuthorityChanges(() => {
			queueMicrotask(() => {
				if (stopped || runtime.session !== session) return;
				stopped = true;
				onLost();
			});
		});
	let unsubscribeSession = bind(runtime.session);
	const unsubscribeSessionReplaced = runtime.subscribeSessionReplaced((session) => {
		if (stopped) return;
		unsubscribeSession();
		unsubscribeSession = bind(session);
	});
	return () => {
		stopped = true;
		unsubscribeSessionReplaced();
		unsubscribeSession();
	};
}
