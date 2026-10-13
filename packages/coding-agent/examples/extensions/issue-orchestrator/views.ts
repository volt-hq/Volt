/**
 * What the orchestrator shows of its issues: a row per issue, saying what it
 * is doing with it and why, those that need someone first (running, handed
 * to a human, ready to merge, retrying, waiting, then finished ones).
 *
 * - The panel is a card with a table of them. It stays within the 12 rows a
 *   terminal panel shows, so its actions stay in view; the rows that do not
 *   fit are counted.
 * - The work item's progress lists them as steps, which `/work` shows full
 *   screen above the orchestrator's log. They stay within what a live work
 *   value holds.
 * - Notes in the conversation link to an issue or pull request a human may
 *   want to follow: when the orchestrator picks an issue up, when the issue
 *   gets its pull request, and when it is handed to a human. The work's log
 *   carries the same links, under the issues in `/work`.
 */

import { Buffer } from "node:buffer";
import type { ExtensionPanel } from "@hansjm10/volt-coding-agent";
import type { UiNode, UiNodeAction, UiNodeStyledText, UiNodeToken, WorkProgressStep } from "@hansjm10/volt-protocol";
import type { OrchestratorEvent, OrchestratorSnapshot } from "./orchestrator.ts";
import type { Role } from "./workflow.ts";

/** Issue rows the panel shows: with the card's border, the table's header, and the actions, 12 rows. */
const MAX_PANEL_ROWS = 6;
/** Running issues that get an Open action. */
const MAX_OPEN_ACTIONS = 4;
/** Longest error the panel shows: two rows of a 60-column terminal. `/orchestrate status` says all of it. */
const ERROR_MAX_CHARS = 100;
/** Issue steps the work's progress lists at most, the one counting the rest included. */
const MAX_STEPS = 30;
/** Bytes of steps at most: a live work value holds 8 KB, with the progress text and framing. */
const STEPS_MAX_BYTES = 5_000;
const STEP_TITLE_MAX_CHARS = 72;
const STEP_LABEL_MAX_CHARS = 180;

/** What a role does to a pull request, for a note. */
const DOING_TO_PR: Readonly<Record<Exclude<Role, "implement">, string>> = {
	review: "reviewing",
	fix: "fixing",
	update: "updating",
	triage: "triaging",
};

const DOING: Readonly<Record<Role, string>> = {
	implement: "implementing",
	review: "reviewing",
	fix: "fixing",
	update: "updating",
	triage: "triaging",
};

interface Row {
	readonly issue: number;
	readonly title: string;
	/** What the rows past the room are counted as, such as "waiting". */
	readonly group: string;
	readonly glyph: string;
	readonly state: string;
	readonly token: UiNodeToken;
	readonly step: WorkProgressStep["status"];
	readonly detail: string;
}

/** `count` and `noun`, with the noun in the plural unless the count is one. */
function counted(count: number, noun: string, plural = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : plural}`;
}

/** `text`, cut to `max` characters with an ellipsis. */
function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How long since `since`, in whole minutes: `<1m`, `23m`, `1h 05m`. */
function elapsed(since: number, now: number): string {
	const minutes = Math.floor(Math.max(0, now - since) / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function rowsOf(snapshot: OrchestratorSnapshot, now: number): Row[] {
	const rows: Row[] = [
		...snapshot.running.map((run) => ({
			issue: run.issue,
			title: run.title,
			group: "running",
			glyph: "●",
			state: DOING[run.role],
			token: "accent" as const,
			step: "active" as const,
			detail: run.runId === undefined ? "setting up its checkout" : `for ${elapsed(run.startedAt, now)}`,
		})),
		...snapshot.handedOff
			.filter((issue) => !issue.ready)
			.map((issue) => ({
				...issue,
				group: "needing you",
				glyph: "▲",
				state: "needs you",
				token: "warning" as const,
				step: "failed" as const,
				detail: issue.reason,
			})),
		...snapshot.handedOff
			.filter((issue) => issue.ready)
			.map((issue) => ({
				...issue,
				group: "ready",
				glyph: "✓",
				state: "ready to merge",
				token: "success" as const,
				step: "done" as const,
				detail: issue.reason,
			})),
		...snapshot.retrying.map((retry) => ({
			...retry,
			group: "retrying",
			glyph: "↻",
			state: "retrying",
			token: "warning" as const,
			step: "pending" as const,
			detail: `${counted(retry.failures, "failure")}: ${retry.error}`,
		})),
		...snapshot.waiting.map((issue) => ({
			...issue,
			group: "waiting",
			glyph: "○",
			state: "waiting",
			token: "muted" as const,
			step: "pending" as const,
			detail: issue.reason,
		})),
		...snapshot.finished.map((issue) => ({
			...issue,
			group: "done",
			glyph: "✓",
			state: "done",
			token: "muted" as const,
			step: "done" as const,
			detail: issue.reason,
		})),
	];
	// An issue shows once, in its first group: one waiting for a slot may also be due a retry.
	const seen = new Set<number>();
	return rows.filter((row) => !seen.has(row.issue) && seen.add(row.issue));
}

/** What the rows past the room are: `+3 more: 1 waiting, 2 done`. */
function overflow(rows: readonly Row[]): string {
	const groups = new Map<string, number>();
	for (const row of rows) groups.set(row.group, (groups.get(row.group) ?? 0) + 1);
	const parts = [...groups].map(([group, count]) => `${count} ${group}`);
	return `+${rows.length} more: ${parts.join(", ")}`;
}

function issueCell(row: Row): UiNodeStyledText {
	return [
		{ text: `#${row.issue}`, token: "accent" },
		{ text: ` ${row.title}`, ...(row.group === "done" ? { token: "muted" as const } : {}) },
	];
}

/**
 * The status panel of `snapshot` at `now`. `command` is the intent type of
 * the extension's `/orchestrate` command, which the Refresh and Stop actions
 * send.
 */
export function panel(snapshot: OrchestratorSnapshot, command: string, now = Date.now()): ExtensionPanel {
	const rows = rowsOf(snapshot, now);
	const children: UiNode[] = [];
	let room = MAX_PANEL_ROWS;
	if (snapshot.error) {
		children.push({
			type: "text",
			key: "error",
			text: [{ text: `✗ ${clip(snapshot.error, ERROR_MAX_CHARS)}`, token: "error" }],
		});
		// It may wrap.
		room -= 2;
	}
	if (rows.length === 0) {
		children.push({ type: "text", key: "idle", text: "No labeled issues need work.", token: "muted" });
	} else {
		const shown = rows.length > room ? rows.slice(0, room - 1) : rows;
		const hidden = rows.slice(shown.length);
		children.push({
			type: "table",
			key: "issues",
			columns: [{ header: "Issue" }, { header: "Status" }, { header: "Detail" }],
			rows: shown.map((row) => ({
				key: String(row.issue),
				cells: [
					issueCell(row),
					[{ text: `${row.glyph} ${row.state}`, token: row.token }],
					[{ text: row.detail, token: "muted" }],
				],
			})),
		});
		if (hidden.length > 0) children.push({ type: "text", key: "more", text: overflow(hidden), token: "muted" });
	}

	const stuck = snapshot.handedOff.filter((issue) => !issue.ready).length;
	const ready = snapshot.handedOff.length - stuck;
	const actions: UiNodeAction[] = [
		...snapshot.running.flatMap((run) =>
			run.runId === undefined
				? []
				: [
						{
							id: `open-${run.issue}`,
							label: `Open #${run.issue}`,
							intent: { type: "open_work", input: { workId: run.runId } },
						},
					],
		),
	].slice(0, MAX_OPEN_ACTIONS);
	actions.push(
		{ id: "refresh", label: "Refresh", intent: { type: command, input: { arguments: "refresh" } } },
		{ id: "stop", label: "Stop", destructive: true, intent: { type: command, input: { arguments: "stop" } } },
	);
	return {
		node: {
			type: "card",
			key: "orchestrator",
			title: snapshot.repo === undefined ? "Issue orchestrator" : `Issue orchestrator · ${snapshot.repo}`,
			badges: [
				{ label: `${snapshot.running.length} running`, token: snapshot.running.length > 0 ? "accent" : "muted" },
				...(stuck > 0
					? [{ label: `${stuck} ${stuck === 1 ? "needs" : "need"} you`, token: "warning" as const }]
					: []),
				...(ready > 0 ? [{ label: `${ready} ready`, token: "success" as const }] : []),
				{ label: `$${snapshot.totals.cost.toFixed(2)}`, token: "muted" },
			],
			sections: [{ key: "issues", children }],
			actions,
		},
	};
}

/**
 * The issues of `snapshot` at `now` as work progress steps, one each:
 * `#812 Title · implementing · for 23m`, its status in the step's icon. The
 * ones past the room are counted in a last step.
 */
export function issueSteps(snapshot: OrchestratorSnapshot, now = Date.now()): WorkProgressStep[] {
	const rows = rowsOf(snapshot, now);
	const steps: WorkProgressStep[] = [];
	let bytes = 0;
	for (const [index, row] of rows.entries()) {
		const label = `#${row.issue} ${clip(row.title, STEP_TITLE_MAX_CHARS)} · ${row.state}${row.detail ? ` · ${row.detail}` : ""}`;
		const step: WorkProgressStep = {
			key: String(row.issue),
			label: clip(label, STEP_LABEL_MAX_CHARS),
			status: row.step,
		};
		bytes += Buffer.byteLength(JSON.stringify(step));
		const last = index === rows.length - 1;
		if (bytes > STEPS_MAX_BYTES || (!last && steps.length === MAX_STEPS - 1)) {
			steps.push({ key: "more", label: overflow(rows.slice(index)), status: "pending" });
			break;
		}
		steps.push(step);
	}
	return steps;
}

/** `text` on one line as literal Markdown: every ASCII punctuation character escaped, so it adds no links or formatting. */
function literal(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[!-/:-@[-`{-~]/g, "\\$&");
}

/** `url` when it is a plain http(s) address, which Markdown shows as a link. */
function linkable(url: string): string | undefined {
	return /^https?:\/\/[^\s<>()[\]]+$/.test(url) ? url : undefined;
}

/**
 * The Markdown note of `event`: what happened, then the link on its own line,
 * which renders as a clickable link, or as the address a terminal opens where
 * it shows no links.
 */
export function noteText(event: OrchestratorEvent): string {
	const issue = `**\\#${event.issue.number}** ${literal(event.issue.title)}`;
	let text: string;
	let url: string;
	switch (event.kind) {
		case "picked_up":
			if (event.role === "implement" || event.pr === undefined) {
				text = `Picked up ${issue}: ${DOING[event.role]} it.`;
				url = event.issue.url;
			} else {
				text = `Picked up ${issue}: ${DOING_TO_PR[event.role]} pull request \\#${event.pr.number}.`;
				url = event.pr.url;
			}
			break;
		case "pr_opened":
			text = `${issue}: pull request \\#${event.pr.number} is open.`;
			url = event.pr.url;
			break;
		case "handed_off":
			text =
				event.ready && event.pr !== undefined
					? `${issue}: pull request \\#${event.pr.number} is ready for you to merge.`
					: `${issue} needs you: ${literal(event.reason)}`;
			url = event.pr?.url ?? event.issue.url;
			break;
	}
	const link = linkable(url);
	return link === undefined ? text : `${text}\n\n${link}`;
}

/**
 * The work log's line for `event`: what happened, then the link as a plain
 * address, which a terminal opens. `/work` shows the log full width.
 */
export function logLine(event: OrchestratorEvent): string {
	let text: string;
	let url: string;
	switch (event.kind) {
		case "picked_up":
			text = `#${event.issue.number}: picked up`;
			url = event.pr?.url ?? event.issue.url;
			break;
		case "pr_opened":
			text = `#${event.issue.number}: pull request #${event.pr.number} is open`;
			url = event.pr.url;
			break;
		case "handed_off":
			text =
				event.ready && event.pr !== undefined
					? `#${event.issue.number}: pull request #${event.pr.number} is ready for you to merge`
					: `#${event.issue.number}: needs you`;
			url = event.pr?.url ?? event.issue.url;
			break;
	}
	const link = linkable(url);
	return link === undefined ? text : `${text}: ${link}`;
}
