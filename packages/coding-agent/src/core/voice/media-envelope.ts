/**
 * The voice media envelope (`VOICE_ENVELOPE_*` in the protocol package): a
 * 4-byte big-endian length, then kind, epoch, sequence, sample offset, and
 * the payload. The decoder validates the length before it allocates, rejects
 * unknown kinds and malformed audio payloads, and never yields a partial
 * frame; sequence and epoch checks are the consumer's, which knows the epoch.
 */

import {
	VOICE_ENVELOPE_HEADER_BYTES,
	VOICE_ENVELOPE_KINDS,
	VOICE_ENVELOPE_MAX_BYTES,
	VOICE_FRAME_BYTES,
	type VoiceEnvelopeKind,
} from "@hansjm10/volt-protocol";

export interface VoiceEnvelope {
	readonly kind: VoiceEnvelopeKind;
	readonly epoch: number;
	readonly sequence: number;
	readonly sampleOffset: number;
	readonly payload: Buffer;
}

export class VoiceEnvelopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceEnvelopeError";
	}
}

const KINDS: ReadonlySet<number> = new Set(Object.values(VOICE_ENVELOPE_KINDS));
const LENGTH_PREFIX_BYTES = 4;
const UINT32_MAX = 0xffffffff;

function assertUint32(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
		throw new VoiceEnvelopeError(`${name} must be a 32-bit unsigned integer`);
	}
}

/** Encode one envelope. Audio payloads must be exactly one frame. */
export function encodeVoiceEnvelope(envelope: VoiceEnvelope): Buffer {
	if (!KINDS.has(envelope.kind)) throw new VoiceEnvelopeError(`unknown envelope kind ${envelope.kind}`);
	assertUint32(envelope.epoch, "epoch");
	assertUint32(envelope.sequence, "sequence");
	assertUint32(envelope.sampleOffset, "sampleOffset");
	const payload = envelope.payload;
	if (envelope.kind === VOICE_ENVELOPE_KINDS.audio && payload.length !== VOICE_FRAME_BYTES) {
		throw new VoiceEnvelopeError(`audio payload must be ${VOICE_FRAME_BYTES} bytes`);
	}
	if (envelope.kind !== VOICE_ENVELOPE_KINDS.audio && payload.length !== 0) {
		throw new VoiceEnvelopeError("control envelopes carry no payload");
	}
	const length = VOICE_ENVELOPE_HEADER_BYTES + payload.length;
	const out = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES + length);
	out.writeUInt32BE(length, 0);
	out.writeUInt8(envelope.kind, 4);
	out.writeUInt32BE(envelope.epoch, 5);
	out.writeUInt32BE(envelope.sequence, 9);
	out.writeUInt32BE(envelope.sampleOffset, 13);
	payload.copy(out, LENGTH_PREFIX_BYTES + VOICE_ENVELOPE_HEADER_BYTES);
	return out;
}

/**
 * An incremental decoder over a byte stream. `push` returns the complete
 * envelopes the bytes completed, in order; it throws `VoiceEnvelopeError`
 * on the first malformed envelope, after which the stream is unusable.
 * Buffered bytes never exceed one envelope's limit.
 */
export class VoiceEnvelopeDecoder {
	private buffered: Buffer = Buffer.alloc(0);
	private failed = false;

	/** Bytes waiting for the rest of their envelope. */
	get pendingBytes(): number {
		return this.buffered.length;
	}

	push(chunk: Buffer): VoiceEnvelope[] {
		if (this.failed) throw new VoiceEnvelopeError("the envelope stream already failed");
		const out: VoiceEnvelope[] = [];
		let data = this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
		let offset = 0;
		try {
			for (;;) {
				if (data.length - offset < LENGTH_PREFIX_BYTES) break;
				const length = data.readUInt32BE(offset);
				// Validated before any allocation for the body.
				if (length < VOICE_ENVELOPE_HEADER_BYTES || length > VOICE_ENVELOPE_MAX_BYTES) {
					throw new VoiceEnvelopeError(`envelope length ${length} is out of bounds`);
				}
				if (data.length - offset < LENGTH_PREFIX_BYTES + length) break;
				const body = offset + LENGTH_PREFIX_BYTES;
				const kind = data.readUInt8(body);
				if (!KINDS.has(kind)) throw new VoiceEnvelopeError(`unknown envelope kind ${kind}`);
				const payloadLength = length - VOICE_ENVELOPE_HEADER_BYTES;
				if (kind === VOICE_ENVELOPE_KINDS.audio && payloadLength !== VOICE_FRAME_BYTES) {
					throw new VoiceEnvelopeError(`audio payload of ${payloadLength} bytes is not one frame`);
				}
				if (kind !== VOICE_ENVELOPE_KINDS.audio && payloadLength !== 0) {
					throw new VoiceEnvelopeError("control envelope carries a payload");
				}
				const payloadStart = body + VOICE_ENVELOPE_HEADER_BYTES;
				out.push({
					kind: kind as VoiceEnvelopeKind,
					epoch: data.readUInt32BE(body + 1),
					sequence: data.readUInt32BE(body + 5),
					sampleOffset: data.readUInt32BE(body + 9),
					// A copy: the stream's chunk buffers are reused by the socket.
					payload: Buffer.from(data.subarray(payloadStart, payloadStart + payloadLength)),
				});
				offset = payloadStart + payloadLength;
			}
		} catch (error) {
			this.failed = true;
			this.buffered = Buffer.alloc(0);
			throw error;
		}
		this.buffered = offset === 0 ? data : Buffer.from(data.subarray(offset));
		data = Buffer.alloc(0);
		return out;
	}
}

/** A PCM frame as the envelope carries it. */
export function frameToPayload(frame: Int16Array): Buffer {
	const out = Buffer.allocUnsafe(frame.length * 2);
	for (let i = 0; i < frame.length; i++) out.writeInt16LE(frame[i] ?? 0, i * 2);
	return out;
}

export function payloadToFrame(payload: Buffer): Int16Array {
	const frame = new Int16Array(payload.length / 2);
	for (let i = 0; i < frame.length; i++) frame[i] = payload.readInt16LE(i * 2);
	return frame;
}
