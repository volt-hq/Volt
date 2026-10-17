/**
 * A client's end of conversation voice (docs/daemon-voice-design.md,
 * milestone 4): what a TUI does with its microphone and speaker on the
 * control and media planes the host serves. `start()` sends `voice_start`
 * on the client's conversation, attaches media for the offer it answers,
 * and starts capturing; frames go up as envelopes of the voice epoch, and
 * audio coming down plays unless its playback epoch was retired.
 *
 * - Mute stops the capture (the microphone is off, not merely unsent) and
 *   tells the host, which pauses its stall detector; unmute starts it again
 *   and tells the host with the new capture's first frame, so a tool that
 *   takes a while to start cannot read as stalled input.
 * - Interruption drops what the speaker holds at once and discards audio of
 *   the interrupted playback epoch until the host's next one; the agent's
 *   work is untouched.
 * - Half duplex, for a client without echo cancellation, sends silence
 *   instead of the microphone while the speaker plays and shortly after, so
 *   voice never hears itself; it is interrupted by key, not by talking.
 * - Voice ends once: stopped here, a local audio failure (which stops it on
 *   the host), the host ending the epoch (its live `voice` value says why),
 *   the media stream ending, or the client leaving the conversation.
 *   Nothing restarts it: a new start is a new epoch with fresh audio.
 *
 * Queues are bounded per direction: microphone frames the media stream
 * cannot take are dropped, and the speaker's tool drops what it cannot.
 * Microphone frames faster than real time beyond a burst of half the host's
 * allowance (a tool's startup backlog) are dropped as stale, so the client
 * never trips the host's overrun check.
 */

import type { Duplex } from "node:stream";
import {
	type LiveVoiceValue,
	VOICE_ENVELOPE_HEADER_BYTES,
	VOICE_ENVELOPE_KINDS,
	VOICE_FRAME_BYTES,
	VOICE_FRAME_SAMPLES,
	VOICE_FRAMES_PER_SECOND,
	VOICE_LIMITS,
	VOICE_MEDIA_FORMAT,
	type VoiceStartOutput,
} from "@hansjm10/volt-protocol";
import { FrameRateLimiter } from "../../core/voice/bounded.ts";
import { encodeVoiceEnvelope, type VoiceEnvelope, VoiceEnvelopeDecoder } from "../../core/voice/media-envelope.ts";
import type { ProtocolClient } from "../protocol-client.ts";
import type { VoiceAudio, VoiceCapture, VoicePlayback } from "./audio-tools.ts";

/** `half`: the microphone is silent while voice speaks; `full`: always open, for headphones or OS echo cancellation. */
export type VoiceDuplex = "half" | "full";

/** How long after it should have finished playing the microphone stays silent in half duplex: device latency and room echo. */
export const VOICE_ECHO_TAIL_MS = 400;
/** How long the client waits for the host to say why media ended before it says so itself. */
const END_REASON_WAIT_MS = 1_500;
const FRAME_MS = VOICE_MEDIA_FORMAT.frameMs;
/** An audio envelope on the wire: its length prefix, header, and frame. */
const ENVELOPE_BYTES = 4 + VOICE_ENVELOPE_HEADER_BYTES + VOICE_FRAME_BYTES;
/** Microphone audio the media stream may hold before frames are dropped. */
const UPLINK_QUEUE_BYTES = (VOICE_LIMITS.queuedAudioMs / FRAME_MS) * ENVELOPE_BYTES;
const SILENCE = Buffer.alloc(VOICE_FRAME_BYTES);
/** How far ahead of real time the microphone may run: half of what the host admits. */
const UPLINK_BURST_MS = VOICE_LIMITS.queuedAudioMs / 2;

export class VoiceClientError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VoiceClientError";
	}
}

export interface VoiceClientOptions {
	readonly client: ProtocolClient;
	/** The media stream for `offerId`, on the client's own attachment to its host. */
	readonly openMedia: (offerId: string) => Promise<Duplex>;
	readonly audio: VoiceAudio;
	readonly duplex: VoiceDuplex;
	/** What the client shows changed: voice started, ended, muted, or began or stopped playing. */
	readonly onChange?: () => void;
	/** Voice ended, once per start: why, or undefined when this client stopped it. */
	readonly onEnded?: (reason: string | undefined) => void;
	readonly now?: () => number;
}

/** Safe counters: no audio, no transcript. */
export interface VoiceClientDiagnostics {
	framesSent: number;
	framesSilenced: number;
	framesDroppedUp: number;
	framesPlayed: number;
	framesDroppedDown: number;
}

interface Running {
	readonly epoch: number;
	readonly stream: Duplex;
	readonly playback: VoicePlayback;
	capture: VoiceCapture | undefined;
	muted: boolean;
	/** The host still thinks input muted: the next frame goes after an `unmute`. */
	unmutePending: boolean;
	/** Frames of the current capture beyond real time and its burst are stale. */
	pace: FrameRateLimiter;
	/** The next audio envelope's sequence and first sample. */
	sequence: number;
	samples: number;
	/** The newest playback epoch the host announced or sent audio of. */
	heardEpoch: number;
	/** Audio of earlier playback epochs is stale: retired by an interruption or the host. */
	playableFrom: number;
	/** When what the speaker was given should have finished playing. */
	playingUntil: number;
	/** The audio stopped; voice may still wait for the host to say why. */
	closed: boolean;
	notified: boolean;
	endTimer: NodeJS.Timeout | undefined;
	readonly diagnostics: VoiceClientDiagnostics;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class VoiceClient {
	private readonly options: VoiceClientOptions;
	private readonly now: () => number;
	private running: Running | undefined;
	private starting = false;
	private disposed = false;
	private speakingTimer: NodeJS.Timeout | undefined;

	constructor(options: VoiceClientOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** `starting` until media is attached and the microphone opened, then `on` until voice ends. */
	get state(): "off" | "starting" | "on" {
		if (this.starting) return "starting";
		return this.running && !this.running.closed ? "on" : "off";
	}

	get muted(): boolean {
		return this.running?.closed === false && this.running.muted;
	}

	/** Whether the speaker should still be playing what it was given. */
	get playing(): boolean {
		const running = this.live();
		return running !== undefined && this.now() < running.playingUntil;
	}

	/** The epoch voice runs in, while it runs. */
	get epoch(): number | undefined {
		return this.live()?.epoch;
	}

	get diagnostics(): VoiceClientDiagnostics | undefined {
		return this.running ? { ...this.running.diagnostics } : undefined;
	}

	private live(): Running | undefined {
		return this.running && !this.running.closed ? this.running : undefined;
	}

	private changed(): void {
		this.options.onChange?.();
	}

	/**
	 * Start voice: `voice_start`, the media attachment, then the microphone.
	 * Rejects with `VoiceClientError` saying why it could not; the host's
	 * session of a start that failed after it was accepted is stopped.
	 */
	async start(): Promise<void> {
		if (this.disposed) throw new VoiceClientError("Voice is not available here anymore");
		if (this.state !== "off") throw new VoiceClientError("Voice is already on");
		this.flushEnding("Voice was started again");
		this.starting = true;
		this.changed();
		try {
			let output: VoiceStartOutput | undefined;
			try {
				output = (await this.options.client.intent("voice_start", {})).result as VoiceStartOutput | undefined;
			} catch (error) {
				throw new VoiceClientError(errorText(error), { cause: error });
			}
			const format = output?.media.format;
			if (
				output === undefined ||
				format?.encoding !== VOICE_MEDIA_FORMAT.encoding ||
				format.sampleRate !== VOICE_MEDIA_FORMAT.sampleRate ||
				format.channels !== VOICE_MEDIA_FORMAT.channels ||
				format.frameMs !== VOICE_MEDIA_FORMAT.frameMs
			) {
				this.stopOnHost(output?.epoch);
				throw new VoiceClientError("The host offered voice media in a format this client does not play");
			}
			let stream: Duplex;
			try {
				stream = await this.options.openMedia(output.media.offerId);
			} catch (error) {
				this.stopOnHost(output.epoch);
				throw new VoiceClientError(`Could not attach voice media: ${errorText(error)}`, { cause: error });
			}
			if (this.disposed) {
				stream.destroy();
				this.stopOnHost(output.epoch);
				throw new VoiceClientError("Voice is not available here anymore");
			}
			this.run(output.epoch, stream);
		} finally {
			this.starting = false;
			this.changed();
		}
	}

	private run(epoch: number, stream: Duplex): void {
		const running: Running = {
			epoch,
			stream,
			playback: this.options.audio.openPlayback({
				onFailure: (message) => this.fail(running, `Speaker: ${message}`),
			}),
			capture: undefined,
			muted: false,
			unmutePending: false,
			pace: new FrameRateLimiter(VOICE_FRAMES_PER_SECOND, UPLINK_BURST_MS, this.now()),
			sequence: 0,
			samples: 0,
			heardEpoch: 0,
			playableFrom: 0,
			playingUntil: 0,
			closed: false,
			notified: false,
			endTimer: undefined,
			diagnostics: { framesSent: 0, framesSilenced: 0, framesDroppedUp: 0, framesPlayed: 0, framesDroppedDown: 0 },
		};
		this.running = running;
		const decoder = new VoiceEnvelopeDecoder();
		stream.on("data", (chunk: Buffer) => {
			if (running.closed) return;
			let envelopes: VoiceEnvelope[];
			try {
				envelopes = decoder.push(chunk);
			} catch {
				this.fail(running, "The host sent malformed voice media");
				return;
			}
			for (const envelope of envelopes) this.receive(running, envelope);
		});
		const onEnd = () => this.mediaEnded(running);
		stream.on("end", onEnd);
		stream.on("close", onEnd);
		stream.on("error", onEnd);
		stream.resume();
		this.openCapture(running);
	}

	private openCapture(running: Running): void {
		running.pace = new FrameRateLimiter(VOICE_FRAMES_PER_SECOND, UPLINK_BURST_MS, this.now());
		running.capture = this.options.audio.openCapture({
			onFrame: (frame) => this.send(running, frame),
			onFailure: (message) => this.fail(running, `Microphone: ${message}`),
		});
	}

	private send(running: Running, frame: Buffer): void {
		if (running.closed || running.muted) return;
		if (running.stream.writableLength > UPLINK_QUEUE_BYTES || !running.pace.admit(this.now())) {
			running.diagnostics.framesDroppedUp += 1;
			return;
		}
		if (running.unmutePending) {
			running.unmutePending = false;
			this.write(running, this.control(running, VOICE_ENVELOPE_KINDS.unmute));
		}
		const silenced = this.options.duplex === "half" && this.now() < running.playingUntil + VOICE_ECHO_TAIL_MS;
		if (silenced) running.diagnostics.framesSilenced += 1;
		this.write(running, {
			kind: VOICE_ENVELOPE_KINDS.audio,
			epoch: running.epoch,
			sequence: running.sequence,
			sampleOffset: running.samples,
			payload: silenced ? SILENCE : frame,
		});
		running.sequence = (running.sequence + 1) >>> 0;
		running.samples = (running.samples + VOICE_FRAME_SAMPLES) >>> 0;
		running.diagnostics.framesSent += 1;
	}

	private control(running: Running, kind: typeof VOICE_ENVELOPE_KINDS.mute | typeof VOICE_ENVELOPE_KINDS.unmute) {
		return { kind, epoch: running.epoch, sequence: 0, sampleOffset: 0, payload: Buffer.alloc(0) };
	}

	private write(running: Running, envelope: VoiceEnvelope): void {
		try {
			running.stream.write(encodeVoiceEnvelope(envelope));
		} catch {
			this.mediaEnded(running);
		}
	}

	private receive(running: Running, envelope: VoiceEnvelope): void {
		if (running.closed) return;
		if (envelope.kind === VOICE_ENVELOPE_KINDS.playback_epoch) {
			if (envelope.epoch < running.heardEpoch) return;
			running.heardEpoch = envelope.epoch;
			running.playableFrom = envelope.epoch;
			this.silenceSpeaker(running);
			return;
		}
		if (envelope.kind !== VOICE_ENVELOPE_KINDS.audio) return;
		if (envelope.epoch < running.playableFrom) {
			running.diagnostics.framesDroppedDown += 1;
			return;
		}
		running.heardEpoch = Math.max(running.heardEpoch, envelope.epoch);
		if (!running.playback.write(envelope.payload)) {
			running.diagnostics.framesDroppedDown += 1;
			return;
		}
		running.diagnostics.framesPlayed += 1;
		const wasPlaying = this.now() < running.playingUntil;
		running.playingUntil = Math.max(this.now(), running.playingUntil) + FRAME_MS;
		this.scheduleSpeakingEnd(running);
		if (!wasPlaying) this.changed();
	}

	/** Tell the client once the speaker should have finished what it was given. */
	private scheduleSpeakingEnd(running: Running): void {
		if (this.speakingTimer) clearTimeout(this.speakingTimer);
		this.speakingTimer = setTimeout(
			() => {
				this.speakingTimer = undefined;
				if (this.running === running && !running.closed) this.changed();
			},
			Math.max(0, running.playingUntil - this.now()) + 1,
		);
		this.speakingTimer.unref?.();
	}

	private silenceSpeaker(running: Running): void {
		running.playback.flush();
		const wasPlaying = this.now() < running.playingUntil;
		running.playingUntil = Math.min(running.playingUntil, this.now());
		if (wasPlaying) this.changed();
	}

	/** Mute or unmute the microphone. False when voice is not on. */
	setMuted(muted: boolean): boolean {
		const running = this.live();
		if (!running) return false;
		if (running.muted === muted) return true;
		running.muted = muted;
		if (muted) {
			running.capture?.stop();
			running.capture = undefined;
			// Muted again before the new capture spoke: the host never heard the unmute.
			if (running.unmutePending) running.unmutePending = false;
			else this.write(running, this.control(running, VOICE_ENVELOPE_KINDS.mute));
		} else {
			running.unmutePending = true;
			this.openCapture(running);
		}
		this.changed();
		return true;
	}

	/**
	 * Stop what voice is saying: the speaker drops it at once, audio of the
	 * playback epoch it belonged to is discarded, and the host is asked to
	 * advance its playback epoch. False when voice is not on.
	 */
	interrupt(): boolean {
		const running = this.live();
		if (!running) return false;
		running.playableFrom = Math.max(running.playableFrom, running.heardEpoch + 1);
		this.silenceSpeaker(running);
		void this.options.client.intent("voice_interrupt", { epoch: running.epoch }).catch(() => undefined);
		return true;
	}

	/** Stop voice: the audio at once, then the host's epoch. Resolves once the host answered. */
	async stop(): Promise<void> {
		const running = this.live();
		if (!running) return;
		this.finish(running, undefined);
		await this.options.client.intent("voice_stop", { epoch: running.epoch }).catch(() => undefined);
	}

	/**
	 * The conversation's live `voice` value changed: when the host ended this
	 * client's epoch (or started a later one), voice ends with its reason.
	 */
	observe(value: LiveVoiceValue | undefined): void {
		const running = this.running;
		if (!running || running.notified || value === undefined) return;
		const ended = value.epoch > running.epoch || (value.epoch === running.epoch && value.lifecycle === "stopping");
		const off = value.epoch === running.epoch && value.lifecycle === "off";
		if (!ended && !off) return;
		// A stop without a reason that this client did not ask for is still an end it reports.
		this.finish(running, value.error?.message ?? "Voice stopped on the host");
	}

	/** The client leaves the conversation: its voice ends here; the host ends its epoch as the client detaches. */
	dispose(reason = "Voice ended with the conversation"): void {
		this.disposed = true;
		const running = this.running;
		if (running) this.finish(running, reason);
	}

	/** A local failure: voice ends with it here and on the host. */
	private fail(running: Running, message: string): void {
		if (running.notified) return;
		this.finish(running, message);
		this.stopOnHost(running.epoch);
	}

	private stopOnHost(epoch: number | undefined): void {
		if (epoch === undefined) return;
		void this.options.client.intent("voice_stop", { epoch }).catch(() => undefined);
	}

	/** The media stream ended: the audio stops now; why is the host's to say, shortly. */
	private mediaEnded(running: Running): void {
		if (running.closed) return;
		this.close(running);
		running.endTimer = setTimeout(() => this.finish(running, "The voice media stream ended"), END_REASON_WAIT_MS);
		running.endTimer.unref?.();
		this.observe(this.voiceValue());
	}

	private voiceValue(): LiveVoiceValue | undefined {
		const value = this.options.client.live.values.get("voice");
		return value?.kind === "voice" ? value : undefined;
	}

	/** An earlier start still waiting for its reason reports what it knows now. */
	private flushEnding(reason: string): void {
		const running = this.running;
		if (running?.closed && !running.notified) this.finish(running, reason);
	}

	private close(running: Running): void {
		if (running.closed) return;
		running.closed = true;
		running.capture?.stop();
		running.capture = undefined;
		running.playback.close();
		running.stream.destroy();
		if (this.speakingTimer) clearTimeout(this.speakingTimer);
		this.speakingTimer = undefined;
		this.changed();
	}

	private finish(running: Running, reason: string | undefined): void {
		if (running.notified) return;
		running.notified = true;
		if (running.endTimer) clearTimeout(running.endTimer);
		this.close(running);
		this.options.onEnded?.(reason);
	}
}
