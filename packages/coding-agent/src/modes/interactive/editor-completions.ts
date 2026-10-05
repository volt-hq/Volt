/**
 * Extension completion providers in the TUI editor (RFC §8.3): when the token
 * before the cursor starts with a provider's trigger, the editor asks the
 * host's `editor_completions` query, as every client does, and its items
 * replace the token. Other text completes as the base provider completes it.
 */

import type { EditorCompletionItem } from "@hansjm10/volt-protocol";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@hansjm10/volt-tui";
import { completionToken } from "../../core/extensions/completions.ts";

export interface EditorCompletionsOptions {
	/** The triggers of the conversation's completion providers. */
	readonly triggers: readonly string[];
	/** Ask the host for completions of `text` at `cursor` (in Unicode scalars). */
	readonly complete: (text: string, cursor: number) => Promise<{ prefix: string; items: EditorCompletionItem[] }>;
}

/** `base` with completions from the extensions' providers for tokens their triggers start. */
export function withEditorCompletions(
	base: AutocompleteProvider,
	options: EditorCompletionsOptions,
): AutocompleteProvider {
	if (options.triggers.length === 0) return base;
	/** Items this provider offered: applying one replaces its prefix. */
	const offered = new WeakSet<AutocompleteItem>();
	const firstCharacters = options.triggers.map((trigger) => [...trigger][0] ?? "");
	return {
		triggerCharacters: [...new Set([...(base.triggerCharacters ?? []), ...firstCharacters])],
		async getSuggestions(lines, cursorLine, cursorCol, suggestionOptions): Promise<AutocompleteSuggestions | null> {
			const before = [...lines.slice(0, cursorLine), (lines[cursorLine] ?? "").slice(0, cursorCol)].join("\n");
			const cursor = [...before].length;
			const text = lines.join("\n");
			const token = completionToken(text, cursor);
			if (token.length > 0 && options.triggers.some((trigger) => token.startsWith(trigger))) {
				try {
					const answer = await options.complete(text, cursor);
					if (!suggestionOptions.signal.aborted && answer.items.length > 0 && answer.prefix === token) {
						const items = answer.items.map((item): AutocompleteItem => {
							const offeredItem = {
								value: item.value,
								label: item.label ?? item.value,
								...(item.description === undefined ? {} : { description: item.description }),
							};
							offered.add(offeredItem);
							return offeredItem;
						});
						return { items, prefix: answer.prefix };
					}
				} catch {
					// No completions from the extensions: the editor completes as it does without them.
				}
			}
			return base.getSuggestions(lines, cursorLine, cursorCol, suggestionOptions);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!offered.has(item)) return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const start = Math.max(0, cursorCol - prefix.length);
			const next = [...lines];
			next[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
			return { lines: next, cursorLine, cursorCol: start + item.value.length };
		},
		...(base.shouldTriggerFileCompletion === undefined
			? {}
			: {
					shouldTriggerFileCompletion: (lines: string[], cursorLine: number, cursorCol: number) =>
						base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false,
				}),
	};
}
