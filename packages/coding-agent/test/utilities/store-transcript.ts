/**
 * The transcript a TUI client's store holds for a session: its log projected
 * on the local profile, as a snapshot carries it, from its newest compaction.
 */

import { clientActiveBranch, clientRestore, type ProjectedEntry } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { conversationProjectionSource } from "../../src/core/protocol/projection/entries.ts";
import { logSnapshot } from "../../src/core/protocol/server/subscription.ts";
import { transcriptOf } from "../../src/modes/interactive/client/tui-store.ts";

export function storeTranscript(session: AgentSession): ProjectedEntry[] {
	const manager = session.sessionManager;
	const ordinal = manager.getOrdinal();
	const snapshot = logSnapshot(manager, localProfile, ordinal, conversationProjectionSource(session));
	return transcriptOf(clientActiveBranch(clientRestore(ordinal, snapshot)));
}
