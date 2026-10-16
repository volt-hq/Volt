/**
 * Opt-in real-provider smoke test for daemon-owned voice: the product's
 * `openai-codex` adapter on a real daemon and worker, driven by the
 * headless fixture client with a prerecorded utterance. Separate from CI:
 * it runs only with `VOLT_VOICE_SMOKE_WAV` (a 16-bit PCM WAV) and
 * `VOLT_VOICE_SMOKE_EXPECT` (the words in it) set, uses the saved
 * `openai-codex` credential of `VOLT_VOICE_SMOKE_AUTH` (default
 * `~/.volt/agent/auth.json`, copied, never written), and opens a billed
 * Live session.
 */

import { copyFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { VOICE_ENVELOPE_KINDS, VOICE_FRAME_SAMPLES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { openDaemonConversation } from "../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import { payloadToFrame } from "../src/core/voice/media-envelope.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { attachVoiceMedia, startVoice, untilVoice, voiceValue } from "./suite/voice-fixture-client.ts";

const WAV = process.env.VOLT_VOICE_SMOKE_WAV;
const EXPECT = process.env.VOLT_VOICE_SMOKE_EXPECT;
const AUTH = process.env.VOLT_VOICE_SMOKE_AUTH ?? join(homedir(), ".volt", "agent", "auth.json");
const END_MS =
	process.env.VOLT_VOICE_SMOKE_END_MS === undefined ? undefined : Number(process.env.VOLT_VOICE_SMOKE_END_MS);
const enabled = WAV !== undefined && EXPECT !== undefined;

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 16-bit PCM WAV, any rate or channel count, resampled to 24 kHz mono frames. */
function wavFrames(path: string, endMs: number | undefined): Int16Array[] {
	const buffer = readFileSync(path);
	let offset = 12;
	let channels = 0;
	let rate = 0;
	let data: Buffer | undefined;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		if (id === "fmt ") {
			channels = buffer.readUInt16LE(offset + 10);
			rate = buffer.readUInt32LE(offset + 12);
		} else if (id === "data") {
			data = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
		}
		offset += 8 + size + (size % 2);
	}
	if (!data || channels === 0 || rate === 0) throw new Error(`${path}: not a PCM WAV`);
	const frames = Math.floor(data.length / (2 * channels));
	const mono = new Int16Array(frames);
	for (let i = 0; i < frames; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
		mono[i] = Math.round(sum / channels);
	}
	const ratio = rate / 24_000;
	const length = Math.min(
		Math.floor(mono.length / ratio),
		endMs === undefined ? Number.POSITIVE_INFINITY : Math.floor((endMs / 1000) * 24_000),
	);
	const out: Int16Array[] = [];
	for (let start = 0; start < length; start += VOICE_FRAME_SAMPLES) {
		const frame = new Int16Array(VOICE_FRAME_SAMPLES);
		for (let i = 0; i < VOICE_FRAME_SAMPLES && start + i < length; i++) {
			const position = (start + i) * ratio;
			const index = Math.floor(position);
			const a = mono[index] ?? 0;
			const b = mono[Math.min(index + 1, mono.length - 1)] ?? a;
			frame[i] = Math.round(a + (b - a) * (position - index));
		}
		out.push(frame);
	}
	return out;
}

function rms(frame: Int16Array): number {
	let sum = 0;
	for (const sample of frame) sum += sample * sample;
	return Math.sqrt(sum / frame.length);
}

function tokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

describe.skipIf(!enabled)("voice smoke test against the openai-codex provider", () => {
	it("hears a prerecorded utterance as a literal user message and speaks the assistant's reply", async () => {
		const before = statSync(AUTH);
		const harness: DaemonHarness = await createDaemonHarness({
			settings: { voice: { enabled: true, provider: "openai-codex" } },
		});
		cleanups.push(() => harness.dispose());
		copyFileSync(AUTH, join(harness.agentDir, "auth.json"));
		harness.faux.setResponses([fauxAssistantMessage("The smoke test number is forty two.")]);
		const tui = await harness.connect("tui");
		const { opened, transport } = await openDaemonConversation(tui, {
			target: { kind: "new" },
			spawn: { env: {}, config: {}, cwd: harness.workspacePath, persist: true, session: {} },
			clientKey: "smoke-tui",
		});
		const client = new ProtocolClient({ followMoves: "reconnect" });
		cleanups.push(() => client.stop());
		await client.connect(transport);
		await untilVoice(client, (value) => value.availability.available, "voice available", 20_000);

		const started = await startVoice(client);
		const media = await attachVoiceMedia(tui, {
			sessionId: opened.sessionId,
			clientKey: "smoke-tui",
			offerId: started.media.offerId,
			epoch: started.epoch,
		});
		cleanups.push(() => media.close());
		await untilVoice(client, (value) => value.lifecycle === "active", "active", 30_000);

		// Real-time pacing, then silence so turn detection ends the turn.
		const frames = [
			...wavFrames(WAV as string, END_MS),
			...Array.from({ length: 100 }, () => new Int16Array(VOICE_FRAME_SAMPLES)),
		];
		const startedAt = performance.now();
		for (const [index, frame] of frames.entries()) {
			media.sendFrame(frame);
			const due = startedAt + (index + 1) * 20;
			const wait = due - performance.now();
			if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		}
		const userMessage = await (async () => {
			const deadline = Date.now() + 30_000;
			for (;;) {
				const texts = client.state.entries.flatMap((entry) => {
					const message = entry.type === "message" ? entry.payload?.message : undefined;
					if (message?.role !== "user") return [];
					const content = message.content;
					return [
						typeof content === "string"
							? content
							: content.map((block) => ("text" in block ? block.text : "")).join(""),
					];
				});
				if (texts.length > 0) return texts[0] as string;
				if (Date.now() > deadline)
					throw new Error(`no user message; voice is ${JSON.stringify(voiceValue(client))}`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		})();
		const expected = tokens(EXPECT as string);
		const actual = tokens(userMessage);
		let cursor = 0;
		for (const token of expected) {
			const index = actual.indexOf(token, cursor);
			expect(index, `expected "${token}" in the transcribed user message`).toBeGreaterThanOrEqual(0);
			cursor = index + 1;
		}
		await client.waitForIdle(60_000);
		// The assistant's reply was spoken: non-silent audio reached the client.
		await expect
			.poll(
				() =>
					media.received.filter(
						(envelope) =>
							envelope.kind === VOICE_ENVELOPE_KINDS.audio && rms(payloadToFrame(envelope.payload)) > 64,
					).length,
				{ timeout: 30_000 },
			)
			.toBeGreaterThan(10);
		await client.intent("voice_stop", { epoch: started.epoch });
		await untilVoice(client, (value) => value.lifecycle === "off", "off");
		expect(voiceValue(client)?.error).toBeUndefined();
		const after = statSync(AUTH);
		expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({ size: before.size, mtimeMs: before.mtimeMs });
	}, 180_000);
});
