import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, truncateStyledText, wrapStyledText } from "../styled-text.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth } from "../utils.ts";

export interface TerminalOutputProps {
	lines: readonly StyledText[];
	/** Lines dropped before `lines[0]` by the producer, reported in the hidden-lines indicator. */
	omittedLines?: number;
	/** Maximum retained lines; older lines are dropped. Defaults to 1000. */
	maxLines?: number;
	/** Maximum rows shown, tail first. Defaults to showing every retained line. */
	maxVisibleRows?: number;
	/** Wrap long lines instead of truncating them. Defaults to true. */
	wrap?: boolean;
}

const DEFAULT_MAX_LINES = 1000;

/**
 * Bounded command output. Appending reuses the rendered rows of existing lines, so streaming output costs
 * only the new lines. When `setProps` receives lines that extend the previous lines, it appends.
 */
export class TerminalOutput implements Component {
	private readonly theme: SemanticTheme;
	private props: TerminalOutputProps;
	private lines: StyledText[] = [];
	private droppedLines = 0;
	private renderedWidth: number | undefined;
	private renderedRows: string[][] = [];

	constructor(theme: SemanticTheme, props: TerminalOutputProps) {
		this.theme = theme;
		this.props = props;
		this.appendLines(props.lines);
	}

	setProps(props: TerminalOutputProps): void {
		const previous = this.props;
		this.props = props;
		const extendsPrevious =
			props.lines.length >= previous.lines.length &&
			(props.omittedLines ?? 0) === (previous.omittedLines ?? 0) &&
			previous.lines.every((line, index) => props.lines[index] === line);
		if (props.wrap !== previous.wrap) this.renderedWidth = undefined;
		if (extendsPrevious) {
			this.trim();
			this.appendLines(props.lines.slice(previous.lines.length));
		} else {
			this.setLines(props.lines);
		}
	}

	/** Append output lines, dropping the oldest beyond `maxLines`. */
	appendLines(lines: readonly StyledText[]): void {
		this.lines.push(...lines);
		if (this.renderedWidth !== undefined) {
			for (const line of lines) this.renderedRows.push(this.renderLine(line, this.renderedWidth));
		}
		this.trim();
	}

	/** Replace all output lines. */
	setLines(lines: readonly StyledText[]): void {
		this.lines = [];
		this.renderedRows = [];
		this.droppedLines = 0;
		this.appendLines(lines);
	}

	/** Lines currently retained (after the `maxLines` bound). */
	getLineCount(): number {
		return this.lines.length;
	}

	invalidate(): void {
		this.renderedWidth = undefined;
	}

	render(width: number): RenderFrame {
		if (this.renderedWidth !== width) {
			this.renderedWidth = width;
			this.renderedRows = this.lines.map((line) => this.renderLine(line, width));
		}
		const rows = this.renderedRows.flat();
		const hiddenBefore = this.droppedLines + (this.props.omittedLines ?? 0);
		const maxRows = this.props.maxVisibleRows;
		const needsIndicator = hiddenBefore > 0 || (maxRows !== undefined && rows.length > maxRows);
		const budget = maxRows === undefined ? rows.length : Math.max(0, needsIndicator ? maxRows - 1 : maxRows);
		const shown = rows.slice(Math.max(0, rows.length - budget));
		if (!needsIndicator) return createRenderFrame(shown);
		const hidden = hiddenBefore + rows.length - shown.length;
		const indicator = this.theme.muted(
			truncateToWidth(`… ${hidden} earlier line${hidden === 1 ? "" : "s"}`, width, ""),
		);
		return createRenderFrame([indicator, ...shown]);
	}

	private renderLine(line: StyledText, width: number): string[] {
		if (this.props.wrap === false) return [truncateStyledText(line, width, this.theme)];
		return wrapStyledText(line, width, this.theme).map((row) => truncateToWidth(row, width, ""));
	}

	private trim(): void {
		const excess = this.lines.length - Math.max(1, this.props.maxLines ?? DEFAULT_MAX_LINES);
		if (excess <= 0) return;
		this.lines.splice(0, excess);
		if (this.renderedWidth !== undefined) this.renderedRows.splice(0, excess);
		this.droppedLines += excess;
	}
}
