import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { PinnedConversationError } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./host-harness.ts";

/** A UI surface that records the statuses it shows. */
function statusUi(statuses: Map<string, string>): ExtensionUIContext {
	const ui: Pick<ExtensionUIContext, "setStatus" | "setWidget" | "setTitle" | "notify"> = {
		setStatus: (key, text) => {
			if (text === undefined) statuses.delete(key);
			else statuses.set(key, text);
		},
		setWidget: () => {},
		setTitle: () => {},
		notify: () => {},
	};
	return ui as ExtensionUIContext;
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
		const client = harness.client("tui", { ui: statusUi(statuses) });
		await harness.host.attach(client, source);
		expect(statuses.get("ext")).toBe(`ready:${source.id}`);
		harness.events.length = 0;

		const result = await harness.host.openFor(client, { kind: "new" });
		const target = result.conversation;
		if (!target) throw new Error("Expected the new conversation");

		expect(result).toMatchObject({ cancelled: false, seeded: false });
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

		const result = await harness.host.openFor(
			client,
			{ kind: "new" },
			{
				withSession: async (ctx) => {
					expect(source.closed).toBe(true);
					await ctx.sendUserMessage("seed");
				},
			},
		);

		expect(result.seeded).toBe(true);
		expect(result.conversation?.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("redirects a redirect client to the new conversation without attaching it there", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const redirects: string[] = [];
		const phone: HostClient = {
			id: "phone",
			surface: { mode: "rpc" },
			move: { kind: "redirect", redirect: (sessionId) => void redirects.push(sessionId) },
		};
		await harness.host.attach(phone, source);

		const result = await harness.host.openFor(phone, { kind: "new" });

		expect(redirects).toEqual([result.conversation?.id]);
		expect(harness.host.conversationOf(phone)).toBeUndefined();
		expect(source.closed).toBe(true);
		expect(result.conversation?.closed).toBe(false);
	});

	it("runs one client's structural intents one at a time", async () => {
		const harness = await setup();
		const source = await harness.openStartup();
		const client = harness.client("tui");
		await harness.host.attach(client, source);

		const [first, second] = await Promise.all([
			harness.host.openFor(client, { kind: "new" }),
			harness.host.openFor(client, { kind: "new" }),
		]);

		expect(client.moves).toEqual([first.conversation?.id, second.conversation?.id]);
		expect(first.conversation?.closed).toBe(true);
		expect(second.conversation?.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		expect(harness.host.list()).toEqual([second.conversation]);
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
