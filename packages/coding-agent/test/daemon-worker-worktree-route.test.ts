/**
 * A conversation worker's process reaches its daemon only over its own
 * connection: a managed checkout opened without the worker's route fails
 * instead of starting a daemon from inside the worker (which, its own daemon
 * gone, would leave another daemon behind it). This file marks its process
 * as a worker, so it holds only this case.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import {
	closeLocalSessionManager,
	markConversationWorkerProcess,
	restoreLocalSessionWorktree,
} from "../src/daemon/session-worktree.ts";
import * as daemonSpawn from "../src/daemon/spawn.ts";
import { getWorktreesRoot } from "../src/daemon/worktree-manager.ts";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a conversation worker's managed checkouts", () => {
	it("never starts a daemon for a checkout opened without the worker's route", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-worker-route-")));
		roots.push(root);
		const agentDir = join(root, "agent");
		const checkout = join(getWorktreesRoot(agentDir), "ws", "amber-basin");
		mkdirSync(checkout, { recursive: true });
		const manager = await SessionManager.create(checkout, getDefaultSessionDir(agentDir));
		const ensureDaemon = vi.spyOn(daemonSpawn, "ensureDaemonRunning");
		markConversationWorkerProcess();
		try {
			await expect(restoreLocalSessionWorktree(manager, agentDir)).rejects.toThrow(
				"restores a managed checkout only through its daemon connection",
			);
			expect(ensureDaemon).not.toHaveBeenCalled();
		} finally {
			await closeLocalSessionManager(manager);
		}
	});
});
