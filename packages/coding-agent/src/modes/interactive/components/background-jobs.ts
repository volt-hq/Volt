import {
	type Component,
	createRenderFrame,
	getKeybindings,
	type Keybinding,
	type RenderFrame,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import type {
	BackgroundJobSnapshot,
	BackgroundJobSource,
	BackgroundJobSummary,
} from "../../../core/background-jobs.ts";
import { theme } from "../../../core/theme/runtime.ts";
import {
	BACKGROUND_JOB_STYLES,
	backgroundJobActivity,
	backgroundJobCounts,
	backgroundJobLabel,
	backgroundJobText,
	backgroundJobTiming,
	findBackgroundJob,
} from "../../../core/tools/background-render.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/** A bounded dock, independent of model tool calls and completion-notice delivery. */
export class BackgroundJobsStatus implements Component {
	private readonly source: () => BackgroundJobSource;

	constructor(source: () => BackgroundJobSource) {
		this.source = source;
	}

	render(width: number): RenderFrame {
		const jobs = this.source().listUncollected();
		if (jobs.length === 0 || width <= 0) return createRenderFrame([]);
		const title = `${theme.fg("accent", "Jobs")}  `;
		const separator = theme.fg("dim", " · ");
		const hint = keyDisplayText("app.jobs.open") || "/jobs";
		const hintWidth = visibleWidth(hint);
		let content: string;
		let showHint: boolean;
		if (jobs.length === 1) {
			const job = jobs[0];
			const status = theme.fg(BACKGROUND_JOB_STYLES[job.status].color, job.status);
			// At very small widths, keep the worker state rather than the dock title.
			const heading = visibleWidth(title + status) <= width ? title + status : status;
			const label = backgroundJobLabel(job);
			const labelWidth = visibleWidth(label);
			showHint = visibleWidth(heading) + 3 + Math.min(8, labelWidth) + 2 + hintWidth <= width;
			const contentWidth = width - (showHint ? hintWidth + 2 : 0);
			const labelSpace = contentWidth - visibleWidth(heading) - 3;
			const minimumLabel = Math.min(20, labelWidth);
			let suffix = "";
			if (job.endedAt !== undefined && labelSpace >= minimumLabel + 18) {
				suffix = `${separator}${theme.fg("dim", "awaiting review")}`;
			}
			const duration = `${Math.floor(Math.max(0, (job.endedAt ?? Date.now()) - job.startedAt) / 1000)}s`;
			if (labelSpace >= minimumLabel + visibleWidth(suffix) + 3 + duration.length) {
				suffix = `${separator}${theme.fg("dim", duration)}${suffix}`;
			}
			content = heading;
			if (labelSpace > 0) {
				content += `${separator}${truncateToWidth(label, labelSpace - visibleWidth(suffix), "…")}${suffix}`;
			}
			content = truncateToWidth(content, contentWidth, "");
		} else {
			const counts = (["running", "cancelling", "failed", "completed", "cancelled"] as const).flatMap((status) => {
				const count = jobs.filter((job) => job.status === status).length;
				return count ? [theme.fg(BACKGROUND_JOB_STYLES[status].color, `${count} ${status}`)] : [];
			});
			const heading = visibleWidth(title + counts[0]) <= width ? title : "";
			showHint = visibleWidth(heading + counts[0]) + 2 + hintWidth <= width;
			content = truncateToWidth(heading + counts.join(separator), width - (showHint ? hintWidth + 2 : 0), "…");
		}
		if (showHint) {
			content += `${" ".repeat(width - visibleWidth(content) - hintWidth)}${theme.fg("dim", hint)}`;
		}
		return createRenderFrame([content]);
	}

	invalidate(): void {}
}

export interface BackgroundJobsInspectorOptions {
	getHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
}

/** Local UI only: inspecting and closing this view never starts inference or stops work. */
export class BackgroundJobsInspector implements Component {
	private readonly source: BackgroundJobSource;
	private readonly options: BackgroundJobsInspectorOptions;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private list?: SelectList;
	private selectedId?: string;
	private detailId?: string;
	private confirmId?: string;
	private follow = true;
	/** One bounded reading snapshot; live retention can advance without moving paused text. */
	private readingOutput?: Pick<BackgroundJobSnapshot, "output" | "outputTruncated">;
	private lastRenderedOutput?: Pick<BackgroundJobSnapshot, "output" | "outputTruncated">;
	private scrollTop = 0;
	private viewportRows = 1;
	private outputRowCount = 0;
	private notice?: string;
	private disposed = false;

	constructor(source: BackgroundJobSource, options: BackgroundJobsInspectorOptions) {
		this.source = source;
		this.options = options;
		this.unsubscribe = source.subscribe(() => this.refresh());
		this.timer = setInterval(() => {
			if (source.list().some((job) => job.endedAt === undefined)) this.refresh();
		}, 1000);
		this.timer.unref();
	}

	refresh(): void {
		if (!this.disposed) this.options.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		clearInterval(this.timer);
		this.readingOutput = undefined;
		this.lastRenderedOutput = undefined;
	}

	private close(): void {
		this.dispose();
		this.options.onClose();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const keys = getKeybindings();
		if (this.confirmId) {
			if (keys.matches(data, "tui.select.cancel")) this.confirmId = undefined;
			else if (keys.matches(data, "tui.select.confirm")) {
				const id = this.confirmId;
				this.confirmId = undefined;
				try {
					this.source.cancel(id);
					// The live worker state already shows Cancelling until settlement.
					this.notice = undefined;
				} catch {
					this.notice = "This job is no longer accessible in the current runtime and branch";
				}
			}
			this.refresh();
			return;
		}
		if (keys.matches(data, "app.jobs.open")) {
			this.close();
			return;
		}
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.detailId) {
				this.detailId = undefined;
				this.readingOutput = undefined;
				this.lastRenderedOutput = undefined;
			} else this.close();
		} else if (keys.matches(data, "app.jobs.cancel")) {
			const job = findBackgroundJob(this.source, this.detailId ?? this.selectedId);
			if (job?.status === "running") this.confirmId = job.id;
		} else if (this.detailId) {
			if (keys.matches(data, "app.jobs.follow")) {
				this.follow = true;
				this.readingOutput = undefined;
			} else if (keys.matches(data, "tui.altScreen.top")) {
				this.readingOutput ??= this.lastRenderedOutput;
				this.follow = false;
				this.scrollTop = 0;
			} else {
				const movement = keys.matches(data, "tui.select.pageUp")
					? -this.viewportRows
					: keys.matches(data, "tui.select.pageDown")
						? this.viewportRows
						: keys.matches(data, "tui.select.up")
							? -1
							: keys.matches(data, "tui.select.down")
								? 1
								: 0;
				if (movement) {
					this.readingOutput ??= this.lastRenderedOutput;
					this.follow = false;
					this.scrollTop = Math.max(
						0,
						Math.min(this.scrollTop + movement, this.outputRowCount - this.viewportRows),
					);
				}
			}
		} else this.list?.handleInput(data);
		this.refresh();
	}

	render(width: number): RenderFrame {
		const height = Math.max(1, this.options.getHeight());
		const innerWidth = Math.max(1, width - 4);
		const jobs = this.source.list().sort((a, b) => {
			const priority = (job: BackgroundJobSummary) =>
				job.endedAt === undefined ? 0 : job.status === "failed" ? 1 : 2;
			return priority(a) - priority(b);
		});
		if (!jobs.some((job) => job.id === this.selectedId)) this.selectedId = jobs[0]?.id;
		const lines: string[] = [];
		let footer: string[];
		if (this.confirmId) {
			const job = findBackgroundJob(this.source, this.confirmId);
			lines.push(
				"",
				...wrapTextWithAnsi(theme.fg("warning", "Cancel this job? Other jobs will continue."), innerWidth),
			);
			if (job) {
				lines.push(...wrapTextWithAnsi(backgroundJobLabel(job), innerWidth));
				lines.push(...wrapTextWithAnsi(theme.fg("dim", job.id), innerWidth));
			} else lines.push("This job is no longer accessible.");
			footer = this.hints(
				[
					["tui.select.confirm", "confirm cancellation"],
					["tui.select.cancel", "keep running"],
				],
				innerWidth,
			);
		} else if (this.detailId) {
			const job = findBackgroundJob(this.source, this.detailId);
			footer = this.hints(
				[
					[["tui.select.up", "tui.select.down"], "scroll"],
					...(innerWidth >= 50 ? [[["tui.select.pageUp", "tui.select.pageDown"], "page"] as const] : []),
					["app.jobs.follow", "follow latest"],
					...(job?.status === "running" ? [["app.jobs.cancel", "cancel job"] as const] : []),
					["tui.select.cancel", "back"],
				],
				innerWidth,
			);
			if (!job) {
				lines.push(
					...wrapTextWithAnsi(
						"This job is no longer accessible. Jobs do not survive runtime restart or branch changes.",
						innerWidth,
					),
				);
			} else {
				const displayedOutput = this.follow ? job : (this.readingOutput ?? job);
				this.lastRenderedOutput = {
					output: displayedOutput.output,
					outputTruncated: displayedOutput.outputTruncated,
				};
				const footerRows = Math.min(footer.length, Math.max(1, height - 4));
				// Reserve at least three output rows before allowing metadata to wrap.
				const metadataRows = Math.max(1, height - footerRows - 7);
				const labelLines = wrapTextWithAnsi(backgroundJobText(job.label), innerWidth);
				const metadata = [
					...wrapTextWithAnsi(this.jobHeading(job), innerWidth),
					...labelLines,
					...wrapTextWithAnsi(theme.fg("dim", job.id), innerWidth),
					...wrapTextWithAnsi(theme.fg("muted", backgroundJobActivity(job)), innerWidth),
					...(displayedOutput.outputTruncated
						? wrapTextWithAnsi(
								theme.fg("warning", "Output truncated: latest 50 KB / 2000 lines retained"),
								innerWidth,
							)
						: []),
				];
				if (metadata.length <= metadataRows) lines.push(...metadata);
				else {
					const labelRows = Math.max(0, metadataRows - (displayedOutput.outputTruncated ? 3 : 2));
					lines.push(truncateToWidth(this.jobHeading(job), innerWidth));
					lines.push(
						...labelLines
							.slice(0, labelRows)
							.map((line, index) =>
								index === labelRows - 1 && labelLines.length > labelRows
									? `${truncateToWidth(line, Math.max(1, innerWidth - 3), "")}...`
									: line,
							),
					);
					lines.push(truncateToWidth(theme.fg("muted", backgroundJobActivity(job)), innerWidth));
					if (displayedOutput.outputTruncated)
						lines.push(truncateToWidth(theme.fg("warning", "Retained output truncated"), innerWidth));
					lines.splice(metadataRows);
				}
				const output = backgroundJobText(displayedOutput.output).trimEnd();
				const outputLines = output
					? output.split("\n").flatMap((line) => wrapTextWithAnsi(line, innerWidth))
					: [job.endedAt === undefined ? "No output yet" : "No output was produced"];
				this.viewportRows = Math.max(1, height - lines.length - footerRows - 4);
				this.outputRowCount = outputLines.length;
				const maximum = Math.max(0, outputLines.length - this.viewportRows);
				this.scrollTop = this.follow ? maximum : Math.min(this.scrollTop, maximum);
				lines.push(
					theme.fg(
						"dim",
						`${this.follow ? "Following latest" : displayedOutput.output !== job.output ? "Scroll paused (snapshot; newer output available)" : "Scroll paused (snapshot)"} · lines ${this.scrollTop + 1}-${Math.min(this.scrollTop + this.viewportRows, outputLines.length)} / ${outputLines.length}`,
					),
				);
				lines.push(
					...outputLines
						.slice(this.scrollTop, this.scrollTop + this.viewportRows)
						.map((line) => theme.fg("toolOutput", line)),
				);
			}
		} else {
			lines.push(
				theme.fg(
					"muted",
					jobs.length ? backgroundJobCounts(jobs) : "No background jobs in this runtime and branch.",
				),
			);
			const selected = findBackgroundJob(this.source, this.selectedId);
			footer = this.hints(
				[
					[["tui.select.up", "tui.select.down"], "select"],
					["tui.select.confirm", "view output"],
					...(selected?.status === "running" ? [["app.jobs.cancel", "cancel job"] as const] : []),
					["tui.select.cancel", "close"],
				],
				innerWidth,
			);
			if (jobs.length) {
				const maxVisible = Math.max(1, Math.min(6, height - footer.length - 10));
				this.list = new SelectList(
					jobs.map((job) => ({
						value: job.id,
						label: `${BACKGROUND_JOB_STYLES[job.status].label} · ${backgroundJobTiming(job)} · ${backgroundJobLabel(job)}`,
					})),
					maxVisible,
					{
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("muted", text),
					},
				);
				this.list.setSelectedIndex(jobs.findIndex((job) => job.id === this.selectedId));
				this.list.onSelectionChange = (item) => {
					this.selectedId = item.value;
					this.notice = undefined;
				};
				this.list.onSelect = (item) => {
					this.detailId = item.value;
					this.follow = true;
					this.readingOutput = undefined;
					this.lastRenderedOutput = undefined;
				};
				// SelectList is text-only; the inspector intentionally accepts no image placements.
				lines.push(...this.list.render(innerWidth).lines);
				if (selected) {
					lines.push("", this.jobHeading(selected), truncateToWidth(backgroundJobLabel(selected), innerWidth));
					lines.push(theme.fg("muted", backgroundJobActivity(selected)));
					const preview = backgroundJobText(selected.output)
						.trimEnd()
						.split("\n")
						.filter((line) => line.trim())
						.slice(-3);
					lines.push(...preview.map((line) => theme.fg("toolOutput", truncateToWidth(line, innerWidth))));
					if (selected.outputTruncated)
						lines.push(theme.fg("warning", "Output truncated; view retained output for details"));
				}
			} else this.list = undefined;
			if (this.notice) lines.push(theme.fg("warning", this.notice));
		}
		// Fixed-height framing keeps the overlay stationary as jobs produce output.
		// Reserve controls first so resizing never hides the way back.
		if (height < 6 || width < 8) {
			return createRenderFrame([...lines, ...footer].slice(-height).map((line) => truncateToWidth(line, width)));
		}
		const visibleFooter = footer.slice(-Math.min(footer.length, height - 4));
		const bodyRows = Math.max(0, height - visibleFooter.length - 3);
		const body = lines.slice(0, bodyRows);
		while (body.length < bodyRows) body.push("");
		const title = truncateToWidth("─ Background jobs ", width - 2, "");
		const border = (text: string) => theme.fg("borderAccent", text);
		return createRenderFrame([
			border(`╭${title}${"─".repeat(Math.max(0, width - 2 - visibleWidth(title)))}╮`),
			...[...body, "", ...visibleFooter].map((line) => {
				const content = truncateToWidth(line, innerWidth);
				return `${border("│")} ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} ${border("│")}`;
			}),
			border(`╰${"─".repeat(width - 2)}╯`),
		]);
	}

	private jobHeading(job: BackgroundJobSnapshot): string {
		const style = BACKGROUND_JOB_STYLES[job.status];
		return `${job.toolName === "bash" ? "Bash" : "Subagent"} · ${theme.fg(style.color, style.label)} · ${backgroundJobTiming(job)}`;
	}

	private hints(items: readonly (readonly [Keybinding | readonly Keybinding[], string])[], width: number): string[] {
		return wrapTextWithAnsi(
			theme.fg(
				"dim",
				items
					.flatMap(([action, description]) => {
						const actions = typeof action === "string" ? [action] : action;
						const keys = actions.map(keyDisplayText).filter(Boolean).join(" / ");
						return keys ? [`${keys} ${description}`] : [];
					})
					.join(" · "),
			),
			width,
		);
	}
}
