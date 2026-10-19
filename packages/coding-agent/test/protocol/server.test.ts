/**
 * The protocol server on the local profile (docs/rpc.md): connection
 * admission, subscriptions from a snapshot and by position, intents and their
 * outcomes, idempotency, structural moves, host requests, notices, queries,
 * and catalog changes.
 */

import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolClient, ProtocolRejectedError } from "../../src/client/protocol-client.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair, type RpcTransport } from "../../src/core/protocol/transport/index.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../suite/host-harness.ts";

/** A raw client end that records every frame the host writes. */
function rawClient(transport: RpcTransport): { frames: HostFrame[]; send(frame: object): void } {
	const frames: HostFrame[] = [];
	transport.onValue?.((value) => {
		frames.push(value as HostFrame);
	});
	return { frames, send: (frame) => void transport.write(frame) };
}

/** A client end that records what the client writes, and loses the host frames `loses` picks before the client reads them. */
function tapped(
	transport: RpcTransport,
	loses: (frame: HostFrame) => boolean = () => false,
): { transport: RpcTransport; sent: Array<Record<string, unknown>> } {
	const sent: Array<Record<string, unknown>> = [];
	return {
		sent,
		transport: {
			write: (value) => {
				sent.push(value as Record<string, unknown>);
				return transport.write(value);
			},
			onLine: (handler) => transport.onLine(handler),
			onValue: (handler) => transport.onValue!((value) => (loses(value as HostFrame) ? undefined : handler(value))),
			onClose: (handler) => transport.onClose!(handler),
			close: () => transport.close(),
		},
	};
}

const HELLO = { type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } };

describe("protocol server on the local profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		options: HostHarnessOptions = {},
	): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness(options);
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function connect(
		harness: HostHarness,
		conversation: HostedConversation,
		options: Parameters<typeof createLoopbackClient>[2] = {},
	) {
		const frames: HostFrame[] = [];
		const client = await createLoopbackClient(harness.host, conversation, options);
		client.onFrame((frame) => frames.push(frame));
		cleanups.push(() => client.stop());
		return { client, frames };
	}

	it("welcomes a client with the conversation it attached it to, then serves a snapshot and the live lane", async () => {
		const { harness, conversation } = await setup();
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, { host: harness.host, conversation });
		const raw = rawClient(pair.client);
		cleanups.push(async () => {
			await pair.client.close();
			await connection.closed.catch(() => undefined);
		});
		raw.send(HELLO);
		await vi.waitFor(() => expect(raw.frames.map((frame) => frame.type)).toEqual(["welcome"]));
		expect(raw.frames[0]).toMatchObject({ protocol: 1, profile: "local", conversation: conversation.id });
		await connection.ready;

		raw.send({ type: "subscribe", subscriptionId: "s1", conversation: conversation.id, after: "snapshot" });
		await vi.waitFor(() => expect(raw.frames.some((frame) => frame.type === "live")).toBe(true));
		const snapshot = raw.frames.find((frame) => frame.type === "snapshot");
		expect(snapshot).toMatchObject({
			subscriptionId: "s1",
			conversation: conversation.id,
			sessionGeneration: conversation.session.sessionManager.getSessionGeneration(),
		});
		const live = raw.frames.find((frame) => frame.type === "live");
		expect(live).toMatchObject({ seq: 1, reset: true });
		if (live?.type !== "live") throw new Error("Expected a live frame");
		expect(live.items.map((item) => (item.type === "set" ? item.key : item.type))).toEqual(
			expect.arrayContaining(["phase", "intents", "usage", "git", "prompt_cache"]),
		);

		raw.send({ type: "unsubscribe", subscriptionId: "s1" });
		await vi.waitFor(() =>
			expect(raw.frames.at(-1)).toEqual({ type: "ended", subscriptionId: "s1", reason: "unsubscribed" }),
		);
	});

	it("ends the connection with fatal on a frame before hello, a protocol mismatch, and a malformed frame", async () => {
		const { harness, conversation } = await setup();
		const sessionGeneration = conversation.session.sessionManager.getSessionGeneration();
		const subscribe = { type: "subscribe", subscriptionId: "s", conversation: conversation.id };
		const cases: Array<{ frames: object[]; code: string; message?: string }> = [
			{
				frames: [{ ...subscribe, after: 0, sessionGeneration }],
				code: "invalid_frame",
				message: "The first frame must be hello",
			},
			{ frames: [{ ...HELLO, protocol: 2 }], code: "protocol_mismatch" },
			{ frames: [HELLO, { type: "subscribe", subscriptionId: "s" }], code: "invalid_frame" },
			// A position without the log generation it belongs to, and a snapshot that names one.
			{ frames: [HELLO, { ...subscribe, after: 0 }], code: "invalid_frame", message: "Invalid subscribe frame" },
			{
				frames: [HELLO, { ...subscribe, after: "snapshot", sessionGeneration }],
				code: "invalid_frame",
				message: "Invalid subscribe frame",
			},
			{ frames: [HELLO, { type: "welcome" }], code: "invalid_frame" },
			{ frames: [HELLO, { type: "set_model", input: {} }], code: "invalid_frame" },
		];
		for (const testCase of cases) {
			const pair = createLoopbackRpcTransportPair();
			const connection = serveConnection(pair.server, localProfile, {
				host: harness.host,
				conversation,
				anchor: false,
			});
			const raw = rawClient(pair.client);
			for (const frame of testCase.frames) raw.send(frame);
			await connection.closed.catch(() => undefined);
			expect(raw.frames.at(-1)).toMatchObject({
				type: "fatal",
				code: testCase.code,
				...(testCase.message === undefined ? {} : { message: testCase.message }),
			});
		}
	});

	it("accepts a prompt once admitted, streams its run, and commits its entries", async () => {
		const { harness, conversation } = await setup();
		const { client, frames } = await connect(harness, conversation);
		const accepted = await client.prompt("hello");
		expect(accepted.ordinals.length).toBeGreaterThan(0);
		await client.waitForIdle(10_000);

		const messages = client.state.entries.filter((entry) => entry.type === "message");
		expect(messages.map((entry) => entry.view?.role)).toEqual(["user", "assistant"]);
		expect(messages[0]?.view).toMatchObject({ text: "hello", clientMessageId: accepted.intentId });
		expect(messages[1]?.view).toMatchObject({ text: "one", stopReason: "stop" });
		expect(
			frames.some((frame) => frame.type === "live" && frame.items.some((item) => item.type === "assistant_start")),
		).toBe(true);
		// The committed entry ended the stream; the live state holds no streaming message.
		expect(client.live.assistant).toBeUndefined();
		expect(client.live.values.get("usage")).toMatchObject({ kind: "usage" });
	});

	it("rejects unknown intents and invalid input, and answers a retried intent id with the same outcome", async () => {
		const { harness, conversation } = await setup();
		const { client, frames } = await connect(harness, conversation);
		await expect(client.intent("no_such_intent", {})).rejects.toMatchObject({ reason: { code: "unknown_intent" } });
		await expect(client.intent("set_session_name", { name: 1 })).rejects.toMatchObject({
			reason: { code: "invalid_input" },
		});

		const first = await client.intent("set_session_name", { name: "first" }, { intentId: "rename-1" });
		await vi.waitFor(() => expect(client.state.name).toBe("first"));
		const names = () =>
			conversation.session.sessionManager.getEntries().filter((entry) => entry.type === "session_info");
		expect(names()).toHaveLength(1);
		const replayed = await client.intent("set_session_name", { name: "first" }, { intentId: "rename-1" });
		expect(replayed).toEqual(first);
		expect(names()).toHaveLength(1);
		const conflict = client.intent("set_session_name", { name: "second" }, { intentId: "rename-1" });
		await expect(conflict).rejects.toBeInstanceOf(ProtocolRejectedError);
		await expect(conflict).rejects.toMatchObject({ reason: { code: "conflict" } });
		expect(frames.filter((frame) => frame.type === "accepted" && frame.intentId === "rename-1")).toHaveLength(2);
	});

	it("moves the client with a structural intent: accepted names the target, then the old subscription ends moved", async () => {
		const { harness, conversation } = await setup();
		const { client, frames } = await connect(harness, conversation);
		const accepted = await client.intent("new_session", {});
		expect(accepted.conversation).toBeDefined();
		expect(accepted.conversation).not.toBe(conversation.id);
		await vi.waitFor(() => expect(client.conversation).toBe(accepted.conversation));
		await client.caughtUp();
		// The client holds the target's log generation now, from its snapshot.
		const target = harness.host.get(accepted.conversation!)!.session.sessionManager.getSessionGeneration();
		expect(client.sessionGeneration).toBe(target);
		expect(target).not.toBe(conversation.session.sessionManager.getSessionGeneration());
		const acceptedIndex = frames.findIndex(
			(frame) => frame.type === "accepted" && frame.intentId === accepted.intentId,
		);
		const endedIndex = frames.findIndex((frame) => frame.type === "ended" && frame.reason === "moved");
		expect(acceptedIndex).toBeGreaterThanOrEqual(0);
		expect(endedIndex).toBeGreaterThan(acceptedIndex);
		expect(frames[endedIndex]).toMatchObject({ target: accepted.conversation });

		// Intents now act on the new conversation.
		await client.prompt("in the new session");
		await client.waitForIdle(10_000);
		expect(harness.host.get(accepted.conversation!)?.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("asks the host requests the client accepts and takes its answer", async () => {
		const answers: boolean[] = [];
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.registerCommand("ask", {
					handler: async (_args, ctx) => {
						answers.push(await ctx.ui.confirm("Proceed?", "Continue with the change?"));
					},
				});
			},
		});
		const { client } = await connect(harness, conversation, { hostRequests: ["confirm"] });
		// The command's prompt is admitted once the command ran: it waits for the answer.
		const asked = client.prompt("/ask");
		let requestId: string | undefined;
		await vi.waitFor(() => {
			const request = [...client.live.values.values()].find((value) => value.kind === "host_request");
			if (request?.kind !== "host_request") throw new Error("No host request yet");
			requestId = request.requestId;
		});
		client.answer(requestId!, { confirmed: true });
		await asked;
		await vi.waitFor(() => expect(answers).toEqual([true]));
		await vi.waitFor(() =>
			expect([...client.live.values.values()].some((value) => value.kind === "host_request")).toBe(false),
		);
	});

	it("tells the client about extension errors as notices", async () => {
		const { harness, conversation } = await setup({
			extension: (volt) => {
				volt.on("turn_start", () => {
					throw new Error("turn hook failed");
				});
			},
		});
		const { client, frames } = await connect(harness, conversation);
		await client.prompt("hello");
		await client.waitForIdle(10_000);
		const notices = frames.flatMap((frame) =>
			frame.type === "live" ? frame.items.filter((item) => item.type === "notice") : [],
		);
		expect(notices).toContainEqual(
			expect.objectContaining({ level: "error", message: expect.stringContaining("turn hook failed") }),
		);
	});

	it("answers history pages and content chunks from the projected log", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two", "three"] });
		const { client } = await connect(harness, conversation);
		for (const prompt of ["first", "second", "third"]) {
			await client.prompt(prompt);
			await client.waitForIdle(10_000);
		}
		const head = conversation.session.sessionManager.getOrdinal();
		const page = await client.query("history", { before: head + 1, limit: 2 });
		expect(page.entries.map((entry) => entry.ordinal)).toEqual(
			client.state.entries.slice(-2).map((entry) => entry.ordinal),
		);
		expect(page.earlier).toBe(true);
		expect(page.entries).toEqual(client.state.entries.slice(-2));

		const leaf = client.state.leafId!;
		const branch = await client.query("history", { before: head + 1, limit: 200, branch: leaf });
		expect(branch.entries.flatMap((entry) => (entry.type === "message" ? [entry.view?.text] : []))).toEqual([
			"first",
			"one",
			"second",
			"two",
			"third",
			"three",
		]);
		expect(branch.earlier).toBe(false);

		const firstUser = client.state.entries.find((entry) => entry.type === "message" && entry.view?.role === "user")!;
		await expect(client.query("content", { entryId: firstUser.id })).resolves.toEqual({
			entryId: firstUser.id,
			part: 0,
			parts: 1,
			content: { type: "text", text: "first", offset: 0, nextOffset: null, totalScalars: 5 },
		});
		await expect(client.query("content", { entryId: firstUser.id, offset: 2 })).resolves.toMatchObject({
			content: { text: "rst", offset: 2 },
		});
		await expect(client.query("content", { entryId: "missing" })).rejects.toMatchObject({ code: "invalid_input" });
	});

	it("rejects a branch-fenced intent stale once the branch switched after the client's position", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two"] });
		const { client } = await connect(harness, conversation);
		await client.prompt("first");
		await client.waitForIdle(10_000);
		await client.prompt("second");
		await client.waitForIdle(10_000);
		const position = client.state.ordinal;
		const firstAnswer = client.state.entries.find((entry) => entry.type === "message" && entry.view?.text === "one")!;
		await conversation.session.navigateTree(firstAnswer.id);
		const switched = conversation.session.conversationGenerationRevision;
		expect(switched).toBeGreaterThan(position);

		await expect(
			client.intent("set_agent_mode", { mode: "plan" }, { expectedOrdinal: position }),
		).rejects.toMatchObject({
			reason: { code: "stale", ordinal: switched },
		});
		await vi.waitFor(() => expect(client.state.ordinal).toBeGreaterThanOrEqual(switched));
		await expect(
			client.intent("set_agent_mode", { mode: "plan" }, { expectedOrdinal: client.state.ordinal }),
		).resolves.toMatchObject({ type: "accepted" });
	});

	it("rejects a branch-fenced intent stale when the branch switches while it awaits", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two"] });
		const { client } = await connect(harness, conversation);
		await client.prompt("first");
		await client.waitForIdle(10_000);
		await client.prompt("second");
		await client.waitForIdle(10_000);
		const position = client.state.ordinal;
		const firstAnswer = client.state.entries.find((entry) => entry.type === "message" && entry.view?.text === "one")!;
		const session = conversation.session;
		const model = session.model!;
		// The model lookup holds until the branch switched under it.
		const lookup = Promise.withResolvers<void>();
		const registry = session.modelRegistry;
		const getAvailable = registry.getAvailable.bind(registry);
		// The intent awaits the lookup, so a pending one holds it.
		vi.spyOn(registry, "getAvailable").mockImplementation(
			() => lookup.promise.then(getAvailable) as unknown as ReturnType<typeof getAvailable>,
		);
		const setModel = vi.spyOn(session, "setModel");

		const outcome = client.intent(
			"set_model",
			{ provider: model.provider, modelId: model.id },
			{ expectedOrdinal: position },
		);
		await vi.waitFor(() => expect(registry.getAvailable).toHaveBeenCalled());
		await session.navigateTree(firstAnswer.id);
		lookup.resolve();

		await expect(outcome).rejects.toMatchObject({
			reason: { code: "stale", ordinal: session.conversationGenerationRevision },
		});
		expect(setModel).not.toHaveBeenCalled();
	});

	it("tells the client to refetch settings after a settings intent", async () => {
		const { harness, conversation } = await setup();
		const { client, frames } = await connect(harness, conversation);
		await client.intent("set_steering_mode", { mode: "all" });
		await vi.waitFor(() => expect(frames).toContainEqual({ type: "changed", catalog: "settings" }));
		await expect(client.query("settings")).resolves.toMatchObject({ steeringMode: "all" });
	});

	it("resumes a reconnecting client after its position", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two"], whenUnattached: "keep" });
		const first = new ProtocolClient();
		const firstPair = createLoopbackRpcTransportPair();
		const firstConnection = serveConnection(firstPair.server, localProfile, {
			host: harness.host,
			conversation,
			anchor: false,
		});
		await first.connect(firstPair.client);
		await first.prompt("first");
		await first.waitForIdle(10_000);
		await first.stop();
		await firstConnection.closed;
		const position = first.state.ordinal;

		// The conversation goes on while the client is away.
		await conversation.session.prompt("while away");
		await conversation.session.waitForIdle();

		const secondPair = createLoopbackRpcTransportPair();
		const resumed = serveConnection(secondPair.server, localProfile, {
			host: harness.host,
			conversation,
			anchor: false,
		});
		const frames: HostFrame[] = [];
		first.onFrame((frame) => frames.push(frame));
		const secondEnd = tapped(secondPair.client);
		await first.connect(secondEnd.transport);
		cleanups.push(async () => {
			await first.stop();
			await resumed.closed.catch(() => undefined);
		});
		// It resumes after its position in the log generation that position belongs to.
		const sessionGeneration = conversation.session.sessionManager.getSessionGeneration();
		expect(secondEnd.sent.filter((frame) => frame.type === "subscribe")).toEqual([
			{
				type: "subscribe",
				subscriptionId: expect.any(String),
				conversation: conversation.id,
				after: position,
				sessionGeneration,
			},
		]);
		expect(first.sessionGeneration).toBe(sessionGeneration);
		expect(frames.some((frame) => frame.type === "snapshot")).toBe(false);
		const resent = frames.flatMap((frame) => (frame.type === "entry" ? [frame.entry.ordinal] : []));
		expect(Math.min(...resent)).toBeGreaterThan(position);
		const texts = first.state.entries.flatMap((entry) => (entry.type === "message" ? [entry.view?.text] : []));
		expect(texts).toEqual(["first", "one", "while away", "two"]);
	});

	it("resubscribes after a gap in the live lane at its position in its log generation, and so does an observation", async () => {
		const { harness, conversation } = await setup({ whenUnattached: "keep" });
		const other = await harness.openStartup();
		const sessionGeneration = conversation.session.sessionManager.getSessionGeneration();
		const otherGeneration = other.session.sessionManager.getSessionGeneration();
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, {
			host: harness.host,
			conversation,
			anchor: false,
		});
		// The next frame `losing` picks is lost on the way to the client.
		let losing: ((frame: HostFrame) => boolean) | undefined;
		const end = tapped(pair.client, (frame) => {
			if (losing?.(frame) !== true) return false;
			losing = undefined;
			return true;
		});
		const client = new ProtocolClient();
		cleanups.push(async () => {
			await client.stop();
			await connection.closed.catch(() => undefined);
		});
		const frames: HostFrame[] = [];
		client.onFrame((frame) => frames.push(frame));
		const subscribes = (to: string) =>
			end.sent.filter((frame) => frame.type === "subscribe" && frame.conversation === to);
		const liveAfterReset = (subscriptionId: unknown) => (frame: HostFrame) =>
			frame.type === "live" && frame.subscriptionId === subscriptionId && frame.reset !== true;
		const served = (subscriptionId: unknown, type: HostFrame["type"]) =>
			frames.some(
				(frame) => frame.type === type && "subscriptionId" in frame && frame.subscriptionId === subscriptionId,
			);

		await client.connect(end.transport);
		expect(subscribes(conversation.id)).toEqual([
			{ type: "subscribe", subscriptionId: expect.any(String), conversation: conversation.id, after: "snapshot" },
		]);
		expect(client.sessionGeneration).toBe(sessionGeneration);
		const position = client.state.ordinal;
		losing = liveAfterReset(subscribes(conversation.id)[0]?.subscriptionId);
		conversation.liveState.notice("info", "lost");
		await vi.waitFor(() => expect(losing).toBeUndefined());
		conversation.liveState.notice("info", "after the gap");
		await vi.waitFor(() => expect(subscribes(conversation.id)).toHaveLength(2));
		const resumed = subscribes(conversation.id)[1];
		expect(resumed).toEqual({
			type: "subscribe",
			subscriptionId: expect.any(String),
			conversation: conversation.id,
			after: position,
			sessionGeneration,
		});
		await client.caughtUp();
		// The host resumed the position in that log: no snapshot.
		expect(served(resumed?.subscriptionId, "snapshot")).toBe(false);
		expect(client.sessionGeneration).toBe(sessionGeneration);

		// An observation holds its own conversation's generation and resumes in it.
		const observation = client.observe(other.id);
		await vi.waitFor(() => expect(observation.caughtUp).toBe(true));
		expect(subscribes(other.id)).toEqual([
			{ type: "subscribe", subscriptionId: expect.any(String), conversation: other.id, after: "snapshot" },
		]);
		expect(observation.sessionGeneration).toBe(otherGeneration);
		expect(otherGeneration).not.toBe(sessionGeneration);
		const observed = observation.state.ordinal;
		losing = liveAfterReset(subscribes(other.id)[0]?.subscriptionId);
		other.liveState.notice("info", "lost");
		await vi.waitFor(() => expect(losing).toBeUndefined());
		other.liveState.notice("info", "after the gap");
		await vi.waitFor(() => expect(subscribes(other.id)).toHaveLength(2));
		const reobserved = subscribes(other.id)[1];
		expect(reobserved).toEqual({
			type: "subscribe",
			subscriptionId: expect.any(String),
			conversation: other.id,
			after: observed,
			sessionGeneration: otherGeneration,
		});
		await vi.waitFor(() =>
			expect(
				frames.some(
					(frame) =>
						frame.type === "live" && frame.subscriptionId === reobserved?.subscriptionId && frame.reset === true,
				),
			).toBe(true),
		);
		expect(served(reobserved?.subscriptionId, "snapshot")).toBe(false);
		expect(observation.ended).toBeUndefined();
		expect(observation.sessionGeneration).toBe(otherGeneration);
	});
});
