import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionReplacementTransaction,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ConversationLock, ConversationLockedError } from "../../../src/core/conversation-log/conversation-lock.ts";
import type { RpcCloseHandler, RpcLineHandler } from "../../../src/core/rpc/transport.ts";
import {
	SessionConversationStateUnavailableError,
	SessionManager,
	type SessionReference,
} from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-585-lock-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/** Create a persisted session with one message and close it. */
async function storedSession(sessionDir: string, cwd: string, text = "hello"): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, sessionDir);
	manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	await manager.flush();
	const ref = manager.getSessionRef()!;
	await manager.closePersistence();
	return ref;
}

async function owned(manager: SessionManager): Promise<SessionManager> {
	cleanups.push(() => manager.closePersistence().catch(() => {}));
	return manager;
}

function lockHolder(error: unknown): string | undefined {
	return error instanceof ConversationLockedError ? `${error.code}:${error.holder}` : undefined;
}

async function openError(open: Promise<unknown>): Promise<unknown> {
	try {
		await owned((await open) as SessionManager);
	} catch (error) {
		return error;
	}
	return undefined;
}

/** A process that takes the session's lock and holds it until it exits. */
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

async function createRuntime(
	cwd: string,
	sessionManager: SessionManager,
	responses: string[] = [],
): Promise<AgentSessionRuntime> {
	const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir: cwd,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(volt: ExtensionAPI) => {
						volt.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							streamSimple: faux.streamSimple,
							models: faux.models.map((model) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir: cwd, sessionManager });
	// A runtime whose session lost its log cannot close its persistence cleanly.
	cleanups.push(() => runtime.dispose().catch(() => {}));
	return runtime;
}

function lockState(ref: SessionReference): "free" | "held" {
	const acquisition = ConversationLock.tryAcquire(ref.sessionDirectory, ref.sessionId);
	if (acquisition.status === "held") return "held";
	acquisition.lock.close();
	return "free";
}

describe("regression #585: one writer per conversation log", () => {
	it("refuses a second writer in the same process while readers keep working", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const ref = await storedSession(sessionDir, root);
		const writer = await owned(await SessionManager.open(ref));

		expect(lockHolder(await openError(SessionManager.open(ref)))).toBe("conversation_locked:this_process");
		expect(lockHolder(await openError(SessionManager.continueRecent(root, sessionDir)))).toBe(
			"conversation_locked:this_process",
		);
		expect(lockHolder(await openError(SessionManager.delete(ref).then(() => writer)))).toBe(
			"conversation_locked:this_process",
		);

		// Readers take no lock.
		const reader = await owned(await SessionManager.openReadOnly(ref));
		expect(reader.getEntries().map((entry) => entry.type)).toEqual(["message"]);
		expect(() => reader.appendMessage({ role: "user", content: "no", timestamp: Date.now() })).toThrow(
			`Session ${ref.sessionId} was opened read-only`,
		);
		expect((await SessionManager.list(root, sessionDir)).map((session) => session.id)).toEqual([ref.sessionId]);
		const snapshot = join(root, "snapshot.jsonl");
		await expect(SessionManager.exportJsonlSnapshot(ref, snapshot)).resolves.toEqual({ lastOrdinal: 1 });
		// Forking reads the source and writes only the new session.
		const forked = await owned(await SessionManager.forkFrom(ref, root, sessionDir));
		expect(forked.getSessionId()).not.toBe(ref.sessionId);
		expect(forked.getEntries().map((entry) => entry.type)).toEqual(["message"]);

		// The writer is unaffected.
		writer.appendMessage({ role: "user", content: "still mine", timestamp: Date.now() });
		await writer.flush();
		expect(writer.getEntries()).toHaveLength(2);
	});

	it("releases the lock when the writer closes, so the next writer opens", async () => {
		const root = temporaryDirectory();
		const ref = await storedSession(join(root, "sessions"), root);
		const writer = await SessionManager.open(ref);
		expect(lockState(ref)).toBe("held");
		await writer.closePersistence();
		expect(lockState(ref)).toBe("free");
		const next = await owned(await SessionManager.open(ref));
		expect(next.getEntries()).toHaveLength(1);
	});

	it("refuses a writer while another process holds the session and opens once that process exits", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const ref = await storedSession(sessionDir, root);
		const holder = await holdInAnotherProcess(sessionDir, ref.sessionId);

		const error = await openError(SessionManager.open(ref));
		expect(lockHolder(error)).toBe("conversation_locked:another_process");
		expect((error as Error).message).toContain(`Session ${ref.sessionId} is open in another Volt process`);
		await expect(SessionManager.openReadOnly(ref).then(owned)).resolves.toBeDefined();

		// The holder exits without releasing: the OS releases its lock.
		const exited = once(holder, "exit");
		holder.send("exit");
		await exited;
		await expect(SessionManager.open(ref).then(owned)).resolves.toBeDefined();
	});

	it("takes a replacement target's lock before releasing the source's, and stays on the source when it is held", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "source");
		const targetRef = await storedSession(sessionDir, root, "target");
		const runtime = await createRuntime(root, await SessionManager.open(sourceRef));

		const elsewhere = ConversationLock.acquire(sessionDir, targetRef.sessionId);
		await expect(runtime.switchSession(targetRef)).rejects.toBeInstanceOf(ConversationLockedError);
		expect(runtime.session.sessionId).toBe(sourceRef.sessionId);
		expect(lockState(sourceRef)).toBe("held");
		elsewhere.close();

		await expect(runtime.switchSession(targetRef)).resolves.toEqual({ cancelled: false, seeded: false });
		expect(runtime.session.sessionId).toBe(targetRef.sessionId);
		expect(lockState(targetRef)).toBe("held");
		expect(lockState(sourceRef)).toBe("free");
	});

	it("forks from a read-only copy of the current session and moves the lock to the fork", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "first");
		const runtime = await createRuntime(root, await SessionManager.open(sourceRef), ["reply"]);
		await runtime.session.prompt("second");
		const second = runtime.session.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "message" && entry.message.role === "user");

		const result = await runtime.fork(second!.id);
		expect(result).toMatchObject({ cancelled: false, selectedText: "second" });
		const forkRef = runtime.session.sessionRef!;
		expect(forkRef.sessionId).not.toBe(sourceRef.sessionId);
		expect(lockState(forkRef)).toBe("held");
		expect(lockState(sourceRef)).toBe("free");
	});

	it("prepares the host lease before opening the target, and rolls it back when the open fails", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "source");
		const targetRef = await storedSession(sessionDir, root, "target");
		const runtime = await createRuntime(root, await SessionManager.open(sourceRef));
		// The daemon hosts the target: its runtime holds the target's lock.
		let daemonRuntimeLock: ConversationLock | undefined = ConversationLock.acquire(sessionDir, targetRef.sessionId);
		const steps: string[] = [];
		const transaction = (): AgentSessionReplacementTransaction => ({
			commit: async () => {
				steps.push("commit");
			},
			rollback: async () => {
				steps.push("rollback");
			},
			dispose: async () => {
				steps.push("dispose");
			},
		});

		// A lease that does not free the lock: the open fails and the lease is rolled back.
		runtime.setPrepareSessionReplacement(async (target) => {
			steps.push(`prepare:${target.sessionId}:${target.cwd}`);
			return transaction();
		});
		await expect(runtime.switchSession(targetRef)).rejects.toBeInstanceOf(ConversationLockedError);
		expect(steps).toEqual([`prepare:${targetRef.sessionId}:${root}`, "rollback"]);
		expect(runtime.session.sessionId).toBe(sourceRef.sessionId);

		// Granting the lease disposes the daemon runtime first, which frees the lock for the open.
		steps.length = 0;
		runtime.setPrepareSessionReplacement(async (target) => {
			steps.push(`prepare:${target.sessionId}:${lockState(targetRef)}`);
			daemonRuntimeLock?.close();
			daemonRuntimeLock = undefined;
			return transaction();
		});
		await expect(runtime.switchSession(targetRef)).resolves.toEqual({ cancelled: false, seeded: false });
		expect(steps).toEqual([`prepare:${targetRef.sessionId}:held`, "commit"]);
		expect(runtime.session.sessionId).toBe(targetRef.sessionId);
		expect(lockState(targetRef)).toBe("held");
	});

	it("fails an RPC switch to a session open elsewhere with the stable conversation_locked code", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "source");
		const targetRef = await storedSession(sessionDir, root, "target");
		const runtime = await createRuntime(root, await SessionManager.open(sourceRef));
		const elsewhere = ConversationLock.acquire(sessionDir, targetRef.sessionId);
		cleanups.push(() => elsewhere.close());
		let line!: RpcLineHandler;
		let close: RpcCloseHandler | undefined;
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const writes: object[] = [];
		const mode = runRpcMode(runtime, {
			exitProcess: false,
			disposeRuntimeOnClose: false,
			onReady: ready,
			transport: {
				write: (value) => {
					writes.push(value);
				},
				onLine: (handler) => {
					line = handler;
					return () => {};
				},
				onClose: (handler) => {
					close = handler;
					return () => {};
				},
				close: () => {},
			},
		});
		await started;
		try {
			await line(JSON.stringify({ id: "switch", type: "switch_session", sessionId: targetRef.sessionId }));
			await vi.waitFor(() =>
				expect(writes).toContainEqual(
					expect.objectContaining({
						id: "switch",
						type: "response",
						success: false,
						errorCode: "conversation_locked",
					}),
				),
			);
			expect(runtime.session.sessionId).toBe(sourceRef.sessionId);
		} finally {
			close?.();
			await mode;
		}
	});

	it("shuts an RPC host down with an error when its session loses its log", async () => {
		const root = temporaryDirectory();
		const ref = await storedSession(join(root, "sessions"), root);
		const runtime = await createRuntime(root, await SessionManager.open(ref));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		let ready!: () => void;
		const started = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const mode = runRpcMode(runtime, {
			exitProcess: false,
			onReady: ready,
			transport: {
				write: () => {},
				onLine: () => () => {},
				onClose: () => () => {},
				close: () => {},
			},
		});
		void mode.catch(() => {});
		await started;

		runtime.session.sessionManager.retireConversationAuthority(
			new Error(`Expected log ordinal 1, but the log head is 2`),
		);

		await expect(mode).rejects.toBeInstanceOf(SessionConversationStateUnavailableError);
		expect(consoleError).toHaveBeenCalledWith(
			`Volt stopped session ${ref.sessionId} because its saved state could not be confirmed: Expected log ordinal 1, but the log head is 2`,
		);
		// The RPC host owned the runtime: disposal released the session's lock.
		expect(lockState(ref)).toBe("free");
	});
});
