import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type SemanticToken, sanitizeText } from "../styled-text.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, wrapTextWithAnsi } from "../utils.ts";

export type DiffLineKind = "context" | "add" | "remove" | "hunk" | "meta";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldLine?: number;
	newLine?: number;
}

export interface DiffViewProps {
	lines: readonly DiffLine[];
	/** Show old and new line numbers in a gutter. Defaults to true. */
	lineNumbers?: boolean;
	/** Wrap long lines instead of truncating them. Defaults to false. */
	wrap?: boolean;
	/** Show at most this many diff lines, followed by a count of the rest. */
	maxLines?: number;
}

const LINE_STYLES: Record<DiffLineKind, { sign: string; token: SemanticToken }> = {
	context: { sign: " ", token: "text" },
	add: { sign: "+", token: "success" },
	remove: { sign: "-", token: "error" },
	hunk: { sign: "", token: "accent" },
	meta: { sign: "", token: "muted" },
};

/** Unified diff with signs, semantic colors, and an optional line-number gutter. */
export class DiffView implements Component {
	private readonly theme: SemanticTheme;
	private props: DiffViewProps;
	private cache: { width: number; frame: RenderFrame } | undefined;

	constructor(theme: SemanticTheme, props: DiffViewProps) {
		this.theme = theme;
		this.props = props;
	}

	setProps(props: DiffViewProps): void {
		this.props = props;
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): RenderFrame {
		if (this.cache?.width === width) return this.cache.frame;
		const frame = createRenderFrame(this.renderLines(width));
		this.cache = { width, frame };
		return frame;
	}

	private renderLines(width: number): string[] {
		const { lines, lineNumbers = true, wrap = false } = this.props;
		const shown = this.props.maxLines === undefined ? lines : lines.slice(0, Math.max(0, this.props.maxLines));
		const digits = lineNumbers
			? Math.max(1, ...shown.map((line) => String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length))
			: 0;
		const gutterWidth = lineNumbers && width >= digits * 2 + 12 ? digits * 2 + 2 : 0;
		const output: string[] = [];
		for (const line of shown) {
			const { sign, token } = LINE_STYLES[line.kind];
			const numbered = line.kind !== "hunk" && line.kind !== "meta";
			const gutter =
				gutterWidth === 0
					? ""
					: this.theme.muted(
							numbered
								? `${(line.oldLine === undefined ? "" : String(line.oldLine)).padStart(digits)} ${(line.newLine === undefined ? "" : String(line.newLine)).padStart(digits)} `
								: " ".repeat(gutterWidth),
						);
			const signText = numbered ? `${sign} ` : "";
			const textWidth = Math.max(1, width - gutterWidth - signText.length);
			const text = sanitizeText(line.text).replace(/\n/g, " ");
			const segments = wrap ? wrapTextWithAnsi(text, textWidth) : [truncateToWidth(text, textWidth, "…")];
			for (const [index, segment] of segments.entries()) {
				const sign = signText ? this.theme[token](signText) : "";
				const lead = index === 0 ? gutter + sign : " ".repeat(gutterWidth + signText.length);
				output.push(truncateToWidth(lead + this.theme[token](segment), width, ""));
			}
		}
		const hidden = lines.length - shown.length;
		if (hidden > 0) {
			output.push(
				this.theme.muted(truncateToWidth(`… ${hidden} more diff line${hidden === 1 ? "" : "s"}`, width, "")),
			);
		}
		return output;
	}
}
