/**
 * Voice on the daemon and its conversation workers (docs/daemon-voice-design.md,
 * milestone 2): a headless fixture client starts voice on a worker-hosted
 * conversation over the ordinary protocol, attaches media through the
 * daemon's relay, and exchanges envelopes; ownership, revocation, bounds,
 * and shutdown are exercised against the real daemon with the fake voice
 * provider and the faux text provider.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { VOICE_ENVELOPE_KINDS } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { type ConversationOpened, openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient, ProtocolRejectedError } from "../src/client/protocol-client.ts";
import type { DaemonClient } from "../src/daemon/control-client.ts";
import type { WorkerSpawnOptions } from "../src/daemon/control-protocol.ts";
import { FakeVoiceProvider } from "./fixtures/fake-voice-provider.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { InProcessWorkerLauncher } from "./suite/in-process-worker-launcher.ts";
import { attachVoiceMedia, startVoice, untilVoice, voiceValue } from "./suite/voice-fixture-client.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface VoiceHarness {
	harness: DaemonHarness;
	provider: FakeVoiceProvider;
}

async function startHarness(options: { enabled?: boolean } = {}): Promise<VoiceHarness> {
	const provider = new FakeVoiceProvider();
	const harness = await createDaemonHarness({
		workerLauncher: new InProcessWorkerLauncher({ voiceProviders: new Map([["fake", provider]]) }),
		settings: { voice: { enabled: options.enabled ?? true, provider: "fake" } },
	});
	cleanups.push(() => harness.dispose());
	return { harness, provider };
}

function spawnOptions(cwd: string): WorkerSpawnOptions {
	return { env: {}, config: {}, cwd, persist: true, session: {} };
}

async function openTui(
	harness: DaemonHarness,
	clientKey: string,
	target: { kind: "new" } | { kind: "session"; sessionId: string } = { kind: "new" },
): Promise<{ tui: DaemonClient; opened: ConversationOpened; client: ProtocolClient }> {
	const tui = await harness.connect("tui");
	const { opened, transport } = await openDaemonConversation(tui, {
		target,
		spawn: spawnOptions(harness.workspacePath),
		clientKey,
	});
	const client = new ProtocolClient({ followMoves: "reconnect" });
	cleanups.push(() => client.stop());
	await client.connect(transport);
	return { tui, opened, client };
}

function userTexts(client: ProtocolClient): string[] {
	return client.state.entries.flatMap((entry) => {
		const message = entry.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== "user") return [];
		const content = message.content;
		return [
			typeof content === "string" ? content : content.map((block) => ("text" in block ? block.text : "")).join(""),
		];
	});
}

describe("voice on worker-hosted conversations", () => {
	it("starts, attaches media through the daemon, bridges speech both ways, and stops without touching the agent", async () => {
		const { harness, provider } = await startHarness();
		harness.faux.setResponses([fauxAssistantMessage("The tests pass.")]);
		const { tui, opened, client } = await openTui(harness, "tui-1");
		await untilVoice(client, (value) => value.lifecycle === "off" && value.availability.available, "voice available");

		const started = await startVoice(client, "start-1");
		expect(started.epoch).toBe(1);
		await untilVoice(client, (value) => value.lifecycle === "starting", "starting");
		// A retry of the same intent answers the same offer.
		expect(await startVoice(client, "start-1")).toEqual(started);

		const media = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-1",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		cleanups.push(() => media.close());
		await untilVoice(client, (value) => value.lifecycle === "active", "active");
		expect(provider.sessions).toHaveLength(1);
		// The media attachment counts as an attached client.
		expect((await harness.status()).workers[0]?.clients.local).toBe(2);

		media.sendFrame();
		media.sendFrame();
		await expect.poll(() => provider.current.frames.length).toBe(2);
		await untilVoice(client, (value) => value.input === "listening", "listening");

		provider.current.emit({ type: "user_turn_completed", turnId: "t1", transcript: "do the tests pass" });
		await expect.poll(() => provider.current.appended.length, { timeout: 10_000 }).toBe(1);
		await client.waitForIdle();
		expect(userTexts(client)).toEqual(["do the tests pass"]);
		expect(provider.current.appended[0]).toEqual({
			text: "The tests pass.",
			channel: "speakable",
			delegationId: undefined,
		});

		provider.current.emit({ type: "assistant_turn_started" });
		provider.current.emit({ type: "audio", frame: new Int16Array(480).fill(321) });
		await expect.poll(() => media.received.length).toBe(1);
		expect(media.received[0]).toMatchObject({ kind: VOICE_ENVELOPE_KINDS.audio, epoch: 0, sequence: 0 });
		await untilVoice(client, (value) => value.output === "speaking", "speaking");

		await client.intent("voice_interrupt", { epoch: started.epoch });
		await expect.poll(() => media.received.length).toBe(2);
		expect(media.received[1]).toMatchObject({ kind: VOICE_ENVELOPE_KINDS.playback_epoch, epoch: 1 });
		expect(client.phase?.operation ?? null).toBeNull();

		await client.intent("voice_stop", { epoch: started.epoch });
		await untilVoice(client, (value) => value.lifecycle === "off", "off");
		expect(provider.current.closed).toBe(true);
		await expect.poll(() => media.stream.destroyed).toBe(true);
		// The conversation serves on.
		harness.faux.setResponses([fauxAssistantMessage("still here")]);
		await client.promptAndWait("typed after voice");
		expect(userTexts(client)).toEqual(["do the tests pass", "typed after voice"]);
	}, 60_000);

	it("is unavailable, and refuses to start, when voice is disabled", async () => {
		const { harness } = await startHarness({ enabled: false });
		const { client } = await openTui(harness, "tui-1");
		await untilVoice(client, (value) => value.lifecycle === "off", "voice value");
		expect(voiceValue(client)?.availability).toEqual({ available: false, reason: "disabled" });
		await expect(client.intent("voice_start", {})).rejects.toMatchObject({ reason: { code: "unavailable" } });
	}, 30_000);

	it("lets no other client attach to, replay, or stop the owner's media, and ends voice when the owner leaves", async () => {
		const { harness, provider } = await startHarness();
		const { tui, opened, client } = await openTui(harness, "tui-1");
		const started = await startVoice(client);

		// Another TUI process on the same conversation cannot redeem the owner's offer.
		const other = await openTui(harness, "tui-2", { kind: "session", sessionId: opened.sessionId });
		const stolen = await attachVoiceMedia(other.tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-2",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		await expect.poll(() => stolen.stream.destroyed || stolen.stream.readableEnded).toBe(true);
		expect(provider.sessions).toHaveLength(0);
		expect(voiceValue(client)?.lifecycle).toBe("starting");

		const media = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-1",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		cleanups.push(() => media.close());
		await untilVoice(client, (value) => value.lifecycle === "active", "active");

		// A consumed offer cannot be replayed, even by the owner.
		const replayed = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-1",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		await expect.poll(() => replayed.stream.destroyed || replayed.stream.readableEnded).toBe(true);
		expect(media.stream.destroyed).toBe(false);

		// Other clients see the owner exists, but cannot stop or interrupt its epoch, nor start their own.
		await untilVoice(other.client, (value) => value.lifecycle === "active", "observer sees active");
		expect(voiceValue(other.client)?.owner).toBeDefined();
		await expect(other.client.intent("voice_stop", { epoch: started.epoch })).rejects.toMatchObject({
			reason: { code: "conflict" },
		});
		await expect(other.client.intent("voice_interrupt", { epoch: started.epoch })).rejects.toMatchObject({
			reason: { code: "conflict" },
		});
		await expect(other.client.intent("voice_start", {})).rejects.toMatchObject({ reason: { code: "conflict" } });
		// A stale epoch from the owner stops nothing.
		await expect(client.intent("voice_stop", { epoch: started.epoch + 1 })).rejects.toMatchObject({
			reason: { code: "stale" },
		});
		expect(voiceValue(client)?.lifecycle).toBe("active");

		// The owner's control connection goes: media and provider close; the observer keeps the conversation.
		await client.stop();
		await untilVoice(other.client, (value) => value.lifecycle === "off", "off after owner left");
		expect(voiceValue(other.client)?.error).toMatchObject({ code: "owner_detached" });
		expect(provider.current.closed).toBe(true);
		await expect.poll(() => media.stream.destroyed || media.stream.readableEnded).toBe(true);
		harness.faux.setResponses([fauxAssistantMessage("fine")]);
		await other.client.promptAndWait("observer still works");
		expect(userTexts(other.client)).toEqual(["observer still works"]);
	}, 60_000);

	it("keeps malformed and oversized media from the conversation, and joins cleanup on daemon shutdown", async () => {
		const { harness, provider } = await startHarness();
		const { tui, opened, client } = await openTui(harness, "tui-1");
		const started = await startVoice(client);
		const media = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-1",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		cleanups.push(() => media.close());
		await untilVoice(client, (value) => value.lifecycle === "active", "active");
		// An envelope claiming 64 KiB: rejected before allocation.
		media.sendRaw(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x01]));
		await untilVoice(client, (value) => value.lifecycle === "off", "off after oversized envelope");
		expect(voiceValue(client)?.error).toMatchObject({ code: "media_invalid" });
		harness.faux.setResponses([fauxAssistantMessage("fine")]);
		await client.promptAndWait("typed");
		expect(userTexts(client)).toEqual(["typed"]);

		// A fresh epoch, then the daemon stops with voice active: the provider closes, nothing hangs.
		const again = await startVoice(client);
		expect(again.epoch).toBe(2);
		const second = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "tui-1",
			offerId: again.media.offerId,
			epoch: again.epoch,
		});
		cleanups.push(() => second.close());
		await untilVoice(client, (value) => value.lifecycle === "active", "active again");
		provider.current.closeDelayMs = 200;
		const stopped = Date.now();
		expect(await harness.shutdown()).toBe(0);
		expect(Date.now() - stopped).toBeLessThan(30_000);
		expect(provider.sessions.every((session) => session.closed)).toBe(true);
	}, 60_000);
});

describe("voice intent admission", () => {
	it("rejects a stop or interruption when no voice epoch lives", async () => {
		const { harness } = await startHarness();
		const { client } = await openTui(harness, "tui-1");
		await untilVoice(client, (value) => value.lifecycle === "off", "voice value");
		await expect(client.intent("voice_stop", { epoch: 1 })).rejects.toBeInstanceOf(ProtocolRejectedError);
		await expect(client.intent("voice_interrupt", { epoch: 1 })).rejects.toMatchObject({ reason: { code: "stale" } });
	}, 30_000);
});
