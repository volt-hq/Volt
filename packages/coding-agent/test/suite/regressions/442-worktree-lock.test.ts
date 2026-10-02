import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeFileLock } from "../../../src/core/workspace-fs/native-loader.ts";
import { tryAcquireWorktreeLock } from "../../../src/daemon/worktree-lock.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const harness = await createHarness({ settings: { lsp: { enabled: false } } });
	cleanups.push(() => harness.cleanupAsync());
	const agentDir = realpathSync(harness.tempDir);
	const checkout = join(agentDir, "worktrees", "workspace", "checkout");
	mkdirSync(checkout, { recursive: true });
	const acquire = (shared: boolean): NativeFileLock | undefined => {
		const lock = tryAcquireWorktreeLock(agentDir, checkout, shared);
		if (lock)
			cleanups.push(() => {
				lock.close();
			});
		return lock;
	};
	const child = async (shared: boolean): Promise<ChildProcess> => {
		const process = fork(
			fileURLToPath(new URL("../../fixtures/worktree-lock-holder.ts", import.meta.url)),
			[agentDir, checkout, shared ? "shared" : "exclusive"],
			{ execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] },
		);
		cleanups.push(async () => {
			if (process.exitCode !== null || process.signalCode !== null) return;
			const exited = once(process, "exit");
			process.kill("SIGKILL");
			await exited;
		});
		await new Promise<void>((resolve, reject) => {
			process.once("error", reject);
			process.once("exit", () => reject(new Error("Lock holder exited before acquisition")));
			process.once("message", (message) => {
				if (message === "locked") resolve();
				else reject(new Error("Unexpected lock holder response"));
			});
		});
		return process;
	};
	return { agentDir, checkout, acquire, child };
}

describe("#442 process-owned checkout locks", () => {
	it("retains shared protection until the last independent process releases it", async () => {
		const f = await fixture();
		const first = await f.child(true);
		const second = await f.child(true);
		const local = f.acquire(true);
		expect(local).toBeDefined();
		expect(f.acquire(false)).toBeUndefined();
		const firstExited = once(first, "exit");
		first.send("release");
		await firstExited;
		expect(f.acquire(false)).toBeUndefined();
		local!.close();
		expect(f.acquire(false)).toBeUndefined();
		const secondExited = once(second, "exit");
		second.send("release");
		await secondExited;
		expect(f.acquire(false)).toBeDefined();
		expect(readdirSync(join(f.agentDir, "worktree-locks"))).toHaveLength(1);
	});

	it.each([true, false])("releases a crashed process's shared=%s lock without stale-file cleanup", async (shared) => {
		const f = await fixture();
		const child = await f.child(shared);
		expect(f.acquire(false)).toBeUndefined();
		if (!shared) expect(f.acquire(true)).toBeUndefined();
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
		const lock = f.acquire(false);
		expect(lock).toBeDefined();
		expect(lock!.close()).toBe(true);
		expect(lock!.close()).toBe(false);
		expect(readdirSync(join(f.agentDir, "worktree-locks"))).toHaveLength(1);
	});

	it("keeps the same lock authority when the checkout disappears and is recreated", async () => {
		const f = await fixture();
		const lock = f.acquire(true);
		expect(lock).toBeDefined();
		renameSync(f.checkout, `${f.checkout}-archived`);
		expect(existsSync(f.checkout)).toBe(false);
		expect(f.acquire(false)).toBeUndefined();
		mkdirSync(f.checkout);
		expect(f.acquire(false)).toBeUndefined();
		lock!.close();
		expect(f.acquire(false)).toBeDefined();
	});

	it.runIf(process.platform !== "win32")("shares lock identity through agent-directory aliases", async () => {
		const f = await fixture();
		const alias = join(f.agentDir, "alias");
		symlinkSync(f.agentDir, alias);
		const lock = f.acquire(true);
		expect(lock).toBeDefined();
		expect(tryAcquireWorktreeLock(alias, join(alias, "worktrees", "workspace", "checkout"), false)).toBeUndefined();
	});
});
