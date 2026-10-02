import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, styledTextWidth, truncateStyledText } from "../styled-text.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface TableColumn {
	header: StyledText;
	align?: "left" | "right";
	/** Columns are never shrunk below this width (default 1) unless the table cannot fit otherwise. */
	minWidth?: number;
}

export interface TableProps {
	columns: readonly TableColumn[];
	rows: readonly (readonly StyledText[])[];
	/** Shown instead of rows when there are none. */
	emptyText?: StyledText;
}

const COLUMN_GAP = "  ";

/** Shrink the widest columns until the total fits, respecting minimum widths first. */
function fitColumnWidths(natural: number[], minimums: number[], available: number): number[] {
	const widths = [...natural];
	let total = widths.reduce((sum, width) => sum + width, 0);
	for (const floor of [minimums, minimums.map(() => 1)]) {
		while (total > available) {
			let widest = -1;
			for (let index = 0; index < widths.length; index++) {
				if (widths[index]! > floor[index]! && (widest === -1 || widths[index]! > widths[widest]!)) widest = index;
			}
			if (widest === -1) break;
			widths[widest]!--;
			total--;
		}
	}
	return widths;
}

/** Column-aligned table with a header row. Cells that do not fit are truncated with an ellipsis. */
export class Table implements Component {
	private readonly theme: SemanticTheme;
	private props: TableProps;
	private cache: { width: number; frame: RenderFrame } | undefined;

	constructor(theme: SemanticTheme, props: TableProps) {
		this.theme = theme;
		this.props = props;
	}

	setProps(props: TableProps): void {
		this.props = props;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): RenderFrame {
		if (this.cache?.width === width) return this.cache.frame;
		const frame = createRenderFrame(this.renderLines(width).map((line) => truncateToWidth(line, width, "")));
		this.cache = { width, frame };
		return frame;
	}

	private renderLines(width: number): string[] {
		const { columns, rows } = this.props;
		if (columns.length === 0) return [];
		const natural = columns.map((column, index) =>
			Math.max(styledTextWidth(column.header), ...rows.map((row) => styledTextWidth(row[index] ?? ""))),
		);
		const available = Math.max(columns.length, width - COLUMN_GAP.length * (columns.length - 1));
		const minimums = columns.map((column, index) => Math.min(natural[index]!, Math.max(1, column.minWidth ?? 1)));
		const widths = fitColumnWidths(natural, minimums, available);
		const formatRow = (cells: readonly StyledText[], header: boolean): string =>
			columns
				.map((column, index) => {
					const cellWidth = widths[index]!;
					const text = truncateStyledText(cells[index] ?? "", cellWidth, this.theme);
					const styled = header ? this.theme.bold(text) : text;
					const padding = " ".repeat(Math.max(0, cellWidth - visibleWidth(text)));
					return column.align === "right" ? padding + styled : styled + padding;
				})
				.join(COLUMN_GAP)
				.trimEnd();
		const lines = [
			formatRow(
				columns.map((column) => column.header),
				true,
			),
			this.theme.muted(widths.map((cellWidth) => "─".repeat(cellWidth)).join(COLUMN_GAP)),
		];
		if (rows.length === 0 && this.props.emptyText !== undefined) {
			lines.push(truncateStyledText(this.props.emptyText, width, this.theme, "muted"));
		}
		for (const row of rows) lines.push(formatRow(row, false));
		return lines;
	}
}
