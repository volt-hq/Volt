import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import {
	type SemanticTheme,
	type SemanticToken,
	type StyledText,
	styledTextWidth,
	truncateStyledText,
} from "../styled-text.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface ProgressBarProps {
	value: number;
	/** Value that represents completion. Defaults to 1. */
	max?: number;
	label?: StyledText;
	/** Token for the filled part of the bar. Defaults to `accent`. */
	token?: SemanticToken;
	/** Show the percentage after the bar. Defaults to true. */
	showPercent?: boolean;
}

const MIN_BAR_WIDTH = 4;

/** Determinate progress bar with an optional label and percentage. */
export class ProgressBar implements Component {
	private readonly theme: SemanticTheme;
	private props: ProgressBarProps;

	constructor(theme: SemanticTheme, props: ProgressBarProps) {
		this.theme = theme;
		this.props = props;
	}

	setProps(props: ProgressBarProps): void {
		this.props = props;
	}

	/** Completed fraction in [0, 1]. */
	getFraction(): number {
		const max = this.props.max ?? 1;
		if (!(max > 0) || !Number.isFinite(this.props.value)) return 0;
		return Math.max(0, Math.min(1, this.props.value / max));
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const fraction = this.getFraction();
		const percent = this.props.showPercent === false ? "" : ` ${Math.floor(fraction * 100)}%`.padStart(5);
		let label = "";
		if (this.props.label !== undefined) {
			const labelWidth = Math.min(styledTextWidth(this.props.label), width - percent.length - MIN_BAR_WIDTH - 1);
			if (labelWidth > 0) label = `${truncateStyledText(this.props.label, labelWidth, this.theme)} `;
		}
		const barWidth = Math.max(1, width - visibleWidth(label) - percent.length);
		const filled = Math.round(fraction * barWidth);
		const style = (token: SemanticToken, text: string): string => (text ? this.theme[token](text) : "");
		const bar =
			style(this.props.token ?? "accent", "█".repeat(filled)) + style("muted", "░".repeat(barWidth - filled));
		return createRenderFrame([truncateToWidth(`${label}${bar}${style("muted", percent)}`, width, "")]);
	}
}

export type ProgressStepStatus = "pending" | "active" | "done" | "failed" | "skipped";

export interface ProgressStep {
	label: StyledText;
	status: ProgressStepStatus;
	detail?: StyledText;
}

export interface StepProgressProps {
	steps: readonly ProgressStep[];
	/** Optional heading, shown with the completed step count. */
	title?: StyledText;
}

const STEP_ICONS: Record<ProgressStepStatus, { icon: string; token: SemanticToken }> = {
	pending: { icon: "○", token: "muted" },
	active: { icon: "●", token: "accent" },
	done: { icon: "✓", token: "success" },
	failed: { icon: "✗", token: "error" },
	skipped: { icon: "–", token: "muted" },
};

/** Ordered list of steps with a status icon each. */
export class StepProgress implements Component {
	private readonly theme: SemanticTheme;
	private props: StepProgressProps;

	constructor(theme: SemanticTheme, props: StepProgressProps) {
		this.theme = theme;
		this.props = props;
	}

	setProps(props: StepProgressProps): void {
		this.props = props;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const { steps, title } = this.props;
		const lines: string[] = [];
		if (title !== undefined) {
			const done = steps.filter((step) => step.status === "done").length;
			const count = ` (${done}/${steps.length})`;
			const heading = truncateStyledText(title, Math.max(1, width - count.length), this.theme);
			lines.push(truncateToWidth(this.theme.bold(heading) + this.theme.muted(count), width, ""));
		}
		for (const step of steps) {
			const { icon, token } = STEP_ICONS[step.status];
			const prefix = `${this.theme[token](icon)} `;
			const available = Math.max(1, width - 2);
			const labelToken = step.status === "pending" || step.status === "skipped" ? "muted" : "text";
			const label = truncateStyledText(step.label, available, this.theme, labelToken);
			const detailWidth = available - visibleWidth(label) - 2;
			const detail =
				step.detail !== undefined && detailWidth >= 4
					? `  ${truncateStyledText(step.detail, detailWidth, this.theme, "muted")}`
					: "";
			lines.push(truncateToWidth(prefix + label + detail, width, ""));
		}
		return createRenderFrame(lines);
	}
}
