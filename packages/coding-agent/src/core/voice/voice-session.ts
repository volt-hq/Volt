/**
 * One conversation's voice session (docs/daemon-voice-design.md): the
 * lifecycle (`off -> starting -> active -> stopping -> off`), the media
 * owner and its revocable lease, the voice and playback epochs, the
 * provider session, and the automatic bridge to the conversation's agent.
 *
 * Input: a completed user turn the provider reports is admitted once, as
 * literal user text, through ordinary prompt admission (receipt by its
 * utterance id, extension input hooks, branch fence, steering while a run is
 * active). Transcript fragments, output transcripts, and delegation notices
 * start no work.
 *
 * Output: committed assistant messages of this conversation, projected for
 * the owner's profile, are queued for synthesis in order through a bounded
 * serial queue, correlated to a verified provider delegation when one is
 * open, standalone otherwise. Settlement (`agent_settled`) closes the open
 * utterances; it carries no identity of its own.
 *
 * Nothing here persists audio, transcripts, provider payloads, or
 * credentials; the live value and diagnostics carry safe codes and counts.
 */

import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { DeepReadonly } from "@hansjm10/volt-ai";
import {
	type LiveVoiceValue,
	VOICE_ENVELOPE_KINDS,
	VOICE_FRAMES_PER_SECOND,
	VOICE_LIMITS,
	VOICE_MEDIA_FORMAT,
	type VoiceAvailability,
	type VoiceError,
	type VoiceErrorCode,
	type VoiceLifecycle,
	type VoiceStartOutput,
	type VoiceUsage,
} from "@hansjm10/volt-protocol";
import type { AgentSessionEvent } from "../agent-session.ts";
import { ClientScope } from "../host/client-scope.ts";
import type { HostedConversation } from "../host/hosted-conversation.ts";
import type { Profile } from "../protocol/profiles.ts";
import { conversationProjectionSource, type ProjectionSource } from "../protocol/projection/entries.ts";
import { projectTranscriptItem } from "../protocol/projection/transcript.ts";
import type { CommittedSessionEntry } from "../session-manager.ts";
import { FrameRateLimiter, SpeechQueue, TranscriptWindow, VoiceBoundExceededError } from "./bounded.ts";
import {
	encodeVoiceEnvelope,
	frameToPayload,
	payloadToFrame,
	VoiceEnvelopeDecoder,
	VoiceEnvelopeError,
} from "./media-envelope.ts";
import type { VoiceProvider, VoiceProviderEvent, VoiceProviderSession, VoiceSpeechChannel } from "./provider.ts";
import { VoiceProviderError } from "./provider.ts";

/** How long a stop waits for the provider's teardown before giving up on it. */
export const VOICE_PROVIDER_CLOSE_TIMEOUT_MS = 5_000;
/** How often the input stall detector looks. */
const STALL_CHECK_MS = 250;
const ignoreError = (): void => {};
/** Outbound bytes the stream may hold unread before the reader counts as too slow. */
const SLOW_READER_BYTES = Math.ceil((VOICE_LIMITS.queuedAudioMs / VOICE_MEDIA_FORMAT.frameMs) * (960 + 17));

export interface VoiceOwner {
	/** The owning client's id in its conversation host: its control attachment. */
	readonly clientId: string;
	/**
	 * What a media attachment must prove: a TUI's process key, or the key of
	 * a paired device's conversation stream.
	 */
	readonly clientKey: string;
	/** The owner's projection: what it may hear is what its transcript could show, redacted as its stream is. */
	readonly profile: Profile;
}

/** How a start failed, with the code the intent reports. */
export class VoiceStartError extends Error {
	readonly code: "owner_conflict" | "unavailable" | "busy";

	constructor(code: "owner_conflict" | "unavailable" | "busy", message: string) {
		super(message);
		this.name = "VoiceStartError";
		this.code = code;
	}
}

export interface VoiceSessionOptions {
	readonly conversation: HostedConversation;
	readonly provider: VoiceProvider;
	readonly instructions: string;
	/** Whether the owner's control attachment is still on the conversation. */
	readonly isOwnerAttached: (owner: VoiceOwner) => boolean;
	/** Current availability, for the live value. */
	readonly availability: () => VoiceAvailability;
	/** The live value changed. */
	readonly onChange: (value: LiveVoiceValue) => void;
	/** Safe diagnostics: ids, codes, counts; never text or payloads. */
	readonly log?: (message: string) => void;
	readonly now?: () => number;
}

interface PendingOffer {
	readonly id: string;
	readonly epoch: number;
	readonly clientKey: string;
	readonly expiresAt: number;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface MediaLease {
	readonly epoch: number;
	valid: boolean;
	readonly stream: Duplex;
}

interface Utterance {
	readonly utteranceId: string;
	readonly turnId: string;
	delegationId: string | undefined;
	settled: boolean;
}

/** Safe diagnostic counters, for tests and status. */
export interface VoiceSessionDiagnostics {
	framesIn: number;
	framesOut: number;
	framesDropped: number;
	utterancesAdmitted: number;
	utterancesRejected: number;
	duplicateTurnEvents: number;
	blocksSpoken: number;
	delegationsAssociated: number;
}

export class VoiceSession {
	private readonly options: VoiceSessionOptions;
	private lifecycle: VoiceLifecycle = "off";
	private epoch = 0;
	private playbackEpoch = 0;
	private owner: VoiceOwner | undefined;
	private error: VoiceError | undefined;
	private usage: VoiceUsage = { available: false };
	private input: "muted" | "listening" = "muted";
	private output: "idle" | "speaking" = "idle";
	/** The intent id the current epoch was started by: a retry answers the same. */
	private startedBy: { intentId: string | undefined; output: VoiceStartOutput } | undefined;
	private offer: PendingOffer | undefined;
	private lease: MediaLease | undefined;
	private providerSession: VoiceProviderSession | undefined;
	private providerOpening: Promise<void> | undefined;
	private stopping: Promise<void> | undefined;
	private readonly nonce = randomBytes(6).toString("base64url");
	/** Teardowns of the epoch: subscriptions, timers, pumps. */
	private cleanups: Array<() => void> = [];
	/** Utterances are admitted one after another, so spoken turns keep their order. */
	private admitting: Promise<void> = Promise.resolve();
	private readonly speech = new SpeechQueue();
	private speaking: Promise<void> = Promise.resolve();
	private readonly transcript = new TranscriptWindow();
	private readonly utterances = new Map<string, Utterance>();
	private readonly seenTurnIds = new Set<string>();
	private readonly seenEntryIds = new Set<string>();
	private startOrdinal = 0;
	private generationRevision = 0;
	/** Output audio is dropped from a barge-in until the provider starts its next turn. */
	private suppressOutput = false;
	private outboundSequence = 0;
	private outboundSamples = 0;
	private inboundSequence = 0;
	private lastInputAt = 0;
	private rateLimiter: FrameRateLimiter | undefined;
	private source: ProjectionSource | undefined;
	readonly diagnostics: VoiceSessionDiagnostics = {
		framesIn: 0,
		framesOut: 0,
		framesDropped: 0,
		utterancesAdmitted: 0,
		utterancesRejected: 0,
		duplicateTurnEvents: 0,
		blocksSpoken: 0,
		delegationsAssociated: 0,
	};

	constructor(options: VoiceSessionOptions) {
		this.options = options;
	}

	get state(): VoiceLifecycle {
		return this.lifecycle;
	}

	get currentEpoch(): number {
		return this.epoch;
	}

	get currentOwner(): VoiceOwner | undefined {
		return this.owner;
	}

	/** The labeled ephemeral transcript of the current epoch. */
	transcriptSegments() {
		return this.transcript.list();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private log(message: string): void {
		this.options.log?.(`voice[${this.options.conversation.id}] epoch=${this.epoch} ${message}`);
	}

	liveValue(): LiveVoiceValue {
		return {
			kind: "voice",
			availability: this.options.availability(),
			lifecycle: this.lifecycle,
			epoch: this.epoch,
			...(this.owner === undefined ? {} : { owner: { client: this.owner.clientId } }),
			input: this.input,
			output: this.output,
			...(this.error === undefined ? {} : { error: this.error }),
			usage: this.usage,
		};
	}

	private publish(): void {
		this.options.onChange(this.liveValue());
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	/**
	 * Start a new epoch for `owner`. Idempotent by `intentId` for the same
	 * owner while the epoch it started lives; another owner's start, or a new
	 * start while one lives, is an owner conflict.
	 */
	start(owner: VoiceOwner, intentId: string | undefined): VoiceStartOutput {
		if (this.lifecycle !== "off") {
			if (
				this.startedBy !== undefined &&
				intentId !== undefined &&
				this.startedBy.intentId === intentId &&
				this.owner?.clientKey === owner.clientKey
			) {
				return this.startedBy.output;
			}
			if (this.lifecycle === "stopping") throw new VoiceStartError("busy", "Voice is stopping; retry shortly");
			throw new VoiceStartError(
				"owner_conflict",
				this.owner?.clientKey === owner.clientKey
					? "Voice is already on for this client"
					: "Another client owns voice on this conversation",
			);
		}
		const availability = this.options.availability();
		if (!availability.available)
			throw new VoiceStartError("unavailable", `Voice is unavailable: ${availability.reason}`);
		const { conversation } = this.options;
		if (conversation.closed) throw new VoiceStartError("unavailable", "The conversation is closed");

		this.epoch += 1;
		this.playbackEpoch = 0;
		this.owner = owner;
		this.error = undefined;
		this.usage = { available: false };
		this.input = "muted";
		this.output = "idle";
		this.lifecycle = "starting";
		this.seenTurnIds.clear();
		this.seenEntryIds.clear();
		this.utterances.clear();
		this.speech.clear();
		this.transcript.clear();
		this.suppressOutput = false;
		this.outboundSequence = 0;
		this.outboundSamples = 0;
		this.inboundSequence = 0;
		this.startOrdinal = conversation.session.sessionManager.getOrdinal();
		this.generationRevision = conversation.session.conversationGenerationRevision;
		this.source = conversationProjectionSource(conversation.session);

		const epoch = this.epoch;
		const offerId = randomBytes(24).toString("base64url");
		const expiresAt = this.now() + VOICE_LIMITS.mediaOfferTtlMs;
		const timer = setTimeout(() => {
			if (this.offer?.id !== offerId || this.epoch !== epoch) return;
			this.offer = undefined;
			void this.fail({ code: "attach_timeout", message: "No media attached before the offer expired" });
		}, VOICE_LIMITS.mediaOfferTtlMs);
		timer.unref?.();
		this.offer = { id: offerId, epoch, clientKey: owner.clientKey, expiresAt, timer };
		this.cleanups.push(() => {
			clearTimeout(timer);
			if (this.offer?.id === offerId) this.offer = undefined;
		});
		// The owner leaving, the conversation changing branch, and the conversation closing end the epoch.
		this.cleanups.push(
			conversation.liveState.subscribeClients(() => {
				if (this.epoch === epoch && this.owner && !this.options.isOwnerAttached(this.owner)) {
					void this.fail({ code: "owner_detached", message: "The media owner left the conversation" });
				}
			}),
		);
		this.cleanups.push(
			conversation.session.subscribeConversationGenerationChanges(() => {
				if (this.epoch === epoch && this.lifecycle !== "off") {
					void this.fail({ code: "conversation_changed", message: "The conversation changed branch" });
				}
			}),
		);
		this.cleanups.push(conversation.session.sessionManager.subscribeEntries((entry) => this.onEntry(entry)));
		this.cleanups.push(conversation.session.subscribe((event) => this.onSessionEvent(event)));

		const output: VoiceStartOutput = {
			epoch,
			media: { offerId, format: { ...VOICE_MEDIA_FORMAT }, expiresAt },
		};
		this.startedBy = { intentId, output };
		this.log(`starting owner=${owner.clientId}`);
		this.publish();
		return output;
	}

	/** The pending offer `offerId` of `clientKey`; throws when there is none. Consumes nothing. */
	private pendingOffer(offerId: string, clientKey: string): PendingOffer {
		const offer = this.offer;
		if (
			this.lifecycle !== "starting" ||
			offer === undefined ||
			offer.id !== offerId ||
			offer.clientKey !== clientKey ||
			offer.epoch !== this.epoch ||
			this.now() > offer.expiresAt
		) {
			throw new Error("The media offer is not pending for this client");
		}
		return offer;
	}

	/** Throws unless `attachMedia(offerId, clientKey, ...)` would admit a stream now. */
	assertMediaOffer(offerId: string, clientKey: string): void {
		this.pendingOffer(offerId, clientKey);
	}

	/**
	 * Attach the media stream for `offerId`: the offer must be pending for
	 * this epoch and client key. Consumed atomically; the provider session
	 * opens once media is attached, so no provider session listens without a
	 * media owner. Throws when the offer does not match; the stream is then
	 * the caller's to close.
	 */
	attachMedia(offerId: string, clientKey: string, stream: Duplex): void {
		const offer = this.pendingOffer(offerId, clientKey);
		this.offer = undefined;
		clearTimeout(offer.timer);
		const epoch = this.epoch;
		const lease: MediaLease = { epoch, valid: true, stream };
		this.lease = lease;
		this.lastInputAt = this.now();
		this.rateLimiter = new FrameRateLimiter(VOICE_FRAMES_PER_SECOND, VOICE_LIMITS.queuedAudioMs, this.now());
		this.startMediaPumps(lease);
		this.log("media attached");
		this.providerOpening = this.openProvider(epoch);
	}

	private async openProvider(epoch: number): Promise<void> {
		let session: VoiceProviderSession;
		try {
			session = await this.options.provider.start({
				instructions: this.options.instructions,
				authStorage: this.options.conversation.services.authStorage,
				onEvent: (event) => this.onProviderEvent(epoch, event),
			});
		} catch (error) {
			if (this.epoch !== epoch || this.lifecycle !== "starting") return;
			const code: VoiceErrorCode = error instanceof VoiceProviderError ? error.code : "provider_failed";
			this.log(`provider start failed code=${code}`);
			// Not awaited: the stop joins this very promise.
			void this.fail({ code, message: "The voice provider could not start" });
			return;
		}
		if (this.epoch !== epoch || this.lifecycle !== "starting") {
			// Stopped while the provider opened: it must not outlive the epoch.
			await session.close(VOICE_PROVIDER_CLOSE_TIMEOUT_MS).catch(() => undefined);
			return;
		}
		this.providerSession = session;
		this.lifecycle = "active";
		this.log("active");
		this.publish();
	}

	/** Barge-in on `epoch`: queued and current output audio go; the agent's work does not. */
	interrupt(epoch: number): boolean {
		if (epoch !== this.epoch || this.lifecycle !== "active") return false;
		this.playbackEpoch += 1;
		this.suppressOutput = true;
		this.output = "idle";
		this.outboundSequence = 0;
		this.outboundSamples = 0;
		const lease = this.lease;
		if (lease?.valid) {
			this.writeEnvelope(lease, {
				kind: VOICE_ENVELOPE_KINDS.playback_epoch,
				epoch: this.playbackEpoch,
				sequence: 0,
				sampleOffset: 0,
				payload: Buffer.alloc(0),
			});
		}
		this.providerSession?.interrupt();
		this.log(`interrupted playbackEpoch=${this.playbackEpoch}`);
		this.publish();
		return true;
	}

	/** Stop `epoch` on the owner's request; a late stop of an earlier epoch does nothing. */
	stop(epoch: number): Promise<boolean> {
		if (epoch !== this.epoch || this.lifecycle === "off") return Promise.resolve(false);
		return this.end(undefined).then(() => true);
	}

	/** The conversation closes, or the host shuts down: end whatever epoch runs. */
	dispose(): Promise<void> {
		if (this.lifecycle === "off") return Promise.resolve();
		return this.end({ code: "stopped", message: "The conversation closed" });
	}

	/** Resolves once the current stop, if any, finished. */
	whenStopped(): Promise<void> {
		return this.stopping ?? Promise.resolve();
	}

	private fail(error: VoiceError): Promise<void> {
		if (this.lifecycle === "off" || this.lifecycle === "stopping") return this.whenStopped();
		this.log(`failing code=${error.code}`);
		return this.end(error);
	}

	/** Retire the epoch: fence media and output first, then join the bounded provider teardown. */
	private end(error: VoiceError | undefined): Promise<void> {
		if (this.stopping) return this.stopping;
		this.lifecycle = "stopping";
		this.error = error;
		const lease = this.lease;
		if (lease) lease.valid = false;
		this.lease = undefined;
		this.speech.clear();
		this.input = "muted";
		this.output = "idle";
		this.publish();
		const providerSession = this.providerSession;
		this.providerSession = undefined;
		const opening = this.providerOpening;
		this.providerOpening = undefined;
		for (const cleanup of this.cleanups.splice(0)) {
			try {
				cleanup();
			} catch {
				// Teardown is best effort per item.
			}
		}
		lease?.stream.destroy();
		this.stopping = (async () => {
			await opening?.catch(() => undefined);
			// A session that opened after the fence closes through `openProvider`; this one is ours.
			await providerSession?.close(VOICE_PROVIDER_CLOSE_TIMEOUT_MS).catch(() => undefined);
			if (this.usage.available && providerSession) this.usage = { ...this.usage, partial: true };
			this.utterances.clear();
			this.transcript.clear();
			this.owner = undefined;
			this.startedBy = undefined;
			this.lifecycle = "off";
			this.stopping = undefined;
			this.log(`off${error === undefined ? "" : ` code=${error.code}`}`);
			this.publish();
		})();
		return this.stopping;
	}

	// ==========================================================================
	// Media
	// ==========================================================================

	private startMediaPumps(lease: MediaLease): void {
		const { stream } = lease;
		const decoder = new VoiceEnvelopeDecoder();
		const onData = (chunk: Buffer) => {
			if (!lease.valid) return;
			let envelopes: ReturnType<VoiceEnvelopeDecoder["push"]>;
			try {
				envelopes = decoder.push(chunk);
			} catch (error) {
				const message = error instanceof VoiceEnvelopeError ? error.message : "malformed media";
				void this.fail({ code: "media_invalid", message });
				return;
			}
			for (const envelope of envelopes) {
				if (!lease.valid) return;
				if (envelope.epoch !== lease.epoch) {
					void this.fail({ code: "media_invalid", message: "media envelope for another epoch" });
					return;
				}
				switch (envelope.kind) {
					case VOICE_ENVELOPE_KINDS.audio: {
						if (envelope.sequence !== this.inboundSequence) {
							void this.fail({ code: "media_invalid", message: "media sequence gap" });
							return;
						}
						this.inboundSequence = (this.inboundSequence + 1) >>> 0;
						const now = this.now();
						if (!this.rateLimiter?.admit(now)) {
							void this.fail({ code: "media_overrun", message: "media arrives faster than real time" });
							return;
						}
						this.lastInputAt = now;
						this.diagnostics.framesIn += 1;
						if (this.input !== "listening") {
							this.input = "listening";
							this.providerSession?.setInputMuted(false);
							this.publish();
						}
						// Frames before the provider is ready are dropped: nothing listens yet.
						if (this.providerSession) this.providerSession.sendAudio(payloadToFrame(envelope.payload));
						else this.diagnostics.framesDropped += 1;
						break;
					}
					case VOICE_ENVELOPE_KINDS.mute:
						if (this.input !== "muted") {
							this.input = "muted";
							this.providerSession?.setInputMuted(true);
							this.publish();
						}
						break;
					case VOICE_ENVELOPE_KINDS.unmute:
						this.lastInputAt = this.now();
						if (this.input !== "listening") {
							this.input = "listening";
							this.providerSession?.setInputMuted(false);
							this.publish();
						}
						break;
					default:
						void this.fail({ code: "media_invalid", message: "unexpected media envelope kind" });
						return;
				}
			}
		};
		const onEnd = () => {
			if (lease.valid) void this.fail({ code: "media_lost", message: "The media stream ended" });
		};
		const onError = () => {
			if (lease.valid) void this.fail({ code: "media_lost", message: "The media stream failed" });
		};
		stream.on("data", onData);
		stream.on("end", onEnd);
		stream.on("close", onEnd);
		stream.on("error", onError);
		// Destroying the stream at the end of the epoch may emit an abort; it must never be unhandled.
		stream.on("error", ignoreError);
		stream.resume();
		const stall = setInterval(() => {
			if (!lease.valid) return;
			// The owner's detach reaches us through the live clients; a host without live clients is polled.
			if (this.owner && !this.options.isOwnerAttached(this.owner)) {
				void this.fail({ code: "owner_detached", message: "The media owner left the conversation" });
				return;
			}
			if (this.input !== "listening") return;
			if (this.now() - this.lastInputAt > VOICE_LIMITS.inputStallMs) {
				void this.fail({ code: "input_stalled", message: "The input stream stalled while listening" });
			}
		}, STALL_CHECK_MS);
		stall.unref?.();
		this.cleanups.push(() => {
			clearInterval(stall);
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("close", onEnd);
			stream.off("error", onError);
		});
	}

	private writeEnvelope(lease: MediaLease, envelope: Parameters<typeof encodeVoiceEnvelope>[0]): void {
		if (!lease.valid) return;
		if (lease.stream.writableLength > SLOW_READER_BYTES) {
			void this.fail({ code: "slow_reader", message: "The media owner reads audio too slowly" });
			return;
		}
		try {
			lease.stream.write(encodeVoiceEnvelope(envelope));
		} catch {
			void this.fail({ code: "media_lost", message: "The media stream failed" });
		}
	}

	// ==========================================================================
	// Provider events: the input bridge
	// ==========================================================================

	private onProviderEvent(epoch: number, event: VoiceProviderEvent): void {
		if (epoch !== this.epoch) return;
		if (this.lifecycle !== "active" && this.lifecycle !== "starting") return;
		switch (event.type) {
			case "ready":
				return;
			case "user_turn_started":
				return;
			case "user_transcript_delta":
				this.recordTranscript({ role: "user", text: event.text, final: false });
				return;
			case "user_turn_completed":
				this.recordTranscript({ role: "user", text: event.transcript, final: true });
				this.admitUtterance(event.turnId, event.transcript);
				return;
			case "assistant_turn_started":
				// A barge-in suppressed the rest of the interrupted turn; what follows is new speech.
				this.suppressOutput = false;
				return;
			case "assistant_transcript_delta":
				this.recordTranscript({ role: "assistant", text: event.text, final: false });
				return;
			case "assistant_turn_completed":
				this.recordTranscript({ role: "assistant", text: event.transcript, final: true });
				if (this.output !== "idle") {
					this.output = "idle";
					this.publish();
				}
				return;
			case "audio": {
				const lease = this.lease;
				if (!lease?.valid || this.suppressOutput) {
					this.diagnostics.framesDropped += 1;
					return;
				}
				if (this.output !== "speaking") {
					this.output = "speaking";
					this.publish();
				}
				this.writeEnvelope(lease, {
					kind: VOICE_ENVELOPE_KINDS.audio,
					epoch: this.playbackEpoch,
					sequence: this.outboundSequence,
					sampleOffset: this.outboundSamples,
					payload: frameToPayload(event.frame),
				});
				this.outboundSequence = (this.outboundSequence + 1) >>> 0;
				this.outboundSamples = (this.outboundSamples + event.frame.length) >>> 0;
				this.diagnostics.framesOut += 1;
				return;
			}
			case "delegation_created": {
				// Only a provider-verified association counts; text and timing never do.
				const utterance = event.turnId === undefined ? undefined : this.utteranceByTurn(event.turnId);
				if (utterance && utterance.delegationId === undefined) {
					utterance.delegationId = event.delegationId;
					this.diagnostics.delegationsAssociated += 1;
				}
				return;
			}
			case "usage":
				this.usage = { available: true, audioSeconds: event.audioSeconds, partial: false };
				this.publish();
				return;
			case "failed":
				void this.fail({ code: event.code, message: "The voice provider failed" });
				return;
			case "closed":
				void this.fail({ code: "provider_failed", message: "The voice provider closed the session" });
				return;
			default:
				return;
		}
	}

	private recordTranscript(segment: { role: "user" | "assistant"; text: string; final: boolean }): void {
		try {
			this.transcript.push(segment);
		} catch (error) {
			if (error instanceof VoiceBoundExceededError) {
				void this.fail({ code: "transcript_overflow", message: "The voice transcript overflowed" });
				return;
			}
			throw error;
		}
	}

	private utteranceByTurn(turnId: string): Utterance | undefined {
		for (const utterance of this.utterances.values()) {
			if (utterance.turnId === turnId) return utterance;
		}
		return undefined;
	}

	/**
	 * Admit a completed user turn once, as literal user text, within the
	 * owner's client scope. The utterance is registered at once, so a
	 * delegation the provider ties to its turn finds it; a rejected admission
	 * removes it. Admissions run one after another, in the order spoken.
	 */
	private admitUtterance(turnId: string, transcript: string): void {
		if (this.seenTurnIds.has(turnId)) {
			this.diagnostics.duplicateTurnEvents += 1;
			return;
		}
		this.seenTurnIds.add(turnId);
		const text = transcript.trim();
		if (text.length === 0) return;
		const owner = this.owner;
		if (!owner || !this.lease?.valid || this.lifecycle !== "active") return;
		const { session } = this.options.conversation;
		const utteranceId = `voice-${this.nonce}-${this.epoch}-${turnId}`;
		const utterance: Utterance = { utteranceId, turnId, delegationId: undefined, settled: false };
		this.utterances.set(utteranceId, utterance);
		const epoch = this.epoch;
		const expectedRevision = this.generationRevision;
		this.admitting = this.admitting.then(
			() =>
				new Promise<void>((resolve) => {
					if (this.epoch !== epoch || this.lifecycle !== "active") {
						this.utterances.delete(utteranceId);
						resolve();
						return;
					}
					let settled = false;
					const done = () => {
						if (settled) return;
						settled = true;
						resolve();
					};
					const promise = ClientScope.run(owner.clientId, () =>
						session.prompt(text, {
							clientMessageId: utteranceId,
							source: "voice",
							// Literal user text: no extension command, skill, or prompt template expansion.
							expandPromptTemplates: false,
							streamingBehavior: "steer",
							assertConversationGenerationCurrent: () => {
								if (session.conversationGenerationRevision !== expectedRevision) {
									throw new Error("The conversation changed branch while voice input was admitted");
								}
							},
							preflightResult: (result) => {
								if (result.success) {
									this.diagnostics.utterancesAdmitted += 1;
									this.log(`utterance admitted turn=${turnId} outcome=${result.outcome}`);
								}
								done();
							},
						}),
					);
					promise.then(done, (error: unknown) => {
						if (!settled) {
							this.utterances.delete(utteranceId);
							this.diagnostics.utterancesRejected += 1;
							this.log(
								`utterance rejected turn=${turnId}: ${error instanceof Error ? error.message : String(error)}`,
							);
						}
						done();
					});
				}),
		);
	}

	// ==========================================================================
	// Committed entries and settlement: the output bridge
	// ==========================================================================

	private onEntry(entry: CommittedSessionEntry): void {
		if (this.lifecycle !== "active" && this.lifecycle !== "starting") return;
		if (entry.type !== "message" || entry.message.role !== "assistant") return;
		if (entry.ordinal <= this.startOrdinal || this.seenEntryIds.has(entry.id)) return;
		this.seenEntryIds.add(entry.id);
		const message = entry.message;
		// A failed or aborted partial message is not a successful reply.
		if (message.error !== undefined || message.stopReason === "error" || message.stopReason === "aborted") return;
		const source = this.source;
		const profile = this.owner?.profile;
		if (!source || !profile || !profile.includes(entry)) return;
		const item = projectTranscriptItem(entry, source, profile);
		if (!item || item.role !== "assistant") return;
		const text = (item.parts ?? [])
			.flatMap((part) => (part.type === "text" && part.text.length > 0 ? [part.text] : []))
			.join("\n\n")
			.trim();
		if (text.length === 0) return;
		const channel: VoiceSpeechChannel = message.stopReason === "toolUse" ? "commentary" : "speakable";
		const open = [...this.utterances.values()].filter((utterance) => !utterance.settled);
		const utteranceId = open.at(-1)?.utteranceId;
		try {
			this.speech.push({ entryId: entry.id, text, channel, utteranceId });
		} catch (error) {
			if (error instanceof VoiceBoundExceededError) {
				void this.fail({
					code: "speech_backlog",
					message: "Assistant text is arriving faster than it can be spoken",
				});
				return;
			}
			throw error;
		}
		this.drainSpeech();
	}

	/** Serial synthesis, independent of agent execution: a slow provider never delays tools or commits. */
	private drainSpeech(): void {
		const epoch = this.epoch;
		this.speaking = this.speaking.then(async () => {
			for (;;) {
				if (this.epoch !== epoch || this.lifecycle !== "active") return;
				const block = this.speech.shift();
				if (!block) return;
				const session = this.providerSession;
				if (!session) return;
				const delegationId =
					block.utteranceId === undefined ? undefined : this.utterances.get(block.utteranceId)?.delegationId;
				try {
					if (delegationId !== undefined) {
						await session.appendDelegationSpeech(delegationId, block.text, block.channel);
					} else {
						await session.appendSpeech(block.text, block.channel);
					}
					this.diagnostics.blocksSpoken += 1;
				} catch (error) {
					if (this.epoch !== epoch) return;
					const code: VoiceErrorCode = error instanceof VoiceProviderError ? error.code : "provider_failed";
					void this.fail({ code, message: "The voice provider rejected assistant text" });
					return;
				}
			}
		});
	}

	private onSessionEvent(event: DeepReadonly<AgentSessionEvent>): void {
		if (event.type !== "agent_settled") return;
		// Settlement carries no identity: every open utterance's work settled, whatever else ran.
		for (const utterance of this.utterances.values()) utterance.settled = true;
	}
}
