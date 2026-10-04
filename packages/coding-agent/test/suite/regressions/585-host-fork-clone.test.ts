import { afterEach, describe, expect, it } from "vitest";
import type { SessionReference } from "../../../src/core/session-manager.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

function userTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
	return messages
		.filter((message) => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: (message.content as Array<{ type: string; text?: string }>)
						.filter((part) => part.type === "text")
						.map((part) => part.text ?? "")
						.join(""),
		);
}

describe("regression #585: fork and clone open a new conversation from an open one", () => {
	const harnesses: HostHarness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function setup() {
		const harness = await createHostHarness();
		harnesses.push(harness);
		const source = await harness.openStartup();
		const client = harness.client("tui", { anchor: true });
		await harness.host.attach(client, source);
		await source.session.prompt("first prompt");
		await source.session.prompt("second prompt");
		harness.events.length = 0;
		return { harness, source, client };
	}

	it("forks before a user message: the branch up to its parent, its text returned, lineage recorded", async () => {
		const { harness, source, client } = await setup();
		const sourceRef = source.session.sessionRef as SessionReference;
		const second = source.session.getUserMessagesForForking().find((message) => message.text === "second prompt");
		if (!second) throw new Error("Expected the second user message");
		const parentId = source.session.sessionManager.getEntry(second.entryId)?.parentId;

		const result = await harness.host.openFor(client, {
			kind: "fork",
			source,
			entryId: second.entryId,
			position: "before",
		});
		const fork = result.conversation;
		if (!fork) throw new Error("Expected the fork");

		expect(result.selectedText).toBe("second prompt");
		expect(userTexts(fork.session.messages)).toEqual(["first prompt"]);
		expect(fork.session.sessionManager.getForkedFrom()).toEqual({ sessionId: source.id, entryId: parentId });
		expect(harness.events).toEqual([
			{ type: "session_before_fork", entryId: second.entryId, position: "before", sessionId: source.id },
			{ type: "session_start", reason: "fork", previousSessionRef: sourceRef, sessionId: fork.id },
			{
				type: "session_shutdown",
				reason: "fork",
				targetSessionRef: fork.session.sessionRef,
				sessionId: source.id,
			},
		]);
		expect(source.closed).toBe(true);
	});

	it("clones at the leaf", async () => {
		const { harness, source, client } = await setup();
		const leafId = source.session.sessionManager.getLeafId();
		if (!leafId) throw new Error("Expected a leaf");
		const sourceMessages = source.session.messages;

		const result = await harness.host.openFor(client, { kind: "fork", source, entryId: leafId, position: "at" });
		const clone = result.conversation;
		if (!clone) throw new Error("Expected the clone");

		expect(result.selectedText).toBeUndefined();
		expect(clone.id).not.toBe(source.id);
		expect(userTexts(clone.session.messages)).toEqual(userTexts(sourceMessages));
		expect(clone.session.sessionManager.getForkedFrom()).toEqual({ sessionId: source.id, entryId: leafId });
	});

	it("keeps the source when the fork entry is invalid", async () => {
		const { harness, source, client } = await setup();
		const assistantEntry = source.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!assistantEntry) throw new Error("Expected an assistant entry");

		await expect(
			harness.host.openFor(client, { kind: "fork", source, entryId: "missing", position: "at" }),
		).rejects.toThrow("Invalid entry ID for forking");
		await expect(
			harness.host.openFor(client, { kind: "fork", source, entryId: assistantEntry.id, position: "before" }),
		).rejects.toThrow("Invalid entry ID for forking");

		expect(harness.host.conversationOf(client)).toBe(source);
		expect(harness.host.list()).toEqual([source]);
		expect(harness.events.filter((event) => event.type === "session_shutdown")).toEqual([]);
	});
});
