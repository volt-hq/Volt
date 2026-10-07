/**
 * A single-file extension that records each `session_start` it hears: the
 * session, the reason, and the previous session's id. The records are on
 * `globalThis` (its module may load more than once in a process), so a test
 * reads what a daemon's in-process worker heard.
 */

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "session-start-recorder",
	displayName: "Session start recorder",
} as const;

export interface SessionStartRecord {
	readonly sessionId: string;
	readonly reason: string;
	readonly previousSessionId?: string;
}

const STATE = Symbol.for("volt.test.sessionStarts");

export function sessionStarts(): SessionStartRecord[] {
	const global = globalThis as { [STATE]?: SessionStartRecord[] };
	global[STATE] ??= [];
	return global[STATE];
}

export default function sessionStartExtension(volt: ExtensionAPI): void {
	volt.on("session_start", (event, ctx) => {
		const previousSessionId = event.previousSessionRef?.sessionId;
		sessionStarts().push({
			sessionId: ctx.sessionManager.getSessionId(),
			reason: event.reason,
			...(previousSessionId === undefined ? {} : { previousSessionId }),
		});
	});
}
