import { type FocusDirection, type FocusScope, isFocusScope } from "../focus.ts";
import { getKeybindings } from "../keybindings.ts";
import { concatRenderFrames, createRenderFrame, type RenderFrame } from "../render-frame.ts";
import { type SemanticTheme, type StyledText, truncateStyledText } from "../styled-text.ts";
import { type Component, type Focusable, isFocusable } from "../tui.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

export interface TabItem {
	id: string;
	label: StyledText;
	content: Component;
}

export interface TabsProps {
	tabs: readonly TabItem[];
	/** Initially active tab. A changed value switches tabs. */
	activeId?: string;
}

const TAB_SEPARATOR = " │ ";

/**
 * Tab strip above the active tab's content. The strip is one focus stop where left/right switch tabs;
 * Tab moves into focusable content and on to the next control.
 */
export class Tabs implements Component, Focusable, FocusScope {
	onChange?: (id: string) => void;
	private readonly theme: SemanticTheme;
	private props: TabsProps;
	private activeId: string | undefined;
	private contentFocused = false;
	private hasFocus = false;

	constructor(theme: SemanticTheme, props: TabsProps) {
		this.theme = theme;
		this.props = props;
		this.activeId = this.resolveActive(props.activeId);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		this.hasFocus = focused;
		this.syncContentFocus();
	}

	setProps(props: TabsProps): void {
		const previousContent = this.activeContent();
		const previous = this.props;
		this.props = props;
		this.activeId = this.resolveActive(props.activeId !== previous.activeId ? props.activeId : this.activeId);
		this.handleContentChange(previousContent);
	}

	getActiveId(): string | undefined {
		return this.activeId;
	}

	/** Activate a tab by id. Returns false when no such tab exists. */
	selectTab(id: string): boolean {
		if (!this.props.tabs.some((tab) => tab.id === id)) return false;
		if (id === this.activeId) return true;
		const previousContent = this.activeContent();
		this.activeId = id;
		this.handleContentChange(previousContent);
		this.onChange?.(id);
		return true;
	}

	moveFocus(direction: FocusDirection): boolean {
		const content = this.activeContent();
		if (this.contentFocused && content) {
			if (isFocusScope(content) && content.moveFocus(direction)) return true;
			if (direction === 1) return false;
			this.setContentFocused(false);
			return true;
		}
		return direction === 1 && this.enterContent(1);
	}

	enterFocus(direction: FocusDirection): boolean {
		if (direction === -1 && this.enterContent(-1)) return true;
		this.setContentFocused(false);
		return this.props.tabs.length > 0;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.focus.next") || keybindings.matches(data, "tui.focus.previous")) {
			const direction = keybindings.matches(data, "tui.focus.next") ? 1 : -1;
			if (!this.moveFocus(direction)) this.enterFocus(direction);
			return;
		}
		if (this.contentFocused) {
			this.activeContent()?.handleInput?.(data);
			return;
		}
		if (keybindings.matches(data, "tui.select.left")) this.cycle(-1);
		else if (keybindings.matches(data, "tui.select.right")) this.cycle(1);
	}

	invalidate(): void {
		for (const tab of this.props.tabs) tab.content.invalidate();
	}

	render(width: number): RenderFrame {
		const strip = this.renderStrip(width);
		const content = this.activeContent();
		const header = createRenderFrame([strip, this.theme.muted("─".repeat(Math.max(0, width)))]);
		return content ? concatRenderFrames([header, content.render(width)]) : header;
	}

	private renderStrip(width: number): string {
		const { tabs } = this.props;
		const activeIndex = tabs.findIndex((tab) => tab.id === this.activeId);
		const labels = tabs.map((tab, index) => {
			const active = index === activeIndex;
			const label = truncateStyledText(tab.label, Math.max(1, width - 4), this.theme, active ? "accent" : "muted");
			if (!active) return label;
			const emphasized = this.theme.bold(label);
			return this.hasFocus && !this.contentFocused ? this.theme.underline(emphasized) : emphasized;
		});
		let first = 0;
		const stripWidth = (start: number): number =>
			labels
				.slice(start, Math.max(activeIndex + 1, start + 1))
				.reduce((sum, label) => sum + visibleWidth(label), 0) +
			Math.max(0, activeIndex - start) * TAB_SEPARATOR.length +
			(start > 0 ? 2 : 0);
		while (first < activeIndex && stripWidth(first) > width) first++;
		const separator = this.theme.muted(TAB_SEPARATOR);
		const strip = (first > 0 ? this.theme.muted("… ") : "") + labels.slice(first).join(separator);
		return truncateToWidth(strip, width, this.theme.muted("…"));
	}

	private resolveActive(preferred: string | undefined): string | undefined {
		const { tabs } = this.props;
		return (
			tabs.find((tab) => tab.id === preferred)?.id ?? tabs.find((tab) => tab.id === this.activeId)?.id ?? tabs[0]?.id
		);
	}

	private activeContent(): Component | undefined {
		return this.props.tabs.find((tab) => tab.id === this.activeId)?.content;
	}

	private cycle(direction: 1 | -1): void {
		const { tabs } = this.props;
		if (tabs.length === 0) return;
		const index = tabs.findIndex((tab) => tab.id === this.activeId);
		this.selectTab(tabs[(index + direction + tabs.length) % tabs.length]!.id);
	}

	private enterContent(direction: FocusDirection): boolean {
		const content = this.activeContent();
		if (!content || typeof content.handleInput !== "function") return false;
		if (isFocusScope(content) && !content.enterFocus(direction)) return false;
		this.setContentFocused(true);
		return true;
	}

	private setContentFocused(focused: boolean): void {
		this.contentFocused = focused;
		this.syncContentFocus();
	}

	private syncContentFocus(): void {
		const content = this.activeContent();
		if (content && isFocusable(content)) content.focused = this.hasFocus && this.contentFocused;
	}

	private handleContentChange(previousContent: Component | undefined): void {
		const content = this.activeContent();
		if (content === previousContent) return;
		if (previousContent && isFocusable(previousContent)) previousContent.focused = false;
		this.contentFocused = false;
		this.syncContentFocus();
	}
}
