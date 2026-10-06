/**
 * The in-process connector (architecture rewrite §10, Phase 7 slice 3): the
 * TUI's client over loopback, following each move by reconnecting. Its host
 * redirects the client and closes the conversation it left once the target
 * started; the client subscribes to the target from a snapshot on a new
 * connection, and what it asked around the move goes out again there,
 * answered once.
 */

import { join } from "node:path";
import { type ClientState, clientActiveBranch } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProtocolClient } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { createTuiHarness, type TuiHarness } from "./tui-harness.ts";

/** The text of the user messages on the client's active branch. */
function userTexts(state: ClientState): string[] {
	return clientActiveBranch(state).flatMap((entry) => {
		const message = entry.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== "user") return [];
		return [
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
		];
	});
}

/** Resolves once the client shows `conversation` on a connection of its own, caught up with its log. */
async function shows(client: ProtocolClient, conversation: string | undefined): Promise<void> {
	if (conversation === undefined) throw new Error("The intent moved the client nowhere");
	await vi.waitFor(() => {
		expect(client.moving).toBeUndefined();
		expect(client.conversation).toBe(conversation);
	});
	await client.caughtUp();
}

describe("InProcessConnector", () => {
	let harness: TuiHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("connects the TUI's client over loopback: its prompts are interactive input, and it anchors its conversation", async () => {
		const sources: string[] = [];
		let recover: { mock: { calls: unknown[] } } | undefined;
		harness = await createTuiHarness({
			extension: (volt) => {
				volt.on("input", (event) => {
					// The conversation's queued input started replaying before the client's own input ran.
					sources.push(`${event.source}:${recover?.mock.calls.length}`);
				});
			},
		});
		recover = vi.spyOn(harness.startup, "startRecoveredClientInputs");
		const client = await harness.connect();

		await client.promptAndWait("hello");
		expect(sources).toEqual(["interactive:1"]);

		await harness.connector.dispose();
		expect(harness.startup.closed).toBe(true);
	});

	it("keeps the model scope the TUI started with across a profile switch", async () => {
		// The host harness's faux provider and model.
		harness = await createTuiHarness({ modelScopePatterns: ["faux/faux-1"] });
		const client = await harness.connect();
		expect(harness.startup.session.scopedModels).toEqual([]);

		await client.intent("set_profile", { name: "work", create: true });

		expect(harness.startup.session.scopedModels.map((scoped) => scoped.model.id)).toEqual(["faux-1"]);
	});

	it("follows clone, new, switch, fork, and import by reconnecting, each target shown from its snapshot", async () => {
		harness = await createTuiHarness({ responses: ["first reply"] });
		const client = await harness.connect();
		await client.promptAndWait("first question");
		const source = harness.startup;
		const connections = new Set([client.connectionId]);
		const moveTo = async (conversation: string | undefined): Promise<HostedConversation> => {
			await shows(client, conversation);
			connections.add(client.connectionId);
			expect(harness?.connector.conversation.id).toBe(conversation);
			return harness!.connector.conversation;
		};

		const clone = await moveTo((await client.intent("clone", {})).conversation);
		expect(userTexts(client.state)).toEqual(["first question"]);
		// The source closed as the anchor's move closes it, once the clone started.
		await vi.waitFor(() => expect(source.closed).toBe(true));
		expect(harness.events.map((event) => [event.type, event.sessionId]).slice(-2)).toEqual([
			["session_start", clone.id],
			["session_shutdown", source.id],
		]);
		const exported = join(harness.tempDir, "clone.jsonl");
		await client.intent("export_jsonl", { outputPath: exported });

		await moveTo((await client.intent("new_session", {})).conversation);
		expect(userTexts(client.state)).toEqual([]);
		await vi.waitFor(() => expect(clone.closed).toBe(true));

		await moveTo((await client.intent("switch_session", { sessionId: clone.id })).conversation);
		expect(userTexts(client.state)).toEqual(["first question"]);
		const question = clientActiveBranch(client.state).find((entry) => entry.type === "message")?.id;
		if (question === undefined) throw new Error("The clone holds no message");

		const fork = await client.intent("fork", { entryId: question });
		expect(fork.result).toEqual({ text: "first question" });
		await moveTo(fork.conversation);
		expect(userTexts(client.state)).toEqual([]);

		await moveTo((await client.intent("import_session", { path: exported })).conversation);
		expect(userTexts(client.state)).toEqual(["first question"]);
		// Each move ended the connection it left: the client reconnected for each.
		expect(connections.size).toBe(6);
		expect(harness.host.list()).toEqual([harness.connector.conversation]);
	});

	it("answers an extension command that moved its client once, after the client reconnected, and seeds the target", async () => {
		const handled: string[] = [];
		harness = await createTuiHarness({
			responses: ["kickoff reply"],
			extension: (volt) => {
				volt.registerCommand("handoff", {
					handler: async (_args, ctx) => {
						handled.push(ctx.sessionManager.getSessionId());
						const result = await ctx.newSession({
							withSession: async (next) => {
								handled.push(`seed:${next.sessionManager.getSessionId()}`);
								await next.sendUserMessage("kickoff");
							},
						});
						handled.push(JSON.stringify(result.cancelled ? result : { seeded: result.seeded }));
					},
				});
			},
		});
		const client = await harness.connect();
		const source = harness.startup.id;
		const { intents } = await client.query("intents");
		const handoff = intents.find((intent) => intent.name.endsWith(".handoff"))?.name;
		if (handoff === undefined) throw new Error("The command is not listed");
		harness.events.splice(0);

		const accepted = await client.intent(handoff, {});

		expect(accepted).toMatchObject({ type: "accepted" });
		const target = harness.connector.conversation.id;
		expect(target).not.toBe(source);
		expect(handled).toEqual([source, `seed:${target}`, JSON.stringify({ seeded: true })]);
		// The target started before the source closed, and the seed came after both.
		expect(harness.events.map((event) => [event.type, event.sessionId])).toEqual([
			["session_before_switch", source],
			["session_start", target],
			["session_shutdown", source],
		]);
		await shows(client, target);
		await vi.waitFor(() => expect(userTexts(client.state)).toEqual(["kickoff"]));
	});

	it("holds what the client asks while it moves, and sends it in order to the conversation it moved to", async () => {
		harness = await createTuiHarness({
			extension: (volt) => {
				volt.registerCommand("leave", {
					handler: async (_args, ctx) => {
						await ctx.newSession();
					},
				});
			},
		});
		const client = await harness.connect();
		const asked: Array<Promise<unknown>> = [];
		client.onChange((change) => {
			if (change?.type !== "ended" || change.reason !== "moved") return;
			expect(client.moving).toBe(change.target);
			asked.push(client.intent("set_session_name", { name: "renamed while moving" }));
			asked.push(client.query("conversation_info"));
		});

		await client.prompt("/leave");
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		const [, info] = await Promise.all(asked);
		const target = harness.connector.conversation;

		expect(target.id).not.toBe(harness.startup.id);
		expect(info).toMatchObject({ id: target.id });
		expect(target.session.sessionManager.getSessionName()).toBe("renamed while moving");
	});

	it("starts a plan executed in a new session there once the client reconnected", async () => {
		harness = await createTuiHarness({ responses: ["execution reply"] });
		const client = await harness.connect();
		const session = harness.startup.session;
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({
			title: "Hand off",
			summary: "Execute in a fresh session.",
			steps: [{ text: "Make the change" }],
		});
		const ready = await session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Hand off",
			summary: "Execute in a fresh session.",
		});

		const accepted = await client.intent("plan_execute", {
			planId: ready.id,
			expectedRevision: ready.revision,
			strategy: "new_session",
		});

		await shows(client, accepted.conversation);
		await vi.waitFor(() => expect(harness?.connector.conversation.session.messages.at(-1)?.role).toBe("assistant"));
		const target = harness.connector.conversation;
		expect(target.session.planningState.plan).toMatchObject({ id: ready.id, phase: "active" });
		// The source handed the plan off before it closed.
		await vi.waitFor(() => expect(harness?.startup.closed).toBe(true));
	});

	it("leaves an extension fork's editor text for the connection the client reconnects on", async () => {
		harness = await createTuiHarness({
			responses: ["first reply"],
			extension: (volt) => {
				volt.registerCommand("xfork", {
					handler: async (args, ctx) => {
						await ctx.fork(args.trim());
					},
				});
			},
		});
		const editorTexts: string[] = [];
		const client = await harness.connect({
			onFrame: (frame) => {
				if (frame.type !== "live") return;
				for (const item of frame.items) {
					if (item.type === "directive" && item.directive !== "set_theme") editorTexts.push(item.text);
				}
			},
		});
		await client.promptAndWait("first question");
		const question = clientActiveBranch(client.state).find((entry) => entry.type === "message")?.id;

		await client.prompt(`/xfork ${question}`);

		await vi.waitFor(() => expect(editorTexts).toEqual(["first question"]));
		expect(harness.connector.conversation.id).not.toBe(harness.startup.id);
	});
});
