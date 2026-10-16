/**
 * The headless voice fixture client (docs/daemon-voice-design.md, milestone
 * 2): what a TUI or app does on the control plane and the media plane,
 * without a microphone or speaker. It starts voice with the `voice_start`
 * intent on its conversation stream, attaches media through the daemon's
 * `voice_media_open` relay, frames PCM into envelopes, and decodes what it
 * receives.
 */

import type { Duplex } from "node:stream";
import {
	type LiveVoiceValue,
	VOICE_ENVELOPE_KINDS,
	VOICE_FRAME_SAMPLES,
	type VoiceStartOutput,
} from "@hansjm10/volt-protocol";
import type { ProtocolClient } from "../../src/client/protocol-client.ts";
import {
	encodeVoiceEnvelope,
	frameToPayload,
	type VoiceEnvelope,
	VoiceEnvelopeDecoder,
} from "../../src/core/voice/media-envelope.ts";
import type { DaemonClient } from "../../src/daemon/control-client.ts";

export interface VoiceMediaAttachment {
	readonly stream: Duplex;
	readonly received: VoiceEnvelope[];
	/** Send one PCM frame (480 samples; a flat tone when omitted) with the next sequence. */
	sendFrame(frame?: Int16Array): void;
	sendMute(): void;
	sendUnmute(): void;
	/** Write raw bytes, for malformed input. */
	sendRaw(bytes: Buffer): void;
	close(): void;
}

/** The live `voice` value the client sees, if any. */
export function voiceValue(client: ProtocolClient): LiveVoiceValue | undefined {
	const value = client.live.values.get("voice");
	return value?.kind === "voice" ? value : undefined;
}

export async function untilVoice(
	client: ProtocolClient,
	predicate: (value: LiveVoiceValue) => boolean,
	what: string,
	timeoutMs = 10_000,
): Promise<LiveVoiceValue> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = voiceValue(client);
		if (value && predicate(value)) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; voice is ${JSON.stringify(value)}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** `voice_start` on the client's conversation: the epoch and the media offer. */
export async function startVoice(client: ProtocolClient, intentId?: string): Promise<VoiceStartOutput> {
	const accepted = await client.intent("voice_start", {}, intentId === undefined ? {} : { intentId });
	const result = accepted.result as VoiceStartOutput | undefined;
	if (!result) throw new Error("voice_start answered without a result");
	return result;
}

/**
 * Attach media for `offer` through the daemon: `voice_media_open` on the
 * TUI's control connection, then the relay it answers, dialed as a
 * conversation relay is.
 */
export async function attachVoiceMedia(
	tui: DaemonClient,
	options: { sessionId: string; clientKey: string; offerId: string; epoch: number },
): Promise<VoiceMediaAttachment> {
	const response = await tui.request({
		type: "voice_media_open",
		sessionId: options.sessionId,
		clientKey: options.clientKey,
		offerId: options.offerId,
	});
	if (response.type !== "voice_media_opened") {
		throw new Error(`voice_media_open refused: ${JSON.stringify(response)}`);
	}
	const stream = await tui.openConversationRelay({ relayId: response.relayId, relayToken: response.relayToken });
	stream.on("error", () => undefined);
	const decoder = new VoiceEnvelopeDecoder();
	const received: VoiceEnvelope[] = [];
	stream.on("data", (chunk: Buffer) => {
		try {
			received.push(...decoder.push(chunk));
		} catch {
			// A malformed host envelope would be a host bug; tests inspect `received`.
		}
	});
	stream.resume();
	let sequence = 0;
	let samples = 0;
	const tone = new Int16Array(VOICE_FRAME_SAMPLES).fill(1234);
	return {
		stream,
		received,
		sendFrame(frame = tone) {
			stream.write(
				encodeVoiceEnvelope({
					kind: VOICE_ENVELOPE_KINDS.audio,
					epoch: options.epoch,
					sequence,
					sampleOffset: samples,
					payload: frameToPayload(frame),
				}),
			);
			sequence += 1;
			samples += frame.length;
		},
		sendMute() {
			stream.write(
				encodeVoiceEnvelope({
					kind: VOICE_ENVELOPE_KINDS.mute,
					epoch: options.epoch,
					sequence: 0,
					sampleOffset: 0,
					payload: Buffer.alloc(0),
				}),
			);
		},
		sendUnmute() {
			stream.write(
				encodeVoiceEnvelope({
					kind: VOICE_ENVELOPE_KINDS.unmute,
					epoch: options.epoch,
					sequence: 0,
					sampleOffset: 0,
					payload: Buffer.alloc(0),
				}),
			);
		},
		sendRaw(bytes) {
			stream.write(bytes);
		},
		close() {
			stream.destroy();
		},
	};
}
