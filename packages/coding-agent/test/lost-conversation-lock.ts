import type { ConversationLogLostError } from "@hansjm10/volt-agent-core";
import { vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../src/core/session-store/index.ts";

/**
 * Simulate losing a live writer's lock. An OS lock gives no loss signal, so a
 * writer finds out when it commits: the store's ordinal fence reports that
 * another writer appended. The next commit of `manager`'s session gets that
 * conflict, injected through the shared store client the way the store tests
 * inject other faults.
 */
export async function loseConversationLock(manager: SessionManager): Promise<void> {
	const lease = await acquireSharedSQLiteSessionStore(manager.getSessionDir());
	try {
		const { client } = lease;
		const applyTransaction = client.applyTransaction.bind(client);
		const sessionId = manager.getSessionId();
		let fenced = false;
		vi.spyOn(client, "applyTransaction").mockImplementation(async (input) => {
			if (fenced || input.sessionId !== sessionId) return applyTransaction(input);
			fenced = true;
			return { status: "conflict", actualOrdinal: input.expectedOrdinal + 1 };
		});
	} finally {
		await lease.release();
	}
}

/** Lose `manager`'s lock and commit one write, so the manager loses its log now. */
export async function loseLog(manager: SessionManager): Promise<ConversationLogLostError> {
	await loseConversationLock(manager);
	await manager.appendCustomEntry("lost-lock-probe").catch(() => undefined);
	return manager.lost;
}
