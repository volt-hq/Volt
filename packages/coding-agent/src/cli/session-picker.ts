/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setKeybindings, TuiMainScreen } from "@hansjm10/volt-tui";
import { KeybindingsManager } from "../core/keybindings.ts";
import { deleteStoredSession } from "../core/session-delete.ts";
import type { SessionInfo, SessionListProgress, SessionReference } from "../core/session-manager.ts";
import {
	SessionSelectorComponent,
	type SessionSelectorItem,
} from "../modes/interactive/components/session-selector.ts";
import { canonicalizePath } from "../utils/paths.ts";

type SessionsLoader = (onProgress?: SessionListProgress, query?: string) => Promise<SessionInfo[]>;

/** A stored session's identity across session directories that may name one directory by several paths. */
function sessionRefKey(ref: SessionReference): string {
	return `${canonicalizePath(ref.sessionDirectory)}\0${ref.storeId}\0${ref.sessionId}\0${ref.sessionGeneration}`;
}

/** A stored session as the session selector lists it, keyed by its reference. */
export function sessionSelectorItem(info: SessionInfo): SessionSelectorItem {
	return {
		key: sessionRefKey(info.ref),
		id: info.id,
		...(info.name === undefined ? {} : { name: info.name }),
		cwd: info.cwd,
		created: info.created,
		modified: info.modified,
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
		...(info.parentSessionRef === undefined ? {} : { parentKey: sessionRefKey(info.parentSessionRef) }),
		location: info.ref.sessionDirectory,
	};
}

/** Show TUI session selector and return the selected stable reference or null if cancelled. */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
): Promise<SessionReference | null> {
	// The selector lists sessions by key; the references they stand for, by the same key.
	const refs = new Map<string, SessionReference>();
	const listed =
		(load: SessionsLoader) =>
		async (onProgress?: SessionListProgress, query?: string): Promise<SessionSelectorItem[]> =>
			(await load(onProgress, query)).map((info) => {
				const item = sessionSelectorItem(info);
				refs.set(item.key, info.ref);
				return item;
			});
	const refOf = (session: SessionSelectorItem): SessionReference => {
		const ref = refs.get(session.key);
		if (!ref) throw new Error(`Session ${session.id} is not listed`);
		return ref;
	};
	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			listed(currentSessionsLoader),
			listed(allSessionsLoader),
			(session) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(refOf(session));
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings, deleteSession: (session) => deleteStoredSession(refOf(session)) },
		);

		ui.addChild(selector);
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
