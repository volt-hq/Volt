/**
 * What the TUI's commands show in the conversation it shows: notices and
 * text in the transcript, and dialogs and selectors in place of the editor.
 * Commands that act on a conversation show through this instead of reaching
 * into the TUI's components.
 */

import type { Component } from "@hansjm10/volt-tui";

/** Builds a selector shown in place of the conversation; it calls `done` to close. */
export type SelectorFactory = (done: () => void) => { component: Component; focus: Component; dispose?: () => void };

export interface ConversationPresenter {
	/** Show a status line; back-to-back status lines replace each other. */
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
	/** Show a block of text. */
	showText(text: string): void;
	/** Ask the user to pick one of `options`: the one picked, or undefined when the selector closed without one. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Ask the user a yes/no question: true for yes. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Ask the user for a line of text: undefined when the input closed without one. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** Show the selector `create` builds until it calls `done`. */
	showSelector(create: SelectorFactory): void;
	requestRender(): void;
}
