/**
 * The TUI's session commands (architecture rewrite §10): what `/clear`,
 * `/resume`, `/fork`, `/clone`, `/tree`, `/name`, `/export`, `/import`,
 * `/compact`, `/reload`, and `/worktree` send, as intents and queries of the
 * TUI's protocol client, and what the session pickers, `/copy`, and
 * `/session` read of the conversation from the client fold.
 *
 * A command that moves the client resolves once the store shows the
 * conversation it moved to: the host answers `accepted{conversation}`, ends
 * the subscription `moved`, and the client subscribes to the target from a
 * snapshot. A session whose working directory is gone is rejected
 * `unavailable`; the TUI asks, then sends the intent again with a
 * `cwdOverride`.
 */

import type {
	ClientState,
	ConversationInfo,
	IntentInput,
	IntentOutput,
	LogMessage,
	ProjectedEntry,
	RpcSessionListItem,
} from "@hansjm10/volt-protocol";
import { isPublicProjectedEntryType } from "@hansjm10/volt-protocol";
import { ProtocolRejectedError } from "../../../client/protocol-client.ts";
import type { SessionSelectorItem } from "../components/session-selector.ts";
import type { EntryTreeNode } from "../components/tree-selector.ts";
import type { TuiStore } from "./tui-store.ts";

/** A structural intent's outcome: the conversation the client moved to, or cancelled. */
export type MoveOutcome = { readonly moved: true; readonly conversation: string } | { readonly moved: false };

/** A fork's outcome: the fork, with the text of the message it was taken before, or cancelled. */
export type ForkOutcome =
	| { readonly moved: true; readonly conversation: string; readonly text: string }
	| { readonly moved: false };

/** How many of each kind of message the conversation's log holds, on every branch. */
export interface MessageStats {
	readonly user: number;
	readonly assistant: number;
	readonly toolCalls: number;
	readonly toolResults: number;
	/** Every message and custom message. */
	readonly total: number;
}

/** Where `/tree` moves the active branch to, and what it does with the branch it leaves. */
export interface NavigateOptions {
	readonly summarize: boolean;
	readonly customInstructions?: string;
}

/** A tree navigation's outcome, as the `navigate_tree` intent answers it. */
export type NavigateOutcome = IntentOutput<"navigate_tree">;

/** Whether `error` is a rejection that names a session whose working directory is gone. */
export function isMissingCwd(error: unknown): error is ProtocolRejectedError {
	return error instanceof ProtocolRejectedError && error.reason.code === "unavailable";
}

/** The text blocks of a message's content, joined. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && "type" in block && block.type === "text" && "text" in block) {
			text += block.text;
		}
	}
	return text;
}

function messageOf(entry: ProjectedEntry): LogMessage | undefined {
	return entry.type === "message" ? entry.payload?.message : undefined;
}

/** The user messages a fork can be taken before, on every branch, oldest first. */
export function forkableMessages(state: ClientState): Array<{ readonly entryId: string; readonly text: string }> {
	const messages: Array<{ entryId: string; text: string }> = [];
	for (const entry of state.entries) {
		const message = messageOf(entry);
		if (message?.role !== "user") continue;
		const text = textOf(message.content);
		if (text) messages.push({ entryId: entry.id, text });
	}
	return messages;
}

/** The text of the transcript's last assistant message, skipping an aborted one that said nothing. */
export function lastAssistantText(transcript: readonly ProjectedEntry[]): string | undefined {
	for (let index = transcript.length - 1; index >= 0; index--) {
		const entry = transcript[index];
		const message = entry === undefined ? undefined : messageOf(entry);
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" && message.content.length === 0) continue;
		return textOf(message.content).trim() || undefined;
	}
	return undefined;
}

/** How many messages of each kind the log holds, on every branch. */
export function messageStats(state: ClientState): MessageStats {
	let user = 0;
	let assistant = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let total = 0;
	for (const entry of state.entries) {
		if (entry.type === "custom_message") total++;
		const message = messageOf(entry);
		if (!message) continue;
		total++;
		if (message.role === "user") user++;
		else if (message.role === "toolResult") toolResults++;
		else if (message.role === "assistant") {
			assistant++;
			toolCalls += message.content.filter((block) => block.type === "toolCall").length;
		}
	}
	return { user, assistant, toolCalls, toolResults, total };
}

/**
 * The conversation's entry tree as the client fold holds it: its public
 * entries by parent, each with its label, children oldest first. An entry
 * whose parent the client does not hold is a root.
 */
export function entryTree(state: ClientState): EntryTreeNode[] {
	const nodes = new Map<string, EntryTreeNode>();
	const entries = state.entries.filter((entry) => isPublicProjectedEntryType(entry.type));
	for (const entry of entries) {
		const label = state.labels.get(entry.id);
		nodes.set(entry.id, {
			entry,
			children: [],
			...(label === undefined ? {} : { label: label.label, labelTimestamp: label.timestamp }),
		});
	}
	const roots: EntryTreeNode[] = [];
	for (const entry of entries) {
		const node = nodes.get(entry.id);
		if (!node) continue;
		const parent = entry.parentId === null || entry.parentId === entry.id ? undefined : nodes.get(entry.parentId);
		if (parent) parent.children.push(node);
		else roots.push(node);
	}
	const time = (node: EntryTreeNode): number => new Date(node.entry.timestamp).getTime();
	for (const node of nodes.values()) node.children.sort((left, right) => time(left) - time(right));
	return roots;
}

/** A stored session as the session picker lists it. */
export function sessionItem(session: RpcSessionListItem): SessionSelectorItem {
	return {
		key: session.sessionId,
		id: session.sessionId,
		...(session.sessionName === undefined ? {} : { name: session.sessionName }),
		cwd: session.cwd ?? "",
		created: new Date(session.createdAt),
		modified: new Date(session.modifiedAt),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
		...(session.parentSessionId === undefined ? {} : { parentKey: session.parentSessionId }),
		...(session.sessionDir === undefined ? {} : { location: session.sessionDir }),
	};
}

export class TuiSessions {
	private readonly store: TuiStore;

	constructor(store: TuiStore) {
		this.store = store;
	}

	/** Where the conversation's log lives, and its working directory. */
	info(): Promise<ConversationInfo> {
		return this.store.client.query("conversation_info");
	}

	/** The stored sessions of the conversation's workspace, or with `all` of every session directory; searched. */
	async list(scope: "workspace" | "all", search?: string): Promise<RpcSessionListItem[]> {
		const trimmed = search?.trim();
		const { sessions } = await this.store.client.query("sessions", {
			...(scope === "all" ? { scope } : {}),
			...(trimmed ? { search: trimmed } : {}),
		});
		return sessions;
	}

	/** Start a new session. */
	newSession(): Promise<MoveOutcome> {
		return this.move("new_session", {});
	}

	/** Start a new session in another existing directory, such as a worktree checkout, of the workspace and base ref named. */
	newSessionIn(location: {
		readonly cwd: string;
		readonly workspaceName?: string;
		readonly baseRef?: string;
	}): Promise<MoveOutcome> {
		return this.move("new_session", location);
	}

	/** Open the stored session `sessionId`, in `cwdOverride` when its own working directory is gone. */
	switchTo(sessionId: string, cwdOverride?: string): Promise<MoveOutcome> {
		return this.move("switch_session", { sessionId, ...(cwdOverride === undefined ? {} : { cwdOverride }) });
	}

	/** Continue in a new session from before the user message `entryId`. */
	async fork(entryId: string): Promise<ForkOutcome> {
		const accepted = await this.store.client.intent("fork", { entryId });
		if (accepted.conversation === undefined) return { moved: false };
		await this.store.showing(accepted.conversation);
		const result = accepted.result;
		return {
			moved: true,
			conversation: accepted.conversation,
			text: result !== undefined && "text" in result ? result.text : "",
		};
	}

	/** Duplicate the session at its current position. */
	clone(): Promise<MoveOutcome> {
		return this.move("clone", {});
	}

	/** Import a JSONL session file as a new session, in `cwdOverride` when its working directory is gone. */
	importSession(path: string, cwdOverride?: string): Promise<MoveOutcome> {
		return this.move("import_session", { path, ...(cwdOverride === undefined ? {} : { cwdOverride }) });
	}

	/** Write the session as HTML, or with a `.jsonl` path its active branch as JSONL; resolves the file written. */
	async exportTo(outputPath?: string): Promise<string> {
		const output = outputPath === undefined ? {} : { outputPath };
		const accepted = outputPath?.endsWith(".jsonl")
			? await this.store.client.intent("export_jsonl", output)
			: await this.store.client.intent("export_html", output);
		const path = accepted.result?.path;
		if (path === undefined) throw new Error("The host wrote no file");
		return path;
	}

	/** Delete the stored session `sessionId`; `trashed` when its recovery snapshot went to the system trash. */
	async deleteSession(sessionId: string): Promise<{ readonly trashed: boolean }> {
		return { trashed: (await this.store.client.intent("delete_session", { sessionId })).result?.trashed === true };
	}

	/** Name the session, or the stored session `sessionId`. */
	async rename(name: string, sessionId?: string): Promise<void> {
		await this.store.client.intent("set_session_name", { name, ...(sessionId === undefined ? {} : { sessionId }) });
	}

	/** Move the active branch to `entryId`, summarizing the branch it leaves when asked. */
	async navigate(entryId: string, options: NavigateOptions): Promise<NavigateOutcome> {
		const accepted = await this.store.client.intent("navigate_tree", {
			entryId,
			summarize: options.summarize,
			...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
		});
		return accepted.result ?? { cancelled: false };
	}

	/** Bookmark `entryId`, or remove its label. */
	async label(entryId: string, label: string | undefined): Promise<void> {
		await this.store.client.intent("set_label", { entryId, label: label ?? null });
	}

	/** Summarize the conversation's context; resolves once the compaction ended. */
	async compact(customInstructions?: string): Promise<void> {
		await this.store.client.intent("compact", customInstructions === undefined ? {} : { customInstructions });
	}

	/** Reload the conversation's extensions, skills, prompts, themes, and settings. */
	async reload(): Promise<void> {
		await this.store.client.intent("reload");
	}

	/** Send a structural intent; resolves once the store shows the conversation it moved the client to. */
	private async move<N extends "new_session" | "switch_session" | "clone" | "import_session">(
		name: N,
		input: IntentInput<N>,
	): Promise<MoveOutcome> {
		const accepted = await this.store.client.intent(name, input);
		if (accepted.conversation === undefined) return { moved: false };
		await this.store.showing(accepted.conversation);
		return { moved: true, conversation: accepted.conversation };
	}
}
