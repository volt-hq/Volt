/**
 * The host's own custom message types and their presenters (RFC §8.3): a
 * finished work item's notice (`work_notice`) and a review's result
 * (`review`) present as `UiNode` data on every client, as an extension's
 * message presenter would. The host's types are its own: an extension cannot
 * register a presenter for one, so no extension restyles what the host says.
 * Host messages without a presenter here show as their text.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import { type UiNode, WORK_NOTICE_CUSTOM_TYPE, type WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { PLAN_CHECKPOINT_CUSTOM_TYPE, PLAN_EXECUTION_CUSTOM_TYPE } from "../planning.ts";
import { formatReviewUsage } from "../review-presentation.ts";
import type { MessagePresenter, MessagePresentInput } from "./presentation.ts";

/** The custom type of the notice offering a conversation's subagent runs suspended since a restart. */
export const SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE = "subagent_recovery";
/** The custom type of a review's accounting and result messages. */
export const REVIEW_CUSTOM_TYPE = "review";

/** The custom message types the host sends: extensions cannot present them. */
export const HOST_CUSTOM_MESSAGE_TYPES: ReadonlySet<string> = new Set([
	WORK_NOTICE_CUSTOM_TYPE,
	REVIEW_CUSTOM_TYPE,
	SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
	PLAN_CHECKPOINT_CUSTOM_TYPE,
	PLAN_EXECUTION_CUSTOM_TYPE,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A custom message's text blocks, joined. */
function messageText(content: MessagePresentInput["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

// ============================================================================
// Work notices
// ============================================================================

/** A notice's details, when they describe its work. */
export function workNoticeDetails(details: unknown): WorkNoticeDetails | undefined {
	if (!isRecord(details)) return undefined;
	const { workId, kind, title, outcome } = details;
	return typeof workId === "string" &&
		typeof kind === "string" &&
		typeof title === "string" &&
		(outcome === "completed" || outcome === "failed")
		? (details as unknown as WorkNoticeDetails)
		: undefined;
}

/** The line naming a notice's work, as the host writes it first. */
function noticeHeading(details: WorkNoticeDetails): string {
	return `${details.title} (${details.kind} ${details.workId}) ${details.outcome}.`;
}

/** A notice's text as the host writes it without the kind's own: the heading, then the summary and error. */
function defaultNoticeText(details: WorkNoticeDetails): string {
	return [
		noticeHeading(details),
		...(details.summary ? [details.summary] : []),
		...(details.error ? [`Error: ${details.error}`] : []),
	].join("\n");
}

/**
 * The kind's own text of a notice: what follows the heading when the notice
 * is not the host's default text; undefined for a default notice.
 */
export function workNoticeOwnText(text: string, details: WorkNoticeDetails): string | undefined {
	if (text === defaultNoticeText(details)) return undefined;
	const heading = noticeHeading(details);
	if (!text.startsWith(`${heading}\n`)) return undefined;
	const own = text.slice(heading.length + 1);
	return own.trim() ? own : undefined;
}

/**
 * A `work_notice`: the line naming the work, then its summary and error, or
 * the kind's own text as Markdown. The line naming the work, the summary, and
 * the error are data and stay literal text.
 */
export const presentWorkNotice: MessagePresenter = (message) => {
	const text = messageText(message.content);
	const details = workNoticeDetails(message.details);
	const own = details === undefined ? undefined : workNoticeOwnText(text, details);
	const title = [{ text: "work", bold: true, token: "accent" as const }];
	if (details === undefined || own === undefined) {
		return { title, body: [{ type: "text", key: "text", text: text.trim() }] };
	}
	return {
		title,
		body: [
			{ type: "text", key: "heading", text: noticeHeading(details) },
			{ type: "markdown", key: "text", markdown: own },
		],
	};
};

// ============================================================================
// Reviews
// ============================================================================

/**
 * A review's message: collapsed, the compact summary its details carry and
 * its accounting; expanded, the full result and every pass's accounting. A
 * review message without a summary shows its text.
 */
export const presentReview: MessagePresenter = (message) => {
	const text = messageText(message.content);
	const details = isRecord(message.details) ? message.details : undefined;
	const summary = typeof details?.summary === "string" ? details.summary : undefined;
	if (summary === undefined) return { body: [{ type: "markdown", key: "text", markdown: text }] };
	const usage = (expanded: boolean): UiNode => ({
		type: "markdown",
		key: "usage",
		markdown: formatReviewUsage(details?.usage as JsonValue | undefined, expanded),
	});
	return {
		summary: [{ type: "markdown", key: "text", markdown: summary }, usage(false)],
		body: [{ type: "markdown", key: "text", markdown: text }, usage(true)],
	};
};

/** The host's message presenters, by custom type. */
export const BUILTIN_MESSAGE_PRESENTERS: ReadonlyMap<string, MessagePresenter> = new Map([
	[WORK_NOTICE_CUSTOM_TYPE, presentWorkNotice],
	[REVIEW_CUSTOM_TYPE, presentReview],
]);
