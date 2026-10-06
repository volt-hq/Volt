/**
 * The TUI follows its moves by reconnecting (architecture rewrite Phase 7,
 * slice 3): while its client moves, the store holds nothing and the TUI
 * waits for the conversation it moves to. What the user sends meanwhile goes
 * there once it shows, and the interrupt key stops nothing.
 */

import { type FauxResponseFactory, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness, type TuiHarness, waitForScreen } from "./tui-harness.ts";

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };
const ESCAPE = "\x1b";

/** A faux response that waits until released. */
function held(text: string): { step: FauxResponseFactory; started: Promise<void>; release(): void } {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		step: () =>
			new Promise((resolve) => {
				started.resolve();
				void released.promise.then(() => resolve(fauxAssistantMessage(text)));
			}),
		started: started.promise,
		release: () => released.resolve(),
	};
}

describe("the TUI while its client moves", () => {
	const harnesses: TuiHarness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.restoreAllMocks();
	});

	it("queues what the user sends until the conversation it moves to shows, and Esc stops nothing", async () => {
		const harness = await createTuiHarness({ globalSettings: SETTINGS, responses: ["first reply", "second reply"] });
		harnesses.push(harness);
		const tui = await harness.startMode({ columns: 100, rows: 30 });
		await tui.submit("first question");
		await waitForScreen(tui, "first reply");
		await tui.store.client.waitForIdle();
		const source = harness.startup;
		// The connector reaches the conversation a move leads to only once the test lets it.
		const reach = Promise.withResolvers<void>();
		const open = harness.connector.open.bind(harness.connector);
		vi.spyOn(harness.connector, "open").mockImplementation(async (target, options) => {
			if (target.kind === "session") await reach.promise;
			return open(target, options);
		});
		const intents = vi.spyOn(tui.store.client, "intent");

		const moving = tui.submit("/clear");
		await vi.waitFor(() => expect(tui.store.moving).toBeDefined());
		const target = tui.store.moving;
		const typed = tui.submit("typed while moving");
		tui.terminal.sendInput(ESCAPE);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(intents.mock.calls.map(([name]) => name)).toEqual(["new_session"]);

		reach.resolve();
		await moving;
		await typed;
		await waitForScreen(tui, "typed while moving", "second reply");
		expect(tui.store.conversation).toBe(target);
		expect(harness.connector.conversation.id).toBe(target);
		await vi.waitFor(() => expect(source.closed).toBe(true));
		expect(intents.mock.calls.map(([name]) => name)).toEqual(["new_session", "prompt"]);
		const userTexts = harness.connector.conversation.session.messages.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return [message.content.map((block) => (block.type === "text" ? block.text : "")).join("")];
		});
		expect(userTexts).toEqual(["typed while moving"]);
	});

	it("shows a session whose queued input it recovers at startup while that input runs", async () => {
		const harness = await createTuiHarness({
			globalSettings: SETTINGS,
			// Durable input a previous run queued and never delivered.
			startup: {
				seed: async (writer) => {
					await writer.queueHostMessages("steer", [
						{
							role: "custom",
							customType: "test-queued",
							content: "queued before startup",
							display: true,
							timestamp: 0,
						},
					]);
				},
			},
		});
		harnesses.push(harness);
		const reply = held("recovered reply");
		harness.faux.setResponses([reply.step]);

		const tui = await harness.startMode({ columns: 100, rows: 30 });

		await reply.started;
		await waitForScreen(tui, "queued before startup");
		expect(tui.store.phase?.busy).toBe(true);
		reply.release();
		await waitForScreen(tui, "recovered reply");
	});
});
