import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationLockedError } from "../../../src/core/conversation-log/conversation-lock.ts";
import { MissingSessionCwdError } from "../../../src/core/session-cwd.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { connectTestClient, openTestHost } from "../../utilities/host-client.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../host-harness.ts";

describe("regression #585: a failed open keeps the client on its source", () => {
	const harnesses: HostHarness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(options?: HostHarnessOptions) {
		const harness = await createHostHarness(options);
		harnesses.push(harness);
		const source = await harness.openStartup();
		const client = harness.client("tui", { anchor: true });
		await harness.host.attach(client, source);
		await source.session.prompt("before the failed open");
		harness.events.length = 0;
		return { harness, source, client };
	}

	/** A stored session in the harness store with one message, closed unless kept open. */
	async function storedSession(harness: HostHarness, cwd = harness.tempDir): Promise<SessionManager> {
		const manager = await SessionManager.create(cwd, join(harness.tempDir, "sessions"));
		await manager.logWriter.appendMessage({ role: "user", content: "stored", timestamp: Date.now() });
		return manager;
	}

	async function expectSourceKept(harness: HostHarness, source: Awaited<ReturnType<typeof setup>>["source"]) {
		expect(source.closed).toBe(false);
		expect(harness.events.filter((event) => event.type === "session_shutdown")).toEqual([]);
		await source.session.prompt("after the failed open");
		expect(source.session.messages.filter((message) => message.role === "user")).toHaveLength(2);
	}

	it("keeps the source when the target session is open in another process", async () => {
		const { harness, source, client } = await setup();
		const holder = await storedSession(harness);
		const ref = holder.getSessionRef() as SessionReference;

		try {
			await expect(harness.host.openFor(client, { kind: "session", ref })).rejects.toBeInstanceOf(
				ConversationLockedError,
			);
		} finally {
			await holder.closePersistence();
		}

		expect(harness.host.conversationOf(client)).toBe(source);
		expect(harness.host.list()).toEqual([source]);
		await expectSourceKept(harness, source);
	});

	it("keeps the source when the target session's cwd is missing", async () => {
		const { harness, source, client } = await setup();
		const missingCwd = join(harness.tempDir, "removed-checkout");
		mkdirSync(missingCwd);
		const stored = await storedSession(harness, missingCwd);
		const ref = stored.getSessionRef() as SessionReference;
		await stored.closePersistence();
		rmSync(missingCwd, { recursive: true });

		await expect(harness.host.openFor(client, { kind: "session", ref })).rejects.toBeInstanceOf(
			MissingSessionCwdError,
		);

		expect(harness.host.conversationOf(client)).toBe(source);
		await expectSourceKept(harness, source);
		// The failed open released the target's lock.
		const reopened = await SessionManager.open(ref, harness.tempDir);
		await reopened.closePersistence();
	});

	it("closes the candidate and keeps the source when creating the new session fails", async () => {
		let failNext = false;
		const { harness, source, client } = await setup({
			beforeCreate: () => {
				if (!failNext) return;
				failNext = false;
				throw new Error("injected session creation failure");
			},
		});
		let candidateRef: SessionReference | undefined;
		failNext = true;

		await expect(
			harness.host.openFor(client, {
				kind: "new",
				seed: async (writer) => {
					candidateRef = writer.sessionManager.getSessionRef();
				},
			}),
		).rejects.toThrow("injected session creation failure");

		expect(harness.host.conversationOf(client)).toBe(source);
		await expectSourceKept(harness, source);
		const reopened = await SessionManager.open(candidateRef as SessionReference);
		await reopened.closePersistence();
	});

	it("keeps an in-place client on its session when its switch intent fails to open", async () => {
		const harness = await createHostHarness();
		harnesses.push(harness);
		const { host, conversation } = await openTestHost(harness.factory, {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions")),
		});
		const prepare = vi.fn();
		const onMoved = vi.fn();
		const runtime = await connectTestClient(host, conversation, { surface: {}, prepare, onMoved });
		const source = runtime.session;
		await source.prompt("before the failed switch");
		const holder = await storedSession(harness);
		harness.events.length = 0;

		try {
			await expect(runtime.switchSession(holder.getSessionRef() as SessionReference)).rejects.toBeInstanceOf(
				ConversationLockedError,
			);
		} finally {
			await holder.closePersistence();
		}

		expect(runtime.session).toBe(source);
		expect(host.conversationOf(runtime.client)).toBe(conversation);
		expect(prepare).not.toHaveBeenCalled();
		expect(onMoved).not.toHaveBeenCalled();
		expect(harness.events.map((event) => event.type)).toEqual(["session_before_switch"]);
		await source.prompt("after the failed switch");
		expect(source.messages.filter((message) => message.role === "user")).toHaveLength(2);
		await runtime.dispose();
	});
});
