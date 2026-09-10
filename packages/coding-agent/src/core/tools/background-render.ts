import {
	type Component,
	createRenderFrame,
	type RenderFrame,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import { keyDisplayText } from "../../modes/interactive/components/keybinding-hints.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import type {
	BackgroundJobSnapshot,
	BackgroundJobSource,
	BackgroundJobStatus,
	BackgroundJobSummary,
} from "../background-jobs.ts";
import type { Theme } from "../theme/runtime.ts";
import { formatDuration } from "./render-utils.ts";

export const BACKGROUND_JOB_STYLES = {
	running: { label: "Running", color: "warning" },
	cancelling: { label: "Cancelling", color: "warning" },
	completed: { label: "Completed", color: "success" },
	failed: { label: "Failed", color: "error" },
	cancelled: { label: "Cancelled", color: "muted" },
} as const;

/** Worker text stays literal: no Markdown, hyperlinks, terminal controls or bidi overrides. */
export function backgroundJobText(text: string): string {
	return stripAnsi(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "")
		.replace(/\t/g, "   ");
}

export function backgroundJobLabel(job: Pick<BackgroundJobSummary, "label">): string {
	return backgroundJobText(job.label).replace(/\s+/g, " ").trim() || "(no task label)";
}

export function backgroundJobTiming(job: BackgroundJobSummary, now = Date.now()): string {
	return formatDuration(Math.max(0, (job.endedAt ?? now) - job.startedAt));
}

export function backgroundJobActivity(job: BackgroundJobSnapshot, now = Date.now()): string {
	if (job.status === "cancelling") return "Cancellation requested; waiting for the worker to stop";
	if (job.endedAt !== undefined) return job.output.trim() ? "Output" : "No output was produced";
	if (job.lastOutputAt === undefined) return job.output.trim() ? "Latest output" : "No output yet";
	return `Last output ${formatDuration(Math.max(0, now - job.lastOutputAt))} ago`;
}

export function isBackgroundJobSummary(job: unknown): job is BackgroundJobSummary {
	if (typeof job !== "object" || job === null || Array.isArray(job)) return false;
	const value = job as Record<string, unknown>;
	return (
		typeof value.id === "string" &&
		/^job_[a-zA-Z0-9-]+$/.test(value.id) &&
		(value.toolName === "bash" || value.toolName === "subagent") &&
		typeof value.toolCallId === "string" &&
		typeof value.label === "string" &&
		typeof value.status === "string" &&
		Object.hasOwn(BACKGROUND_JOB_STYLES, value.status) &&
		typeof value.startedAt === "number" &&
		Number.isFinite(value.startedAt) &&
		(value.endedAt === undefined || (typeof value.endedAt === "number" && Number.isFinite(value.endedAt)))
	);
}

export function getBackgroundJobSnapshot(details: unknown): BackgroundJobSnapshot | undefined {
	if (typeof details !== "object" || details === null || !("backgroundJob" in details)) return undefined;
	const job = details.backgroundJob;
	if (typeof job !== "object" || job === null || Array.isArray(job)) return undefined;
	const value = job as Record<string, unknown>;
	if (
		!isBackgroundJobSummary(job) ||
		(value.lastOutputAt !== undefined &&
			(typeof value.lastOutputAt !== "number" || !Number.isFinite(value.lastOutputAt))) ||
		typeof value.output !== "string" ||
		typeof value.outputTruncated !== "boolean"
	)
		return undefined;
	return job as BackgroundJobSnapshot;
}

export function findBackgroundJob(
	source: BackgroundJobSource | undefined,
	id: string | undefined,
): BackgroundJobSnapshot | undefined {
	if (!source || !id) return undefined;
	try {
		return source.get(id);
	} catch {
		// Historical, evicted and revoked handles are not live UI controls.
		return undefined;
	}
}

/** Deliberately has no generic tool-success badge or tool-call timer. */
export class BackgroundJobView implements Component {
	private readonly draw: (width: number) => RenderFrame;
	private readonly cache: boolean;
	private cached?: { width: number; frame: RenderFrame };

	constructor(draw: (width: number) => RenderFrame, cache = false) {
		this.draw = draw;
		this.cache = cache;
	}

	render(width: number): RenderFrame {
		if (this.cache && this.cached?.width === width) return this.cached.frame;
		const frame = this.draw(width);
		if (this.cache) this.cached = { width, frame };
		return frame;
	}

	invalidate(): void {
		this.cached = undefined;
	}
}

export function renderBackgroundJobCard(
	job: BackgroundJobSnapshot,
	width: number,
	theme: Theme,
	options: { expanded?: boolean; historical?: boolean; captured?: boolean; heading?: string; label?: string } = {},
): RenderFrame {
	const style = BACKGROUND_JOB_STYLES[job.status];
	const tool = job.toolName === "bash" ? "Bash" : "Subagent";
	const capturedWhileActive = (options.historical || options.captured) && job.endedAt === undefined;
	const state = capturedWhileActive ? `${style.label} at capture` : style.label;
	const timing = capturedWhileActive ? "" : ` · ${backgroundJobTiming(job)}`;
	const heading = options.heading ? `${options.heading} · ${tool}` : tool;
	const background = options.heading ? "" : theme.fg("dim", " · background");
	const lines = wrapTextWithAnsi(
		`${theme.bold(theme.fg("toolTitle", heading))}${background} · ${theme.fg(style.color, state)}${theme.fg("dim", timing)}`,
		width,
	);
	const label = backgroundJobText(options.label ?? job.label).trim() || "(no task label)";
	if (options.expanded) lines.push(...wrapTextWithAnsi(theme.fg("text", label), width));
	else lines.push(truncateToWidth(theme.fg("text", label.replace(/\s+/g, " ")), width));

	if (options.captured) {
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "Output snapshot · /jobs for current status"), width));
	} else if (options.historical && job.endedAt === undefined) {
		lines.push(...wrapTextWithAnsi(theme.fg("muted", "Saved snapshot; live status unavailable"), width));
	} else if (job.endedAt === undefined || !job.output.trim()) {
		lines.push(...wrapTextWithAnsi(theme.fg("muted", backgroundJobActivity(job)), width));
	}
	const output = backgroundJobText(job.output).trimEnd();
	if (output) {
		const outputLines = output.split("\n");
		const preview = options.expanded ? outputLines : outputLines.filter((line) => line.trim()).slice(-3);
		const indent = width > 2 ? "  " : "";
		const outputWidth = Math.max(1, width - indent.length);
		for (const line of preview) {
			const styled = theme.fg("toolOutput", line);
			const rows = options.expanded ? wrapTextWithAnsi(styled, outputWidth) : [truncateToWidth(styled, outputWidth)];
			lines.push(...rows.map((row) => indent + row));
		}
		if (!options.expanded && outputLines.length > preview.length) {
			lines.push(truncateToWidth(theme.fg("dim", `${outputLines.length - preview.length} earlier lines`), width));
		}
	}
	if (job.outputTruncated) {
		lines.push(
			...wrapTextWithAnsi(theme.fg("warning", "Retained output truncated (latest 50 KB / 2000 lines)"), width),
		);
	}
	if (options.expanded) lines.push(...wrapTextWithAnsi(theme.fg("dim", job.id), width));
	const expand = keyDisplayText("app.tools.expand");
	const hints = [expand ? `${expand} ${options.expanded ? "collapse" : "expand"} output` : "", "/jobs inspect"].filter(
		Boolean,
	);
	lines.push(...wrapTextWithAnsi(theme.fg("dim", hints.join(" · ")), width));
	return createRenderFrame(lines);
}

export function backgroundJobCounts(jobs: readonly BackgroundJobSummary[]): string {
	return (["running", "cancelling", "failed", "completed", "cancelled"] as BackgroundJobStatus[])
		.flatMap((status) => {
			const count = jobs.filter((job) => job.status === status).length;
			return count ? [`${count} ${status}`] : [];
		})
		.join(" · ");
}
