import { afterEach, describe, expect, it, vi } from "vitest";
import { PinnedConversationError } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { LiveClient } from "../../src/core/host/live-state.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { findSessionInfoById, SessionManager } from "../../src/core/session-manager.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions, moved } from "./host-harness.ts";

/** A live view that keeps the extension statuses it is shown in `statuses`. */
function statusLive(statuses: Map<string, string>): LiveClient {
	return {
		acceptsHostRequest: () => false,
		apply: (update) => {
			if (update.reset) statuses.clear();
			for (const item of update.items) {
				if (item.type === "set" && item.value.kind === "ext_status") {
					statuses.set(item.key.slice("ext_status/".length), item.value.text);
				} else if (item.type === "clear" && item.key.startsWith("ext_status/")) {
					statuses.delete(item.key.slice("ext_status/".length));
				}
			}
		},
	};
}

describe("ConversationHost", () => {
	const harnesses: HostHarness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup(options?: HostHarnessOptions): Promise<HostHarness> {
		const harness = await createHostHarness(options);
		harnesses.push(harness);
		return harness;
	}

	it("binds a conversation's extensions when its first client attaches and closes it when the anchor leaves", async () => {
		const harness = await setup();
		const opened: string[] = [];
		const closed: string[] = [];
		harness.host.onOpened((conversation) => opened.push(conversation.id));
		harness.host.onClosed((conversation) => closed.push(conversation.id));
		const conversation = await harness.openStartup();
		expect(opened).toEqual([conversation.id]);
		expect(harness.events).toEqual([]);

		const anchor = harness.client("anchor", { anchor: true });
		await harness.host.attach(anchor, conversation);
		await harness.host.attach(harness.client("guest"), conversation);
		expect(harness.events).toEqual([{ type: "session_start", reason: "startup", sessionId: conversation.id }]);
		expect(harness.host.get(conversation.id)).toBe(conversation);

		await harness.host.detach(anchor);
		expect(conversation.closed).toBe(true);
		expect(closed).toEqual([conversation.id]);
		expect(harness.host.list()).toEqual([]);
		expect(harness.host.get(conversation.id)).toBeUndefined();
		expect(harness.events.at(-1)).toEqual({ type: "session_shutdown", reason: "quit", sessionId: conversation.id });
	});

	it("closes an unattached conversation when its last client leaves", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const first = harness.client("first");
		const second = harness.client("second");
		await harness.host.attach(first, conversation);
		await harness.host.attach(second, conversation);

		await harness.host.detach(first);
		expect(conversation.closed).toBe(false);
		await harness.host.detach(second);
		expect(conversation.closed).toBe(true);
	});

	it("keeps or retains unattached conversations per its rule", async () => {
		const kept = await setup({ whenUnattached: "keep" });
		const keptConversation = await kept.openStartup();
		const keptClient = kept.client("kept");
		await kept.host.attach(keptClient, keptConversation);
		await kept.host.detach(keptClient);
		expect(keptConversation.closed).toBe(false);

		const retained = await setup({ whenUnattached: { retainMs: 20 } });
		const retainedConversation = await retained.openStartup();
		const retainedClient = retained.client("retained");
		await retained.host.attach(retainedClient, retainedConversation);
		await retained.host.detach(retainedClient);
		// A client returning within the retention window keeps it open.
		await retained.host.attach(retainedClient, retainedConversation);
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(retainedConversation.closed).toBe(false);
		await retained.host.detach(retainedClient);
		await vi.waitFor(() => expect(retainedConversation.closed).toBe(true));
	});

	it("starts the new conversation before the source shuts down, out of the moving client's sight", async () => {
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_start", (_event, ctx) =>
					ctx.ui.setStatus("ext", `ready:${ctx.sessionManager.getSessionId()}`),
				);
				volt.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus("ext", undefined));
			},
		});
		const source = await harness.openStartup();
		const statuses = new Map<string, string>();
		const client = harness.client("tui", { live: statusLive(statuses) });
		await harness.host.attach(client, source);
		expect(statuses.get("ext")).toBe(`ready:${source.id}`);
		harness.events.length = 0;

		const result = moved(await harness.host.openFor(client, { kind: "new" }));
		const target = result.conversation;

		expect(result).toMatchObject({ cancelled: false, sessionId: target.id, seeded: false });
		expect(client.moves).toEqual([target.id]);
		expect(harness.host.conversationOf(client)).toBe(target);
		expect(source.closed).toBe(true);
		// The source's shutdown handler cleared its status where no client sees it.
		expect(statuses.get("ext")).toBe(`ready:${target.id}`);
		expect(harness.events).toEqual([
			{ type: "session_before_switch", reason: "new", sessionId: source.id },
			{ type: "session_start", reason: "new", previousSessionRef: source.session.sessionRef, sessionId: target.id },
			{
				type: "session_shutdown",
				reason: "new",
				targetSessionRef: target.session.sessionRef,
				sessionId: source.id,
			},
		]);
	});

	it("runs withSession against the new conversation after the move", async () => {
		const harness = await setup({ responses: ["seeded reply"] });
		const source = await harness.openStartup();
		const client = harness.client("tui");
		await harness.host.attach(client, source);

		const result = moved(
			await harness.host.openFor(
				client,
				{ kind: "new" },
				{
					withSession: async (ctx) => {
						expect(source.closed).toBe(true);
						await ctx.sendUserMessage("seed");
					},
				},
			),
		);

		expect(result.seeded).toBe(true);
		expect(result.conversation.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("runs beforeMove while the source is open and fenced, and keeps the client there when it fails", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const client = harness.client("tui");
		await harness.host.attach(client, source);

		await expect(
			harness.host.openFor(
				client,
				{ kind: "new" },
				{
					beforeMove: async (from, to) => {
						expect(from).toBe(source);
						expect(from?.closed).toBe(false);
						await expect(from!.session.prompt("blocked")).rejects.toThrow();
						await from!.session.sessionWriter.appendCustomEntry("handoff-ack", { to: to.id });
						throw new Error("handoff failed");
					},
				},
			),
		).rejects.toThrow("handoff failed");
		expect(harness.host.conversationOf(client)).toBe(source);
		expect(harness.host.list()).toEqual([source]);
		expect(harness.events.filter((event) => event.type === "session_shutdown")).toEqual([]);
		// The fence is lifted: the source admits work again.
		await source.session.prompt("after");

		let acknowledgedIn: string | undefined;
		const result = moved(
			await harness.host.openFor(
				client,
				{ kind: "new" },
				{
					beforeMove: async (from) => {
						await from!.session.sessionWriter.appendCustomEntry("handoff-ack", {});
						acknowledgedIn = from!.id;
					},
				},
			),
		);
		expect(acknowledgedIn).toBe(source.id);
		expect(result.sessionId).not.toBe(source.id);
		expect(source.closed).toBe(true);
	});

	it("redirects a redirect client to the new conversation without attaching it there", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const redirects: string[] = [];
		const phone: HostClient = {
			id: "phone",
			surface: {},
			move: { kind: "redirect", redirect: (sessionId) => void redirects.push(sessionId) },
		};
		await harness.host.attach(phone, source);

		const result = moved(await harness.host.openFor(phone, { kind: "new" }));

		expect(redirects).toEqual([result.sessionId]);
		expect(harness.host.conversationOf(phone)).toBeUndefined();
		expect(source.closed).toBe(true);
		expect(result.conversation.closed).toBe(false);
	});

	it("lets a redirect client leave a busy source its other clients keep open, without fencing it", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const redirects: string[] = [];
		const phone: HostClient = {
			id: "phone",
			move: { kind: "redirect", redirect: (sessionId) => void redirects.push(sessionId) },
		};
		await harness.host.attach(phone, source);
		const assertCanLeave = vi.spyOn(source, "assertCanLeave").mockImplementation(() => {
			throw new Error("Cannot change sessions while an agent run is active");
		});
		const holdForLeave = vi.spyOn(source, "holdForLeave");

		// Alone on the source, the phone would close it: it may not leave it busy.
		await expect(harness.host.openFor(phone, { kind: "new" })).rejects.toThrow("an agent run is active");
		expect(harness.host.conversationOf(phone)).toBe(source);

		await harness.host.attach(harness.client("tui", { anchor: true }), source);
		const result = moved(
			await harness.host.openFor(phone, { kind: "new", seed: async () => {} }, { beforeMove: async () => {} }),
		);

		expect(redirects).toEqual([result.sessionId]);
		expect(source.closed).toBe(false);
		expect(assertCanLeave).toHaveBeenCalledTimes(1);
		expect(holdForLeave).not.toHaveBeenCalled();
		expect(harness.host.list()).toEqual([source, result.conversation]);
	});

	it("writes a redirected client's new log and leaves its source open for the other clients", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const anchor = harness.client("tui", { anchor: true });
		await harness.host.attach(anchor, source);
		const redirects: string[] = [];
		const phone: HostClient = {
			id: "phone",
			move: { kind: "redirect", redirect: (sessionId) => void redirects.push(sessionId) },
		};
		await harness.host.attach(phone, source);
		const sourceWrites: string[] = [];

		const result = await harness.host.redirectFor(
			phone,
			{ kind: "new", seed: (writer) => writer.appendSessionInfo("for the phone") },
			{ beforeMove: async (from) => void sourceWrites.push(from.id) },
		);
		if (result.cancelled) throw new Error("the redirect was cancelled");

		expect(redirects).toEqual([result.sessionId]);
		expect(sourceWrites).toEqual([source.id]);
		expect(harness.host.conversationOf(phone)).toBeUndefined();
		// The source stays open for the anchor; the new log never opened here.
		expect(source.closed).toBe(false);
		expect(harness.host.list()).toEqual([source]);
		expect(harness.events.map((event) => event.type)).toEqual(["session_start", "session_before_switch"]);
		const info = await findSessionInfoById(source.session.sessionManager.getSessionDir(), result.sessionId);
		if (!info) throw new Error("the new log is not stored");
		const written = await SessionManager.openReadOnly(info.ref);
		expect(written.getSessionName()).toBe("for the phone");
		await written.closePersistence();
	});

	it("closes a source its anchor is leaving with the anchor's move, even when another client leaves meanwhile", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const phone: HostClient = { id: "phone", move: { kind: "redirect", redirect: () => {} } };
		const anchor: HostClient = {
			id: "tui",
			anchor: true,
			surface: {},
			move: {
				kind: "in_place",
				// The phone disconnects while the anchor's move is under way.
				onMoved: () => harness.host.detach(phone),
			},
		};
		await harness.host.attach(anchor, source);
		await harness.host.attach(phone, source);

		const result = moved(await harness.host.openFor(anchor, { kind: "new" }));

		expect(source.closed).toBe(true);
		expect(harness.events.filter((event) => event.type === "session_shutdown")).toEqual([
			expect.objectContaining({ type: "session_shutdown", reason: "new", sessionId: source.id }),
		]);
		expect(harness.host.list()).toEqual([result.conversation]);
	});

	it("runs one client's structural intents one at a time", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const client = harness.client("tui");
		await harness.host.attach(client, source);

		const [first, second] = (
			await Promise.all([
				harness.host.openFor(client, { kind: "new" }),
				harness.host.openFor(client, { kind: "new" }),
			])
		).map(moved);

		expect(client.moves).toEqual([first!.sessionId, second!.sessionId]);
		expect(first!.conversation.closed).toBe(true);
		expect(second!.conversation.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(harness.host.list()).toEqual([second!.conversation]);
	});

	it("pins owner-lifetime conversations", async () => {
		const harness = await setup();
		const opened = await harness.host.open({ kind: "new", cwd: harness.tempDir }, { lifetime: "owner" });
		if (opened.cancelled) throw new Error("Expected the conversation");
		const child: HostedConversation = opened.conversation;
		const client = harness.client("owner");
		await harness.host.attach(client, child);

		await expect(harness.host.openFor(client, { kind: "new" })).rejects.toBeInstanceOf(PinnedConversationError);
		const elsewhere = await harness.openStartup();
		await expect(harness.host.move(client, elsewhere)).rejects.toBeInstanceOf(PinnedConversationError);
		expect(harness.host.conversationOf(client)).toBe(child);
		expect(harness.host.list()).toHaveLength(2);
	});

	it("closes a conversation only after the operations it stays open for settle", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const client = harness.client("anchor", { anchor: true });
		await harness.host.attach(client, conversation);
		const operationStarted = Promise.withResolvers<void>();
		const releaseOperation = Promise.withResolvers<void>();
		const held = conversation.whileOpen(async (session) => {
			operationStarted.resolve();
			await releaseOperation.promise;
			return session.sessionId;
		});
		await operationStarted.promise;
		const disposeSession = vi.spyOn(conversation.session, "dispose");

		const closing = harness.host.detach(client);
		await expect(conversation.whileOpen(() => "late")).rejects.toThrow("The conversation is closed");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(disposeSession).not.toHaveBeenCalled();
		expect(harness.events.map((event) => event.type)).toEqual(["session_start"]);

		releaseOperation.resolve();
		await expect(held).resolves.toBe(conversation.id);
		await closing;
		expect(disposeSession).toHaveBeenCalledOnce();
		expect(harness.events.map((event) => event.type)).toEqual(["session_start", "session_shutdown"]);
	});

	it("closes every conversation on dispose", async () => {
		const harness = await setup();
		const first = await harness.openStartup();
		const second = await harness.openStartup();
		await harness.host.attach(harness.client("first"), first);

		await harness.host.dispose();

		expect(first.closed).toBe(true);
		expect(second.closed).toBe(true);
		expect(harness.host.list()).toEqual([]);
	});
});
