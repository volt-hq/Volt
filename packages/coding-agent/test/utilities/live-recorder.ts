/**
 * A live view for tests: it records every update the live state delivers and
 * accepts the host request kinds it was given.
 */

import type { HostRequest, HostRequestKind, LiveItem } from "@hansjm10/volt-protocol";
import type { LiveClient, LiveUpdate } from "../../src/core/host/live-state.ts";

/** Keys of the values a conversation's session feeds into its live state, beside the extensions' UI. */
export const SESSION_FED_LIVE_KEYS: ReadonlySet<string> = new Set([
	"phase",
	"git",
	"prompt_cache",
	"usage",
	"intents",
	"jobs",
]);

/** Whether `item` is extension UI or a host request: not a session-fed value and not streaming. */
function isUiItem(item: LiveItem): boolean {
	if (item.type === "set" || item.type === "clear") return !SESSION_FED_LIVE_KEYS.has(item.key);
	return item.type === "notice" || item.type === "directive";
}

export interface LiveRecorder extends LiveClient {
	readonly updates: LiveUpdate[];
	/** Every delivered item, in order. */
	items(): LiveItem[];
	/** The delivered extension UI and host request items, in order: no session-fed values or streaming. */
	uiItems(): LiveItem[];
	/** The delivered notices as `[level, message]`. */
	notices(): Array<[string, string]>;
	/** The delivered extension status changes as `[key, text]`; a cleared status has no text. */
	statuses(): Array<[string, string | undefined]>;
	/** The host requests delivered and not cleared since, oldest first. */
	pending(): Array<{ requestId: string; request: HostRequest }>;
}

export function createLiveRecorder(accepts: readonly HostRequestKind[] = []): LiveRecorder {
	const updates: LiveUpdate[] = [];
	const items = (): LiveItem[] => updates.flatMap((update) => update.items);
	return {
		updates,
		acceptsHostRequest: (kind) => accepts.includes(kind),
		apply: (update) => {
			updates.push(update);
		},
		items,
		uiItems: () => items().filter(isUiItem),
		notices: () =>
			items().flatMap(
				(item): Array<[string, string]> => (item.type === "notice" ? [[item.level, item.message]] : []),
			),
		statuses: () =>
			items().flatMap((item): Array<[string, string | undefined]> => {
				if (item.type === "set" && item.value.kind === "ext_status") {
					return [[item.key.slice("ext_status/".length), item.value.text]];
				}
				if (item.type === "clear" && item.key.startsWith("ext_status/")) {
					return [[item.key.slice("ext_status/".length), undefined]];
				}
				return [];
			}),
		pending: () => {
			const pending = new Map<string, HostRequest>();
			for (const update of updates) {
				if (update.reset) pending.clear();
				for (const item of update.items) {
					if (item.type === "set" && item.value.kind === "host_request") {
						pending.set(item.value.requestId, item.value.request);
					} else if (item.type === "clear" && item.key.startsWith("host_request/")) {
						pending.delete(item.key.slice("host_request/".length));
					}
				}
			}
			return [...pending].map(([requestId, request]) => ({ requestId, request }));
		},
	};
}
