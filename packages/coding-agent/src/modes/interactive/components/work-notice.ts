/**
 * Notices of finished work in the transcript (RFC §7.1). A delivered result
 * is a `work_notice` message: the line naming the work, then its summary and
 * error, or the kind's own text, which renders as Markdown. The line naming
 * the work, the summary, and the error are data and stay literal. Notices
 * still queued for the next turn, and the end of work that delivers no
 * notice, show as one line each.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import type { ClientWorkItem, WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@hansjm10/volt-tui";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { workDisplayText, workTitle } from "./work-inspector.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

function messageText(content: CustomMessage<JsonValue>["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** A `work_notice` message in the transcript. */
export class WorkNoticeComponent extends Container {
	constructor(message: CustomMessage<JsonValue>, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		const label = theme.bg("customMessageBg", theme.fg("customMessageLabel", theme.bold(" work ")));
		this.addChild(new Text(label, 1, 0));
		const text = messageText(message.content);
		const details = workNoticeDetails(message.details);
		const own = details ? workNoticeOwnText(text, details) : undefined;
		if (!details || own === undefined) {
			// The host's own text names work by title and carries summaries: data, not Markdown.
			this.addChild(new Text(theme.fg("customMessageText", workDisplayText(text).trim()), 1, 0));
			return;
		}
		this.addChild(new Text(theme.fg("customMessageText", workDisplayText(noticeHeading(details))), 1, 0));
		// Markdown of the kind's own text, without terminal controls.
		this.addChild(
			new Markdown(workDisplayText(own), 1, 0, markdownTheme, {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);
	}
}

/** One line for a notice still queued for the next turn. */
export function queuedWorkNoticeLine(details: WorkNoticeDetails): string {
	return theme.fg("dim", `Notice for the next turn: ${workTitle(details)} ${details.outcome}`);
}

/** How finished work ended, as one status line: its summary or error when it has one. */
export function workOutcomeLine(item: ClientWorkItem): { readonly text: string; readonly warning: boolean } {
	const title = workTitle(item);
	if (item.outcome === "failed") {
		const error = item.error ? workDisplayText(item.error).split("\n")[0] : undefined;
		return { text: error ? `${title} failed: ${error}` : `${title} failed`, warning: true };
	}
	const summary = item.result?.summary ? workDisplayText(item.result.summary).split("\n")[0] : undefined;
	return {
		text: summary ? `${title} ${item.outcome}: ${summary}` : `${title} ${item.outcome ?? "ended"}`,
		warning: false,
	};
}
