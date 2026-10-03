import type { AgentMessage, AgentTool, ConversationLogAppend } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { getClientMessageId } from "../../../src/core/messages.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

type UserMessage = Extract<AgentMessage, { role: "user" }>;

const ORIGINAL_IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" };

/** Mutate every exposed reference of `messages` in place, as a misbehaving observer might. */
function mutateMessages(messages: AgentMessage[]): void {
	messages.reverse();
	for (const message of messages) {
		if (message.role !== "user") continue;
		message.timestamp = 1;
		if (typeof message.content === "string") {
			message.content = "mutated by an observer";
			continue;
		}
		for (const part of message.content) {
			if (part.type === "text") part.text = "mutated by an observer";
			if (part.type === "image") part.data = "bXV0YXRlZA==";
		}
	}
}

function findUser(messages: readonly AgentMessage[], text?: string): UserMessage | undefined {
	return messages.find(
		(message): message is UserMessage =>
			message.role === "user" && (text === undefined || getMessageText(message) === text),
	);
}

/** Whether a log batch delivers a user message carrying `text`: that input's delivery commit. */
function deliversUserText(text: string): (batch: ConversationLogAppend) => boolean {
	return (batch) =>
		batch.entries.some((entry) => {
			if (entry.type !== "message") return false;
			const message = (entry.payload as { message?: AgentMessage }).message;
			return message?.role === "user" && getMessageText(message) === text;
		});
}

describe("regression #211: delivery payload isolation", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanupAsync();
		harness = undefined;
	});

	it("keeps canonical, finalized-event, delivery-event, and provider payloads identical when observers mutate what they receive", async () => {
		let providerUser: UserMessage | undefined;
		let deliveryUser: UserMessage | undefined;
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_start", (event) => {
						mutateMessages([event.message]);
					});
					volt.on("message_end", (event) => {
						mutateMessages([event.message]);
					});
					volt.on("context", (event) => {
						const user = findUser(event.messages);
						if (user) providerUser = structuredClone(user);
						return { messages: event.messages };
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type !== "delivery_start") return;
			const user = findUser(event.messages);
			if (user) deliveryUser = structuredClone(user);
			mutateMessages(event.messages);
		});
		harness.session.subscribe((event) => {
			if (event.type === "message_end") mutateMessages([event.message]);
		});
		harness.setResponses([fauxAssistantMessage("committed")]);
		const images = [structuredClone(ORIGINAL_IMAGE)];

		await harness.session.prompt("immutable original", { images });
		images[0]!.data = "bGF0ZSBjYWxsZXIgbXV0YXRpb24=";

		const expectedContent = [{ type: "text", text: "immutable original" }, ORIGINAL_IMAGE];
		const canonicalUser = findUser(harness.sessionManager.buildSessionContext().messages);
		const sessionUser = findUser(harness.session.state.messages);
		expect(canonicalUser?.content).toEqual(expectedContent);
		expect(sessionUser).toEqual(canonicalUser);
		expect(deliveryUser).toEqual(canonicalUser);
		expect(providerUser?.content).toEqual(expectedContent);
		expect(providerUser?.timestamp).toBe(canonicalUser?.timestamp);
	});

	it("keeps a rolled-back delivery's queued payload isolated from the extension output of the failed attempt", async () => {
		const received: string[] = [];
		const returned: UserMessage[] = [];
		let deliveryUser: UserMessage | undefined;
		let providerUser: UserMessage | undefined;
		harness = await createHarness({
			log: "memory",
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						received.push(getMessageText(event.message));
						const replacement: UserMessage = {
							...event.message,
							content: [
								{ type: "text", text: `transformed (${received.length})` },
								{ type: "image", mimeType: "image/png", data: "dHJhbnNmb3JtZWQ=" },
							],
						};
						returned.push(replacement);
						return { message: replacement };
					});
					volt.on("context", (event) => {
						const user = findUser(event.messages);
						if (user) providerUser = structuredClone(user);
						return { messages: event.messages };
					});
				},
			],
		});
		harness.session.subscribe((event) => {
			if (event.type !== "delivery_start") return;
			const user = findUser(event.messages);
			if (user) deliveryUser = structuredClone(user);
		});
		harness.setResponses([fauxAssistantMessage("committed after retry")]);
		const clientMessageId = "isolated-retry";
		harness.log!.failNext("rolled_back", deliversUserText("transformed (1)"));

		await harness.session.steer("original", [structuredClone(ORIGINAL_IMAGE)], clientMessageId);
		await harness.session.waitForIdle();
		// The failed attempt's output, mutated after the hook returned, reaches nothing.
		mutateMessages(returned);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		expect(findUser(harness.sessionManager.buildSessionContext().messages)).toBeUndefined();

		await harness.control.continue();

		const expected = [
			{ type: "text", text: "transformed (2)" },
			{ type: "image", mimeType: "image/png", data: "dHJhbnNmb3JtZWQ=" },
		];
		// The retry prepares the durable queued input again, not the failed attempt's output.
		expect(received).toEqual(["original", "original"]);
		const canonicalUser = findUser(harness.sessionManager.buildSessionContext().messages);
		expect(canonicalUser?.content).toEqual(expected);
		expect(getClientMessageId(canonicalUser!)).toBe(clientMessageId);
		expect(findUser(harness.session.state.messages)).toEqual(canonicalUser);
		expect(deliveryUser).toEqual(canonicalUser);
		expect(providerUser?.content).toEqual(expected);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
	});

	it("keeps a queued input's identity and payload when an extension rewrites them and its delivery commit rolls back", async () => {
		let releaseTool = (): void => undefined;
		let markToolStarted = (): void => undefined;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-for-retained-queue",
			label: "Wait",
			description: "Wait for retained queue delivery",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const text = "queued immutable payload";
		harness = await createHarness({
			log: "memory",
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user" || getMessageText(event.message) !== text) return;
						const replacement = structuredClone(event.message);
						mutateMessages([event.message]);
						Object.assign(replacement, { clientMessageId: "substituted-runtime-identity" });
						return { message: replacement };
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait-for-retained-queue", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("queued turn complete"),
		]);
		harness.log!.failNext("rolled_back", deliversUserText(text));
		const activeRun = harness.session.prompt("start retained queue");
		await toolStarted;
		const clientMessageId = "retained-queue-client";
		await harness.session.steer(text, undefined, clientMessageId);

		releaseTool();
		await activeRun;
		await harness.session.waitForIdle();
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual([{ queueEntryId: clientMessageId, clientMessageId, text }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");

		await harness.control.continue();

		const canonicalUser = harness.sessionManager
			.buildSessionContext()
			.messages.find(
				(message): message is UserMessage =>
					message.role === "user" && getClientMessageId(message) === clientMessageId,
			);
		expect(canonicalUser?.content).toEqual([{ type: "text", text }]);
		expect(
			harness.sessionManager
				.buildSessionContext()
				.messages.filter((message) => message.role === "user" && getMessageText(message) === text),
		).toHaveLength(1);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
