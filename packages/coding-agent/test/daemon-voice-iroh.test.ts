/**
 * Voice from a paired device over real (relay-disabled) Iroh loopback
 * (docs/daemon-voice-design.md, milestone 3): the device starts voice on its
 * conversation stream and carries media on a `voiceMedia` stream of the same
 * connection, which the daemon relays to the worker serving that
 * conversation stream. Authorization (`voice.stream.v1`), the binding to the
 * conversation stream, revocation, connection loss, congestion, and the
 * daemon's media budget are exercised with the fake voice provider and the
 * faux text provider.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveFrame,
	type HostFrame,
	type LiveVoiceValue,
	VOICE_ENVELOPE_KINDS,
	VOICE_FRAME_SAMPLES,
	type VoiceStartOutput,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import { FakeVoiceProvider } from "./fixtures/fake-voice-provider.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { InProcessWorkerLauncher } from "./suite/in-process-worker-launcher.ts";
import { irohVoiceMedia, startVoice } from "./suite/voice-fixture-client.ts";
import { nativeIrohAvailable, type PairedPhone, type PhoneConversation, pairPhone } from "./utilities/daemon-phone.ts";
import type { RemotePhone } from "./utilities/remote-phone.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

interface VoiceHarness {
	harness: DaemonHarness;
	provider: FakeVoiceProvider;
}

async function startHarness(options: { voiceMediaSessions?: number } = {}): Promise<VoiceHarness> {
	const provider = new FakeVoiceProvider();
	const harness = await createDaemonHarness({
		extensions: [createIrohDaemonService({ relayMode: "disabled" })],
		workerLauncher: new InProcessWorkerLauncher({ voiceProviders: new Map([["fake", provider]]) }),
		settings: { voice: { enabled: true, provider: "fake" } },
		...(options.voiceMediaSessions === undefined ? {} : { voiceMediaSessions: options.voiceMediaSessions }),
	});
	cleanups.push(() => harness.dispose());
	return { harness, provider };
}

async function pair(harness: DaemonHarness, options: Parameters<typeof pairPhone>[1] = {}): Promise<PairedPhone> {
	const phone = await pairPhone(harness, options);
	cleanups.push(() => phone.close());
	return phone;
}

/** Open `sessionId` on `paired`, say hello, and subscribe to it. */
async function attach(
	paired: PairedPhone,
	sessionId: string,
): Promise<{ stream: PhoneConversation; phone: RemotePhone }> {
	const stream = await paired.openConversation({ target: "session", sessionId });
	expect(stream.handshake).toMatchObject({ success: true, sessionId });
	const phone = stream.phone!;
	await phone.hello();
	await phone.subscribe(sessionId);
	return { stream, phone };
}

/** The live `voice` value as the device folds its live lane. */
function phoneVoice(phone: RemotePhone): LiveVoiceValue | undefined {
	let state = emptyLiveFold();
	for (const frame of phone.frames) {
		if (frame.type === "live" && frame.subscriptionId === "s1") state = foldLiveFrame(state, frame);
	}
	const value = state.values.get("voice");
	return value?.kind === "voice" ? value : undefined;
}

async function untilPhoneVoice(
	phone: RemotePhone,
	predicate: (value: LiveVoiceValue) => boolean,
	what: string,
	timeoutMs = 10_000,
): Promise<LiveVoiceValue> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = phoneVoice(phone);
		if (value && predicate(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; voice is ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function phoneStartVoice(phone: RemotePhone): Promise<VoiceStartOutput> {
	const outcome = await phone.intent("voice_start", {});
	if (outcome.type !== "accepted") throw new Error(`voice_start rejected: ${JSON.stringify(outcome)}`);
	return outcome.result as VoiceStartOutput;
}

function userTexts(phone: RemotePhone): string[] {
	return phone.frames.flatMap((frame: HostFrame) =>
		frame.type === "entry" &&
		frame.entry.type === "message" &&
		frame.entry.view !== undefined &&
		"role" in frame.entry.view &&
		frame.entry.view.role === "user"
			? [String((frame.entry.view as { text?: unknown }).text ?? "")]
			: [],
	);
}

const OTHER_OFFER = "offer_0123456789abcdefghij";

describe.skipIf(!nativeIrohAvailable)("voice from a paired device over Iroh", () => {
	it("starts voice on a conversation stream and carries its media on a sibling stream of the same connection", async () => {
		const { harness, provider } = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage(`Edited ${harness.workspacePath}/src/app.ts for you.`)]);
		const paired = await pair(harness);
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);
		await untilPhoneVoice(phone, (value) => value.lifecycle === "off" && value.availability.available, "available");

		const started = await phoneStartVoice(phone);
		const sibling = await stream.openSibling({ voiceMedia: { sessionId, offerId: started.media.offerId } });
		expect(sibling.handshake).toMatchObject({
			success: true,
			clientNodeId: paired.nodeId,
			voiceMedia: { sessionId },
		});
		expect(sibling.handshake).not.toHaveProperty("sessionId");
		const media = irohVoiceMedia(sibling.stream, sibling.rest, started.epoch);
		cleanups.push(() => media.close());
		await untilPhoneVoice(phone, (value) => value.lifecycle === "active", "active");
		// The media stream counts as the device attached to the worker, beside its conversation stream.
		expect((await harness.status()).workers[0]?.clients.remote).toBe(2);

		await media.sendFrame();
		await media.sendFrame();
		await expect.poll(() => provider.current.frames.length).toBe(2);

		provider.current.emit({ type: "user_turn_completed", turnId: "t1", transcript: "fix the app" });
		await expect.poll(() => provider.current.appended.length, { timeout: 10_000 }).toBe(1);
		// The device hears what its own stream shows: host paths are redacted as its transcript redacts them.
		expect(provider.current.appended[0]).toEqual({
			text: "Edited /workspace/src/app.ts for you.",
			channel: "speakable",
			delegationId: undefined,
		});
		await expect.poll(() => userTexts(phone)).toEqual(["fix the app"]);

		provider.current.emit({ type: "assistant_turn_started" });
		for (let index = 0; index < 3; index++) {
			provider.current.emit({ type: "audio", frame: new Int16Array(VOICE_FRAME_SAMPLES).fill(500) });
		}
		await expect
			.poll(() => media.received.filter((envelope) => envelope.kind === VOICE_ENVELOPE_KINDS.audio).length)
			.toBe(3);

		expect(await phone.intent("voice_stop", { epoch: started.epoch })).toMatchObject({ type: "accepted" });
		await untilPhoneVoice(phone, (value) => value.lifecycle === "off", "off");
		await media.ended;
		expect(provider.current.closed).toBe(true);
		expect(phoneVoice(phone)?.error).toBeUndefined();
	}, 60_000);

	it("needs voice.stream.v1, which only an explicit grant update gives a paired device", async () => {
		const { harness, provider } = await startHarness();
		const paired = await pair(harness, { access: "coding" });
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);

		expect(await phone.intent("voice_start", {})).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "voice.stream.v1" },
		});
		const media = await stream.openSibling({ voiceMedia: { sessionId, offerId: OTHER_OFFER } });
		expect(media.handshake).toMatchObject({ success: false, error: "rpc_capability_denied: voice.stream.v1" });
		expect(provider.sessions).toHaveLength(0);

		const clients = await harness.control.request({ type: "clients_list" });
		const revision =
			clients.type === "clients_result"
				? clients.clients.find((client) => client.clientNodeId === paired.nodeId)?.rpcGrant?.revision
				: undefined;
		expect(
			await harness.control.request({
				type: "client_access_update",
				clientNodeId: paired.nodeId,
				expectedRevision: revision ?? 1,
				access: "full",
			}),
		).toMatchObject({ type: "client_access_updated" });
		// The update closed the device's connections; its next stream holds the new grant.
		const again = await attach(paired, sessionId);
		const started = await phoneStartVoice(again.phone);
		const attached = await again.stream.openSibling({ voiceMedia: { sessionId, offerId: started.media.offerId } });
		expect(attached.handshake).toMatchObject({ success: true });
		cleanups.push(() => irohVoiceMedia(attached.stream, attached.rest, started.epoch).close());
		await untilPhoneVoice(again.phone, (value) => value.lifecycle === "active", "active");
	}, 60_000);

	it("attaches media only beside the conversation stream that started voice, once, with its offer", async () => {
		const { harness, provider } = await startHarness();
		const paired = await pair(harness);
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);
		const started = await phoneStartVoice(phone);
		const offer = { voiceMedia: { sessionId, offerId: started.media.offerId } };
		const unavailable = { success: false, outcome: "voice_media_unavailable" };

		// The same device on another connection, and another device, have no conversation stream to attach beside.
		expect((await paired.openStream(offer)).handshake).toMatchObject(unavailable);
		const other = await pair(harness, { label: "other-phone" });
		await attach(other, sessionId);
		expect((await other.openStream(offer)).handshake).toMatchObject(unavailable);
		// Beside the right stream, only the offer it was answered admits a stream; a wrong one consumes nothing.
		expect((await stream.openSibling({ voiceMedia: { sessionId, offerId: OTHER_OFFER } })).handshake).toMatchObject(
			unavailable,
		);
		const attached = await stream.openSibling(offer);
		expect(attached.handshake).toMatchObject({ success: true });
		const media = irohVoiceMedia(attached.stream, attached.rest, started.epoch);
		cleanups.push(() => media.close());
		await untilPhoneVoice(phone, (value) => value.lifecycle === "active", "active");
		// The offer was single-use, and one media stream is all a conversation stream holds.
		expect((await stream.openSibling(offer)).handshake).toMatchObject(unavailable);
		expect(provider.sessions).toHaveLength(1);
		await media.sendFrame();
		await expect.poll(() => provider.current.frames.length).toBe(1);
	}, 60_000);

	it("fences the media of a revoked device at once and closes the provider session", async () => {
		const { harness, provider } = await startHarness();
		const paired = await pair(harness);
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);
		const started = await phoneStartVoice(phone);
		const attached = await stream.openSibling({ voiceMedia: { sessionId, offerId: started.media.offerId } });
		const media = irohVoiceMedia(attached.stream, attached.rest, started.epoch);
		await untilPhoneVoice(phone, (value) => value.lifecycle === "active", "active");

		expect(await harness.control.request({ type: "client_revoke", clientNodeId: paired.nodeId })).toMatchObject({
			type: "ok",
		});
		await media.ended;
		await expect.poll(() => provider.current.closed, { timeout: 10_000 }).toBe(true);
		await expect.poll(async () => (await harness.status()).workers[0]?.clients.remote ?? 0).toBe(0);
	}, 60_000);

	it("ends voice when the device's connection is lost, and reports why on reconnect", async () => {
		const { harness, provider } = await startHarness();
		const paired = await pair(harness);
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);
		const started = await phoneStartVoice(phone);
		const attached = await stream.openSibling({ voiceMedia: { sessionId, offerId: started.media.offerId } });
		irohVoiceMedia(attached.stream, attached.rest, started.epoch);
		await untilPhoneVoice(phone, (value) => value.lifecycle === "active", "active");

		await stream.close();
		await expect.poll(() => provider.current.closed, { timeout: 10_000 }).toBe(true);
		const again = await attach(paired, sessionId);
		const value = await untilPhoneVoice(again.phone, (voice) => voice.lifecycle === "off", "off");
		expect(["owner_detached", "media_lost"]).toContain(value.error?.code);
	}, 60_000);

	it("ends voice for a device that stops reading its media, while its conversation stream stays responsive", async () => {
		const { harness, provider } = await startHarness();
		const paired = await pair(harness);
		const { sessionId } = await harness.createSession();
		const { stream, phone } = await attach(paired, sessionId);
		const started = await phoneStartVoice(phone);
		const attached = await stream.openSibling({ voiceMedia: { sessionId, offerId: started.media.offerId } });
		const media = irohVoiceMedia(attached.stream, attached.rest, started.epoch);
		await untilPhoneVoice(phone, (value) => value.lifecycle === "active", "active");

		// The device's network stalls on media while the provider keeps speaking.
		media.pauseReading();
		const frame = new Int16Array(VOICE_FRAME_SAMPLES).fill(700);
		provider.current.emit({ type: "assistant_turn_started" });
		for (let batch = 0; batch < 400 && !provider.current.closed; batch++) {
			for (let index = 0; index < 100; index++) provider.current.emit({ type: "audio", frame });
			await new Promise((resolve) => setImmediate(resolve));
		}
		const value = await untilPhoneVoice(phone, (voice) => voice.lifecycle === "off", "off", 20_000);
		expect(value.error?.code).toBe("slow_reader");
		expect(provider.current.closed).toBe(true);
		// Media congestion never held the conversation stream back.
		expect(await phone.query("host_status")).toMatchObject({ type: "result" });
	}, 60_000);

	it("draws every media attachment of the daemon, a device's and a TUI's, from one budget", async () => {
		const { harness } = await startHarness({ voiceMediaSessions: 1 });
		const paired = await pair(harness);
		const first = await harness.createSession();
		const second = await harness.createSession();
		const a = await attach(paired, first.sessionId);
		const b = await attach(paired, second.sessionId);
		const startedA = await phoneStartVoice(a.phone);
		const startedB = await phoneStartVoice(b.phone);
		const attachedA = await a.stream.openSibling({
			voiceMedia: { sessionId: first.sessionId, offerId: startedA.media.offerId },
		});
		expect(attachedA.handshake).toMatchObject({ success: true });
		irohVoiceMedia(attachedA.stream, attachedA.rest, startedA.epoch);
		await untilPhoneVoice(a.phone, (value) => value.lifecycle === "active", "active");

		const offerB = { voiceMedia: { sessionId: second.sessionId, offerId: startedB.media.offerId } };
		expect((await b.stream.openSibling(offerB)).handshake).toMatchObject({
			success: false,
			outcome: "voice_media_unavailable",
			error: "the host holds as many voice sessions as it allows",
		});
		const tui = await harness.connect("tui");
		const { opened, transport } = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: { env: {}, config: {}, cwd: harness.workspacePath, persist: true, session: {} },
			clientKey: "tui-budget",
		});
		const client = new ProtocolClient({ followMoves: "reconnect" });
		cleanups.push(() => client.stop());
		await client.connect(transport);
		const startedTui = await startVoice(client);
		expect(
			await tui.request({
				type: "voice_media_open",
				sessionId: opened.sessionId,
				clientKey: "tui-budget",
				offerId: startedTui.media.offerId,
			}),
		).toMatchObject({ type: "error", code: "capacity" });

		// Ending one attachment returns its share: the waiting offer attaches now.
		expect(await a.phone.intent("voice_stop", { epoch: startedA.epoch })).toMatchObject({ type: "accepted" });
		await expect.poll(async () => (await b.stream.openSibling(offerB)).handshake.success).toBe(true);
		await untilPhoneVoice(b.phone, (value) => value.lifecycle === "active", "active");
	}, 60_000);
});
