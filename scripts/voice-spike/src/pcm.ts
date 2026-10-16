/**
 * PCM helpers for the spike: WAV parsing, resampling to the design's
 * application baseline (PCM16 LE, 24 kHz, mono, 20 ms frames), and the
 * loudness metrics the report records instead of audio payloads.
 */

import { readFileSync } from "node:fs";

export const SAMPLE_RATE = 24_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

export interface PcmClip {
	readonly samples: Int16Array;
	readonly sampleRate: number;
}

/** Parse a RIFF/WAVE file with 16-bit PCM samples (any channel count and rate). */
export function readWav(path: string): PcmClip {
	const buffer = readFileSync(path);
	if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error(`${path} is not a RIFF/WAVE file`);
	}
	let offset = 12;
	let channels = 0;
	let sampleRate = 0;
	let bitsPerSample = 0;
	let data: Buffer | undefined;
	while (offset + 8 <= buffer.length) {
		const id = buffer.toString("ascii", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			const format = buffer.readUInt16LE(body);
			if (format !== 1) throw new Error(`${path}: only PCM WAV is supported (format ${format})`);
			channels = buffer.readUInt16LE(body + 2);
			sampleRate = buffer.readUInt32LE(body + 4);
			bitsPerSample = buffer.readUInt16LE(body + 14);
		} else if (id === "data") {
			data = buffer.subarray(body, Math.min(body + size, buffer.length));
		}
		offset = body + size + (size % 2);
	}
	if (!data || channels === 0 || sampleRate === 0) throw new Error(`${path}: missing fmt or data chunk`);
	if (bitsPerSample !== 16) throw new Error(`${path}: only 16-bit PCM is supported (${bitsPerSample}-bit)`);
	const frames = Math.floor(data.length / (2 * channels));
	const mono = new Int16Array(frames);
	for (let i = 0; i < frames; i++) {
		let sum = 0;
		for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
		mono[i] = Math.round(sum / channels);
	}
	return { samples: mono, sampleRate };
}

/** Linear-interpolation resample to 24 kHz. Quality is irrelevant for the feasibility question. */
export function resampleTo24k(clip: PcmClip): Int16Array {
	if (clip.sampleRate === SAMPLE_RATE) return clip.samples;
	const ratio = clip.sampleRate / SAMPLE_RATE;
	const length = Math.floor(clip.samples.length / ratio);
	const out = new Int16Array(length);
	for (let i = 0; i < length; i++) {
		const position = i * ratio;
		const index = Math.floor(position);
		const next = Math.min(index + 1, clip.samples.length - 1);
		const fraction = position - index;
		const a = clip.samples[index] ?? 0;
		const b = clip.samples[next] ?? 0;
		out[i] = Math.round(a + (b - a) * fraction);
	}
	return out;
}

export function sliceMs(samples: Int16Array, startMs: number, endMs: number | undefined): Int16Array {
	const start = Math.max(0, Math.floor((startMs / 1000) * SAMPLE_RATE));
	const end = endMs === undefined ? samples.length : Math.min(samples.length, Math.floor((endMs / 1000) * SAMPLE_RATE));
	return samples.subarray(start, end);
}

/** Split into exact 20 ms frames, zero-padding the tail. */
export function frames(samples: Int16Array): Int16Array[] {
	const out: Int16Array[] = [];
	for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
		const frame = new Int16Array(FRAME_SAMPLES);
		frame.set(samples.subarray(offset, Math.min(offset + FRAME_SAMPLES, samples.length)));
		out.push(frame);
	}
	return out;
}

export function silenceFrames(count: number): Int16Array[] {
	return Array.from({ length: count }, () => new Int16Array(FRAME_SAMPLES));
}

export function rms(samples: Int16Array): number {
	if (samples.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < samples.length; i++) {
		const value = samples[i] ?? 0;
		sum += value * value;
	}
	return Math.sqrt(sum / samples.length);
}

export function toDbfs(value: number): number {
	return value <= 0 ? -Infinity : 20 * Math.log10(value / 32768);
}

export function int16ToBuffer(samples: Int16Array): Buffer {
	return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

export function bufferToInt16(buffer: Buffer): Int16Array {
	const copy = Buffer.from(buffer);
	return new Int16Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 2));
}
