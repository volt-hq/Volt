import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolClient } from "../../../src/client/protocol-client.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ConversationLock, ConversationLockedError } from "../../../src/core/conversation-log/conversation-lock.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/index.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { connectTestClient, openTestHost, type TestClient, type TestHost } from "../../utilities/host-client.ts";

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
	await manager.logWriter.appendMessage({ role: "user", content: text, timestamp: Date.now() });
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

/** Open `sessionManager`'s conversation in a host of its own, as startup does. */
async function openConversation(
	cwd: string,
	sessionManager: SessionManager,
	responses: string[] = [],
): Promise<TestHost> {
	const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
	faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const factory: ConversationFactory = async (options) => {
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
	const opened = await openTestHost(factory, { cwd, agentDir: cwd, sessionManager });
	// A conversation whose session lost its log cannot close its persistence cleanly.
	cleanups.push(() => opened.host.dispose().catch(() => {}));
	return opened;
}

/** An in-place client anchoring a conversation opened over `sessionManager`. */
async function createRuntime(
	cwd: string,
	sessionManager: SessionManager,
	responses: string[] = [],
): Promise<TestClient> {
	const { host, conversation } = await openConversation(cwd, sessionManager, responses);
	return connectTestClient(host, conversation);
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
		await expect(
			reader.logWriter.appendMessage({ role: "user", content: "no", timestamp: Date.now() }),
		).rejects.toThrow(`Session ${ref.sessionId} was opened read-only`);
		expect((await SessionManager.list(root, sessionDir)).map((session) => session.id)).toEqual([ref.sessionId]);
		const snapshot = join(root, "snapshot.jsonl");
		await expect(SessionManager.exportJsonlSnapshot(ref, snapshot)).resolves.toEqual({ lastOrdinal: 1 });
		// Forking reads the source and writes only the new session.
		const forked = await owned(await SessionManager.forkFrom(ref, root, sessionDir));
		expect(forked.getSessionId()).not.toBe(ref.sessionId);
		expect(forked.getEntries().map((entry) => entry.type)).toEqual(["message"]);

		// The writer is unaffected.
		await writer.logWriter.appendMessage({ role: "user", content: "still mine", timestamp: Date.now() });
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

		await expect(runtime.switchSession(targetRef)).resolves.toEqual({
			cancelled: false,
			sessionId: targetRef.sessionId,
			seeded: false,
		});
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

	it("keeps the source when the target is held elsewhere, and switches once its lock is free", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "source");
		const targetRef = await storedSession(sessionDir, root, "target");
		const runtime = await createRuntime(root, await SessionManager.open(sourceRef));
		// The daemon hosts the target: its runtime holds the target's lock.
		const daemonRuntimeLock = ConversationLock.acquire(sessionDir, targetRef.sessionId);

		await expect(runtime.switchSession(targetRef)).rejects.toBeInstanceOf(ConversationLockedError);
		expect(runtime.session.sessionId).toBe(sourceRef.sessionId);
		expect(lockState(sourceRef)).toBe("held");

		// Once the daemon released the target, the switch opens it.
		daemonRuntimeLock.close();
		await expect(runtime.switchSession(targetRef)).resolves.toEqual({
			cancelled: false,
			sessionId: targetRef.sessionId,
			seeded: false,
		});
		expect(runtime.session.sessionId).toBe(targetRef.sessionId);
		expect(lockState(targetRef)).toBe("held");
		expect(lockState(sourceRef)).toBe("free");
	});

	it("rejects a protocol switch to a session open elsewhere with the stable locked code", async () => {
		const root = temporaryDirectory();
		const sessionDir = join(root, "sessions");
		const sourceRef = await storedSession(sessionDir, root, "source");
		const targetRef = await storedSession(sessionDir, root, "target");
		const { host, conversation } = await openConversation(root, await SessionManager.open(sourceRef));
		const elsewhere = ConversationLock.acquire(sessionDir, targetRef.sessionId);
		cleanups.push(() => elsewhere.close());
		const client = await createLoopbackClient(host, conversation, { anchor: false });
		cleanups.push(() => client.stop());

		await expect(client.intent("switch_session", { sessionId: targetRef.sessionId })).rejects.toMatchObject({
			reason: { code: "locked" },
		});
		expect(host.list()).toEqual([conversation]);
		expect(conversation.closed).toBe(false);
		expect(client.conversation).toBe(conversation.id);
	});

	it.each([
		["an embedded RPC host settles its close promise", false],
		["an RPC process exits non-zero with the error message", true],
	] as const)("ends when its session loses its log: %s", async (_label, exitProcess) => {
		const root = temporaryDirectory();
		const ref = await storedSession(join(root, "sessions"), root);
		const { host, conversation } = await openConversation(root, await SessionManager.open(ref));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		const pair = createLoopbackRpcTransportPair();
		const ready = Promise.withResolvers<void>();
		const mode = runRpcMode(host, conversation, { transport: pair.server, exitProcess, onReady: ready.resolve });
		void mode.catch(() => {});
		const client = new ProtocolClient();
		cleanups.push(() => client.stop());
		await client.connect(pair.client);
		await ready.promise;

		const lost = await loseLog(conversation.session.sessionWriter);

		await expect(mode).resolves.toBeUndefined();
		if (exitProcess) expect(exit).toHaveBeenCalledExactlyOnceWith(1);
		else expect(exit).not.toHaveBeenCalled();
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Volt stopped session ${ref.sessionId} because its saved state could not be confirmed: ${lost.message}`,
		);
		expect(lost.message).toMatch(/^Expected log ordinal \d+, but the log head is \d+$/);
		// The client was told the host shut down.
		await expect(client.caughtUp()).rejects.toThrow(/shutdown/);
		// The RPC client anchored the conversation: closing it released the session's lock.
		expect(lockState(ref)).toBe("free");
	});
});
