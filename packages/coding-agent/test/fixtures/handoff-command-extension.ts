/**
 * A single-file extension with a `handoff` command that starts a new session
 * through `ctx.newSession`, seeding it from `withSession`. What it saw is
 * recorded on `globalThis` (its module may load more than once in a process),
 * so a test can read what a conversation it did not build itself (a daemon's
 * in-process worker) ran.
 */

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "handoff-command",
	displayName: "Handoff command",
} as const;

/** What the extension recorded across the conversations that loaded it. */
export interface HandoffRecord {
	/** The sessions a `withSession` seeded. */
	readonly seeds: string[];
	/** What each `ctx.newSession()` returned. */
	readonly handoffs: unknown[];
	/** Session lifecycle events: type, session, and reason. */
	readonly events: Array<{ type: string; sessionId: string; reason?: string }>;
}

const RECORD = Symbol.for("volt.test.handoffCommand");

/** The record the extension writes, created on first use. */
export function handoffRecord(): HandoffRecord {
	const global = globalThis as { [RECORD]?: HandoffRecord };
	global[RECORD] ??= { seeds: [], handoffs: [], events: [] };
	return global[RECORD];
}

export default function handoffCommandExtension(volt: ExtensionAPI): void {
	const record = handoffRecord();
	volt.on("session_start", (event, ctx) => {
		record.events.push({ type: event.type, sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
	});
	volt.on("session_before_switch", (event, ctx) => {
		record.events.push({ type: event.type, sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
	});
	volt.on("session_shutdown", (event, ctx) => {
		record.events.push({ type: event.type, sessionId: ctx.sessionManager.getSessionId(), reason: event.reason });
	});
	volt.registerCommand("handoff", {
		remoteSafe: true,
		handler: async (_args, ctx) => {
			record.handoffs.push(
				await ctx.newSession({
					withSession: async (next) => {
						record.seeds.push(next.sessionManager.getSessionId());
					},
				}),
			);
		},
	});
}
