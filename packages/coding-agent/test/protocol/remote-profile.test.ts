/**
 * The protocol server on the remote profile (docs/iroh-remote-protocol.md): a
 * paired device's stream over an Iroh transport. Transcript fidelity and path
 * redaction, admission on the grant, the bound conversation, per-frame
 * authority, bounds on subscriptions, snapshots, and frames, host requests by
 * grant, structural intents by redirect, and workspace streams.
 */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type HostFrame, REMOTE_CAPABILITIES, type RemoteCapability, type RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { ProfileLimits } from "../../src/core/protocol/profiles.ts";
import type { AuthorityLoss, ProtocolConnection } from "../../src/core/protocol/server/connection.ts";
import { createIrohRpcTransport } from "../../src/core/protocol/transport/iroh-transport.ts";
import type { RpcTransport } from "../../src/core/protocol/transport/transport.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../suite/host-harness.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

function grantOf(...capabilities: RemoteCapability[]): RemoteGrant {
	return { schemaVersion: 1, revision: 1, capabilities };
}

const hello = (hostRequests: string[] = []) => ({
	type: "hello",
	protocol: 1,
	client: { name: "phone", version: "1" },
	accepts: { hostRequests },
});

interface Phone {
	readonly frames: HostFrame[];
	readonly transport: RpcTransport;
	readonly connection: ProtocolConnection;
	readonly ended: Promise<void>;
	send(frame: object): void;
	sendLine(line: string): void;
	/** The frames after the first `index`. */
	since(index: number): HostFrame[];
}

describe("protocol server on the remote profile", () => {
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

	function phone(
		harness: HostHarness,
		conversation: HostedConversation | undefined,
		options: {
			grant?: RemoteGrant;
			limits?: Partial<ProfileLimits>;
			authority?: () => AuthorityLoss | undefined;
			revalidate?: () => Promise<boolean>;
			allows?: (kind: "intent" | "query", name: string) => boolean;
			redirect?: boolean;
			workspacePath?: string;
		} = {},
	): Phone {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			...(conversation === undefined ? {} : { host: harness.host, conversation }),
			stream: pair.host,
			grant: options.grant ?? ALL,
			redaction: { workspacePath: options.workspacePath ?? conversation?.cwd ?? harness.tempDir },
			...(options.redirect === false ? {} : { redirect: {} }),
			...(options.limits === undefined ? {} : { limits: options.limits }),
			...(options.authority === undefined ? {} : { authority: options.authority }),
			...(options.revalidate === undefined ? {} : { revalidate: options.revalidate }),
			...(options.allows === undefined ? {} : { allows: options.allows }),
		});
		const transport = createIrohRpcTransport({ stream: pair.phone });
		const frames: HostFrame[] = [];
		const ended = Promise.withResolvers<void>();
		transport.onLine((line) => {
			frames.push(JSON.parse(line) as HostFrame);
		});
		transport.onClose?.(() => ended.resolve());
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await Promise.resolve(transport.close()).catch(() => undefined);
		});
		return {
			frames,
			transport,
			connection,
			ended: ended.promise,
			send: (frame) => void transport.write(frame),
			sendLine: (line) => void pair.phone.send.writeAll(Array.from(Buffer.from(`${line}\n`, "utf8"))),
			since: (index) => frames.slice(index),
		};
	}

	async function welcomed(device: Phone, hostRequests: string[] = []): Promise<void> {
		device.send(hello(hostRequests));
		await vi.waitFor(() => expect(device.frames[0]).toMatchObject({ type: "welcome", profile: "remote" }));
	}

	async function subscribed(device: Phone, conversation: HostedConversation, subscriptionId = "s1"): Promise<void> {
		device.send({ type: "subscribe", subscriptionId, conversation: conversation.id, after: "snapshot" });
		await vi.waitFor(() =>
			expect(
				device.frames.some(
					(frame) => frame.type === "live" && frame.subscriptionId === subscriptionId && frame.reset === true,
				),
			).toBe(true),
		);
	}

	function position(device: Phone): number {
		let ordinal = 0;
		for (const frame of device.frames) {
			if (frame.type === "snapshot") ordinal = frame.ordinal;
			else if (frame.type === "entry") ordinal = frame.entry.ordinal;
			else if (frame.type === "head") ordinal = frame.ordinal;
		}
		return ordinal;
	}

	function outcome(device: Phone, intentId: string): HostFrame | undefined {
		return device.frames.find(
			(frame) => (frame.type === "accepted" || frame.type === "rejected") && frame.intentId === intentId,
		);
	}

	async function settled(device: Phone, intentId: string): Promise<HostFrame> {
		await vi.waitFor(() => expect(outcome(device, intentId)).toBeDefined());
		return outcome(device, intentId)!;
	}

	it("serves the bound conversation at transcript fidelity, with workspace paths redacted", async () => {
		const { harness, conversation, workspace } = await setup();
		harness.faux.setResponses([fauxAssistantMessage(`Edited ${workspace}/src/file.ts`)]);
		const device = phone(harness, conversation);
		await welcomed(device);
		expect(device.frames[0]).toMatchObject({ conversation: conversation.id });
		await subscribed(device, conversation);

		device.send({
			type: "prompt",
			intentId: "c-1",
			expectedOrdinal: position(device),
			input: { message: `Read ${join(workspace, "README.md")}` },
		});
		expect(await settled(device, "c-1")).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(conversation.session.isBusy).toBe(false));
		await vi.waitFor(() =>
			expect(device.frames.filter((frame) => frame.type === "entry" && frame.entry.type === "message")).toHaveLength(
				2,
			),
		);

		const messages = device.frames.flatMap((frame) =>
			frame.type === "entry" && frame.entry.type === "message" ? [frame.entry] : [],
		);
		// Message entries carry their transcript view only.
		for (const entry of messages) expect(entry.payload).toBeUndefined();
		expect(messages.map((entry) => entry.view?.text)).toEqual([
			"Read /workspace/README.md",
			"Edited /workspace/src/file.ts",
		]);
		const wire = JSON.stringify(device.frames);
		expect(wire).not.toContain(workspace);
		expect(wire).not.toMatch(/Signature"/);
	});

	it("admits intents on the grant: remote-safe only, capabilities required, branch intents fenced", async () => {
		const { harness, conversation } = await setup();
		const device = phone(harness, conversation, { grant: grantOf("conversation.observe.v1") });
		await welcomed(device);
		await subscribed(device, conversation);

		device.send({ type: "prompt", intentId: "c-1", expectedOrdinal: position(device), input: { message: "hi" } });
		expect(await settled(device, "c-1")).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "conversation.control.v1" },
		});
		device.send({ type: "set_steering_mode", intentId: "i-1", input: { mode: "all" } });
		expect(await settled(device, "i-1")).toMatchObject({ type: "rejected", reason: { code: "not_allowed" } });

		const controller = phone(harness, conversation);
		await welcomed(controller);
		device.send({ type: "query", queryId: "q-1", query: "intents" });
		await vi.waitFor(
			() =>
				expect(
					device.frames.find(
						(frame) => (frame.type === "result" || frame.type === "query_error") && frame.queryId === "q-1",
					),
				).toMatchObject({ type: "result" }),
			{ timeout: 10_000 },
		);
		controller.send({ type: "prompt", intentId: "c-2", input: { message: "no position" } });
		expect(await settled(controller, "c-2")).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input", message: expect.stringContaining("expectedOrdinal") },
		});
	});

	it("binds the connection to its conversation: other conversations are neither readable nor targets", async () => {
		const { harness, conversation } = await setup();
		const other = await harness.openStartup();
		const device = phone(harness, conversation);
		await welcomed(device);
		device.send({ type: "subscribe", subscriptionId: "other", conversation: other.id, after: "snapshot" });
		await vi.waitFor(() =>
			expect(device.frames.at(-1)).toEqual({ type: "ended", subscriptionId: "other", reason: "closed" }),
		);
		device.send({ type: "set_session_name", intentId: "i-1", conversation: other.id, input: { name: "x" } });
		expect(await settled(device, "i-1")).toMatchObject({ type: "rejected", reason: { code: "ended" } });
		device.send({
			type: "query",
			queryId: "q-1",
			query: "history",
			conversation: other.id,
			params: { before: 99, limit: 5 },
		});
		await vi.waitFor(() =>
			expect(device.frames.find((frame) => frame.type === "query_error" && frame.queryId === "q-1")).toMatchObject({
				reason: { code: "unavailable" },
			}),
		);
		expect(other.session.sessionManager.getSessionName()).toBeUndefined();
	});

	it("caps subscriptions per connection and snapshot reads per window", async () => {
		const { harness, conversation } = await setup();
		const capped = phone(harness, conversation, { limits: { subscriptions: 2 } });
		await welcomed(capped);
		for (const id of ["a", "b", "c"]) {
			capped.send({ type: "subscribe", subscriptionId: id, conversation: conversation.id, after: 0 });
		}
		await capped.ended;
		expect(capped.frames.at(-1)).toMatchObject({ type: "fatal", code: "invalid_frame" });

		const reader = phone(harness, conversation, { limits: { readBurst: 2, readRefillMs: 60_000 } });
		await welcomed(reader);
		for (const id of ["a", "b"]) {
			reader.send({ type: "subscribe", subscriptionId: id, conversation: conversation.id, after: "snapshot" });
			reader.send({ type: "unsubscribe", subscriptionId: id });
		}
		reader.send({ type: "subscribe", subscriptionId: "c", conversation: conversation.id, after: "snapshot" });
		await reader.ended;
		expect(reader.frames.filter((frame) => frame.type === "snapshot")).toHaveLength(2);
		expect(reader.frames.at(-1)).toMatchObject({ type: "fatal", code: "invalid_frame" });

		const pager = phone(harness, conversation, { limits: { readBurst: 1, readRefillMs: 60_000 } });
		await welcomed(pager);
		for (const queryId of ["h-1", "h-2"]) {
			pager.send({ type: "query", queryId, query: "history", params: { before: 1_000, limit: 10 } });
		}
		await vi.waitFor(() =>
			expect(pager.frames.find((frame) => frame.type === "query_error" && frame.queryId === "h-2")).toMatchObject({
				reason: { code: "unavailable", retryAfterMs: expect.any(Number) },
			}),
		);
		expect(pager.frames.find((frame) => frame.type === "result" && frame.queryId === "h-1")).toBeDefined();
	});

	it("charges a resume one read per snapshot tail it replays, and costly queries one read each", async () => {
		const { harness, conversation } = await setup({ responses: ["one", "two", "three"] });
		for (const text of ["first", "second", "third"]) {
			await conversation.session.prompt(text);
			await conversation.session.waitForIdle();
		}
		const head = conversation.session.sessionManager.getOrdinal();
		expect(head).toBeGreaterThan(6);
		// A replay of `head` entries at two entries per read costs ceil(head / 2) reads.
		const cost = Math.ceil(head / 2);
		const resumer = phone(harness, conversation, {
			limits: { snapshotTail: 2, readBurst: cost + 1, readRefillMs: 60_000 },
		});
		await welcomed(resumer);
		resumer.send({ type: "subscribe", subscriptionId: "a", conversation: conversation.id, after: 0, live: false });
		resumer.send({ type: "unsubscribe", subscriptionId: "a" });
		resumer.send({ type: "subscribe", subscriptionId: "b", conversation: conversation.id, after: 0, live: false });
		await resumer.ended;
		expect(resumer.frames.filter((frame) => frame.type === "entry" && frame.subscriptionId === "b")).toEqual([]);
		expect(resumer.frames.at(-1)).toMatchObject({ type: "fatal", code: "invalid_frame" });

		const lister = phone(harness, conversation, { limits: { readBurst: 1, readRefillMs: 60_000 } });
		await welcomed(lister);
		lister.send({ type: "query", queryId: "c-1", query: "sessions" });
		lister.send({ type: "query", queryId: "c-2", query: "content", params: { entryId: "missing" } });
		await vi.waitFor(() =>
			expect(lister.frames.find((frame) => frame.type === "query_error" && frame.queryId === "c-2")).toMatchObject({
				reason: { code: "unavailable", retryAfterMs: expect.any(Number) },
			}),
		);
	});

	it("never slows the conversation for a device that stops reading; it resets that device", async () => {
		const { harness, conversation } = await setup({ responses: ["x".repeat(20_000)] });
		const pair = createIrohStreamPair();
		const gate = Promise.withResolvers<void>();
		cleanups.push(async () => gate.resolve());
		let stalled = false;
		const stream = {
			recv: pair.host.recv,
			send: {
				// Flow control once the device stops reading: a write never completes.
				writeAll: async (bytes: number[]) => {
					if (stalled) await gate.promise;
					await pair.host.send.writeAll(bytes);
				},
				finish: async () => pair.host.send.finish?.(),
				reset: (code: bigint) => {
					gate.resolve();
					return pair.host.send.reset?.(code);
				},
			},
		};
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream,
			grant: grantOf("conversation.observe.v1"),
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
			limits: { sendQueueBytes: 16 * 1024 },
		});
		const transport = createIrohRpcTransport({ stream: pair.phone });
		transport.onLine(() => {});
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await Promise.resolve(transport.close()).catch(() => undefined);
		});
		void transport.write(hello());
		await connection.ready;
		void transport.write({
			type: "subscribe",
			subscriptionId: "s1",
			conversation: conversation.id,
			after: "snapshot",
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		stalled = true;

		const prompt = conversation.session
			.prompt("hello from the desktop")
			.then(() => conversation.session.waitForIdle());
		await expect(
			Promise.race([
				prompt.then(() => "done"),
				new Promise((resolve) => setTimeout(() => resolve("stalled"), 5_000)),
			]),
		).resolves.toBe("done");
		await expect(connection.closed).rejects.toThrow(/fell more than 16384 bytes behind/);
	});

	it("shows a device a queued input's text, never the hidden host messages it delivers", async () => {
		const { harness, conversation } = await setup({ responses: ["ok"] });
		await conversation.session.sendCustomMessage(
			{
				customType: "private-ext",
				content: "TOP SECRET extension context",
				display: false,
				details: { token: "ext-private-detail" },
			},
			{ triggerTurn: true },
		);
		await conversation.session.waitForIdle();
		const device = phone(harness, conversation, { grant: grantOf("conversation.observe.v1") });
		await welcomed(device);
		await subscribed(device, conversation);
		const wire = JSON.stringify(device.frames);
		expect(wire).toContain("client_input_queued");
		expect(wire).not.toContain("TOP SECRET");
		expect(wire).not.toContain("ext-private-detail");
	});

	it("checks a frame's size before parsing it: an oversized frame ends the connection with frame_too_large", async () => {
		const { harness, conversation } = await setup();
		const device = phone(harness, conversation, { limits: { frameBytes: 4_096 } });
		await welcomed(device);
		device.sendLine(JSON.stringify({ type: "prompt", intentId: "c-1", input: { message: "x".repeat(8_000) } }));
		await device.ended;
		expect(device.frames.at(-1)).toMatchObject({ type: "fatal", code: "frame_too_large" });
		expect(device.frames.some((frame) => frame.type === "rejected")).toBe(false);
	});

	it("ends a connection whose authority is gone with fatal{revoked} as its last frame", async () => {
		const { harness, conversation } = await setup();
		let loss: AuthorityLoss | undefined;
		const device = phone(harness, conversation, { authority: () => loss });
		await welcomed(device);
		await subscribed(device, conversation);
		const before = device.frames.length;
		loss = "revoked";
		// The next frame either way checks the authority first: here, a live change.
		conversation.liveState.notice("info", "hello");
		await device.ended;
		expect(device.since(before)).toEqual([{ type: "fatal", code: "revoked" }]);

		let current = true;
		const revalidated = phone(harness, conversation, { revalidate: async () => current });
		await welcomed(revalidated);
		current = false;
		revalidated.send({ type: "set_session_name", intentId: "i-1", input: { name: "x" } });
		await revalidated.ended;
		expect(revalidated.frames.at(-1)).toMatchObject({ type: "fatal", code: "revoked" });
		expect(outcome(revalidated, "i-1")).toBeUndefined();
	});

	it("asks only the host requests the grant allows and maps redacted select options back", async () => {
		const { harness, conversation, workspace } = await setup();
		const limited = phone(harness, conversation, {
			grant: grantOf("conversation.observe.v1", "conversation.control.v1"),
		});
		await welcomed(limited, ["select", "approval"]);
		await subscribed(limited, conversation);
		const full = phone(harness, conversation);
		await welcomed(full, ["select", "approval"]);
		await subscribed(full, conversation);

		const option = join(workspace, "a.ts");
		const answer = conversation.liveState.request({ kind: "select", title: "Pick", options: [option, "other"] });
		const approval = conversation.liveState.request(
			{ kind: "approval", action: "push", title: "Push?" },
			{ unattended: true },
		);
		const requests = (device: Phone) =>
			device.frames.flatMap((frame) =>
				frame.type === "live"
					? frame.items.flatMap((item) =>
							item.type === "set" && item.value.kind === "host_request" ? [item.value] : [],
						)
					: [],
			);
		await vi.waitFor(() => expect(requests(full).map((value) => value.request.kind)).toEqual(["select", "approval"]));
		await vi.waitFor(() => expect(requests(limited).map((value) => value.request.kind)).toEqual(["select"]));
		const select = requests(limited)[0]!;
		if (select.request.kind !== "select") throw new Error("Expected a select request");
		expect(select.request.options).toEqual(["/workspace/a.ts", "other"]);
		limited.send({ type: "host_response", requestId: select.requestId, response: { value: "/workspace/a.ts" } });
		expect(await answer).toMatchObject({ status: "answered", response: { value: option } });
		await conversation.liveState.close();
		await approval;
	});

	it("follows a structural intent by redirect: accepted names the target, the subscription ends moved, then the stream", async () => {
		const { harness, conversation } = await setup();
		const device = phone(harness, conversation);
		await welcomed(device);
		await subscribed(device, conversation);
		device.send({ type: "new_session", intentId: "n-1", expectedOrdinal: position(device), input: {} });
		const accepted = await settled(device, "n-1");
		expect(accepted).toMatchObject({ type: "accepted", conversation: expect.any(String) });
		await device.ended;
		const tail = device.frames.slice(device.frames.indexOf(accepted));
		expect(tail.find((frame) => frame.type === "ended")).toMatchObject({
			type: "ended",
			subscriptionId: "s1",
			reason: "moved",
			target: accepted.type === "accepted" ? accepted.conversation : undefined,
		});
		// The phone stays where it was: the host did not move this conversation's other clients.
		expect(conversation.closed).toBe(false);
	});

	it("serves a workspace stream without a conversation: host queries of its purpose only", async () => {
		const { harness } = await setup();
		const device = phone(harness, undefined, {
			allows: (kind, name) => kind === "query" && name === "sessions",
		});
		await welcomed(device);
		expect(device.frames[0]).not.toHaveProperty("conversation");
		device.send({ type: "query", queryId: "q-1", query: "intents" });
		device.send({
			type: "subscribe",
			subscriptionId: "s",
			conversation: "00000000-0000-0000-0000-000000000000",
			after: 0,
		});
		await vi.waitFor(() =>
			expect(device.frames.find((frame) => frame.type === "query_error" && frame.queryId === "q-1")).toMatchObject({
				reason: { code: "unavailable" },
			}),
		);
		await vi.waitFor(() =>
			expect(device.frames.find((frame) => frame.type === "ended")).toMatchObject({ reason: "closed" }),
		);
	});

	it("never sends a workspace root a stream split across deltas", async () => {
		const { harness, conversation, workspace } = await setup();
		const device = phone(harness, conversation);
		await welcomed(device);
		await subscribed(device, conversation);
		const text = `see ${workspace}/src/index.ts now`;
		const live = conversation.liveState;
		live.stream([{ type: "assistant_start", message: assistant("") }]);
		live.stream([{ type: "assistant_delta", event: { type: "text_start", contentIndex: 0 } }]);
		const cut = Math.floor(text.indexOf(workspace) + workspace.length / 2);
		for (const delta of [text.slice(0, cut), text.slice(cut)]) {
			live.stream([{ type: "assistant_delta", event: { type: "text_delta", contentIndex: 0, delta } }]);
		}
		live.stream([{ type: "assistant_delta", event: { type: "text_end", contentIndex: 0, content: text } }]);
		await vi.waitFor(() =>
			expect(
				device.frames.some(
					(frame) =>
						frame.type === "live" &&
						frame.items.some((item) => item.type === "assistant_delta" && item.event.type === "text_end"),
				),
			).toBe(true),
		);
		const streamed = device.frames
			.flatMap((frame) => (frame.type === "live" ? frame.items : []))
			.flatMap((item) =>
				item.type === "assistant_delta" && item.event.type === "text_delta" ? [item.event.delta] : [],
			)
			.join("");
		expect(streamed).toBe("see /workspace/src/index.ts now");
		expect(JSON.stringify(device.frames)).not.toContain(workspace.slice(0, cut - text.indexOf(workspace)));
	});

	it("refuses a form whose field pattern could backtrack without bound", async () => {
		const { conversation } = await setup();
		await expect(
			conversation.liveState.request({
				kind: "form",
				title: "Name",
				fields: [{ kind: "string", id: "name", label: "Name", pattern: "(a+)+$" }],
			}),
		).rejects.toThrow(/pattern/);
	});
});

function assistant(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text, textSignature: "secret-signature" }],
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
		stopReason: "stop" as const,
		timestamp: 0,
	};
}
