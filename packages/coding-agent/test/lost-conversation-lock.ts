import type { SessionManager } from "../src/core/session-manager.ts";

/**
 * Simulate losing a live writer's OS lock (an OS lock gives no loss signal), so
 * a second writer can open the same log. The store's ordinal fence then detects
 * the lost lock at commit time.
 */
export function loseConversationLock(manager: SessionManager): void {
	(manager as unknown as { conversationLock?: { close(): void } }).conversationLock?.close();
}
