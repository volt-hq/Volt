import { getKeybindings } from "../keybindings.ts";
import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, styledTextWidth, truncateStyledText } from "../styled-text.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { selectionMarker, visibleRange } from "./view-utils.ts";

export interface MultiSelectItem {
	value: string;
	label: StyledText;
	description?: StyledText;
	disabled?: boolean;
}

export interface MultiSelectListProps {
	items: readonly MultiSelectItem[];
	/** Initially checked values. A changed value replaces the checked set. */
	selected?: readonly string[];
	/** Maximum rows shown before the list scrolls. Defaults to 8. */
	maxVisible?: number;
}

/** Checklist with a cursor. Toggle checks the current item; confirm submits the checked values. */
export class MultiSelectList implements Component, Focusable {
	focused = false;
	onSubmit?: (values: string[]) => void;
	onCancel?: () => void;
	onChange?: (values: string[]) => void;
	private readonly theme: SemanticTheme;
	private props: MultiSelectListProps;
	private checked: Set<string>;
	private cursor = 0;

	constructor(theme: SemanticTheme, props: MultiSelectListProps) {
		this.theme = theme;
		this.props = props;
		this.checked = new Set(props.selected ?? []);
	}

	setProps(props: MultiSelectListProps): void {
		const previous = this.props;
		const currentValue = previous.items[this.cursor]?.value;
		this.props = props;
		const values = new Set(props.items.map((item) => item.value));
		this.checked =
			props.selected !== previous.selected
				? new Set(props.selected ?? [])
				: new Set([...this.checked].filter((value) => values.has(value)));
		const nextCursor = props.items.findIndex((item) => item.value === currentValue);
		this.cursor = nextCursor === -1 ? Math.min(this.cursor, Math.max(0, props.items.length - 1)) : nextCursor;
	}

	/** Checked values in item order. */
	getSelectedValues(): string[] {
		return this.props.items.filter((item) => this.checked.has(item.value)).map((item) => item.value);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const count = this.props.items.length;
		const page = Math.max(1, this.maxVisible() - 1);
		if (keybindings.matches(data, "tui.select.up")) {
			if (count > 0) this.cursor = (this.cursor - 1 + count) % count;
		} else if (keybindings.matches(data, "tui.select.down")) {
			if (count > 0) this.cursor = (this.cursor + 1) % count;
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.cursor = Math.max(0, this.cursor - page);
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.cursor = Math.max(0, Math.min(count - 1, this.cursor + page));
		} else if (keybindings.matches(data, "tui.select.toggle")) {
			this.toggleCurrent();
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.onSubmit?.(this.getSelectedValues());
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const { items } = this.props;
		if (items.length === 0) return createRenderFrame([this.theme.muted(truncateToWidth("  No items", width, ""))]);
		const { start, end } = visibleRange(this.cursor, items.length, this.maxVisible());
		const labelWidth = Math.min(
			Math.max(...items.map((item) => styledTextWidth(item.label))),
			Math.max(1, Math.floor((width - 6) * 0.6)),
		);
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const item = items[index]!;
			const box = this.checked.has(item.value) ? "[x] " : "[ ] ";
			const current = index === this.cursor;
			const token = item.disabled ? "muted" : current ? "accent" : "text";
			const prefix = `${selectionMarker(this.theme, current)}${this.theme[token](box)}`;
			const available = Math.max(1, width - 6);
			if (!item.description || available - labelWidth < 12) {
				lines.push(prefix + truncateStyledText(item.label, available, this.theme, token));
				continue;
			}
			const label = truncateStyledText(item.label, labelWidth, this.theme, token);
			const padding = " ".repeat(Math.max(0, labelWidth - visibleWidth(label)) + 2);
			const description = truncateStyledText(item.description, available - labelWidth - 2, this.theme, "muted");
			lines.push(`${prefix}${label}${padding}${description}`);
		}
		if (start > 0 || end < items.length) {
			lines.push(this.theme.muted(truncateToWidth(`  (${this.cursor + 1}/${items.length})`, width, "")));
		}
		return createRenderFrame(lines.map((line) => truncateToWidth(line, width, "")));
	}

	private maxVisible(): number {
		return Math.max(1, this.props.maxVisible ?? 8);
	}

	private toggleCurrent(): void {
		const item = this.props.items[this.cursor];
		if (!item || item.disabled) return;
		if (this.checked.has(item.value)) this.checked.delete(item.value);
		else this.checked.add(item.value);
		this.onChange?.(this.getSelectedValues());
	}
}
