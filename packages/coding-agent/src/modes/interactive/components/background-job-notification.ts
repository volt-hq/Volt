import { type Component, Container, Text, TruncatedText } from "@hansjm10/volt-tui";
import { BACKGROUND_JOB_MAX_RETAINED, type BackgroundJobSummary } from "../../../core/background-jobs.ts";
import type { Theme } from "../../../core/theme/runtime.ts";
import { formatDuration } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

type CompletedJob = Pick<BackgroundJobSummary, "id" | "toolName" | "label" | "startedAt"> & {
	status: "completed" | "failed" | "cancelled";
	endedAt: number;
};

const STATUS_STYLES = {
	completed: { label: "Completed", color: "success" },
	failed: { label: "Failed", color: "error" },
	cancelled: { label: "Cancelled", color: "warning" },
} as const;

function isCompletedJob(value: unknown): value is CompletedJob {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const job = value as Record<string, unknown>;
	return (
		typeof job.id === "string" &&
		/^job_[a-zA-Z0-9-]+$/.test(job.id) &&
		(job.toolName === "bash" || job.toolName === "subagent") &&
		typeof job.label === "string" &&
		(job.status === "completed" || job.status === "failed" || job.status === "cancelled") &&
		typeof job.startedAt === "number" &&
		Number.isFinite(job.startedAt) &&
		typeof job.endedAt === "number" &&
		Number.isFinite(job.endedAt)
	);
}

/** Presentation only: retain the model-facing notice and never read live worker output. */
export function renderBackgroundJobNotification(
	details: unknown,
	expanded: boolean,
	theme: Theme,
): Component | undefined {
	if (typeof details !== "object" || details === null || !("jobs" in details)) return undefined;
	const jobs = details.jobs;
	if (
		!Array.isArray(jobs) ||
		jobs.length === 0 ||
		jobs.length > BACKGROUND_JOB_MAX_RETAINED ||
		!jobs.every(isCompletedJob)
	) {
		return undefined;
	}

	const container = new Container();
	const title = jobs.length === 1 ? "Background job" : "Background jobs";
	container.addChild(new Text(theme.bold(theme.fg("toolTitle", title)), 1, 0));
	if (jobs.length > 1) {
		const counts = (["failed", "cancelled", "completed"] as const).flatMap((status) => {
			const count = jobs.filter((job) => job.status === status).length;
			return count ? [theme.fg(STATUS_STYLES[status].color, `${count} ${status}`)] : [];
		});
		container.addChild(new Text(counts.join(theme.fg("dim", " · ")), 1, 0));
	}

	const displayed = expanded ? jobs : jobs.slice(0, 5);
	for (const job of displayed) {
		const style = STATUS_STYLES[job.status];
		const tool = job.toolName === "bash" ? "Bash" : "Subagent";
		// Commands and task names are data, not Markdown or terminal control sequences.
		const label =
			stripAnsi(job.label)
				.replace(/\r\n?/g, "\n")
				.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
				.replace(/\t/g, "   ")
				.trim() || "(no task label)";
		const heading = `${theme.fg(style.color, style.label)}${theme.fg("muted", ` · ${tool}`)}`;
		if (expanded) {
			const duration = formatDuration(Math.max(0, job.endedAt - job.startedAt));
			container.addChild(
				new Text(
					`${heading}${theme.fg("dim", ` · ${duration}`)}\n${theme.fg("text", label)}\n${theme.fg("dim", job.id)}`,
					2,
					0,
				),
			);
		} else {
			container.addChild(
				new TruncatedText(
					`${heading}${theme.fg("dim", " · ")}${theme.fg("text", label.replace(/\s+/g, " "))}`,
					2,
					0,
				),
			);
		}
	}
	if (displayed.length < jobs.length) {
		container.addChild(new Text(theme.fg("dim", `... (${jobs.length - displayed.length} more jobs)`), 2, 0));
	}
	const expandKey = keyDisplayText("app.tools.expand");
	if (expandKey) {
		container.addChild(
			new Text(theme.fg("dim", `${expandKey} to ${expanded ? "collapse" : "expand"} job details`), 1, 0),
		);
	}
	return container;
}
