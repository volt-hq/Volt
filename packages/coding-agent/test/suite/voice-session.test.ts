/**
 * The voice session's automatic agent bridge, lifecycle, and bounds against
 * a real conversation host over the faux provider and the fake voice
 * provider (docs/daemon-voice-design.md, "Required fixture scenarios").
 */

import { Duplex, PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@hansjm10/volt-ai";
import { VOICE_ENVELOPE_KINDS, VOICE_LIMITS } from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../src/core/host/targets.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import {
	encodeVoiceEnvelope,
	frameToPayload,
	type VoiceEnvelope,
	VoiceEnvelopeDecoder,
} from "../../src/core/voice/media-envelope.ts";
import { VoiceProviderError } from "../../src/core/voice/provider.ts";
import { VoiceService } from "../../src/core/voice/voice-service.ts";
import { FakeVoiceProvider } from "../fixtures/fake-voice-provider.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./host-harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A media stream pair: what the test writes reaches the session; what the session writes, the test reads. */
function mediaPair(): { sessionSide: Duplex; write(buffer: Buffer): void; received: VoiceEnvelope[]; end(): void } {
	const toSession = new PassThrough();
	const fromSession = new PassThrough();
	const sessionSide = Duplex.from({ readable: toSession, writable: fromSession });
	sessionSide.on("error", () => undefined);
	const decoder = new VoiceEnvelopeDecoder();
	const received: VoiceEnvelope[] = [];
	fromSession.on("data", (chunk: Buffer) => received.push(...decoder.push(chunk)));
	return {
		sessionSide,
		write: (buffer) => {
			toSession.write(buffer);
		},
		received,
		end: () => toSession.end(),
	};
}

function audioEnvelope(epoch: number, sequence: number): Buffer {
	const frame = new Int16Array(480);
	frame.fill(1000);
	return encodeVoiceEnvelope({
		kind: VOICE_ENVELOPE_KINDS.audio,
		epoch,
		sequence,
		sampleOffset: sequence * 480,
		payload: frameToPayload(frame),
	});
}

function controlEnvelope(kind: number, epoch: number): Buffer {
	return encodeVoiceEnvelope({ kind: kind as 2 | 3, epoch, sequence: 0, sampleOffset: 0, payload: Buffer.alloc(0) });
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

interface Fixture {
	harness: HostHarness;
	conversation: HostedConversation;
	owner: HostClient;
	provider: FakeVoiceProvider;
	service: VoiceService;
	live: () => ReturnType<typeof liveVoice>;
	now: { value: number };
	/** Start voice for the owner and attach media; resolves once the provider session is active. */
	activate(): Promise<{ epoch: number; media: ReturnType<typeof mediaPair> }>;
}

function liveVoice(conversation: HostedConversation) {
	const value = conversation.liveState.get("voice");
	if (value?.kind !== "voice") throw new Error("no voice live value");
	return value;
}

async function fixture(options: HostHarnessOptions & { voiceEnabled?: boolean } = {}): Promise<Fixture> {
	const harness = await createHostHarness({
		...options,
		globalSettings: {
			...(options.globalSettings ?? {}),
			voice: { enabled: options.voiceEnabled ?? true, provider: "fake" },
		},
	});
	cleanups.push(() => harness.cleanup());
	const conversation = await harness.openStartup();
	const owner = harness.client("owner");
	await harness.host.attach(owner, conversation);
	const provider = new FakeVoiceProvider();
	const now = { value: Date.now() };
	const service = new VoiceService({
		clientsOf: (target) => harness.host.clientsOf(target),
		providers: new Map([["fake", provider]]),
		profile: localProfile,
		now: () => now.value,
	});
	cleanups.push(() => service.close());
	return {
		harness,
		conversation,
		owner,
		provider,
		service,
		now,
		live: () => liveVoice(conversation),
		async activate() {
			const started = service.start(conversation, { clientId: owner.id, clientKey: "owner-key" }, "intent-1");
			const media = mediaPair();
			service.attachMedia(conversation, started.media.offerId, "owner-key", media.sessionSide);
			await until(() => liveVoice(conversation).lifecycle === "active", "voice active");
			return { epoch: started.epoch, media };
		},
	};
}

function userMessages(conversation: HostedConversation): Array<{ text: string; clientMessageId?: string }> {
	return conversation.session.sessionManager.committedEntriesAfter(0).flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "user") return [];
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content.map((block) => (block.type === "text" ? block.text : "")).join("");
		return [{ text, ...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }) }];
	});
}

describe("voice session lifecycle", () => {
	it("starts for its owner, opens the provider only once media attached, and stops without touching the agent", async () => {
		const { conversation, owner, provider, service, live } = await fixture();
		expect(service.availability(conversation)).toEqual({ available: true });
		const started = service.start(conversation, { clientId: owner.id, clientKey: "owner-key" }, "intent-1");
		expect(started.epoch).toBe(1);
		expect(started.media.format).toEqual({ encoding: "pcm_s16le", sampleRate: 24_000, channels: 1, frameMs: 20 });
		expect(live()).toMatchObject({ lifecycle: "starting", epoch: 1, owner: { client: owner.id }, input: "muted" });
		// No provider session without a media owner.
		expect(provider.sessions).toHaveLength(0);
		// A retry of the same intent answers the same; a competing start conflicts.
		expect(service.start(conversation, { clientId: owner.id, clientKey: "owner-key" }, "intent-1")).toEqual(started);
		expect(() => service.start(conversation, { clientId: "other", clientKey: "other-key" }, "intent-2")).toThrow(
			/Another client owns voice/,
		);

		const media = mediaPair();
		service.attachMedia(conversation, started.media.offerId, "owner-key", media.sessionSide);
		await until(() => live().lifecycle === "active", "active");
		expect(provider.sessions).toHaveLength(1);
		expect(provider.current.instructions).toMatch(/defer/);
		// The offer was consumed: a replay fails.
		expect(() =>
			service.attachMedia(conversation, started.media.offerId, "owner-key", mediaPair().sessionSide),
		).toThrow();

		// A stale epoch stops nothing; the live one stops media and provider, not the agent.
		expect(await service.stop(conversation, { clientId: owner.id, clientKey: "owner-key" }, 99)).toBe(false);
		expect(await service.stop(conversation, { clientId: owner.id, clientKey: "owner-key" }, started.epoch)).toBe(
			true,
		);
		expect(live()).toMatchObject({ lifecycle: "off", epoch: 1 });
		expect(live().owner).toBeUndefined();
		expect(provider.current.closed).toBe(true);
		expect(media.sessionSide.destroyed).toBe(true);
		expect(conversation.closed).toBe(false);
	});

	it("refuses a media attachment with the wrong client key or after the offer expired", async () => {
		const { conversation, owner, service, now, live } = await fixture();
		const started = service.start(conversation, { clientId: owner.id, clientKey: "owner-key" }, "intent-1");
		expect(() => service.attachMedia(conversation, started.media.offerId, "thief", mediaPair().sessionSide)).toThrow(
			/not pending/,
		);
		now.value += VOICE_LIMITS.mediaOfferTtlMs + 1;
		expect(() =>
			service.attachMedia(conversation, started.media.offerId, "owner-key", mediaPair().sessionSide),
		).toThrow(/not pending/);
		await until(() => live().lifecycle === "off", "attach timeout", VOICE_LIMITS.mediaOfferTtlMs + 2000);
		expect(live().error).toEqual({ code: "attach_timeout", message: expect.any(String) });
	});

	it("is unavailable when disabled, when the provider is missing, and when the provider says so", async () => {
		const disabled = await fixture({ voiceEnabled: false });
		expect(disabled.service.availability(disabled.conversation)).toEqual({ available: false, reason: "disabled" });
		expect(() =>
			disabled.service.start(disabled.conversation, { clientId: "c", clientKey: "k" }, "intent-1"),
		).toThrow(/unavailable/);
		const { conversation, provider, service } = await fixture();
		provider.availabilityValue = { available: false, reason: "auth_unavailable" };
		expect(service.availability(conversation)).toEqual({ available: false, reason: "auth_unavailable" });
		expect(() => service.start(conversation, { clientId: "c", clientKey: "k" }, "intent-1")).toThrow(
			/auth_unavailable/,
		);
	});

	it("reports a provider start failure with its safe code and keeps the conversation usable", async () => {
		const { conversation, provider, live, activate, harness } = await fixture();
		provider.failStartWith = new VoiceProviderError("auth_unavailable", "token missing");
		await expect(activate()).rejects.toThrow(/timed out/);
		expect(live()).toMatchObject({ lifecycle: "off", error: { code: "auth_unavailable" } });
		harness.faux.setResponses([fauxAssistantMessage("still here")]);
		await conversation.session.prompt("typed");
		expect(userMessages(conversation).map((message) => message.text)).toEqual(["typed"]);
	});

	it("ends when the owner's control attachment leaves, while another client keeps the conversation", async () => {
		const { conversation, owner, provider, live, activate, harness } = await fixture();
		await harness.host.attach(harness.client("observer"), conversation);
		await activate();
		await harness.host.detach(owner);
		await until(() => live().lifecycle === "off", "off after detach");
		expect(live().error).toMatchObject({ code: "owner_detached" });
		expect(provider.current.closed).toBe(true);
	});
});

describe("voice input bridge", () => {
	it("admits each completed user turn once as literal text; fragments, outputs, and delegations start nothing", async () => {
		const { conversation, provider, activate, harness } = await fixture();
		harness.faux.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await activate();
		const session = provider.current;
		session.emit({ type: "user_transcript_delta", turnId: "t1", text: "run the" });
		session.emit({ type: "assistant_transcript_delta", text: "Sure" });
		session.emit({ type: "delegation_created", delegationId: "d-0" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(userMessages(conversation)).toEqual([]);

		session.emit({ type: "user_turn_completed", turnId: "t1", transcript: " run the tests " });
		// The same event again, and the same words as a new turn.
		session.emit({ type: "user_turn_completed", turnId: "t1", transcript: " run the tests " });
		session.emit({ type: "user_turn_completed", turnId: "t2", transcript: "run the tests" });
		await until(() => userMessages(conversation).length === 2, "two user messages");
		await conversation.session.waitForIdle();
		const messages = userMessages(conversation);
		expect(messages.map((message) => message.text)).toEqual(["run the tests", "run the tests"]);
		expect(new Set(messages.map((message) => message.clientMessageId)).size).toBe(2);
		expect(messages[0]?.clientMessageId).toMatch(/^voice-.*-1-t1$/);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps a spoken slash command literal and lets a spoken yes answer no host request", async () => {
		const { conversation, provider, activate, harness } = await fixture();
		harness.faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
		await activate();
		const session = provider.current;
		const pending = conversation.liveState.request({ kind: "confirm", title: "Delete?", message: "Really?" });
		let outcome: Awaited<typeof pending> | undefined;
		void pending.then((result) => {
			outcome = result;
		});
		session.emit({ type: "user_turn_completed", turnId: "t1", transcript: "/clear" });
		session.emit({ type: "user_turn_completed", turnId: "t2", transcript: "yes" });
		await until(() => userMessages(conversation).length === 2, "two literal user messages");
		await conversation.session.waitForIdle();
		expect(userMessages(conversation).map((message) => message.text)).toEqual(["/clear", "yes"]);
		// The conversation was not cleared, and nothing answered the confirmation.
		expect(conversation.closed).toBe(false);
		expect(outcome?.status).not.toBe("answered");
	});
});

describe("voice output bridge", () => {
	it("speaks committed assistant text through the owner's projection: commentary around tools, then the final answer; never thinking or tool data", async () => {
		const spoken: string[] = [];
		const { conversation, provider, activate, harness } = await fixture({
			extension: (volt) => {
				volt.registerTool({
					name: "fixture_tool",
					label: "Fixture tool",
					description: "Counts files",
					parameters: Type.Object({}),
					execute: async () => ({
						content: [{ type: "text", text: "SECRET-TOOL-OUTPUT 42" }],
						details: undefined,
					}),
				});
			},
		});
		harness.faux.setResponses([
			fauxAssistantMessage(
				[
					fauxThinking("private reasoning"),
					{ type: "text", text: "Let me count." },
					fauxToolCall("fixture_tool", {}),
				],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage([fauxThinking("more private reasoning"), { type: "text", text: "There are 42 files." }]),
		]);
		await activate();
		const session = provider.current;
		session.emit({ type: "user_turn_completed", turnId: "t1", transcript: "how many files" });
		await until(() => session.appended.length === 2, "two spoken blocks");
		await conversation.session.waitForIdle();
		expect(session.appended).toEqual([
			{ text: "Let me count.", channel: "commentary", delegationId: undefined },
			{ text: "There are 42 files.", channel: "speakable", delegationId: undefined },
		]);
		for (const entry of session.appended) spoken.push(entry.text);
		expect(spoken.join(" ")).not.toMatch(/private reasoning|SECRET-TOOL-OUTPUT|fixture_tool/);
		// No hidden provider agent: the conversation's selected model ran the turn and the tool.
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("correlates replies to a provider-verified delegation only, and never speaks history or failed messages", async () => {
		const { conversation, provider, activate, harness } = await fixture();
		harness.faux.setResponses([fauxAssistantMessage("historical")]);
		await conversation.session.prompt("before voice");
		await conversation.session.waitForIdle();
		harness.faux.setResponses([
			fauxAssistantMessage("delegated answer"),
			fauxAssistantMessage("broken", {
				stopReason: "error",
				error: { kind: "server", retryable: false, message: "boom" },
			}),
			fauxAssistantMessage("standalone answer"),
		]);
		await activate();
		const session = provider.current;
		session.emit({ type: "user_turn_completed", turnId: "t1", transcript: "first" });
		session.emit({ type: "delegation_created", delegationId: "d-1", turnId: "t1" });
		await until(() => session.appended.length === 1, "delegated reply spoken");
		await conversation.session.waitForIdle();
		expect(session.appended[0]).toEqual({ text: "delegated answer", channel: "speakable", delegationId: "d-1" });

		session.emit({ type: "user_turn_completed", turnId: "t2", transcript: "second" });
		await conversation.session.waitForIdle();
		// A delegation the provider could not tie to a turn, and a failed message, add nothing.
		session.emit({ type: "delegation_created", delegationId: "d-orphan" });
		session.emit({ type: "user_turn_completed", turnId: "t3", transcript: "third" });
		await until(() => session.appended.length === 2, "standalone reply spoken");
		await conversation.session.waitForIdle();
		expect(session.appended[1]).toEqual({ text: "standalone answer", channel: "speakable", delegationId: undefined });
		expect(session.appended.map((entry) => entry.text)).not.toContain("historical");
	});

	it("stops voice visibly when the speech queue overflows instead of dropping text", async () => {
		const { conversation, provider, activate, harness, live } = await fixture();
		const count = VOICE_LIMITS.speechQueueBlocks + 2;
		harness.faux.setResponses(Array.from({ length: count }, (_, index) => fauxAssistantMessage(`reply ${index}`)));
		await activate();
		const session = provider.current;
		session.holdAppends = true;
		for (let index = 0; index < count; index++) {
			await conversation.session.prompt(`typed ${index}`);
			await conversation.session.waitForIdle();
		}
		await until(() => live().lifecycle === "off", "voice off on backlog");
		expect(live().error).toMatchObject({ code: "speech_backlog" });
		session.releaseAppends();
		// The agent's text work was never delayed by speech.
		expect(userMessages(conversation)).toHaveLength(count);
	});
});

describe("voice media", () => {
	it("forwards client audio to the provider and provider audio to the client, drops it on barge-in until new speech, and never cancels the agent", async () => {
		const { conversation, provider, service, owner, activate } = await fixture();
		const { epoch, media } = await activate();
		const session = provider.current;
		media.write(audioEnvelope(epoch, 0));
		media.write(audioEnvelope(epoch, 1));
		await until(() => session.frames.length === 2, "two frames to the provider");
		expect(session.muteChanges).toEqual([false]);

		const frame = new Int16Array(480).fill(500);
		session.emit({ type: "assistant_turn_started" });
		session.emit({ type: "audio", frame });
		await until(() => media.received.length === 1, "one frame to the client");
		expect(media.received[0]).toMatchObject({ kind: VOICE_ENVELOPE_KINDS.audio, epoch: 0, sequence: 0 });

		expect(service.interrupt(conversation, { clientId: owner.id, clientKey: "owner-key" }, epoch)).toBe(true);
		await until(() => media.received.length === 2, "playback epoch envelope");
		expect(media.received[1]).toMatchObject({ kind: VOICE_ENVELOPE_KINDS.playback_epoch, epoch: 1 });
		expect(session.interrupts).toBe(1);
		session.emit({ type: "audio", frame });
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(media.received).toHaveLength(2);
		session.emit({ type: "assistant_turn_started" });
		session.emit({ type: "audio", frame });
		await until(() => media.received.length === 3, "audio after new speech");
		expect(media.received[2]).toMatchObject({ kind: VOICE_ENVELOPE_KINDS.audio, epoch: 1, sequence: 0 });
		expect(conversation.session.isBusy).toBe(false);
		expect(service.interrupt(conversation, { clientId: owner.id, clientKey: "owner-key" }, epoch + 1)).toBe(false);
	});

	it("fails on a wrong epoch, a sequence gap, an oversized envelope, and audio faster than real time, without blocking the conversation", async () => {
		for (const [name, corrupt] of [
			["wrong epoch", (epoch: number) => [audioEnvelope(epoch + 1, 0)]],
			["sequence gap", (epoch: number) => [audioEnvelope(epoch, 0), audioEnvelope(epoch, 2)]],
			["oversized", () => [Buffer.from([0x00, 0x01, 0x00, 0x00])]],
			["too fast", (epoch: number) => Array.from({ length: 30 }, (_, index) => audioEnvelope(epoch, index))],
		] as const) {
			const { conversation, live, activate, harness } = await fixture();
			const { epoch, media } = await activate();
			for (const buffer of corrupt(epoch)) media.write(buffer);
			await until(() => live().lifecycle === "off", `off after ${name}`);
			expect(["media_invalid", "media_overrun"]).toContain(live().error?.code);
			harness.faux.setResponses([fauxAssistantMessage("fine")]);
			await conversation.session.prompt("still works");
			expect(userMessages(conversation).map((message) => message.text)).toEqual(["still works"]);
		}
	});

	it("fails as stalled when an unmuted input stops, but not while muted, and when the stream ends", async () => {
		const stalled = await fixture();
		const { epoch, media } = await stalled.activate();
		media.write(audioEnvelope(epoch, 0));
		await until(() => stalled.live().input === "listening", "listening");
		stalled.now.value += VOICE_LIMITS.inputStallMs + 1;
		await until(() => stalled.live().lifecycle === "off", "stalled");
		expect(stalled.live().error).toMatchObject({ code: "input_stalled" });

		const muted = await fixture();
		const active = await muted.activate();
		active.media.write(audioEnvelope(active.epoch, 0));
		await until(() => muted.live().input === "listening", "listening");
		active.media.write(controlEnvelope(VOICE_ENVELOPE_KINDS.mute, active.epoch));
		await until(() => muted.live().input === "muted", "muted");
		muted.now.value += VOICE_LIMITS.inputStallMs * 3;
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(muted.live().lifecycle).toBe("active");
		active.media.end();
		await until(() => muted.live().lifecycle === "off", "media lost");
		expect(muted.live().error).toMatchObject({ code: "media_lost" });
	});

	it("tracks cumulative usage snapshots and marks the last one partial when the session ends", async () => {
		const { conversation, provider, service, owner, activate, live } = await fixture();
		const { epoch } = await activate();
		provider.current.emit({ type: "usage", audioSeconds: 12 });
		provider.current.emit({ type: "usage", audioSeconds: 30 });
		expect(live().usage).toEqual({ available: true, audioSeconds: 30, partial: false });
		await service.stop(conversation, { clientId: owner.id, clientKey: "owner-key" }, epoch);
		expect(live().usage).toEqual({ available: true, audioSeconds: 30, partial: true });
	});

	it("joins a stop that races the provider's start without leaking the session", async () => {
		const { conversation, provider, service, owner, live } = await fixture();
		provider.startDelayMs = 100;
		const started = service.start(conversation, { clientId: owner.id, clientKey: "owner-key" }, "intent-1");
		service.attachMedia(conversation, started.media.offerId, "owner-key", mediaPair().sessionSide);
		await service.stop(conversation, { clientId: owner.id, clientKey: "owner-key" }, started.epoch);
		expect(live().lifecycle).toBe("off");
		await until(() => provider.sessions.length === 1 && provider.current.closed, "late session closed");
	});
});
