/**
 * The `openai-codex` voice provider: a `gpt-live-1-codex` V3 WebRTC call on
 * the Codex subscription, with Volt's saved OAuth, through the native
 * engine and the sideband. What the spike proved (scripts/voice-spike) binds
 * this adapter:
 *
 * - `speakable` appends are spoken verbatim; `commentary` is at the model's
 *   discretion.
 * - There is no cancel operation: `interrupt` is a no-op here, and the
 *   session's playback-epoch drop is the barge-in.
 * - `turn.created{role: user}` marks a user turn's onset; `turn.done` ends it.
 * - A delegation is tied to a turn only when the provider says so.
 * - Usage arrives as `session.usage.updated{usage.audio_duration_ms}`,
 *   reported as the latest snapshot.
 *
 * The credential is read from the conversation's auth storage in memory
 * and held for the call only; it is never written, refreshed, logged, or
 * passed through arguments or environment.
 */

import type { VoiceAvailability } from "@hansjm10/volt-protocol";
import type { AuthStorage } from "../../auth-storage.ts";
import {
	type VoiceProvider,
	VoiceProviderError,
	type VoiceProviderEvent,
	type VoiceProviderSession,
	type VoiceProviderSessionOptions,
	type VoiceSpeechChannel,
} from "../provider.ts";
import { CodexMediaEngine, loadVoiceNativeMedia, type VoiceNativeMedia } from "./media-engine.ts";
import {
	createLiveCall,
	type LiveCredential,
	LiveSideband,
	type LiveSidebandEvent,
	LiveSignalingError,
	newRealtimeSessionId,
} from "./signaling.ts";

export const CODEX_LIVE_PROVIDER_NAME = "openai-codex";
const AUTH_PROVIDER = "openai-codex";
/** A credential closer to expiry than this would need the refresh the provider never runs. */
const MIN_CREDENTIAL_REMAINING_MS = 5 * 60 * 1000;
const CALL_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 20_000;

/** The in-memory credential, or undefined when a renewal would be required. */
function liveCredential(authStorage: AuthStorage, now = Date.now()): LiveCredential | undefined {
	const credential = authStorage.get(AUTH_PROVIDER);
	if (credential?.type !== "oauth") return undefined;
	const accountId = credential.accountId;
	if (
		typeof credential.access !== "string" ||
		credential.access.length === 0 ||
		typeof accountId !== "string" ||
		accountId.length === 0 ||
		typeof credential.expires !== "number" ||
		credential.expires - now < MIN_CREDENTIAL_REMAINING_MS
	) {
		return undefined;
	}
	return { accessToken: credential.access, accountId };
}

class CodexLiveSession implements VoiceProviderSession {
	private readonly engine: CodexMediaEngine;
	private readonly sideband: LiveSideband;
	private readonly onEvent: (event: VoiceProviderEvent) => void;
	private closed = false;
	private userTurns = 0;
	private currentUserTurnId: string | undefined;

	constructor(engine: CodexMediaEngine, sideband: LiveSideband, onEvent: (event: VoiceProviderEvent) => void) {
		this.engine = engine;
		this.sideband = sideband;
		this.onEvent = onEvent;
	}

	/** Map a sideband event to the normalized provider event, if any. */
	onSideband(event: LiveSidebandEvent): void {
		if (this.closed) return;
		switch (event.type) {
			case "session.started":
			case "session.updated":
				this.onEvent({ type: "ready" });
				return;
			case "turn.created":
				if (event.role === "user") {
					this.userTurns += 1;
					this.currentUserTurnId = event.turnId ?? `user-turn-${this.userTurns}`;
					this.onEvent({ type: "user_turn_started", turnId: this.currentUserTurnId });
				} else if (event.role === "assistant") {
					this.onEvent({ type: "assistant_turn_started" });
				}
				return;
			case "input_transcript.added":
				this.onEvent({
					type: "user_transcript_delta",
					...(this.currentUserTurnId === undefined ? {} : { turnId: this.currentUserTurnId }),
					text: event.text,
				});
				return;
			case "output_transcript.added":
				this.onEvent({ type: "assistant_transcript_delta", text: event.text });
				return;
			case "turn.done":
				if (event.role === "user") {
					// The turn's own id when the provider carries one; else the onset's, else a fresh event identity.
					const turnId = event.turnId ?? this.currentUserTurnId ?? `user-turn-${++this.userTurns}`;
					this.currentUserTurnId = undefined;
					this.onEvent({ type: "user_turn_completed", turnId, transcript: event.transcript });
				} else if (event.role === "assistant") {
					this.onEvent({ type: "assistant_turn_completed", transcript: event.transcript });
				}
				return;
			case "delegation.created":
				this.onEvent({
					type: "delegation_created",
					delegationId: event.itemId,
					...(event.turnId === undefined ? {} : { turnId: event.turnId }),
				});
				return;
			case "session.usage.updated":
				if (event.audioDurationMs !== undefined) {
					this.onEvent({ type: "usage", audioSeconds: event.audioDurationMs / 1000 });
				}
				return;
			case "error":
				this.onEvent({
					type: "failed",
					code: "provider_failed",
					detail: `provider error (${event.message.length} chars)`,
				});
				return;
			default:
				return;
		}
	}

	onSidebandClosed(): void {
		if (this.closed) return;
		this.onEvent({ type: "closed" });
	}

	sendAudio(frame: Int16Array): void {
		this.engine.sendFrame(frame);
	}

	setInputMuted(muted: boolean): void {
		if (muted) this.engine.markDiscontinuity();
	}

	async appendSpeech(text: string, channel: VoiceSpeechChannel): Promise<void> {
		try {
			this.sideband.appendSessionContext(text, channel);
		} catch (error) {
			throw new VoiceProviderError("provider_failed", "the sideband could not take the text", { cause: error });
		}
	}

	async appendDelegationSpeech(delegationId: string, text: string, channel: VoiceSpeechChannel): Promise<void> {
		try {
			this.sideband.appendDelegationContext(delegationId, text, channel);
		} catch (error) {
			throw new VoiceProviderError("provider_failed", "the sideband could not take the text", { cause: error });
		}
	}

	/** V3 has no cancel operation: the session's playback-epoch drop is the interruption. */
	interrupt(): void {}

	async close(timeoutMs: number): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await Promise.allSettled([this.sideband.close(timeoutMs), this.engine.close()]);
	}
}

export class CodexLiveVoiceProvider implements VoiceProvider {
	readonly name = CODEX_LIVE_PROVIDER_NAME;
	private readonly loadMedia: () => { media?: VoiceNativeMedia; error?: unknown };
	private readonly now: () => number;

	constructor(options: { loadMedia?: () => { media?: VoiceNativeMedia; error?: unknown }; now?: () => number } = {}) {
		this.loadMedia = options.loadMedia ?? loadVoiceNativeMedia;
		this.now = options.now ?? Date.now;
	}

	availability(authStorage: AuthStorage): VoiceAvailability {
		if (this.loadMedia().media === undefined) return { available: false, reason: "native_media_unavailable" };
		if (liveCredential(authStorage, this.now()) === undefined)
			return { available: false, reason: "auth_unavailable" };
		return { available: true };
	}

	async start(options: VoiceProviderSessionOptions): Promise<VoiceProviderSession> {
		const { media } = this.loadMedia();
		if (!media) throw new VoiceProviderError("native_media_unavailable", "the voice media engine is not installed");
		const credential = liveCredential(options.authStorage, this.now());
		if (!credential) throw new VoiceProviderError("auth_unavailable", "no valid openai-codex credential in memory");
		let session: CodexLiveSession | undefined;
		const engine = new CodexMediaEngine({
			media,
			onFrame: (frame) => options.onEvent({ type: "audio", frame }),
			onConnectionState: (state) => {
				if ((state === "failed" || state === "disconnected") && session) {
					options.onEvent({ type: "failed", code: "media_lost", detail: `peer connection ${state}` });
				}
			},
		});
		let sideband: LiveSideband | undefined;
		try {
			const realtimeSessionId = newRealtimeSessionId();
			const offer = await engine.createOffer();
			const call = await createLiveCall(
				credential,
				realtimeSessionId,
				offer,
				{ instructions: options.instructions },
				AbortSignal.timeout(CALL_TIMEOUT_MS),
			);
			await engine.acceptAnswer(call.answerSdp);
			await engine.waitConnected(CONNECT_TIMEOUT_MS);
			sideband = await LiveSideband.connect(credential, call.callId, {
				realtimeSessionId,
				onEvent: (event) => session?.onSideband(event),
				onClose: () => session?.onSidebandClosed(),
			});
			session = new CodexLiveSession(engine, sideband, options.onEvent);
			return session;
		} catch (error) {
			await Promise.allSettled([engine.close(), sideband?.close(1000)]);
			if (error instanceof LiveSignalingError && (error.status === 401 || error.status === 403)) {
				throw new VoiceProviderError("auth_unavailable", "the subscription refused the voice call", {
					cause: error,
				});
			}
			throw new VoiceProviderError("provider_failed", "the voice call could not be set up", { cause: error });
		}
	}
}
