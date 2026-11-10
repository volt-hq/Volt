/**
 * The single context builder (RFC §4.3): the provider messages for the fold's
 * active branch are `applyReplayPolicy(convertToLlm(transformContext(messages)))`.
 * Model-dependent normalization stays in providers at request time.
 */

import { applyReplayPolicy, type Message } from "@hansjm10/volt-ai";
import type { AgentMessage, ThinkingLevel } from "../types.ts";
import type { ConversationState } from "./fold.ts";
import { isCoreLogEntry } from "./log.ts";

export interface BuildContextOptions {
	/** Rewrites the branch messages before conversion. It receives a copy it may change freely. */
	readonly transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Converts runtime messages to provider messages; drops each user message's `clientMessageId`. */
	readonly convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	readonly signal?: AbortSignal;
	/** Include request-only historical thinking selections for per-message effort. */
	readonly thinkingLevels?: boolean;
}

/** The provider messages for the fold's active branch. Never changes `state`. */
export async function buildContext(state: ConversationState, options: BuildContextOptions): Promise<Message[]> {
	const source = options.thinkingLevels ? withThinkingLevels(state) : [...state.context.messages];
	const messages = options.transformContext
		? await options.transformContext(structuredClone(source), options.signal)
		: source;
	return applyReplayPolicy(await options.convertToLlm(messages));
}

/**
 * Snapshot thinking at each input's position on the branch, before request hooks run.
 * Changes made during an assistant/tool loop wait for new input. The original log
 * and folded messages stay untouched, so this metadata never reaches persistence
 * or protocol clients. Forks/resume reconstruct it from the same public entries.
 */
export function withThinkingLevels(
	state: ConversationState,
	messages: readonly AgentMessage[] = state.context.messages,
): AgentMessage[] {
	let selected: ThinkingLevel = "off";
	let effective: ThinkingLevel = "off";
	let keptFrom = 0;
	let compacted = false;
	const inputs: { index: number; level: ThinkingLevel }[] = [];
	for (const [index, id] of state.branch.entries()) {
		const entry = state.tree.byId.get(id);
		if (!entry || !isCoreLogEntry(entry)) continue;
		if (entry.type === "thinking_level_change") {
			selected = entry.payload.thinkingLevel;
		} else if (entry.type === "compaction") {
			const kept = state.branch.indexOf(entry.payload.firstKeptEntryId);
			keptFrom = kept === -1 ? index : kept;
			compacted = true;
		} else if (
			entry.type === "message" ||
			entry.type === "custom_message" ||
			(entry.type === "branch_summary" && entry.payload.summary)
		) {
			// Only new input advances the effective level, never a tool result or an
			// assistant response recorded after a setting changed while it streamed.
			if (
				entry.type !== "message" ||
				(entry.payload.message.role !== "assistant" &&
					entry.payload.message.role !== "toolResult" &&
					!(entry.payload.message.role === "bashExecution" && entry.payload.message.excludeFromContext))
			) {
				effective = selected;
			}
			inputs.push({ index, level: effective });
		}
	}
	const retained = inputs.filter((input) => input.index >= keptFrom);
	const levels = retained.map((input) => input.level);
	// A split-turn summary stands in for the removed input. Seed it with the
	// retained turn's effective selection, not a newer setting awaiting input.
	if (compacted) levels.unshift(retained[0]?.level ?? effective);
	const byMessage = new Map(state.context.messages.map((message, index) => [message, levels[index]]));
	return messages.map((message) => {
		const thinkingLevel = byMessage.get(message);
		return thinkingLevel !== undefined && message.role !== "assistant" && message.role !== "toolResult"
			? { ...message, thinkingLevel }
			: message;
	});
}
