/**
 * Editor completions from extension completion providers (RFC §8.3), as the
 * `editor_completions` query answers them: the token before the cursor picks
 * the providers whose trigger starts it, in load order, and the first that
 * answers with items wins; all of them share {@link EDITOR_COMPLETIONS_TIMEOUT_MS}. Items
 * are bounded ({@link EDITOR_COMPLETIONS_MAX_ITEMS}, each text at most
 * `EDITOR_COMPLETION_TEXT_MAX_CHARS`) and plain: terminal controls are
 * removed, and a remote client's result passes the connection's redaction.
 */

import {
	EDITOR_COMPLETION_TEXT_MAX_CHARS,
	EDITOR_COMPLETIONS_MAX_ITEMS,
	type EditorCompletionItem,
} from "@hansjm10/volt-protocol";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";
import type { ExtensionError, RegisteredCompletionProvider } from "./types.ts";

/** How long the host waits for the providers of one query, together. */
export const EDITOR_COMPLETIONS_TIMEOUT_MS = 1_000;

export { EDITOR_COMPLETIONS_MAX_ITEMS };

/** The answer of the `editor_completions` query: `items` replace `prefix`, which ends at the cursor. */
export interface EditorCompletions {
	readonly prefix: string;
	readonly items: EditorCompletionItem[];
}

export interface EditorCompletionOptions {
	/** Report a provider that failed or answered with something other than items. */
	readonly onError?: (error: ExtensionError) => void;
	/** Aborted when the asker no longer waits. */
	readonly signal?: AbortSignal;
}

/** One line of completion text: controls removed, at most the protocol's bound. */
function completionText(value: string): string {
	const text = stripTerminalControls(value).replace(/[\r\n\t]+/g, " ");
	const scalars = [...text];
	return scalars.length <= EDITOR_COMPLETION_TEXT_MAX_CHARS
		? text
		: scalars.slice(0, EDITOR_COMPLETION_TEXT_MAX_CHARS).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The items a provider answered, bounded; undefined when it answered something else. */
function keptItems(answer: unknown): EditorCompletionItem[] | undefined {
	if (answer === undefined || answer === null) return [];
	if (!Array.isArray(answer)) return undefined;
	const items: EditorCompletionItem[] = [];
	for (const item of answer.slice(0, EDITOR_COMPLETIONS_MAX_ITEMS)) {
		if (!isRecord(item) || typeof item.value !== "string") return undefined;
		const value = completionText(item.value);
		if (value.length === 0) continue;
		items.push({
			value,
			...(typeof item.label === "string" ? { label: completionText(item.label) } : {}),
			...(typeof item.description === "string" ? { description: completionText(item.description) } : {}),
		});
	}
	return items;
}

/** The token before `cursor` (in Unicode scalars): the text after the last whitespace. */
export function completionToken(text: string, cursor: number): string {
	const before = [...text].slice(0, Math.max(0, cursor)).join("");
	return /(?:^|\s)(\S*)$/u.exec(before)?.[1] ?? "";
}

/** Ask one provider, waiting at most `timeoutMs`. */
async function ask(
	provider: RegisteredCompletionProvider,
	request: { text: string; cursor: number; prefix: string; query: string },
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<unknown> {
	const controller = new AbortController();
	const abort = (): void => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(undefined);
			}, timeoutMs);
			timer.unref?.();
		});
		const answer = Promise.resolve().then(() => provider.complete({ ...request, signal: controller.signal }));
		// A provider that settles after the timeout is not awaited; its failure goes nowhere.
		answer.catch(() => {});
		return await Promise.race([answer, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

/**
 * Completions for the token before `cursor` in `text` from `providers`, in
 * order: the first provider whose trigger starts the token and that answers
 * with items. None answers with no items.
 */
export async function completeEditorText(
	providers: readonly RegisteredCompletionProvider[],
	text: string,
	cursor: number,
	options: EditorCompletionOptions = {},
): Promise<EditorCompletions> {
	const token = completionToken(text, cursor);
	const prefix = completionText(token);
	const deadline = Date.now() + EDITOR_COMPLETIONS_TIMEOUT_MS;
	for (const provider of providers) {
		const remaining = deadline - Date.now();
		if (options.signal?.aborted || remaining <= 0) break;
		if (!token.startsWith(provider.trigger)) continue;
		const request = { text, cursor, prefix: token, query: token.slice(provider.trigger.length) };
		let answer: unknown;
		try {
			answer = await ask(provider, request, options.signal, remaining);
		} catch (error) {
			options.onError?.({
				extensionId: provider.extensionId,
				event: "completion",
				error: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		const items = keptItems(answer);
		if (items === undefined) {
			options.onError?.({
				extensionId: provider.extensionId,
				event: "completion",
				error: `Completion provider ${provider.name} answered something other than items`,
			});
			continue;
		}
		if (items.length > 0) return { prefix, items };
	}
	return { prefix, items: [] };
}
