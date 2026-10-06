/**
 * A single-file extension with a string flag, `spawn-flag`, that records the
 * flag's value each conversation that loaded it saw at `session_start`. The
 * record is on `globalThis` (its module may load more than once in a
 * process), so a test reads what a daemon's in-process worker saw.
 */

import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

export const manifest = {
	id: "spawn-flag",
	displayName: "Spawn flag",
} as const;

const RECORD = Symbol.for("volt.test.spawnFlag");

/** The flag value each conversation saw, by session id. */
export function spawnFlagRecord(): Map<string, boolean | string | undefined> {
	const global = globalThis as { [RECORD]?: Map<string, boolean | string | undefined> };
	global[RECORD] ??= new Map();
	return global[RECORD];
}

export default function spawnFlagExtension(volt: ExtensionAPI): void {
	volt.registerFlag("spawn-flag", { type: "string", description: "A value the test opens its conversation with" });
	volt.on("session_start", (_event, ctx) => {
		spawnFlagRecord().set(ctx.sessionManager.getSessionId(), volt.getFlag("spawn-flag"));
	});
}
