import type { SessionEntry } from "../session-manager.ts";
import { decodeBridgeValue } from "./codec.ts";
import { MAX_STORED_KEY_CHARS } from "./limits.ts";
import type { CodeModeStoreWrites } from "./runtime.ts";

/**
 * The `custom` session entries that record scripts' writes to a conversation's stored values (section 5.17 of
 * docs/code-mode-design.md): one entry per script that wrote anything, appended when the script ends.
 */
export const CODE_MODE_STORE_ENTRY_TYPE = "volt-run-code-store";

/**
 * What one entry records: the keys a script left set, with the codec text of their values, and the stored keys it
 * deleted. Values stay codec text, because session JSON rejects some values the codec keeps, such as BigInt and -0.
 */
export interface CodeModeStoreEntryData {
	set: Array<[string, string]>;
	delete: string[];
}

export function codeModeStoreEntryData(writes: CodeModeStoreWrites): CodeModeStoreEntryData {
	return { set: writes.set.map(([key, value]): [string, string] => [key, value]), delete: [...writes.delete] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A key the prelude accepts: 1 to 256 characters without lone surrogates. */
function isStoredKey(key: unknown): key is string {
	return (
		typeof key === "string" &&
		key.length > 0 &&
		key.length <= MAX_STORED_KEY_CHARS &&
		Buffer.from(key).toString() === key
	);
}

function isCodecText(value: string): boolean {
	try {
		decodeBridgeValue(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * A conversation's stored values: the fold of its store entries along `branch`, root first, so a branch or fork sees
 * the values written on its own path. Entries that are not well-formed are skipped, and so are keys and values the
 * prelude could not have written.
 */
export function foldCodeModeStore(branch: Iterable<SessionEntry>): Array<[string, string]> {
	const values = new Map<string, string>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== CODE_MODE_STORE_ENTRY_TYPE) continue;
		const data: unknown = entry.data;
		if (!isRecord(data) || !Array.isArray(data.set) || !Array.isArray(data.delete)) continue;
		for (const pair of data.set) {
			if (Array.isArray(pair) && pair.length === 2 && isStoredKey(pair[0]) && typeof pair[1] === "string") {
				values.set(pair[0], pair[1]);
			}
		}
		for (const key of data.delete) if (typeof key === "string") values.delete(key);
	}
	// Decoded only once folded: a long conversation rewrites its values many times.
	return [...values].filter(([, value]) => isCodecText(value));
}
