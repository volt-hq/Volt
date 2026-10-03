import { setImmediate } from "node:timers/promises";
import { ConversationLock } from "../../src/core/conversation-log/conversation-lock.ts";

const [sessionDirectory, sessionId] = process.argv.slice(2);
// Drop the lock object and collect it: only close() or process exit may release the lock.
const { status } = ConversationLock.tryAcquire(sessionDirectory, sessionId);
globalThis.gc?.();
await setImmediate();
// Exit on request without closing the lock: the OS releases it with the process.
process.on("message", () => process.exit(0));
process.send?.(status);
