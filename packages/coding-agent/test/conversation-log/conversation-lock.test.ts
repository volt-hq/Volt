import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationLock } from "../../src/core/conversation-log/conversation-lock.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sessionDirectory(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-conversation-lock-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return join(root, "sessions");
}

function acquire(directory: string, sessionId: string): ConversationLock | undefined {
	const acquisition = ConversationLock.tryAcquire(directory, sessionId);
	if (acquisition.status === "held") return undefined;
	cleanups.push(() => acquisition.lock.close());
	return acquisition.lock;
}

interface Holder {
	readonly child: ChildProcess;
	readonly status: string;
}

/** Fork a process that tries to take the lock and reports whether it got it. */
async function holder(directory: string, sessionId: string): Promise<Holder> {
	const child = fork(
		fileURLToPath(new URL("../fixtures/conversation-lock-holder.ts", import.meta.url)),
		[directory, sessionId],
		{ execArgv: ["--experimental-strip-types", "--expose-gc"], stdio: ["ignore", "ignore", "inherit", "ipc"] },
	);
	cleanups.push(async () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = once(child, "exit");
		child.kill("SIGKILL");
		await exited;
	});
	const status = await new Promise<string>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => reject(new Error("Lock holder exited before reporting")));
		child.once("message", (message) => resolve(String(message)));
	});
	return { child, status };
}

async function exit(holder: Holder): Promise<void> {
	const exited = once(holder.child, "exit");
	holder.child.send("exit");
	await exited;
}

describe("ConversationLock", () => {
	it("locks <sessionDir>/locks/<sha256(sessionId)>.lock and refuses a second holder in the same process", () => {
		const directory = sessionDirectory();
		const lock = acquire(directory, "session-1");
		expect(lock?.path).toBe(
			join(directory, "locks", `${createHash("sha256").update("session-1").digest("hex")}.lock`),
		);
		expect(ConversationLock.tryAcquire(directory, "session-1")).toEqual({ status: "held", holder: "this_process" });
		expect(acquire(directory, "session-2")).toBeDefined();
		lock!.close();
		lock!.close();
		expect(existsSync(lock!.path)).toBe(true);
		expect(acquire(directory, "session-1")).toBeDefined();
		expect(readdirSync(join(directory, "locks"))).toHaveLength(2);
	});

	it("refuses a holder in another process", async () => {
		const directory = sessionDirectory();
		const lock = acquire(directory, "session-1");
		expect(lock).toBeDefined();
		const refused = await holder(directory, "session-1");
		expect(refused.status).toBe("held");
		await exit(refused);
		lock!.close();
		const accepted = await holder(directory, "session-1");
		expect(accepted.status).toBe("acquired");
		expect(ConversationLock.tryAcquire(directory, "session-1")).toEqual({
			status: "held",
			holder: "another_process",
		});
		await exit(accepted);
	});

	it("is released by the OS when the holding process exits", async () => {
		const directory = sessionDirectory();
		const child = await holder(directory, "session-1");
		expect(child.status).toBe("acquired");
		expect(acquire(directory, "session-1")).toBeUndefined();
		await exit(child);
		expect(acquire(directory, "session-1")).toBeDefined();
		expect(readdirSync(join(directory, "locks"))).toHaveLength(1);
	});
});
