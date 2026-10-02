import { type FocusDirection, FocusGroup, type FocusScope } from "../focus.ts";
import { getKeybindings } from "../keybindings.ts";
import {
	concatRenderFrames,
	createRenderFrame,
	mapRenderFrameLines,
	prefixRenderFrame,
	type RenderFrame,
} from "../render-frame.ts";
import {
	type SemanticTheme,
	type SemanticToken,
	type StyledText,
	sanitizeText,
	truncateStyledText,
} from "../styled-text.ts";
import type { Component, Focusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";
import { ActionBar, type ActionItem } from "./action-bar.ts";
import { fitLine } from "./view-utils.ts";

export interface CardBadge {
	label: string;
	token?: SemanticToken;
}

export interface CardSection {
	title?: StyledText;
	children: readonly Component[];
}

export interface CardProps {
	title: StyledText;
	/** Token for the title. Defaults to `accent`. */
	titleToken?: SemanticToken;
	badges?: readonly CardBadge[];
	sections?: readonly CardSection[];
	actions?: readonly ActionItem[];
}

const MIN_BORDERED_WIDTH = 8;

/**
 * Bordered card with a title, badges, titled sections of child components, and an action bar. Tab moves
 * between focusable section children and the actions.
 */
export class Card implements Component, Focusable, FocusScope {
	onAction?: (id: string) => void;
	onCancel?: () => void;
	private readonly theme: SemanticTheme;
	private props: CardProps;
	private readonly actionBar: ActionBar;
	private readonly focusGroup = new FocusGroup([], { wrap: false });

	constructor(theme: SemanticTheme, props: CardProps) {
		this.theme = theme;
		this.props = props;
		this.actionBar = new ActionBar(theme, { actions: props.actions ?? [] });
		this.actionBar.onAction = (id) => this.onAction?.(id);
		this.actionBar.onCancel = () => this.onCancel?.();
		this.syncFocusGroup();
	}

	get focused(): boolean {
		return this.focusGroup.focused;
	}

	set focused(focused: boolean) {
		this.focusGroup.focused = focused;
	}

	setProps(props: CardProps): void {
		this.props = props;
		this.actionBar.setProps({ actions: props.actions ?? [] });
		this.syncFocusGroup();
	}

	/** The section child or the action bar that currently receives input. */
	getFocusedChild(): Component | undefined {
		return this.focusGroup.getFocusedChild();
	}

	moveFocus(direction: FocusDirection): boolean {
		return this.focusGroup.moveFocus(direction);
	}

	enterFocus(direction: FocusDirection): boolean {
		return this.focusGroup.enterFocus(direction);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.focusGroup.getFocusedChild() === undefined && keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (keybindings.matches(data, "tui.focus.next") || keybindings.matches(data, "tui.focus.previous")) {
			const direction = keybindings.matches(data, "tui.focus.next") ? 1 : -1;
			if (!this.focusGroup.moveFocus(direction)) this.focusGroup.enterFocus(direction);
			return;
		}
		this.focusGroup.handleInput(data);
	}

	invalidate(): void {
		this.focusGroup.invalidate();
		this.actionBar.invalidate();
	}

	render(width: number): RenderFrame {
		const bordered = width >= MIN_BORDERED_WIDTH;
		const innerWidth = bordered ? width - 4 : width;
		const blocks: RenderFrame[] = [];
		for (const section of this.props.sections ?? []) {
			const lines: RenderFrame[] = [];
			if (section.title !== undefined) {
				lines.push(createRenderFrame([this.theme.bold(truncateStyledText(section.title, innerWidth, this.theme))]));
			}
			lines.push(...section.children.map((child) => child.render(innerWidth)));
			blocks.push(concatRenderFrames(lines));
		}
		if ((this.props.actions?.length ?? 0) > 0) blocks.push(this.actionBar.render(innerWidth));
		const header = this.renderHeader(width, bordered);
		if (!bordered) {
			return mapRenderFrameLines(concatRenderFrames([createRenderFrame([header]), ...blocks]), (line) =>
				visibleWidth(line) > width ? truncateToWidth(line, width, "") : line,
			);
		}
		const border = (text: string): string => this.theme.muted(text);
		const divider = createRenderFrame([border(`├${"─".repeat(width - 2)}┤`)]);
		const body: RenderFrame[] = [];
		for (const [index, block] of blocks.entries()) {
			if (index > 0) body.push(divider);
			body.push(
				mapRenderFrameLines(
					prefixRenderFrame(block, `${border("│")} `),
					(line) => `${fitLine(line, width - 2)} ${border("│")}`,
				),
			);
		}
		return concatRenderFrames([
			createRenderFrame([header]),
			...body,
			createRenderFrame([border(`╰${"─".repeat(width - 2)}╯`)]),
		]);
	}

	private renderHeader(width: number, bordered: boolean): string {
		const badges = (this.props.badges ?? [])
			.map((badge) => this.theme[badge.token ?? "info"](`[${sanitizeText(badge.label).replace(/\n/g, " ")}]`))
			.join(" ");
		const badgesWidth = visibleWidth(badges);
		const titleToken = this.props.titleToken ?? "accent";
		if (!bordered) {
			const inline = badgesWidth > 0 && width - badgesWidth - 1 >= 4;
			const titleWidth = inline ? width - badgesWidth - 1 : width;
			const title = this.theme.bold(truncateStyledText(this.props.title, titleWidth, this.theme, titleToken));
			return truncateToWidth(inline ? `${title} ${badges}` : title, width, "");
		}
		const border = (text: string): string => this.theme.muted(text);
		const reserved = badgesWidth > 0 ? badgesWidth + 2 : 0;
		const showBadges = badgesWidth > 0 && width - 6 - reserved >= 4;
		const titleWidth = Math.max(1, width - 6 - (showBadges ? reserved : 0));
		const title = this.theme.bold(truncateStyledText(this.props.title, titleWidth, this.theme, titleToken));
		const used = 3 + visibleWidth(title) + 1 + (showBadges ? reserved : 0) + 1;
		const fill = "─".repeat(Math.max(0, width - used));
		return `${border("╭─ ")}${title}${border(` ${fill}`)}${showBadges ? ` ${badges} ` : ""}${border("╮")}`;
	}

	private syncFocusGroup(): void {
		const children = (this.props.sections ?? []).flatMap((section) => section.children);
		this.focusGroup.setChildren([...children, this.actionBar]);
		this.focusGroup.setChildFocusable(this.actionBar, this.actionBar.hasEnabledActions());
	}
}
