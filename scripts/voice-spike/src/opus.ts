/**
 * Opus encode/decode at the 24 kHz mono application boundary. The RTP clock
 * for Opus is always 48 kHz, so one 20 ms frame advances the RTP timestamp
 * by 960 regardless of the sampling rate the encoder runs at.
 */

import OpusScript from "opusscript";
import { bufferToInt16, FRAME_SAMPLES, int16ToBuffer, SAMPLE_RATE } from "./pcm.ts";

export const OPUS_RTP_CLOCK_RATE = 48_000;
export const OPUS_TIMESTAMP_STEP = (OPUS_RTP_CLOCK_RATE * 20) / 1000;

export class OpusCodec {
	private readonly encoder: OpusScript;
	private readonly decoder: OpusScript;

	constructor() {
		this.encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
		this.encoder.setBitrate(32_000);
		this.decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
	}

	encodeFrame(frame: Int16Array): Buffer {
		if (frame.length !== FRAME_SAMPLES) throw new Error(`Opus frame must be ${FRAME_SAMPLES} samples`);
		return this.encoder.encode(int16ToBuffer(frame), FRAME_SAMPLES);
	}

	/** Returns undefined for a packet the decoder rejects (counted by the caller, never thrown mid-stream). */
	decodePacket(packet: Buffer): Int16Array | undefined {
		try {
			return bufferToInt16(this.decoder.decode(packet));
		} catch {
			return undefined;
		}
	}

	close(): void {
		this.encoder.delete();
		this.decoder.delete();
	}
}
