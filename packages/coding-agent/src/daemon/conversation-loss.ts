import type { HostedConversation } from "../core/host/hosted-conversation.ts";

/**
 * Call `onLost` once when a hosted conversation ends because its session lost
 * its log: a commit it could not confirm (a fence conflict, a missing session,
 * or an outcome that could not be resolved) means it may no longer be the
 * log's only writer. Returns a function that stops observing.
 */
export function observeConversationLoss(
	conversation: Pick<HostedConversation, "lost">,
	onLost: () => void,
): () => void {
	let stopped = false;
	void conversation.lost.then(() => {
		if (stopped) return;
		stopped = true;
		onLost();
	});
	return () => {
		stopped = true;
	};
}
