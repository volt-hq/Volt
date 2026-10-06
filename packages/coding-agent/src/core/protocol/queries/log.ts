/**
 * Reads of the projected log (RFC §6.1 as amended): `history` pages older
 * projected entries, and `content` returns one content part of an entry in
 * full. Both read only entries the subscriber's profile projects, and project
 * them exactly as the subscription does: an open conversation's log through
 * its runtime, a closed child's log read without one, as its snapshot is.
 */

import { CONTENT_TEXT_MAX_SCALARS, type ProjectedEntry, type QueryResult } from "@hansjm10/volt-protocol";
import type { CommittedSessionEntry, SessionManager } from "../../session-manager.ts";
import { targetOf } from "../intents/conversation.ts";
import type { IntentContext } from "../intents/types.ts";
import type { Profile } from "../profiles.ts";
import {
	conversationProjectionSource,
	type ProjectionSource,
	projectEntry,
	sessionProjectionSource,
} from "../projection/entries.ts";
import { transcriptWorkNoticeText } from "../projection/transcript.ts";
import { defineQuery, QueryRejectedError } from "./types.ts";

const observe = ["conversation.observe.v1"] as const;

type ContentPart =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "image"; readonly mimeType: string; readonly data: string };

function subscriberOf(ctx: IntentContext, query: string): Profile {
	if (!ctx.subscriber) throw new QueryRejectedError("unavailable", `${query} is read through a protocol subscription`);
	return ctx.subscriber;
}

/** The log a read reads and what its entries present with: a closed child's, or the target conversation's. */
function logOf(ctx: IntentContext): { readonly sessionManager: SessionManager; readonly source: ProjectionSource } {
	if (ctx.closedLog) return { sessionManager: ctx.closedLog, source: sessionProjectionSource(ctx.closedLog) };
	const session = targetOf(ctx).conversation.session;
	return { sessionManager: session.sessionManager, source: conversationProjectionSource(session) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text, thinking, and image blocks of message content, in order. */
function blockParts(content: unknown): ContentPart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const parts: ContentPart[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push({ type: "text", text: block.text });
		else if (block.type === "thinking" && typeof block.thinking === "string") {
			parts.push({ type: "text", text: block.thinking });
		} else if (
			block.type === "image" &&
			typeof block.data === "string" &&
			block.data.length > 0 &&
			typeof block.mimeType === "string"
		) {
			parts.push({ type: "image", mimeType: block.mimeType, data: block.data });
		}
	}
	return parts;
}

/** The content parts of an entry. */
function contentParts(entry: CommittedSessionEntry): ContentPart[] {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (message.role === "bashExecution") return [{ type: "text", text: message.output }];
			return "content" in message ? blockParts(message.content) : [];
		}
		case "custom_message":
			return blockParts(entry.content);
		case "compaction":
		case "branch_summary":
			return [{ type: "text", text: entry.summary }];
		default:
			return [];
	}
}

export const historyQuery = defineQuery({
	name: "history",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	closedLogs: true,
	async run(ctx, params) {
		const profile = subscriberOf(ctx, "history");
		const { sessionManager, source } = logOf(ctx);
		const before = Math.min(params.before, sessionManager.getOrdinal() + 1);
		const newestFirst: ProjectedEntry[] = [];
		let earlier = false;
		const take = (entry: CommittedSessionEntry): boolean => {
			if (entry.ordinal >= before) return true;
			const projected = projectEntry(entry, source, profile);
			if (!projected) return true;
			if (newestFirst.length === params.limit) {
				earlier = true;
				return false;
			}
			newestFirst.push(projected);
			return true;
		};
		if (params.branch === undefined) {
			const entries = sessionManager.committedEntriesAfter(0, before - 1);
			for (let index = entries.length - 1; index >= 0 && take(entries[index]!); index--);
		} else {
			const start = sessionManager.getCommittedEntry(params.branch);
			if (!start || !profile.includes(start)) {
				throw new QueryRejectedError("invalid_input", `Unknown entry: ${params.branch}`);
			}
			const seen = new Set<string>();
			for (let entry: CommittedSessionEntry | undefined = start; entry && !seen.has(entry.id); ) {
				seen.add(entry.id);
				if (!take(entry)) break;
				entry = entry.parentId === null ? undefined : sessionManager.getCommittedEntry(entry.parentId);
			}
		}
		return { entries: newestFirst.reverse(), earlier } satisfies QueryResult<"history">;
	},
});

export const contentQuery = defineQuery({
	name: "content",
	scope: "conversation",
	remote: "safe",
	requires: observe,
	closedLogs: true,
	async run(ctx, params) {
		const profile = subscriberOf(ctx, "content");
		const { sessionManager } = logOf(ctx);
		const entry = sessionManager.getCommittedEntry(params.entryId);
		if (!entry || !profile.includes(entry)) {
			throw new QueryRejectedError("invalid_input", `Unknown entry: ${params.entryId}`);
		}
		// A work notice's content is its view's text, as the subscription projects it.
		const notice = transcriptWorkNoticeText(entry, profile);
		const parts: ContentPart[] =
			notice === undefined ? contentParts(profile.source(entry)) : [{ type: "text", text: notice }];
		const index = params.part ?? 0;
		const part = parts[index];
		if (!part) throw new QueryRejectedError("invalid_input", `Entry ${params.entryId} has no content part ${index}`);
		if (part.type === "image") {
			return { entryId: entry.id, part: index, parts: parts.length, content: part } satisfies QueryResult<"content">;
		}
		const scalars = Array.from(part.text);
		const offset = Math.min(params.offset ?? 0, scalars.length);
		const end = Math.min(scalars.length, offset + CONTENT_TEXT_MAX_SCALARS);
		return {
			entryId: entry.id,
			part: index,
			parts: parts.length,
			content: {
				type: "text",
				text: scalars.slice(offset, end).join(""),
				offset,
				nextOffset: end < scalars.length ? end : null,
				totalScalars: scalars.length,
			},
		} satisfies QueryResult<"content">;
	},
});
