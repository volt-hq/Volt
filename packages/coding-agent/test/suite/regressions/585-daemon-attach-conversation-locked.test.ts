import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import {
	createIrohRemoteHandshakeFailure,
	parseIrohRemoteHandshakeResponse,
} from "../../../src/core/remote/iroh/handshake.ts";
import { IrohRemoteOutcomeError } from "../../../src/core/remote/iroh/protocol.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createSessionManagerTargetStore, resolveIrohRemoteSessionTarget } from "../../../src/daemon/session-target.ts";
import { createIrohRemoteAgentRuntimeWithSessionSelection } from "../../../src/modes/rpc/iroh-remote-agent-runtime.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<{ agentDir: string; cwd: string; sessionDir: string; ref: SessionReference }> {
	const root = mkdtempSync(join(tmpdir(), "volt-585-daemon-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const sessionDir = join(agentDir, "sessions", "workspace");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	const manager = await SessionManager.create(cwd, sessionDir, { id: "phone-session" });
	await manager.logWriter.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const ref = manager.getSessionRef()!;
	await manager.closePersistence();
	return { agentDir, cwd, sessionDir, ref };
}

async function holdInAnotherProcess(sessionDir: string, sessionId: string): Promise<ChildProcess> {
	const child = fork(
		fileURLToPath(new URL("../../fixtures/conversation-lock-holder.ts", import.meta.url)),
		[sessionDir, sessionId],
		{ execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "inherit", "ipc"] },
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
	expect(status).toBe("acquired");
	return child;
}

async function attachError(promise: Promise<unknown>): Promise<IrohRemoteOutcomeError> {
	const error = await promise.then(
		() => undefined,
		(failure: unknown) => failure,
	);
	expect(error).toBeInstanceOf(IrohRemoteOutcomeError);
	return error as IrohRemoteOutcomeError;
}

describe("regression #585: daemon attach to a session another host has open", () => {
	it("takes the session's lock while hosting a phone conversation", async () => {
		const { agentDir, cwd, sessionDir, ref } = await fixture();
		const lockedWhileHosting: string[] = [];
		const setupDone = new Error("stop after the session opened");

		await expect(
			createIrohRemoteAgentRuntimeWithSessionSelection({
				agentDir,
				conversationTarget: { target: "session", sessionId: ref.sessionId },
				cwd,
				sessionDir,
				validateCwd: () => {
					const probe = ConversationLock.tryAcquire(sessionDir, ref.sessionId);
					lockedWhileHosting.push(probe.status === "held" ? probe.holder : "free");
					throw setupDone;
				},
			}),
		).rejects.toBe(setupDone);

		expect(lockedWhileHosting).toEqual(["this_process"]);
		// The failed attach released the session again.
		await expect(SessionManager.open(ref).then((manager) => manager.closePersistence())).resolves.toBeUndefined();
	});

	it("rejects the attach with conversation_locked while another process has the session open", async () => {
		const { agentDir, cwd, sessionDir, ref } = await fixture();
		const holder = await holdInAnotherProcess(sessionDir, ref.sessionId);

		const error = await attachError(
			createIrohRemoteAgentRuntimeWithSessionSelection({
				agentDir,
				conversationTarget: { target: "session", sessionId: ref.sessionId },
				cwd,
				sessionDir,
			}),
		);
		expect(error.outcome).toBe("conversation_locked");
		expect(error).toMatchObject({ sessionId: ref.sessionId });
		expect(error).not.toHaveProperty("retryAfterMs");

		// The phone receives a handshake failure carrying the new outcome.
		const response = parseIrohRemoteHandshakeResponse(
			createIrohRemoteHandshakeFailure(error.message, {
				hostNodeId: "host-node",
				outcome: error.outcome as "conversation_locked",
				sessionId: ref.sessionId,
			}),
		);
		expect(response).toMatchObject({ success: false, outcome: "conversation_locked", sessionId: ref.sessionId });

		// Once that process exits, the same attach opens the session.
		const exited = once(holder, "exit");
		holder.send("exit");
		await exited;
		const resolved = await resolveIrohRemoteSessionTarget(
			{ kind: "session", sessionId: ref.sessionId },
			{ name: "workspace", path: cwd },
			createSessionManagerTargetStore(cwd, sessionDir, { listAll: true, preserveSessionCwd: true }),
		);
		expect(resolved.selection).toBe("resumed");
		await resolved.sessionManager.closePersistence();
	});

	it("asks the phone to retry while this daemon is still creating or retiring the session's runtime", async () => {
		const { cwd, sessionDir, ref } = await fixture();
		const retiring = ConversationLock.acquire(sessionDir, ref.sessionId);
		cleanups.push(() => retiring.close());

		const error = await attachError(
			resolveIrohRemoteSessionTarget(
				{ kind: "session", sessionId: ref.sessionId },
				{ name: "workspace", path: cwd },
				createSessionManagerTargetStore(cwd, sessionDir, { listAll: true, preserveSessionCwd: true }),
			),
		);
		expect(error.outcome).toBe("duplicate_conversation_connection");
		expect(error).toMatchObject({ workspace: "workspace", sessionId: ref.sessionId, retryAfterMs: 500 });
	});

	it("resolves a relayed target read-only while the owning TUI holds the session", async () => {
		const { cwd, sessionDir, ref } = await fixture();
		const tui = await SessionManager.open(ref);
		cleanups.push(() => tui.closePersistence());

		const resolved = await resolveIrohRemoteSessionTarget(
			{ kind: "session", sessionId: ref.sessionId },
			{ name: "workspace", path: cwd },
			createSessionManagerTargetStore(cwd, sessionDir, {
				listAll: true,
				preserveSessionCwd: true,
				readOnly: true,
			}),
		);
		expect(resolved.sessionManager.getCwd()).toBe(cwd);
		await resolved.sessionManager.closePersistence();
	});
});
