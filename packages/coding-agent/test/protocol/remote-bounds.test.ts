/**
 * The remote profile's bounds (RFC §6.2): what a paired device is sent stays
 * within the profile's limits whatever the conversation holds. Snapshots carry
 * a bounded tail and fit a frame, an entry that cannot fit is skipped with
 * `head`, a resume further back than the replay bound is a snapshot, the
 * streaming assistant a device joins mid-stream and its later deltas keep
 * their budgets, live tool items and keyed values are bounded, and a
 * subscription whose queued live frames outgrow their bound resets from the
 * live state. A phone that ends or fails its stream leaves its conversation
 * without holding it or another phone.
 */

import { Buffer } from "node:buffer";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveFrame,
	type HostFrame,
	type LiveFoldState,
	type LiveItem,
	type QueryResult,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { type ProfileLimits, remoteProfile } from "../../src/core/protocol/profiles.ts";
import type { ProtocolConnection } from "../../src/core/protocol/server/connection.ts";
import { Subscription } from "../../src/core/protocol/server/subscription.ts";
import type { IrohBiStreamLike } from "../../src/core/protocol/transport/iroh-transport.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../suite/host-harness.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../utilities/remote-phone.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;

function isFrame<T extends HostFrame["type"]>(type: T): (frame: HostFrame) => frame is Frame<T> {
	return (frame): frame is Frame<T> => frame.type === type;
}

function snapshotOf(phone: RemotePhone): Frame<"snapshot"> {
	const snapshot = phone.frames.find(isFrame("snapshot"));
	if (!snapshot) throw new Error("Expected a snapshot");
	return snapshot;
}

function liveItems(frames: readonly HostFrame[]): LiveItem[] {
	return frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

function messageTexts(frames: readonly { type: string; view?: { text?: string } }[]): Array<string | undefined> {
	return frames.flatMap((entry) => (entry.type === "message" ? [entry.view?.text] : []));
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** The host's end of a stream whose writes can be held or failed. */
interface ControlledStream {
	wrap(stream: IrohBiStreamLike): IrohBiStreamLike;
	/** Hold the next write; resolves once it started. */
	holdNext(): Promise<void>;
	release(): void;
	/** Fail every later write with `error`. */
	fail(error: Error): void;
}

function controlledStream(): ControlledStream {
	let held: PromiseWithResolvers<void> | undefined;
	let started: PromiseWithResolvers<void> | undefined;
	let failure: Error | undefined;
	let holding: PromiseWithResolvers<void> | undefined;
	return {
		wrap: (stream) => ({
			recv: stream.recv,
			send: {
				writeAll: async (bytes) => {
					if (failure) throw failure;
					const gate = held;
					held = undefined;
					if (gate) {
						started?.resolve();
						await gate.promise;
					}
					await stream.send.writeAll(bytes);
				},
				finish: async () => {
					await stream.send.finish?.();
				},
			},
		}),
		holdNext() {
			held = Promise.withResolvers<void>();
			holding = held;
			started = Promise.withResolvers<void>();
			return started.promise;
		},
		release() {
			holding?.resolve();
		},
		fail(error) {
			failure = error;
		},
	};
}

describe("remote profile bounds", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(
		options: HostHarnessOptions = {},
	): Promise<{ harness: HostHarness; conversation: HostedConversation; workspace: string }> {
		const harness = await createHostHarness({ whenUnattached: "keep", ...options });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		return { harness, conversation, workspace: conversation.cwd };
	}

	function serve(
		harness: HostHarness,
		conversation: HostedConversation,
		options: { limits?: Partial<ProfileLimits>; stream?: ControlledStream } = {},
	): { phone: RemotePhone; connection: ProtocolConnection } {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: options.stream ? options.stream.wrap(pair.host) : pair.host,
			grant: ALL,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
			...(options.limits === undefined ? {} : { limits: options.limits }),
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			options.stream?.release();
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		return { phone, connection };
	}

	async function prompt(conversation: HostedConversation, text: string): Promise<void> {
		await conversation.session.prompt(text);
		await conversation.session.waitForIdle();
	}

	it("snapshots the newest entries of a long conversation and pages the older ones with history", async () => {
		const { harness, conversation } = await setup();
		for (const text of ["first", "second", "third"]) await prompt(conversation, text);

		const full = serve(harness, conversation).phone;
		await full.hello();
		await full.subscribe(conversation.id);
		const tail = serve(harness, conversation, { limits: { snapshotTail: 2 } }).phone;
		await tail.hello();
		await tail.subscribe(conversation.id);

		const all = snapshotOf(full).state.entries;
		expect(snapshotOf(full).state.earlier).not.toBe(true);
		expect(all.length).toBeGreaterThan(2);
		const bounded = snapshotOf(tail);
		expect(bounded.ordinal).toBe(snapshotOf(full).ordinal);
		expect(bounded.state.entries).toEqual(all.slice(-2));
		expect(bounded.state.earlier).toBe(true);

		const page = await tail.query("history", { before: bounded.state.entries[0]!.ordinal, limit: 100 });
		if (page.type !== "result") throw new Error("Expected a history page");
		const older = page.data as QueryResult<"history">;
		expect(older.earlier).toBe(false);
		expect([...older.entries, ...bounded.state.entries]).toEqual(all);
		expect(messageTexts([...older.entries, ...bounded.state.entries])).toEqual([
			"first",
			"one",
			"second",
			"two",
			"third",
			"three",
		]);
	});

	it("fits snapshots to a frame, skips an entry larger than a frame with head, and refuses a result that cannot fit", async () => {
		const { harness, conversation } = await setup({
			responses: ["a".repeat(1_500), "b".repeat(1_500), "c".repeat(1_500), "d".repeat(1_500), "e".repeat(8_000)],
		});
		for (const text of ["first", "second", "third", "fourth"]) await prompt(conversation, text);
		const limits = { frameBytes: 6_000 };

		const full = serve(harness, conversation).phone;
		await full.hello();
		await full.subscribe(conversation.id);
		const { phone } = serve(harness, conversation, { limits });
		await phone.hello();
		await phone.subscribe(conversation.id);

		const snapshot = snapshotOf(phone);
		expect(jsonBytes(snapshot)).toBeLessThanOrEqual(limits.frameBytes);
		expect(snapshot.state.earlier).toBe(true);
		// The newest entries stay; the older ones are paged with history.
		const all = snapshotOf(full).state.entries;
		expect(snapshot.state.entries.length).toBeGreaterThan(0);
		expect(snapshot.state.entries.length).toBeLessThan(all.length);
		expect(snapshot.state.entries).toEqual(all.slice(-snapshot.state.entries.length));
		expect(messageTexts(snapshot.state.entries).at(-1)).toBe("d".repeat(1_500));

		const from = phone.frames.length;
		await prompt(conversation, "fifth");
		const large = conversation.session.sessionManager
			.committedEntriesAfter(0)
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.ordinal > snapshot.ordinal,
			);
		if (!large) throw new Error("Expected the large answer's entry");
		await phone.waitFor((frame): frame is Frame<"head"> => frame.type === "head" && frame.ordinal === large.ordinal, {
			from,
		});
		const entries = phone.frames.slice(from).filter(isFrame("entry"));
		expect(entries.some((frame) => frame.entry.ordinal === large.ordinal)).toBe(false);
		expect(messageTexts(entries.map((frame) => frame.entry))).toContain("fifth");
		for (const frame of phone.frames) expect(jsonBytes(frame)).toBeLessThanOrEqual(limits.frameBytes);

		expect(await phone.query("history", { before: large.ordinal + 1, limit: 1 })).toMatchObject({
			type: "query_error",
			reason: { code: "failed" },
		});
	});

	it("redacts a root before cutting a view's text or a content chunk, so no part of the root is sent", async () => {
		const { harness, conversation, workspace } = await setup();
		const lead = `${"x".repeat(20)} `;
		await prompt(conversation, `${lead}${workspace}/src/file.ts`);
		const textScalars = lead.length + Math.floor(workspace.length / 2);
		const { phone } = serve(harness, conversation, { limits: { textScalars } });
		await phone.hello();
		await phone.subscribe(conversation.id);

		const user = snapshotOf(phone).state.entries.find(
			(entry): entry is Extract<typeof entry, { view?: unknown }> => "view" in entry && entry.view?.role === "user",
		);
		expect(user?.view?.text).toBe(`${lead}/workspace/src/file.ts`.slice(0, textScalars));
		const content = await phone.query("content", { entryId: user!.id, offset: textScalars - 3 });
		if (content.type !== "result") throw new Error("Expected a content chunk");
		const chunk = (content.data as QueryResult<"content">).content;
		expect(chunk).toMatchObject({ type: "text", text: `${lead}/workspace/src/file.ts`.slice(textScalars - 3) });
		const sent = JSON.stringify(phone.frames);
		expect(sent).not.toContain(workspace.slice(0, Math.floor(workspace.length / 2)));
		expect(sent).not.toContain(workspace.slice(Math.floor(workspace.length / 2)));
	});

	it("resumes after the phone's position, and answers a position past the log or the replay bound with a snapshot", async () => {
		const { harness, conversation } = await setup();
		for (const text of ["first", "second"]) await prompt(conversation, text);
		const head = conversation.session.sessionManager.getOrdinal();

		const resume = async (after: number): Promise<RemotePhone> => {
			const { phone } = serve(harness, conversation, { limits: { maxReplay: 2 } });
			await phone.hello();
			phone.send({ type: "subscribe", subscriptionId: "r", conversation: conversation.id, after });
			await phone.waitFor(
				(frame): frame is Frame<"live"> =>
					frame.type === "live" && frame.subscriptionId === "r" && frame.reset === true,
			);
			return phone;
		};

		const near = await resume(head - 2);
		expect(near.frames.some((frame) => frame.type === "snapshot")).toBe(false);
		const resent = near.frames.flatMap((frame) =>
			frame.type === "entry" ? [frame.entry.ordinal] : frame.type === "head" ? [frame.ordinal] : [],
		);
		expect(Math.min(...resent)).toBeGreaterThan(head - 2);
		expect(near.position()).toBe(head);

		for (const after of [1, head + 5]) {
			const far = await resume(after);
			expect(snapshotOf(far)).toMatchObject({ ordinal: head });
			expect(far.frames.some((frame) => frame.type === "entry")).toBe(false);
		}
	});

	it("bounds the streaming assistant a phone joins mid-stream; a frozen block streams again with its end", async () => {
		const { harness, conversation, workspace } = await setup();
		const live = conversation.liveState;
		const text = `${"x".repeat(200)} ${workspace}/a.ts`;
		live.stream([
			{
				type: "assistant_start",
				message: assistant([
					{ type: "text", text },
					{
						type: "toolCall",
						id: "call-1",
						name: "write",
						arguments: { path: `${workspace}/big.ts`, content: "c".repeat(50_000) },
					},
				]),
			},
		]);

		const { phone } = serve(harness, conversation, { limits: { assistantSnapshotBytes: 64 } });
		await phone.hello();
		await phone.subscribe(conversation.id);
		const reset = phone.frames.find((frame): frame is Frame<"live"> => frame.type === "live" && frame.reset === true);
		const start = reset?.items.find((item) => item.type === "assistant_start");
		if (start?.type !== "assistant_start") throw new Error("Expected the streaming assistant in the reset");
		const [block, call] = start.message.content;
		expect(block).toEqual({ type: "text", text: "x".repeat(64) });
		if (call?.type !== "toolCall") throw new Error("Expected the streaming tool call");
		expect(call.arguments.path).toBe("/workspace/big.ts");
		expect(jsonBytes(call.arguments)).toBeLessThanOrEqual(12 * 1024);

		const from = phone.frames.length;
		live.stream([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta: " more" } }]);
		live.stream([{ type: "assistant_delta", event: { type: "text_end", contentIndex: 0, content: `${text} more` } }]);
		await phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" &&
				frame.items.some((item) => item.type === "assistant_delta" && item.event.type === "text_end"),
			{ from },
		);
		const deltas = liveItems(phone.frames.slice(from)).flatMap((item) =>
			item.type === "assistant_delta" ? [item.event] : [],
		);
		expect(deltas).toEqual([
			{ type: "text_end", contentIndex: 0, content: `${"x".repeat(200)} /workspace/a.ts more` },
		]);
		expect(JSON.stringify(phone.frames)).not.toContain(workspace);
	});

	it("stops streaming text past the cumulative budget until its block ends", async () => {
		const { harness, conversation } = await setup();
		const { phone } = serve(harness, conversation);
		await phone.hello();
		await phone.subscribe(conversation.id);
		const live = conversation.liveState;
		const chunks = ["a", "b", "c", "d"].map((letter) => letter.repeat(100_000));
		live.stream([
			{ type: "assistant_start", message: assistant([]) },
			{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } },
		]);
		for (const delta of chunks) {
			live.stream([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } }]);
		}
		live.stream([
			{ type: "assistant_delta", event: { type: "text_end", contentIndex: 0, content: chunks.join("") } },
		]);
		await phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" &&
				frame.items.some((item) => item.type === "assistant_delta" && item.event.type === "text_end"),
		);

		const events = liveItems(phone.frames).flatMap((item) => (item.type === "assistant_delta" ? [item.event] : []));
		const streamed = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []));
		// 256 KiB of text streams; the rest arrives with the block's end.
		expect(streamed).toEqual(chunks.slice(0, 2));
		expect(events.at(-1)).toEqual({ type: "text_end", contentIndex: 0, content: chunks.join("") });
	});

	it("bounds live tool items and keyed values: arguments, the partial output's tail, details, and oversized values", async () => {
		const { harness, conversation, workspace } = await setup();
		const { phone } = serve(harness, conversation, { limits: { textScalars: 100 } });
		await phone.hello();
		await phone.subscribe(conversation.id);
		const from = phone.frames.length;
		const live = conversation.liveState;
		live.stream([
			{
				type: "tool",
				op: "start",
				toolCallId: "t-1",
				toolName: "read",
				args: { path: `${workspace}/a.ts`, payload: "p".repeat(50_000) },
			},
		]);
		live.stream([
			{
				type: "tool",
				op: "update",
				toolCallId: "t-1",
				toolName: "read",
				partial: { content: [{ type: "text", text: `${"o".repeat(5_000)}END` }] },
			},
		]);
		live.set("ext_status/ci/big", { kind: "ext_status", extension: "ci", text: "s".repeat(200_000) });
		live.set("ext_panel/ci/huge", {
			kind: "ext_panel",
			extension: "ci",
			placement: "aboveEditor",
			node: { type: "list", items: Array.from({ length: 20_000 }, () => ({ type: "text", text: "w".repeat(40) })) },
		});
		live.notice("info", "after");
		await phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" && frame.items.some((item) => item.type === "notice" && item.message === "after"),
			{ from },
		);

		const items = liveItems(phone.frames.slice(from));
		const start = items.find((item) => item.type === "tool" && item.op === "start");
		if (start?.type !== "tool" || !start.args) throw new Error("Expected the tool start");
		expect(start.args.path).toBe("/workspace/a.ts");
		expect(jsonBytes(start.args)).toBeLessThanOrEqual(12 * 1024);
		const update = items.find((item) => item.type === "tool" && item.op === "update");
		if (update?.type !== "tool" || !update.partial) throw new Error("Expected the tool update");
		expect(update.partial).toEqual({ content: [{ type: "text", text: `${"o".repeat(97)}END` }] });

		const status = items.find((item) => item.type === "set" && item.key === "ext_status/ci/big");
		if (status?.type !== "set" || status.value.kind !== "ext_status") throw new Error("Expected the status");
		expect(jsonBytes(status.value)).toBeLessThanOrEqual(64 * 1024);
		expect(typeof status.value.text === "string" && status.value.text.startsWith("sss")).toBe(true);
		// A value that cannot be bounded is not sent at all.
		expect(items.some((item) => item.type === "set" && item.key === "ext_panel/ci/huge")).toBe(false);
	});

	it("drops queued live frames past the live queue bound and resets from the live state, never dropping entries", async () => {
		const { conversation } = await setup();
		const profile = (limits: Partial<ProfileLimits> = {}) =>
			remoteProfile({ grant: ALL, redaction: { workspacePath: conversation.cwd }, bound: conversation.id, limits });

		// The size of a reset of the current live state, as the queue measures it.
		const measured: HostFrame[] = [];
		const probe = new Subscription({
			subscriptionId: "probe",
			liveClientId: "probe",
			conversation,
			profile: profile(),
			sink: { send: (frame) => measured.push(frame) },
			live: true,
			accepts: () => false,
		});
		probe.start("snapshot");
		const probeReset = measured.find(isFrame("live"));
		probe.dispose();
		if (!probeReset) throw new Error("Expected a live reset");
		const liveQueueBytes = 2 * JSON.stringify(probeReset.items).length + 1_500;

		const frames: HostFrame[] = [];
		const count = Math.ceil((3 * liveQueueBytes) / 200);
		let flooded = false;
		const subscription = new Subscription({
			subscriptionId: "s",
			liveClientId: "s",
			conversation,
			profile: profile({ liveQueueBytes }),
			sink: {
				send: (frame) => {
					frames.push(frame);
					// The live state changes while the writer writes an entry: those frames queue.
					if (frame.type !== "entry" || flooded) return;
					flooded = true;
					for (let index = 0; index < count; index++)
						conversation.liveState.notice("info", `${index}`.padEnd(200, "n"));
					conversation.liveState.set("ext_status/ci/final", {
						kind: "ext_status",
						extension: "ci",
						text: "final",
					});
				},
			},
			live: true,
			accepts: () => false,
		});
		cleanups.push(async () => subscription.dispose());
		subscription.start("snapshot");
		const start = frames.length;
		await conversation.session.setSessionName("renamed");
		await vi.waitFor(() => expect(flooded).toBe(true));

		const after = frames.slice(start);
		expect(after.filter(isFrame("entry")).map((frame) => frame.entry.type)).toContain("session_info");
		const lives = after.filter(isFrame("live"));
		expect(lives.some((frame) => frame.reset === true)).toBe(true);
		const notices = liveItems(after).filter((item) => item.type === "notice");
		expect(notices.length).toBeGreaterThan(0);
		expect(notices.length).toBeLessThan(count);

		// seq restarts with every reset and has no gaps.
		let seq = 0;
		let fold: LiveFoldState = emptyLiveFold();
		for (const frame of frames.filter(isFrame("live"))) {
			expect(frame.seq).toBe(frame.reset === true ? 1 : seq + 1);
			seq = frame.seq;
			fold = foldLiveFrame(fold, frame);
		}
		expect([...fold.values]).toEqual([...conversation.liveState.snapshot().values]);
		expect(fold.values.get("ext_status/ci/final")).toEqual({ kind: "ext_status", extension: "ci", text: "final" });
	});

	it("leaves the conversation when the phone ends its stream, while a host write is still held", async () => {
		const { harness, conversation } = await setup();
		const stream = controlledStream();
		const { phone, connection } = serve(harness, conversation, { stream });
		await phone.hello();
		await phone.subscribe(conversation.id);
		const clients = () => harness.host.clientsOf(conversation).map((client) => client.id);
		expect(clients()).toContain(connection.id);

		const held = stream.holdNext();
		conversation.liveState.notice("info", "held");
		await held;
		await phone.close();
		await vi.waitFor(() => expect(clients()).not.toContain(connection.id));
		expect(conversation.closed).toBe(false);

		stream.release();
		await connection.closed.catch(() => undefined);
	});

	it("ends a phone whose stream fails without disturbing another phone on the conversation", async () => {
		const { harness, conversation } = await setup();
		const stream = controlledStream();
		const broken = serve(harness, conversation, { stream });
		const healthy = serve(harness, conversation);
		for (const { phone } of [broken, healthy]) {
			await phone.hello();
			await phone.subscribe(conversation.id);
		}

		stream.fail(new Error("phone transport failed"));
		conversation.liveState.notice("info", "first");
		const failure = await broken.connection.closed.then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		conversation.liveState.notice("info", "second");
		await healthy.phone.waitFor(
			(frame): frame is Frame<"live"> =>
				frame.type === "live" && frame.items.some((item) => item.type === "notice" && item.message === "second"),
		);
		expect(liveItems(healthy.phone.frames).flatMap((item) => (item.type === "notice" ? [item.message] : []))).toEqual(
			["first", "second"],
		);
		const clients = harness.host.clientsOf(conversation).map((client) => client.id);
		expect(clients).toContain(healthy.connection.id);
		expect(clients).not.toContain(broken.connection.id);
		expect(conversation.closed).toBe(false);
	});
});
