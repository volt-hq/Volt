import { AcceptedFrameSchema, type HostFrame } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, type LoopbackClient } from "../../../src/client/protocol-client.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

type StructuralIntent = "new_session" | "switch_session" | "fork" | "clone";
type AcceptedFrame = Extract<HostFrame, { type: "accepted" }>;

const checkAccepted = Compile(AcceptedFrameSchema);

describe("regression #585: structural intents answer with the conversation the client moved to", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		let cancel = false;
		const harness: HostHarness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
				volt.on("session_before_fork", () => (cancel ? { cancel: true } : undefined));
			},
		});
		const source = await harness.openStartup();
		await source.session.prompt("first prompt");
		const frames: HostFrame[] = [];
		const client: LoopbackClient = await createLoopbackClient(harness.host, source, {
			onFrame: (frame) => frames.push(frame),
		});
		cleanups.push(async () => {
			await client.stop();
			await harness.cleanup();
		});
		const intentNames = new Map<string, StructuralIntent>();
		/** Send a structural intent; once it moved the client, wait until the client follows. */
		const run = async (name: StructuralIntent, input: Record<string, unknown> = {}): Promise<AcceptedFrame> => {
			const accepted = await client.intent(name, input);
			intentNames.set(accepted.intentId, name);
			if (accepted.conversation !== undefined) {
				await vi.waitFor(() => expect(client.conversation).toBe(accepted.conversation));
				await client.caughtUp();
			}
			return accepted;
		};
		/** Every acceptance of `name` so far, checked against the frame schema: its conversation and result. */
		const outcomes = (name: StructuralIntent) => {
			const matching = frames.filter(
				(frame): frame is AcceptedFrame => frame.type === "accepted" && intentNames.get(frame.intentId) === name,
			);
			for (const frame of matching) expect([...checkAccepted.Errors(frame)]).toEqual([]);
			return matching.map((frame) => ({
				...(frame.conversation === undefined ? {} : { conversation: frame.conversation }),
				...(frame.result === undefined ? {} : { result: frame.result }),
			}));
		};
		/** The session of the one conversation the client is on: the host closes each it leaves. */
		const currentSessionId = () => {
			const [conversation, ...others] = harness.host.list();
			if (!conversation || others.length > 0) throw new Error("Expected one open conversation");
			return conversation.id;
		};
		/** The id of the first user message the client's fold holds. */
		const firstUserEntry = () => {
			const entry = client.state.entries.find(
				(candidate) => candidate.type === "message" && candidate.view?.role === "user",
			);
			if (!entry) throw new Error("Expected a user message");
			return entry.id;
		};
		return {
			currentSessionId,
			client,
			run,
			outcomes,
			firstUserEntry,
			cancelNext: (value: boolean) => {
				cancel = value;
			},
		};
	}

	it("answers each structural intent with the conversation the client is on now", async () => {
		const { currentSessionId, client, run, outcomes, firstUserEntry } = await setup();
		const first = currentSessionId();

		const created = await run("new_session");
		const second = currentSessionId();
		expect(second).not.toBe(first);
		expect(created).toMatchObject({ conversation: second });
		expect(client.conversation).toBe(second);

		await expect(run("switch_session", { sessionId: first })).resolves.toMatchObject({ conversation: first });
		await expect(run("switch_session", { sessionId: second })).resolves.toMatchObject({ conversation: second });
		// A switch to the conversation the client is on moves nothing and names it.
		await expect(run("switch_session", { sessionId: second })).resolves.toMatchObject({ conversation: second });
		expect(currentSessionId()).toBe(second);
		expect(client.conversation).toBe(second);

		await run("switch_session", { sessionId: first });
		const forked = await run("fork", { entryId: firstUserEntry() });
		const third = currentSessionId();
		expect(forked).toMatchObject({ conversation: third, result: { text: "first prompt" } });
		expect(new Set([first, second, third]).size).toBe(3);

		await client.prompt("fork prompt");
		await client.waitForIdle(10_000);
		const cloned = await run("clone");
		const fourth = currentSessionId();
		expect(cloned).toMatchObject({ conversation: fourth });
		expect(fourth).not.toBe(third);
		expect(client.conversation).toBe(fourth);

		expect(outcomes("new_session")).toEqual([{ conversation: second }]);
		expect(outcomes("switch_session")).toEqual([
			{ conversation: first },
			{ conversation: second },
			{ conversation: second },
			{ conversation: first },
		]);
		expect(outcomes("fork")).toEqual([{ conversation: third, result: { text: "first prompt" } }]);
		expect(outcomes("clone")).toEqual([{ conversation: fourth }]);
	});

	it("answers only cancelled: true when an extension cancels, and keeps the client on its conversation", async () => {
		const { currentSessionId, client, run, outcomes, firstUserEntry, cancelNext } = await setup();
		const first = currentSessionId();
		const created = await run("new_session");
		if (created.conversation === undefined) throw new Error("Expected the new session");
		await run("switch_session", { sessionId: first });
		const forkFrom = firstUserEntry();
		cancelNext(true);

		await expect(run("new_session")).resolves.not.toHaveProperty("conversation");
		await expect(run("switch_session", { sessionId: created.conversation })).resolves.not.toHaveProperty(
			"conversation",
		);
		await expect(run("fork", { entryId: forkFrom })).resolves.not.toHaveProperty("conversation");
		await expect(run("clone")).resolves.not.toHaveProperty("conversation");

		expect(currentSessionId()).toBe(first);
		expect(client.conversation).toBe(first);
		expect(outcomes("new_session").at(-1)).toEqual({ result: { cancelled: true } });
		expect(outcomes("switch_session").at(-1)).toEqual({ result: { cancelled: true } });
		expect(outcomes("fork")).toEqual([{ result: { cancelled: true } }]);
		expect(outcomes("clone")).toEqual([{ result: { cancelled: true } }]);
	});
});
