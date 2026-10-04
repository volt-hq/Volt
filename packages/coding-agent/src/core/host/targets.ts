/**
 * What a `ConversationHost` opens, and the clients that attach to what it
 * opened. A conversation serves one log for its whole life: a new, resumed,
 * forked, cloned, or imported conversation is another conversation, and a
 * client moves to it.
 */

import type { ExtensionClient } from "../session/extension-binding.ts";
import type { SessionManager, SessionReference } from "../session-manager.ts";
import type { LogWriter } from "../session-writer.ts";
import type { HostedConversation } from "./hosted-conversation.ts";
import type { LiveClient } from "./live-state.ts";

/** A new log. Without a source it is stored; with one it follows the source's storage. */
export interface NewConversationTarget {
	readonly kind: "new";
	/** Working directory; the source's by default. */
	readonly cwd?: string;
	/** Session directory of the stored log; the source's by default. */
	readonly sessionDir?: string;
	/** The conversation id; minted when omitted. */
	readonly id?: string;
	/** Recorded as the new log's parent session. */
	readonly parentSessionRef?: SessionReference;
	/** Whether the log is stored. */
	readonly persist?: boolean;
	/** Host-owned workspace display name for the Git context. */
	readonly workspaceName?: string;
	/** Managed-worktree base ref for the Git context. */
	readonly baseRef?: string;
	/** Write the log before the conversation opens, through its writer. */
	readonly seed?: (writer: LogWriter) => Promise<void>;
}

/** A stored log, resumed. */
export interface SessionConversationTarget {
	readonly kind: "session";
	readonly ref: SessionReference;
	/** Run in this cwd instead of the stored one, which the store keeps. */
	readonly cwdOverride?: string;
}

/**
 * A copy of an open conversation's branch: before a user message (its branch
 * up to that message's parent, the message text returned as `selectedText`)
 * or at an entry. A clone is a fork at the leaf.
 */
export interface ForkConversationTarget {
	readonly kind: "fork";
	readonly source: HostedConversation;
	readonly entryId: string;
	readonly position: "before" | "at";
}

/** A JSONL session snapshot, imported into a new log. */
export interface ImportConversationTarget {
	readonly kind: "import";
	readonly path: string;
	/** Run in this cwd instead of the snapshot's. */
	readonly cwdOverride?: string;
	/** The imported conversation's id; minted when omitted. */
	readonly id?: string;
	/** Session directory of the stored log; the source's by default. */
	readonly sessionDir?: string;
}

/** A log already opened by the caller, such as the one selected at startup. The host owns it from the call. */
export interface AdoptConversationTarget {
	readonly kind: "adopt";
	readonly sessionManager: SessionManager;
	/** Working directory; the log's by default. */
	readonly cwd?: string;
}

export type ConversationTarget =
	| NewConversationTarget
	| SessionConversationTarget
	| ForkConversationTarget
	| ImportConversationTarget
	| AdoptConversationTarget;

/**
 * The conversation a redirect client's structural intent leads it to, opened
 * in the client's host: see `HostClientMove` `hostTarget`.
 */
export interface RedirectTarget {
	readonly sessionId: string;
	/**
	 * The conversation the intent opened in the client's host, which the callee
	 * takes over; absent for a switch to a stored conversation, which opens
	 * wherever the client reconnects.
	 */
	readonly conversation?: HostedConversation;
}

/**
 * A redirect target a host took: prepared before the move writes anything
 * through the source, committed once those writes are done, or aborted.
 */
export interface HostedRedirect {
	/** Make the target the client's to reconnect to. A failure keeps the client where it was. */
	commit(): Promise<void>;
	/** Release what was prepared for a target that will not be used. */
	abort(): Promise<void>;
}

/** How a client follows a move to another conversation. */
export type HostClientMove =
	| {
			/** The same client continues on the new conversation. */
			readonly kind: "in_place";
			/**
			 * Runs once the client left `from`, before it joins `to` and `to`'s
			 * extensions start: the client points its own state at `to`. When the
			 * client cannot join `to`, it runs again with the conversations
			 * swapped as the client returns to `from`, followed by `onMoved`.
			 */
			prepare?(to: HostedConversation, from: HostedConversation | undefined): void;
			/** Runs once the client joined `to`, before `from` closes. */
			onMoved(to: HostedConversation, from: HostedConversation | undefined): Promise<void> | void;
	  }
	| {
			/** The client is told to reconnect to the new conversation and leaves this host's registry. */
			readonly kind: "redirect";
			redirect(sessionId: string): Promise<void> | void;
			/**
			 * Host the conversations the client's structural intents lead it to,
			 * before the client is redirected there. A new, forked, or imported
			 * conversation opens in this host, which need not fence the source
			 * while other clients keep it open; a switch opens nothing. The
			 * callee prepares the target before the move writes through the
			 * source (a handoff) and commits it after; a failure keeps the client
			 * where it was and discards what opened. Without it, the target's log
			 * is written and closed for the host the client reconnects through.
			 */
			readonly hostTarget?: (target: RedirectTarget) => Promise<HostedRedirect>;
	  };

/** A client of hosted conversations: a TUI view, an RPC connection, a phone stream, a print run. */
export interface HostClient {
	/** Matches the client scope the client's requests run in. */
	readonly id: string;
	/** A conversation closes when its anchor leaves, whatever other clients remain. */
	readonly anchor?: boolean;
	/**
	 * The client's surface on each conversation's extensions, attached whenever
	 * the client joins one. The host binds the extensions in its own mode.
	 */
	readonly surface?: Omit<ExtensionClient, "id" | "mode">;
	/**
	 * The client's view of each conversation's live state (extension status,
	 * widgets, and title, notices, dialogs, approvals, MCP authorization),
	 * attached whenever the client joins one, before its surface binds the
	 * extensions. The client answers the host requests it accepts through the
	 * conversation's `liveState` under its id.
	 */
	readonly live?: LiveClient;
	/**
	 * Whether an in-place client replays the durable queued input of each
	 * conversation it moves to, before anything it runs there afterwards.
	 */
	readonly recoversInput?: boolean;
	readonly move: HostClientMove;
}
