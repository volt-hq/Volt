import { getKeybindings } from "../keybindings.ts";
import { createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type SemanticToken, sanitizeText } from "../styled-text.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface ActionItem {
	id: string;
	label: string;
	/** Token for the label, e.g. `error` for a destructive action. Defaults to `text`. */
	token?: SemanticToken;
	disabled?: boolean;
}

export interface ActionBarProps {
	actions: readonly ActionItem[];
	/** Initially selected action. A changed value moves the selection. */
	selectedId?: string;
}

const ACTION_GAP = " ";

/** Horizontal row of actions. Left/right move the selection; confirm activates it. */
export class ActionBar implements Component, Focusable {
	focused = false;
	onAction?: (id: string) => void;
	onCancel?: () => void;
	private readonly theme: SemanticTheme;
	private props: ActionBarProps;
	private selectedId: string | undefined;

	constructor(theme: SemanticTheme, props: ActionBarProps) {
		this.theme = theme;
		this.props = props;
		this.selectedId = this.resolveSelection(props.selectedId);
	}

	setProps(props: ActionBarProps): void {
		const previous = this.props;
		this.props = props;
		const preferred = props.selectedId !== previous.selectedId ? props.selectedId : this.selectedId;
		this.selectedId = this.resolveSelection(preferred);
	}

	getSelectedId(): string | undefined {
		return this.selectedId;
	}

	/** Whether any action can be activated. */
	hasEnabledActions(): boolean {
		return this.props.actions.some((action) => !action.disabled);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.left")) this.moveSelection(-1);
		else if (keybindings.matches(data, "tui.select.right")) this.moveSelection(1);
		else if (keybindings.matches(data, "tui.select.confirm")) {
			if (this.selectedId !== undefined) this.onAction?.(this.selectedId);
		} else if (keybindings.matches(data, "tui.select.cancel")) this.onCancel?.();
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const lines: string[] = [];
		let line = "";
		let lineWidth = 0;
		for (const action of this.props.actions) {
			const label = truncateToWidth(`[ ${sanitizeText(action.label).replace(/\n/g, " ")} ]`, width, "…");
			const labelWidth = visibleWidth(label);
			const gapWidth = lineWidth === 0 ? 0 : ACTION_GAP.length;
			if (lineWidth > 0 && lineWidth + gapWidth + labelWidth > width) {
				lines.push(line);
				line = "";
				lineWidth = 0;
			}
			if (lineWidth > 0) {
				line += ACTION_GAP;
				lineWidth += ACTION_GAP.length;
			}
			line += this.styleAction(action, label);
			lineWidth += labelWidth;
		}
		if (lineWidth > 0) lines.push(line);
		return createRenderFrame(lines);
	}

	private styleAction(action: ActionItem, label: string): string {
		if (action.disabled) return this.theme.muted(label);
		if (this.focused && action.id === this.selectedId) {
			return this.theme.bold(this.theme.underline(this.theme.accent(label)));
		}
		return this.theme[action.token ?? "text"](label);
	}

	private resolveSelection(preferred: string | undefined): string | undefined {
		const enabled = this.props.actions.filter((action) => !action.disabled);
		return enabled.find((action) => action.id === preferred)?.id ?? enabled[0]?.id;
	}

	private moveSelection(direction: 1 | -1): void {
		const enabled = this.props.actions.filter((action) => !action.disabled);
		if (enabled.length === 0) return;
		const index = enabled.findIndex((action) => action.id === this.selectedId);
		this.selectedId = enabled[(index + direction + enabled.length) % enabled.length]!.id;
	}
}
