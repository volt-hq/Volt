/**
 * The voice provider adapter boundary (docs/daemon-voice-design.md,
 * "Ownership"): everything provider-specific (signaling, media engine,
 * event names, channels, credentials) stays behind it. A `VoiceSession`
 * sees normalized audio, completed utterances, delegation associations,
 * spoken transcripts, usage snapshots, and safe failures; never SDP, call
 * ids, account identity, or tokens.
 */

import type { VoiceAvailability, VoiceErrorCode } from "@hansjm10/volt-protocol";
import type { AuthStorage } from "../auth-storage.ts";

/** A PCM frame at the application baseline (`VOICE_MEDIA_FORMAT`): 480 samples of signed 16-bit little-endian. */
export type VoicePcmFrame = Int16Array;

/** The channel assistant text is appended on; `commentary` is advisory, at the provider's discretion. */
export type VoiceSpeechChannel = "speakable" | "commentary";

/**
 * What a provider session reports. Every id is provider-assigned and opaque;
 * the session deduplicates by it, never by text.
 */
export type VoiceProviderEvent =
	/** The provider accepted the session; it listens from here. */
	| { readonly type: "ready" }
	/** A user turn's onset: the barge-in signal. */
	| { readonly type: "user_turn_started"; readonly turnId: string }
	/** A fragment of the running user transcript; starts no work. */
	| { readonly type: "user_transcript_delta"; readonly turnId?: string; readonly text: string }
	/** A completed user turn with its final transcript: the only dispatch source. */
	| { readonly type: "user_turn_completed"; readonly turnId: string; readonly transcript: string }
	/** The provider begins saying something new: audio from here belongs to the current playback epoch. */
	| { readonly type: "assistant_turn_started" }
	/** A fragment of what the provider is saying. */
	| { readonly type: "assistant_transcript_delta"; readonly text: string }
	/** The provider finished saying something; `transcript` labels what it said. */
	| { readonly type: "assistant_turn_completed"; readonly transcript: string }
	/** Spoken audio for the client, one frame. */
	| { readonly type: "audio"; readonly frame: VoicePcmFrame }
	/**
	 * The provider delegated a user request. `turnId` is present only when the
	 * provider itself ties the delegation to a completed user turn; the session
	 * never infers it from text or timing.
	 */
	| { readonly type: "delegation_created"; readonly delegationId: string; readonly turnId?: string }
	/** A cumulative usage snapshot: replaces the previous one. */
	| { readonly type: "usage"; readonly audioSeconds: number }
	/** The session failed; `code` is safe to show, `detail` is for the host's diagnostics only. */
	| { readonly type: "failed"; readonly code: VoiceErrorCode; readonly detail?: string }
	/** The provider closed the session on its own. */
	| { readonly type: "closed" };

export interface VoiceProviderSessionOptions {
	/** Instructions for the live frontend: it defers substantive answers to the conversation's model. */
	readonly instructions: string;
	/** The conversation's credentials, read in memory; a provider never writes them or refreshes on its own. */
	readonly authStorage: AuthStorage;
	readonly onEvent: (event: VoiceProviderEvent) => void;
}

/** One open provider session. Every method is safe to call after `close`. */
export interface VoiceProviderSession {
	/** Microphone audio from the media owner, one frame. */
	sendAudio(frame: VoicePcmFrame): void;
	/** Microphone input is muted or resumed; a provider may use it to end a turn. */
	setInputMuted(muted: boolean): void;
	/** Say assistant text that belongs to no delegation. Resolves once the provider acknowledged the text. */
	appendSpeech(text: string, channel: VoiceSpeechChannel): Promise<void>;
	/** Say assistant text as the result of `delegationId`, when the provider verified that association. */
	appendDelegationSpeech(delegationId: string, text: string, channel: VoiceSpeechChannel): Promise<void>;
	/** Stop current provider speech where supported; a provider that cannot is a no-op here. */
	interrupt(): void;
	/** Close the provider session; resolves once teardown is observed or `timeoutMs` passed. */
	close(timeoutMs: number): Promise<void>;
}

/** A provider the host can start voice sessions with. */
export interface VoiceProvider {
	readonly name: string;
	/**
	 * Whether a session could start now, without opening one: native media
	 * support, valid in-memory credentials, and provider access are reported
	 * distinctly.
	 */
	availability(authStorage: AuthStorage): VoiceAvailability;
	/** Open a provider session; rejects with a `VoiceProviderError` carrying a safe code. */
	start(options: VoiceProviderSessionOptions): Promise<VoiceProviderSession>;
}

export class VoiceProviderError extends Error {
	readonly code: VoiceErrorCode;

	constructor(code: VoiceErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "VoiceProviderError";
		this.code = code;
	}
}
