/**
 * The headless WebRTC media engine for the spike: one Opus audio
 * transceiver on a werift peer connection, a paced RTP sender fed from
 * 24 kHz PCM frames, and a receiver that decodes remote Opus to PCM and
 * keeps loudness metrics (never the samples) for the report.
 */

import { randomInt } from "node:crypto";
import { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket, useOPUS } from "werift";
import { OPUS_TIMESTAMP_STEP, OpusCodec } from "./opus.ts";
import { FRAME_MS, rms, SAMPLE_RATE } from "./pcm.ts";

const OPUS_PAYLOAD_TYPE = 111;
/** Decoded frames quieter than this are counted as silence (about -54 dBFS). */
export const SILENCE_RMS = 64;
/** A loud frame this long after the previous one starts a new speech onset. */
const ONSET_GAP_MS = 300;

export interface ReceiveStats {
	packets: number;
	bytes: number;
	decodeFailures: number;
	decodedSamples: number;
	nonSilentFrames: number;
	peakRms: number;
	/** Monotonic ms of the first and last non-silent decoded frame. */
	firstNonSilentAt: number | undefined;
	lastNonSilentAt: number | undefined;
	firstPacketAt: number | undefined;
	lastPacketAt: number | undefined;
}

export interface SendStats {
	packets: number;
	bytes: number;
	frames: number;
}

export interface MediaEngineEvents {
	/** A decoded remote frame; `loud` reflects {@link SILENCE_RMS}. */
	onRemoteFrame?: (info: { at: number; rms: number; loud: boolean }) => void;
	onConnectionState?: (state: string) => void;
}

export class MediaEngine {
	readonly peer: RTCPeerConnection;
	private readonly localTrack: MediaStreamTrack;
	private readonly codec = new OpusCodec();
	private readonly events: MediaEngineEvents;
	private sequence = randomInt(0, 0x10000);
	private timestamp = randomInt(0, 0x7fffffff);
	private markNext = true;
	private remoteTrack: MediaStreamTrack | undefined;
	private readonly remoteTrackReady = Promise.withResolvers<MediaStreamTrack>();
	private readonly connected = Promise.withResolvers<void>();
	private sender: Promise<void> = Promise.resolve();
	private sendAbort: AbortController | undefined;
	readonly receive: ReceiveStats = {
		packets: 0,
		bytes: 0,
		decodeFailures: 0,
		decodedSamples: 0,
		nonSilentFrames: 0,
		peakRms: 0,
		firstNonSilentAt: undefined,
		lastNonSilentAt: undefined,
		firstPacketAt: undefined,
		lastPacketAt: undefined,
	};
	readonly send: SendStats = { packets: 0, bytes: 0, frames: 0 };
	/** Monotonic ms at which remote speech started after a gap of {@link ONSET_GAP_MS}. */
	readonly loudOnsets: number[] = [];

	/** Ms from `at` to the first speech onset after it, if any yet. */
	firstLoudAfter(at: number): number | undefined {
		const onset = this.loudOnsets.find((time) => time >= at);
		return onset === undefined ? undefined : Math.round(onset - at);
	}

	constructor(events: MediaEngineEvents = {}) {
		this.events = events;
		this.peer = new RTCPeerConnection({
			codecs: { audio: [useOPUS({ payloadType: OPUS_PAYLOAD_TYPE, channels: 2 })], video: [] },
			iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
			iceUseIpv6: false,
			bundlePolicy: "max-bundle",
		});
		this.localTrack = new MediaStreamTrack({ kind: "audio" });
		this.peer.addTransceiver(this.localTrack, { direction: "sendrecv" });
		this.peer.onTrack.subscribe((track) => {
			if (track.kind !== "audio" || this.remoteTrack) return;
			this.remoteTrack = track;
			track.onReceiveRtp.subscribe((rtp) => this.onRemoteRtp(rtp));
			this.remoteTrackReady.resolve(track);
		});
		this.peer.connectionStateChange.subscribe((state) => {
			this.events.onConnectionState?.(state);
			if (state === "connected") this.connected.resolve();
			if (state === "failed" || state === "closed") {
				this.connected.reject(new Error(`peer connection ${state}`));
			}
		});
		// Avoid an unhandled rejection when the connection never completes and nobody awaits it.
		this.connected.promise.catch(() => undefined);
	}

	/** Create the offer and gather candidates (werift resolves setLocalDescription after gathering). */
	async createOffer(): Promise<string> {
		const offer = await this.peer.createOffer();
		await this.peer.setLocalDescription(offer);
		const sdp = this.peer.localDescription?.sdp;
		if (!sdp) throw new Error("no local description after setLocalDescription");
		return sdp;
	}

	async acceptAnswer(sdp: string): Promise<void> {
		await this.peer.setRemoteDescription({ type: "answer", sdp });
	}

	async waitConnected(timeoutMs: number): Promise<void> {
		await withTimeout(this.connected.promise, timeoutMs, "peer connection did not reach connected");
	}

	async waitRemoteTrack(timeoutMs: number): Promise<void> {
		await withTimeout(this.remoteTrackReady.promise, timeoutMs, "no remote audio track was negotiated");
	}

	/** Candidate summary for the report: types only, no addresses. */
	localCandidateTypes(): string[] {
		const sdp = this.peer.localDescription?.sdp ?? "";
		return [...new Set([...sdp.matchAll(/ typ (\w+)/g)].map((match) => match[1] ?? ""))].sort();
	}

	remoteCandidateTypes(): string[] {
		const sdp = this.peer.remoteDescription?.sdp ?? "";
		return [...new Set([...sdp.matchAll(/ typ (\w+)/g)].map((match) => match[1] ?? ""))].sort();
	}

	negotiatedCodec(): string | undefined {
		const codec = this.peer.getTransceivers()[0]?.sender.codec;
		return codec ? `${codec.mimeType}/${codec.clockRate}/${codec.channels ?? 1} pt=${codec.payloadType}` : undefined;
	}

	/**
	 * Send PCM frames at real-time pace (20 ms each). Resolves when every
	 * frame was handed to the sender. Frames queued behind an earlier call
	 * follow it; `abortSending` drops what has not been sent yet.
	 */
	sendFrames(frames: readonly Int16Array[]): Promise<void> {
		const abort = new AbortController();
		this.sendAbort = abort;
		const run = async () => {
			const start = performance.now();
			for (let index = 0; index < frames.length; index++) {
				if (abort.signal.aborted) return;
				const frame = frames[index];
				if (!frame) continue;
				const payload = this.codec.encodeFrame(frame);
				const header = new RtpHeader({
					payloadType: OPUS_PAYLOAD_TYPE,
					sequenceNumber: this.sequence,
					timestamp: this.timestamp,
					marker: this.markNext,
					ssrc: 0,
				});
				this.markNext = false;
				this.sequence = (this.sequence + 1) & 0xffff;
				this.timestamp = (this.timestamp + OPUS_TIMESTAMP_STEP) >>> 0;
				this.localTrack.writeRtp(new RtpPacket(header, payload));
				this.send.packets += 1;
				this.send.bytes += payload.length;
				this.send.frames += 1;
				const due = start + (index + 1) * FRAME_MS;
				const wait = due - performance.now();
				if (wait > 0) await sleep(wait, abort.signal);
			}
		};
		this.sender = this.sender.then(run, run);
		return this.sender;
	}

	abortSending(): void {
		this.sendAbort?.abort();
		this.markNext = true;
	}

	private onRemoteRtp(rtp: RtpPacket): void {
		const at = performance.now();
		this.receive.packets += 1;
		this.receive.bytes += rtp.payload.length;
		this.receive.firstPacketAt ??= at;
		this.receive.lastPacketAt = at;
		const decoded = this.codec.decodePacket(rtp.payload);
		if (!decoded) {
			this.receive.decodeFailures += 1;
			return;
		}
		this.receive.decodedSamples += decoded.length;
		const level = rms(decoded);
		const loud = level >= SILENCE_RMS;
		if (level > this.receive.peakRms) this.receive.peakRms = level;
		if (loud) {
			this.receive.nonSilentFrames += 1;
			this.receive.firstNonSilentAt ??= at;
			const previous = this.receive.lastNonSilentAt;
			if (previous === undefined || at - previous > ONSET_GAP_MS) this.loudOnsets.push(at);
			this.receive.lastNonSilentAt = at;
		}
		this.events.onRemoteFrame?.({ at, rms: level, loud });
	}

	receivedSeconds(): number {
		return this.receive.decodedSamples / SAMPLE_RATE;
	}

	async close(): Promise<void> {
		this.abortSending();
		await this.sender.catch(() => undefined);
		this.localTrack.stop();
		await this.peer.close();
		this.codec.close();
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${message} within ${ms} ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
