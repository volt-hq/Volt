import { getKeybindings } from "./keybindings.ts";
import { type Component, Container, type Focusable, isFocusable } from "./tui.ts";

/** Traversal direction: 1 moves forward (Tab), -1 moves backward (Shift+Tab). */
export type FocusDirection = 1 | -1;

/**
 * A component that owns focus traversal over its own parts. A {@link FocusGroup} hands Tab traversal to a
 * focused scope first and moves past it only when the scope reports that focus would leave it.
 */
export interface FocusScope {
	/** Move focus inside the scope. Returns false when focus would leave the scope. */
	moveFocus(direction: FocusDirection): boolean;
	/** Focus the first (1) or last (-1) part. Returns false when nothing in the scope can take focus. */
	enterFocus(direction: FocusDirection): boolean;
}

export function isFocusScope(component: Component): component is Component & FocusScope {
	const candidate = component as Partial<FocusScope>;
	return typeof candidate.moveFocus === "function" && typeof candidate.enterFocus === "function";
}

export interface FocusGroupChildOptions {
	/** Whether traversal can stop on this child. Defaults to whether the child handles input. */
	focusable?: boolean;
}

export interface FocusGroupOptions {
	/** Wrap around at either end when this group handles the traversal keys itself. Defaults to true. */
	wrap?: boolean;
}

function setFocusedFlag(component: Component, focused: boolean): void {
	if (isFocusable(component)) component.focused = focused;
}

/**
 * Vertical container that routes input to one active child and moves between focusable children with the
 * `tui.focus.next` and `tui.focus.previous` keybindings. Nested scopes (including nested groups) are
 * traversed before moving to the next sibling. Focus the group itself with `TUI.setFocus`.
 */
export class FocusGroup extends Container implements Focusable, FocusScope {
	/** Called after the active child changes. */
	onFocusChange?: (component: Component | undefined) => void;
	private readonly wrap: boolean;
	private readonly excluded = new Set<Component>();
	private active: Component | undefined;
	private hasFocus = false;

	constructor(children: readonly Component[] = [], options: FocusGroupOptions = {}) {
		super();
		this.wrap = options.wrap ?? true;
		this.setChildren(children);
	}

	get focused(): boolean {
		return this.hasFocus;
	}

	set focused(focused: boolean) {
		if (this.hasFocus === focused) return;
		this.hasFocus = focused;
		if (this.active) setFocusedFlag(this.active, focused);
	}

	/** The child that receives input, if any. */
	getFocusedChild(): Component | undefined {
		return this.active;
	}

	override addChild(component: Component, options: FocusGroupChildOptions = {}): void {
		super.addChild(component);
		if (options.focusable === false) this.excluded.add(component);
		else this.excluded.delete(component);
		if (!this.active && this.canFocus(component)) this.setActive(component);
	}

	override removeChild(component: Component): void {
		const index = this.children.indexOf(component);
		if (index === -1) return;
		super.removeChild(component);
		this.excluded.delete(component);
		if (this.active === component) this.setActive(this.nearestFocusable(index));
	}

	override clear(): void {
		this.setChildren([]);
	}

	/** Replace all children. The active child keeps focus when it is still present. */
	setChildren(children: readonly Component[]): void {
		const previousIndex = this.active ? this.children.indexOf(this.active) : 0;
		this.children = [...children];
		for (const component of [...this.excluded]) {
			if (!this.children.includes(component)) this.excluded.delete(component);
		}
		if (this.active && this.children.includes(this.active) && this.canFocus(this.active)) return;
		this.setActive(this.nearestFocusable(previousIndex));
	}

	/** Change whether traversal can stop on a child. */
	setChildFocusable(component: Component, focusable: boolean): void {
		if (focusable) this.excluded.delete(component);
		else this.excluded.add(component);
		if (!focusable && this.active === component) {
			this.setActive(this.nearestFocusable(this.children.indexOf(component)));
		} else if (focusable && !this.active && this.canFocus(component)) {
			this.setActive(component);
		}
	}

	/** Make a child, or a component inside a nested group, the input target. */
	focus(target: Component): boolean {
		for (const child of this.children) {
			if (child === target) {
				if (!this.canFocus(child)) return false;
				this.setActive(child);
				return true;
			}
			if (child instanceof FocusGroup && this.canFocus(child) && child.focus(target)) {
				this.setActive(child);
				return true;
			}
		}
		return false;
	}

	moveFocus(direction: FocusDirection): boolean {
		const candidates = this.focusableChildren();
		const active = this.active;
		const index = active ? candidates.indexOf(active) : -1;
		if (index === -1) return this.enterFocus(direction);
		if (active && isFocusScope(active) && active.moveFocus(direction)) return true;
		for (let next = index + direction; next >= 0 && next < candidates.length; next += direction) {
			if (this.tryEnter(candidates[next]!, direction)) return true;
		}
		return false;
	}

	enterFocus(direction: FocusDirection): boolean {
		const candidates = this.focusableChildren();
		if (direction === -1) candidates.reverse();
		return candidates.some((candidate) => this.tryEnter(candidate, direction));
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.focus.next")) {
			if (!this.moveFocus(1) && this.wrap) this.enterFocus(1);
			return;
		}
		if (keybindings.matches(data, "tui.focus.previous")) {
			if (!this.moveFocus(-1) && this.wrap) this.enterFocus(-1);
			return;
		}
		this.active?.handleInput?.(data);
	}

	private canFocus(component: Component): boolean {
		return !this.excluded.has(component) && typeof component.handleInput === "function";
	}

	private focusableChildren(): Component[] {
		return this.children.filter((child) => this.canFocus(child));
	}

	private nearestFocusable(index: number): Component | undefined {
		for (let next = Math.max(0, index); next < this.children.length; next++) {
			if (this.canFocus(this.children[next]!)) return this.children[next];
		}
		for (let next = Math.min(index, this.children.length) - 1; next >= 0; next--) {
			if (this.canFocus(this.children[next]!)) return this.children[next];
		}
		return undefined;
	}

	private tryEnter(component: Component, direction: FocusDirection): boolean {
		if (isFocusScope(component) && !component.enterFocus(direction)) return false;
		this.setActive(component);
		return true;
	}

	private setActive(component: Component | undefined): void {
		if (component === this.active) return;
		if (this.active && this.hasFocus) setFocusedFlag(this.active, false);
		this.active = component;
		if (component && this.hasFocus) setFocusedFlag(component, true);
		this.onFocusChange?.(component);
	}
}
