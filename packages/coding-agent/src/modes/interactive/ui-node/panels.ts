/**
 * Extension panels in the TUI (RFC §8.3): named `UiNode` panels with a
 * placement hint. Each renders under its optional title through its own
 * retained `UiNode` view, so a keyed update keeps component state (form
 * input, tree expansion, terminal rows).
 *
 * `aboveEditor` and `belowEditor` panels render in the editor dock in both
 * screen modes. `sidebar` panels render in the sidebar slot in fullscreen
 * mode; regular mode has no sidebar, so they render above the editor there.
 * The slot follows the screen mode at each render. A panel shows at most
 * `maxRows` rows: the rest are cut and counted.
 *
 * The panels' interactive components (actions, forms, cards, trees) take the
 * keyboard through a `PanelFocus`: Tab moves through them in slot order, and
 * moving past either end, or cancelling, gives it back.
 */

import type { ExtensionPanelPlacementSchema, LiveValue, UiNode } from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	FocusGroup,
	getKeybindings,
	type RenderFrame,
	sliceRenderFrame,
	type TuiMode,
	truncateStyledText,
	truncateToWidth,
	type ViewReconciler,
} from "@hansjm10/volt-tui";
import type { Static } from "typebox";
import { theme } from "../../../core/theme/runtime.ts";
import { createUiNodeView, type UiNodeViewOptions } from "./registry.ts";
import { TUI_SEMANTIC_THEME } from "./semantic-theme.ts";

export type ExtensionPanelPlacement = Static<typeof ExtensionPanelPlacementSchema>;

/** One panel an extension declares: an `ext_panel` live value's title, placement, and node. */
export type UiPanel = Pick<Extract<LiveValue, { kind: "ext_panel" }>, "title" | "placement" | "node">;

/** Where a panel with `placement` renders in screen mode `mode`. */
export function panelSlot(placement: ExtensionPanelPlacement, mode: TuiMode): ExtensionPanelPlacement {
	return placement === "sidebar" && mode !== "fullscreen" ? "aboveEditor" : placement;
}

export interface UiPanelsOptions extends UiNodeViewOptions {
	/** The TUI's screen mode, read at each render. */
	readonly mode: () => TuiMode;
	/** Most rows one panel shows, its title included. Defaults to {@link DEFAULT_PANEL_MAX_ROWS}. */
	readonly maxRows?: number;
}

export const DEFAULT_PANEL_MAX_ROWS = 12;

interface PanelEntry {
	panel: UiPanel;
	readonly view: ViewReconciler<UiNode>;
}

/** The extension panels of one conversation view, rendered into three slot components the TUI mounts. */
export class UiPanels {
	/** Mount above the editor in both screen modes. */
	readonly aboveEditor: Component;
	/** Mount below the editor in both screen modes. */
	readonly belowEditor: Component;
	/** Mount beside the transcript in fullscreen mode; it renders nothing in regular mode. */
	readonly sidebar: Component;
	private readonly options: UiPanelsOptions;
	private readonly entries = new Map<string, PanelEntry>();

	constructor(options: UiPanelsOptions) {
		this.options = options;
		// A slot renders its panels in the order they were first set.
		const slot = (placement: ExtensionPanelPlacement): Component => ({
			invalidate: () => {
				for (const entry of this.entriesIn(placement)) entry.view.invalidate();
			},
			render: (width) =>
				concatRenderFrames(this.entriesIn(placement).map((entry) => this.renderPanel(entry, width))),
		});
		this.aboveEditor = slot("aboveEditor");
		this.belowEditor = slot("belowEditor");
		this.sidebar = slot("sidebar");
	}

	/**
	 * Show `panel` under `key`, updating the panel already there in place, or
	 * remove it. A node the view cannot reconcile (duplicate sibling keys)
	 * removes the panel and throws.
	 */
	set(key: string, panel: UiPanel | undefined): void {
		const existing = this.entries.get(key);
		if (panel === undefined) {
			existing?.view.dispose();
			this.entries.delete(key);
			return;
		}
		const entry = existing ?? { panel, view: createUiNodeView(this.options) };
		try {
			entry.view.update([panel.node]);
		} catch (error) {
			entry.view.dispose();
			this.entries.delete(key);
			throw error;
		}
		entry.panel = panel;
		this.entries.set(key, entry);
	}

	/** The keys of the panels shown, in order. */
	keys(): string[] {
		return [...this.entries.keys()];
	}

	/** Whether a panel with `placement` is shown. */
	has(placement: ExtensionPanelPlacement): boolean {
		for (const entry of this.entries.values()) if (entry.panel.placement === placement) return true;
		return false;
	}

	/** The retained view of the panel under `key`. */
	getView(key: string): ViewReconciler<UiNode> | undefined {
		return this.entries.get(key)?.view;
	}

	/**
	 * The interactive components the panels render in screen mode `mode`, in
	 * the order the keyboard reaches them: above the editor, below it, then
	 * the sidebar.
	 */
	focusables(mode: TuiMode): Component[] {
		const slots: ExtensionPanelPlacement[] = ["aboveEditor", "belowEditor", "sidebar"];
		return slots.flatMap((slot) =>
			[...this.entries.values()]
				.filter((entry) => panelSlot(entry.panel.placement, mode) === slot)
				.flatMap((entry) => entry.view.children.filter((child) => typeof child.handleInput === "function")),
		);
	}

	/** Remove every panel. */
	clear(): void {
		for (const entry of this.entries.values()) entry.view.dispose();
		this.entries.clear();
	}

	/** The panels rendering in `slot` now. */
	private entriesIn(slot: ExtensionPanelPlacement): PanelEntry[] {
		const mode = this.options.mode();
		return [...this.entries.values()].filter((entry) => panelSlot(entry.panel.placement, mode) === slot);
	}

	private renderPanel(entry: PanelEntry, width: number): RenderFrame {
		const maxRows = Math.max(2, this.options.maxRows ?? DEFAULT_PANEL_MAX_ROWS);
		const frames: RenderFrame[] = [];
		const { title } = entry.panel;
		if (title !== undefined) {
			frames.push(
				createRenderFrame([
					TUI_SEMANTIC_THEME.bold(truncateStyledText(title, width, TUI_SEMANTIC_THEME, "accent")),
				]),
			);
		}
		frames.push(entry.view.render(width));
		const frame = concatRenderFrames(frames);
		if (frame.lines.length <= maxRows) return frame;
		const hidden = frame.lines.length - (maxRows - 1);
		return concatRenderFrames([
			sliceRenderFrame(frame, 0, maxRows - 1),
			createRenderFrame([theme.fg("muted", truncateToWidth(`… ${hidden} more rows`, width, ""))]),
		]);
	}
}

/**
 * Keyboard focus in the extension panels: `tui.focus.next` and
 * `tui.focus.previous` move through their interactive components (a card's
 * own parts first), and moving past either end, or `tui.select.cancel`,
 * leaves the panels. Other keys go to the focused component.
 */
export class PanelFocus extends FocusGroup {
	private readonly onLeave: () => void;

	constructor(onLeave: () => void) {
		super([], { wrap: false });
		this.onLeave = onLeave;
	}

	override handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.focus.next")) {
			if (!this.moveFocus(1)) this.onLeave();
			return;
		}
		if (keybindings.matches(data, "tui.focus.previous")) {
			if (!this.moveFocus(-1)) this.onLeave();
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onLeave();
			return;
		}
		super.handleInput(data);
	}
}
