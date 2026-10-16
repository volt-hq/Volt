/**
 * The headless voice fixture client (docs/daemon-voice-design.md,
 * milestones 2 and 3): what a TUI or app does on the control plane and the
 * media plane, without a microphone or speaker. It starts voice with the
 * `voice_start` intent on its conversation stream, attaches media through
 * the daemon's `voice_media_open` relay (a TUI) or a `voiceMedia` Iroh
 * stream (a paired device), frames PCM into envelopes, and decodes what it
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
import type { IrohBiStreamLike } from "../../src/core/protocol/transport/iroh-transport.ts";
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

/** A paired device's media stream, after its `voiceMedia` handshake succeeded. */
export interface IrohVoiceMedia {
	readonly received: VoiceEnvelope[];
	/** Settles once the host ended the stream, or it failed. */
	readonly ended: Promise<void>;
	/** Send one PCM frame (a flat tone when omitted) with the next sequence; resolves once written. */
	sendFrame(frame?: Int16Array): Promise<void>;
	/** Stop reading what the host sends, as a device whose network stalled does. */
	pauseReading(): void;
	close(): Promise<void>;
}

/** The media client on `stream` for `epoch`; `rest` holds bytes read past the handshake response. */
export function irohVoiceMedia(stream: IrohBiStreamLike, rest: Uint8Array, epoch: number): IrohVoiceMedia {
	const decoder = new VoiceEnvelopeDecoder();
	const received: VoiceEnvelope[] = [];
	const ended = Promise.withResolvers<void>();
	let paused = false;
	const take = (bytes: Uint8Array | number[]) => {
		try {
			received.push(...decoder.push(Buffer.from(bytes)));
		} catch {
			// A malformed host envelope would be a host bug; tests inspect `received`.
		}
	};
	if (rest.length > 0) take(rest);
	void (async () => {
		try {
			while (!paused) {
				const chunk = await stream.recv.read(64 * 1024);
				// The end of the stream reads as nothing or as an empty chunk.
				if (!chunk || chunk.length === 0) break;
				if (!paused) take(chunk);
			}
		} catch {
			// A reset is an end too.
		}
		if (!paused) ended.resolve();
	})();
	let writes: Promise<void> = Promise.resolve();
	let sequence = 0;
	let samples = 0;
	const tone = new Int16Array(VOICE_FRAME_SAMPLES).fill(1234);
	return {
		received,
		ended: ended.promise,
		sendFrame(frame = tone) {
			const bytes = encodeVoiceEnvelope({
				kind: VOICE_ENVELOPE_KINDS.audio,
				epoch,
				sequence,
				sampleOffset: samples,
				payload: frameToPayload(frame),
			});
			sequence += 1;
			samples += frame.length;
			writes = writes.then(() => stream.send.writeAll(Array.from(bytes)));
			return writes;
		},
		pauseReading() {
			paused = true;
		},
		async close() {
			await Promise.resolve(stream.send.finish?.()).catch(() => undefined);
			await Promise.resolve(stream.recv.stop?.(0n)).catch(() => undefined);
		},
	};
}
