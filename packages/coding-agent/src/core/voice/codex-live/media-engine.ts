/**
 * The headless media engine of the Codex Live adapter: one Opus audio
 * transceiver on a werift peer connection, PCM frames encoded to RTP on
 * the way out, remote RTP decoded to PCM frames on the way in. The engine
 * modules are optional dependencies, loaded through the native adapter;
 * without them the provider reports `native_media_unavailable`.
 */

import { randomInt } from "node:crypto";
import { VOICE_FRAME_SAMPLES, VOICE_MEDIA_FORMAT } from "@hansjm10/volt-protocol";
import type OpusScriptModule from "opusscript";
import type * as Werift from "werift";
import voiceNativeAdapter from "../../../remote/voice-native-adapter.cjs";

const OPUS_PAYLOAD_TYPE = 111;
/** The Opus RTP clock is 48 kHz whatever the sampling rate: 960 ticks per 20 ms. */
const OPUS_TIMESTAMP_STEP = 960;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

export interface VoiceNativeMedia {
	readonly werift: typeof Werift;
	readonly opusscript: typeof OpusScriptModule;
}

/** The engine modules, or why they did not load; the attempt happens once per process. */
export function loadVoiceNativeMedia(): { media?: VoiceNativeMedia; error?: unknown } {
	const loaded = voiceNativeAdapter.loadVoiceNativeMedia();
	if (!loaded.werift || !loaded.opusscript)
		return { error: loaded.loadError ?? new Error("voice media modules missing") };
	return {
		media: { werift: loaded.werift as typeof Werift, opusscript: loaded.opusscript as typeof OpusScriptModule },
	};
}

export interface MediaEngineOptions {
	readonly media: VoiceNativeMedia;
	/** A decoded remote frame at the application format. */
	readonly onFrame: (frame: Int16Array) => void;
	readonly onConnectionState: (state: string) => void;
}

export class CodexMediaEngine {
	private readonly peer: Werift.RTCPeerConnection;
	private readonly localTrack: Werift.MediaStreamTrack;
	private readonly encoder: OpusScriptModule;
	private readonly decoder: OpusScriptModule;
	private readonly options: MediaEngineOptions;
	private sequence = randomInt(0, 0x10000);
	private timestamp = randomInt(0, 0x7fffffff);
	private markNext = true;
	private remainder = new Int16Array(0);
	private readonly connected = Promise.withResolvers<void>();
	private closed = false;

	constructor(options: MediaEngineOptions) {
		this.options = options;
		const { werift, opusscript } = options.media;
		this.encoder = new opusscript(VOICE_MEDIA_FORMAT.sampleRate, 1, opusscript.Application.VOIP);
		this.encoder.setBitrate(32_000);
		this.decoder = new opusscript(VOICE_MEDIA_FORMAT.sampleRate, 1, opusscript.Application.VOIP);
		this.peer = new werift.RTCPeerConnection({
			codecs: { audio: [werift.useOPUS({ payloadType: OPUS_PAYLOAD_TYPE, channels: 2 })], video: [] },
			iceServers: ICE_SERVERS,
			iceUseIpv6: false,
			bundlePolicy: "max-bundle",
		});
		this.localTrack = new werift.MediaStreamTrack({ kind: "audio" });
		this.peer.addTransceiver(this.localTrack, { direction: "sendrecv" });
		this.peer.onTrack.subscribe((track) => {
			if (track.kind !== "audio") return;
			track.onReceiveRtp.subscribe((rtp) => this.onRemoteRtp(rtp));
		});
		this.peer.connectionStateChange.subscribe((state) => {
			options.onConnectionState(state);
			if (state === "connected") this.connected.resolve();
			if (state === "failed" || state === "closed") this.connected.reject(new Error(`peer connection ${state}`));
		});
		this.connected.promise.catch(() => undefined);
	}

	/** The offer, with candidates gathered. */
	async createOffer(): Promise<string> {
		const offer = await this.peer.createOffer();
		await this.peer.setLocalDescription(offer);
		const sdp = this.peer.localDescription?.sdp;
		if (!sdp) throw new Error("no local description");
		return sdp;
	}

	async acceptAnswer(sdp: string): Promise<void> {
		await this.peer.setRemoteDescription({ type: "answer", sdp });
	}

	waitConnected(timeoutMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		return Promise.race([
			this.connected.promise,
			new Promise<void>((_, reject) => {
				timer = setTimeout(() => reject(new Error("peer connection timed out")), timeoutMs);
			}),
		]).finally(() => clearTimeout(timer));
	}

	/** One 20 ms PCM frame to the provider, now. */
	sendFrame(frame: Int16Array): void {
		if (this.closed || frame.length !== VOICE_FRAME_SAMPLES) return;
		const payload = this.encoder.encode(
			Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength),
			VOICE_FRAME_SAMPLES,
		);
		const { werift } = this.options.media;
		const header = new werift.RtpHeader({
			payloadType: OPUS_PAYLOAD_TYPE,
			sequenceNumber: this.sequence,
			timestamp: this.timestamp,
			marker: this.markNext,
			ssrc: 0,
		});
		this.markNext = false;
		this.sequence = (this.sequence + 1) & 0xffff;
		this.timestamp = (this.timestamp + OPUS_TIMESTAMP_STEP) >>> 0;
		this.localTrack.writeRtp(new werift.RtpPacket(header, payload));
	}

	/** A pause in input: the next frame marks a new talkspurt. */
	markDiscontinuity(): void {
		this.markNext = true;
	}

	private onRemoteRtp(rtp: Werift.RtpPacket): void {
		if (this.closed) return;
		let decoded: Buffer;
		try {
			decoded = this.decoder.decode(rtp.payload);
		} catch {
			return;
		}
		const samples = new Int16Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength));
		// Packets may carry more than one application frame; carry the remainder over.
		const joined = new Int16Array(this.remainder.length + samples.length);
		joined.set(this.remainder);
		joined.set(samples, this.remainder.length);
		let offset = 0;
		while (joined.length - offset >= VOICE_FRAME_SAMPLES) {
			this.options.onFrame(joined.slice(offset, offset + VOICE_FRAME_SAMPLES));
			offset += VOICE_FRAME_SAMPLES;
		}
		this.remainder = joined.slice(offset);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.localTrack.stop();
		await this.peer.close();
		this.encoder.delete();
		this.decoder.delete();
	}
}
