import { getKeybindings } from "../keybindings.ts";
import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, truncateStyledText } from "../styled-text.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { selectionMarker, visibleRange } from "./view-utils.ts";

export interface TreeItem {
	id: string;
	label: StyledText;
	description?: StyledText;
	children?: readonly TreeItem[];
}

export interface TreeViewProps {
	items: readonly TreeItem[];
	/** Initially expanded item ids. A changed value replaces the expanded set. */
	expanded?: readonly string[];
	/** Initially selected item id. A changed value moves the cursor. */
	selectedId?: string;
	/** Maximum rows shown before the tree scrolls. Defaults to 12. */
	maxVisible?: number;
}

interface TreeRow {
	item: TreeItem;
	depth: number;
	parentId: string | undefined;
}

/** Expandable tree. Up/down move, right expands or enters, left collapses or goes to the parent. */
export class TreeView implements Component, Focusable {
	focused = false;
	onSelect?: (id: string) => void;
	onCancel?: () => void;
	onToggle?: (id: string, expanded: boolean) => void;
	private readonly theme: SemanticTheme;
	private props: TreeViewProps;
	private expanded: Set<string>;
	private selectedId: string | undefined;

	constructor(theme: SemanticTheme, props: TreeViewProps) {
		this.theme = theme;
		this.props = props;
		this.expanded = new Set(props.expanded ?? []);
		this.selectedId = props.selectedId;
		this.ensureSelection(0);
	}

	setProps(props: TreeViewProps): void {
		const previous = this.props;
		const previousIndex = this.rows().findIndex((row) => row.item.id === this.selectedId);
		this.props = props;
		if (props.expanded !== previous.expanded) this.expanded = new Set(props.expanded ?? []);
		if (props.selectedId !== previous.selectedId && props.selectedId !== undefined) {
			this.selectedId = props.selectedId;
		}
		this.ensureSelection(Math.max(0, previousIndex));
	}

	getSelectedId(): string | undefined {
		return this.selectedId;
	}

	isExpanded(id: string): boolean {
		return this.expanded.has(id);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const rows = this.rows();
		const index = rows.findIndex((row) => row.item.id === this.selectedId);
		const row = rows[index];
		if (!row) return;
		const hasChildren = (row.item.children?.length ?? 0) > 0;
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedId = rows[(index - 1 + rows.length) % rows.length]!.item.id;
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.selectedId = rows[(index + 1) % rows.length]!.item.id;
		} else if (keybindings.matches(data, "tui.select.right")) {
			if (hasChildren && !this.expanded.has(row.item.id)) this.setExpanded(row.item.id, true);
			else if (hasChildren) this.selectedId = row.item.children![0]!.id;
		} else if (keybindings.matches(data, "tui.select.left")) {
			if (hasChildren && this.expanded.has(row.item.id)) this.setExpanded(row.item.id, false);
			else if (row.parentId !== undefined) this.selectedId = row.parentId;
		} else if (keybindings.matches(data, "tui.select.toggle")) {
			if (hasChildren) this.setExpanded(row.item.id, !this.expanded.has(row.item.id));
		} else if (keybindings.matches(data, "tui.select.confirm")) {
			this.onSelect?.(row.item.id);
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const rows = this.rows();
		if (rows.length === 0) return createRenderFrame([this.theme.muted(truncateToWidth("  Empty", width, ""))]);
		const selectedIndex = Math.max(
			0,
			rows.findIndex((row) => row.item.id === this.selectedId),
		);
		const { start, end } = visibleRange(selectedIndex, rows.length, Math.max(1, this.props.maxVisible ?? 12));
		const lines: string[] = [];
		for (let index = start; index < end; index++) {
			const { item, depth } = rows[index]!;
			const current = index === selectedIndex;
			const marker = (item.children?.length ?? 0) === 0 ? "  " : this.expanded.has(item.id) ? "▾ " : "▸ ";
			const prefix = `${selectionMarker(this.theme, current)}${"  ".repeat(depth)}${this.theme.muted(marker)}`;
			const available = Math.max(1, width - visibleWidth(prefix));
			const label = truncateStyledText(item.label, available, this.theme, current ? "accent" : "text");
			const descriptionWidth = available - visibleWidth(label) - 2;
			const description =
				item.description && descriptionWidth >= 8
					? `  ${truncateStyledText(item.description, descriptionWidth, this.theme, "muted")}`
					: "";
			lines.push(truncateToWidth(prefix + label + description, width, ""));
		}
		if (start > 0 || end < rows.length) {
			lines.push(this.theme.muted(truncateToWidth(`  (${selectedIndex + 1}/${rows.length})`, width, "")));
		}
		return createRenderFrame(lines);
	}

	private rows(): TreeRow[] {
		const rows: TreeRow[] = [];
		const visit = (items: readonly TreeItem[], depth: number, parentId: string | undefined): void => {
			for (const item of items) {
				rows.push({ item, depth, parentId });
				if (item.children && this.expanded.has(item.id)) visit(item.children, depth + 1, item.id);
			}
		};
		visit(this.props.items, 0, undefined);
		return rows;
	}

	private ensureSelection(fallbackIndex: number): void {
		const rows = this.rows();
		if (rows.some((row) => row.item.id === this.selectedId)) return;
		this.selectedId = rows[Math.min(fallbackIndex, rows.length - 1)]?.item.id;
	}

	private setExpanded(id: string, expanded: boolean): void {
		if (expanded) this.expanded.add(id);
		else this.expanded.delete(id);
		this.onToggle?.(id, expanded);
	}
}
