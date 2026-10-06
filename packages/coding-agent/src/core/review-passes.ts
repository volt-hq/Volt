/**
 * The conversations a session's review passes run in (RFC §5.3): each pass
 * of a review (discovery, verification, presentation) is an ordinary
 * conversation of its own, hosted here for its owner's lifetime. The review
 * links the pass it runs now as its work's `child`, so a client of the
 * reviewing conversation subscribes to it for the review's inline view and
 * its usage, as it does to a subagent child; nothing acts on a pass. A pass
 * keeps no log beyond its run: it closes once it ends, and a closed pass
 * cannot be read. A pass that reads the pull request text the code host
 * provided is local-only: paired remote devices never observe it.
 */

import { HostedConversation, type HostedConversationSession } from "./host/hosted-conversation.ts";

export class ReviewPasses {
	private readonly passes = new Map<string, HostedConversation>();

	/** Host the session of a review pass, until {@link close} closes it. */
	adopt(created: HostedConversationSession, options: { readonly localOnly: boolean }): HostedConversation {
		const conversation = new HostedConversation(created, {
			openedAs: "startup",
			lifetime: "owner",
			localOnly: options.localOnly,
		});
		this.passes.set(conversation.id, conversation);
		return conversation;
	}

	/** The open pass `id`, if any. */
	get(id: string): HostedConversation | undefined {
		const conversation = this.passes.get(id);
		return conversation && !conversation.closed ? conversation : undefined;
	}

	/** Close a pass: its subscribers' subscriptions end, and its session is disposed. */
	async close(conversation: HostedConversation): Promise<void> {
		try {
			// No client joins a pass: its extensions never start, so no `session_shutdown`.
			await conversation.discard();
		} finally {
			if (this.passes.get(conversation.id) === conversation) this.passes.delete(conversation.id);
		}
	}

	/** Close every pass still open, as the session closes. Never rejects. */
	async closeAll(): Promise<void> {
		await Promise.allSettled([...this.passes.values()].map((conversation) => this.close(conversation)));
	}
}
