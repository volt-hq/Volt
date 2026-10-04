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

/** How a client follows a move to another conversation. */
export type HostClientMove =
	| {
			/** The same client continues on the new conversation. */
			readonly kind: "in_place";
			onMoved(to: HostedConversation, from: HostedConversation | undefined): Promise<void> | void;
	  }
	| {
			/** The client is told to reconnect to the new conversation and leaves this host's registry. */
			readonly kind: "redirect";
			redirect(sessionId: string): Promise<void> | void;
	  };

/** A client of hosted conversations: a TUI view, an RPC connection, a phone stream, a print run. */
export interface HostClient {
	/** Matches the client scope the client's requests run in. */
	readonly id: string;
	/** A conversation closes when its anchor leaves, whatever other clients remain. */
	readonly anchor?: boolean;
	/** The client's surface on each conversation's extensions, attached whenever the client joins one. */
	readonly surface?: Omit<ExtensionClient, "id">;
	readonly move: HostClientMove;
}
