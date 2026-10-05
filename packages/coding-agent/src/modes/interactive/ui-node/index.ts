/**
 * The TUI's `UiNode` mapping (RFC §8.3, §10) on the generic reconciler of
 * packages/tui: `text`, `keyValue`, `progress` (determinate and steps),
 * `terminal`, and `list` nodes render as retained components. Every other
 * node type renders as a one-line placeholder until the full mapping lands
 * with data-only extensions. Semantic tokens resolve through the TUI theme.
 */

import type { UiKeyValueNode, UiNode, UiNodeToken, UiTerminalNode, UiTextNode } from "@hansjm10/volt-protocol";
import {
	type Component,
	createRenderFrame,
	ProgressBar,
	prefixRenderFrame,
	type RenderFrame,
	type SemanticTheme,
	StepProgress,
	type StyledText,
	TerminalOutput,
	truncateToWidth,
	ViewReconciler,
	ViewRegistry,
	visibleWidth,
	wrapStyledText,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";

/** The TUI theme as semantic tokens: data names a token, the theme styles it. */
export const TUI_SEMANTIC_THEME: SemanticTheme = {
	text: (text) => theme.fg("text", text),
	muted: (text) => theme.fg("muted", text),
	accent: (text) => theme.fg("accent", text),
	success: (text) => theme.fg("success", text),
	warning: (text) => theme.fg("warning", text),
	error: (text) => theme.fg("error", text),
	info: (text) => theme.fg("accent", text),
	bold: (text) => theme.bold(text),
	italic: (text) => theme.italic(text),
	underline: (text) => theme.underline(text),
	code: (text) => theme.fg("mdCode", text),
};

/** Most rows a terminal node shows, its newest lines. */
const TERMINAL_VISIBLE_ROWS = 12;

/** Styled text, wrapped. */
class StyledTextView implements Component {
	private text: StyledText;
	private token: UiNodeToken;

	constructor(text: StyledText, token: UiNodeToken = "text") {
		this.text = text;
		this.token = token;
	}

	set(text: StyledText, token: UiNodeToken = "text"): void {
		this.text = text;
		this.token = token;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		return createRenderFrame(wrapStyledText(this.text, width, TUI_SEMANTIC_THEME, this.token));
	}
}

/** Labelled values, one item per line: the label muted, the value wrapped after it. */
class KeyValueView implements Component {
	private items: UiKeyValueNode["items"];

	constructor(items: UiKeyValueNode["items"]) {
		this.items = items;
	}

	set(items: UiKeyValueNode["items"]): void {
		this.items = items;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const lines: string[] = [];
		for (const item of this.items) {
			const label = wrapStyledText(item.label, width, TUI_SEMANTIC_THEME, "muted").join(" ");
			const prefix = truncateToWidth(`${label}: `, Math.max(1, Math.floor(width / 2)), "…");
			const indent = visibleWidth(prefix);
			const value = wrapStyledText(item.value, Math.max(1, width - indent), TUI_SEMANTIC_THEME);
			lines.push(...value.map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`));
		}
		return createRenderFrame(lines);
	}
}

/** A list's items, each after its bullet or number. */
class ListView implements Component {
	private ordered: boolean;
	private items: readonly Component[] = [];

	constructor(ordered: boolean) {
		this.ordered = ordered;
	}

	set(ordered: boolean, items: readonly Component[]): void {
		this.ordered = ordered;
		this.items = items;
	}

	invalidate(): void {
		for (const item of this.items) item.invalidate();
	}

	render(width: number): RenderFrame {
		const lines: string[] = [];
		this.items.forEach((item, index) => {
			const marker = this.ordered ? `${index + 1}. ` : "• ";
			const indent = " ".repeat(marker.length);
			const frame = item.render(Math.max(1, width - marker.length));
			const [first, ...rest] = prefixRenderFrame(frame, indent).lines;
			if (first === undefined) return;
			lines.push(`${theme.fg("muted", marker)}${first.slice(indent.length)}`, ...rest);
		});
		return createRenderFrame(lines);
	}
}

/** What the mapping does not render yet: the node's type, muted. */
class PlaceholderView implements Component {
	private type: string;

	constructor(type: string) {
		this.type = type;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		return createRenderFrame([truncateToWidth(theme.fg("dim", `[${this.type}]`), width)]);
	}
}

function terminalProps(node: UiTerminalNode) {
	return {
		lines: node.lines,
		...(node.omittedLines === undefined ? {} : { omittedLines: node.omittedLines }),
		maxVisibleRows: TERMINAL_VISIBLE_ROWS,
	};
}

function textToken(node: UiTextNode): UiNodeToken {
	return node.token ?? "text";
}

const PLACEHOLDER_TYPES = ["markdown", "table", "form", "actions", "card", "diff", "code", "image", "tree"] as const;

/** The node-type registry of the mapping. */
export function createUiNodeRegistry(): ViewRegistry<UiNode> {
	const registry = new ViewRegistry<UiNode>();
	registry.register("text", {
		create: (node) => new StyledTextView(node.text, textToken(node)),
		update: (component, node) => component.set(node.text, textToken(node)),
	});
	registry.register("keyValue", {
		create: (node) => new KeyValueView(node.items),
		update: (component, node) => component.set(node.items),
	});
	registry.register("progress", {
		create: (node) =>
			node.kind === "determinate"
				? new ProgressBar(TUI_SEMANTIC_THEME, {
						value: node.value,
						...(node.max === undefined ? {} : { max: node.max }),
						...(node.label === undefined ? {} : { label: node.label }),
						...(node.token === undefined ? {} : { token: node.token }),
					})
				: new StepProgress(TUI_SEMANTIC_THEME, {
						steps: node.steps.map((step) => ({
							label: step.label,
							status: step.status,
							...(step.detail === undefined ? {} : { detail: step.detail }),
						})),
						...(node.title === undefined ? {} : { title: node.title }),
					}),
	});
	registry.register("terminal", {
		create: (node) => new TerminalOutput(TUI_SEMANTIC_THEME, terminalProps(node)),
		update: (component, node) => component.setProps(terminalProps(node)),
	});
	registry.register("list", {
		create: (node) => new ListView(node.ordered === true),
		children: (node) => node.items,
		mount: (component, children, node) => component.set(node.ordered === true, children),
	});
	for (const type of PLACEHOLDER_TYPES) {
		registry.register(type, { create: (node) => new PlaceholderView(node.type) });
	}
	return registry;
}

/** A retained view of `UiNode` trees: `update` reconciles it against new roots. */
export function createUiNodeView(): ViewReconciler<UiNode> {
	return new ViewReconciler(createUiNodeRegistry());
}
