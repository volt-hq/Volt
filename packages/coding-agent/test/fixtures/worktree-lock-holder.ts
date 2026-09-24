import { tryAcquireWorktreeLock } from "../../src/daemon/worktree-lock.ts";

const [agentDir, checkoutPath, mode] = process.argv.slice(2);
const lock = tryAcquireWorktreeLock(agentDir, checkoutPath, mode === "shared");
if (!lock) throw new Error("Fixture could not acquire checkout protection");
process.on("message", () => {
	lock.close();
	process.disconnect();
});
process.send?.("locked");
