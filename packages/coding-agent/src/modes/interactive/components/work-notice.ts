/**
 * Work notices outside the transcript (RFC §7.1): notices still queued for
 * the next turn, and the end of work that delivers no notice, show as one
 * line each. Delivered notices are `work_notice` messages, which present
 * with the host's message presenter (core/ui/message-presenters.ts).
 */

import type { ClientWorkItem, WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { theme } from "../../../core/theme/runtime.ts";
import { workDisplayText, workTitle } from "./work-inspector.ts";

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
