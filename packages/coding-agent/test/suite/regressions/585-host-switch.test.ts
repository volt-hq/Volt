import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../host-harness.ts";

describe("regression #585: a client switches by opening another conversation", () => {
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
		await source.session.prompt("source prompt");
		harness.events.length = 0;
		return { harness, source, client };
	}

	async function storedSession(harness: HostHarness, text: string): Promise<SessionReference> {
		const manager = await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"));
		await manager.logWriter.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		const ref = manager.getSessionRef();
		await manager.closePersistence();
		if (!ref) throw new Error("Expected a stored session");
		return ref;
	}

	it("resumes a stored session: it starts before the source shuts down, and the source's lock is released", async () => {
		const { harness, source, client } = await setup();
		const targetRef = await storedSession(harness, "stored prompt");
		const sourceRef = source.session.sessionRef as SessionReference;

		const result = await harness.host.openFor(client, { kind: "session", ref: targetRef });
		const target = result.conversation;
		if (!target) throw new Error("Expected the resumed conversation");

		expect(target.id).toBe(targetRef.sessionId);
		expect(harness.host.conversationOf(client)).toBe(target);
		expect(target.session.messages.map((message) => message.role)).toEqual(["user"]);
		expect(harness.events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionRef: targetRef, sessionId: source.id },
			{ type: "session_start", reason: "resume", previousSessionRef: sourceRef, sessionId: target.id },
			{ type: "session_shutdown", reason: "resume", targetSessionRef: targetRef, sessionId: source.id },
		]);
		expect(source.closed).toBe(true);
		const reopened = await SessionManager.open(sourceRef);
		expect(reopened.getConversationState().context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		await reopened.closePersistence();
	});

	it("opens a new session in the source's cwd and store, and switches back to the source", async () => {
		const { harness, source, client } = await setup();
		const sourceRef = source.session.sessionRef as SessionReference;

		const opened = await harness.host.openFor(client, { kind: "new" });
		const fresh = opened.conversation;
		if (!fresh) throw new Error("Expected the new conversation");
		expect(fresh.cwd).toBe(source.cwd);
		expect(fresh.session.sessionManager.getSessionDir()).toBe(source.session.sessionManager.getSessionDir());
		expect(fresh.session.messages).toEqual([]);

		const back = await harness.host.openFor(client, { kind: "session", ref: sourceRef });
		expect(back.conversation?.id).toBe(source.id);
		expect(back.conversation).not.toBe(source);
		expect(fresh.closed).toBe(true);
		expect(harness.events.map((event) => `${event.type}:${event.sessionId === source.id ? "A" : "B"}`)).toEqual([
			"session_before_switch:A",
			"session_start:B",
			"session_shutdown:A",
			"session_before_switch:B",
			"session_start:A",
			"session_shutdown:B",
		]);
		expect(back.conversation?.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("keeps the source and creates nothing when an extension cancels the switch", async () => {
		const { harness, source, client } = await setup({
			extension: (volt) => {
				volt.on("session_before_switch", () => ({ cancel: true }));
			},
		});
		const sessionDir = source.session.sessionManager.getSessionDir();
		const before = await SessionManager.list(source.cwd, sessionDir, undefined, { includeMessageFreeDurable: true });

		await expect(harness.host.openFor(client, { kind: "new" })).resolves.toEqual({ cancelled: true, seeded: false });

		expect(harness.host.conversationOf(client)).toBe(source);
		expect(source.closed).toBe(false);
		expect(harness.host.list()).toEqual([source]);
		const after = await SessionManager.list(source.cwd, sessionDir, undefined, { includeMessageFreeDurable: true });
		expect(after.map((info) => info.id)).toEqual(before.map((info) => info.id));
	});

	it("refuses to leave a source with an active turn", async () => {
		const { harness, source, client } = await setup();
		let releaseTurn!: () => void;
		const turnGate = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		harness.faux.setResponses([
			async () => {
				await turnGate;
				return fauxAssistantMessage("late");
			},
		]);
		const turn = source.session.prompt("held turn");
		try {
			await expect.poll(() => source.session.isStreaming).toBe(true);
			await expect(harness.host.openFor(client, { kind: "new" })).rejects.toThrow(
				"Cannot change sessions while an agent run is active",
			);
			expect(harness.host.conversationOf(client)).toBe(source);
			expect(harness.events).toEqual([]);
		} finally {
			releaseTurn();
			await turn;
		}
	});
});
