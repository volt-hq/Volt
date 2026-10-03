import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";

/**
 * Call `onLost` once when a hosted runtime ends because its session lost its
 * log: a commit it could not confirm (a fence conflict, a missing session, or
 * an outcome that could not be resolved) means it may no longer be the log's
 * only writer. Returns a function that stops observing.
 */
export function observeConversationLoss(runtime: Pick<AgentSessionRuntime, "lost">, onLost: () => void): () => void {
	let stopped = false;
	void runtime.lost.then(() => {
		if (stopped) return;
		stopped = true;
		onLost();
	});
	return () => {
		stopped = true;
	};
}
