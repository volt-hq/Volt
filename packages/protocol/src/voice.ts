/**
 * Daemon-owned voice (docs/daemon-voice-design.md): the control-plane shape
 * of a conversation's voice session. Control stays in the conversation
 * protocol (`voice_start`, `voice_stop`, `voice_interrupt` intents and the
 * live `voice` value); media travels on a separate binary stream whose
 * envelope these constants fix. Audio never enters a frame, an entry, or
 * the live lane.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcEpochMillisecondsSchema } from "./primitives.ts";
import { RPC_WIRE_MAX_SAFE_INTEGER } from "./wire-limits.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Media format and envelope
// ============================================================================

/** The application media baseline: PCM signed 16-bit little-endian, 24 kHz, mono, 20 ms frames. */
export const VOICE_MEDIA_FORMAT = Object.freeze({
	encoding: "pcm_s16le",
	sampleRate: 24_000,
	channels: 1,
	frameMs: 20,
} as const);

/** Samples in one frame: 480. */
export const VOICE_FRAME_SAMPLES = (VOICE_MEDIA_FORMAT.sampleRate * VOICE_MEDIA_FORMAT.frameMs) / 1000;
/** Payload bytes of one audio frame: 960. */
export const VOICE_FRAME_BYTES = VOICE_FRAME_SAMPLES * 2 * VOICE_MEDIA_FORMAT.channels;
/** Frames per second per direction: 50. */
export const VOICE_FRAMES_PER_SECOND = 1000 / VOICE_MEDIA_FORMAT.frameMs;

/**
 * One media envelope: a 4-byte big-endian length of what follows, then
 * `kind` (1 byte), `epoch` (4 bytes), `sequence` (4 bytes), `sampleOffset`
 * (4 bytes), and the payload. Sequences count per direction from 0 within
 * one media epoch; `sampleOffset` is the first sample's position in that
 * direction's stream. Audio from the client carries the media epoch; audio
 * to the client carries the playback epoch it belongs to.
 */
export const VOICE_ENVELOPE_HEADER_BYTES = 1 + 4 + 4 + 4;
/** Hard limit on one envelope's length field. */
export const VOICE_ENVELOPE_MAX_BYTES = 4096;

export const VOICE_ENVELOPE_KINDS = Object.freeze({
	/** A PCM frame of exactly `VOICE_FRAME_BYTES`, either direction. */
	audio: 1,
	/** Client -> host: input is muted until `unmute`; the stall detector pauses. Empty payload. */
	mute: 2,
	/** Client -> host: input resumes. Empty payload. */
	unmute: 3,
	/** Host -> client: the playback epoch advanced to `epoch`; discard queued audio of earlier epochs. Empty payload. */
	playback_epoch: 4,
} as const);

export type VoiceEnvelopeKind = (typeof VOICE_ENVELOPE_KINDS)[keyof typeof VOICE_ENVELOPE_KINDS];

export const VoiceMediaFormatSchema = Type.Object(
	{
		encoding: Type.Literal(VOICE_MEDIA_FORMAT.encoding),
		sampleRate: Type.Literal(VOICE_MEDIA_FORMAT.sampleRate),
		channels: Type.Literal(VOICE_MEDIA_FORMAT.channels),
		frameMs: Type.Literal(VOICE_MEDIA_FORMAT.frameMs),
	},
	closed,
);
export type VoiceMediaFormat = Static<typeof VoiceMediaFormatSchema>;

// ============================================================================
// Bounds
// ============================================================================

/** Engineering budgets the design fixes; verified by the fixtures, not measured. */
export const VOICE_LIMITS = Object.freeze({
	/** Application-queued audio per direction. */
	queuedAudioMs: 200,
	/** Completed assistant blocks awaiting synthesis. */
	speechQueueBlocks: 32,
	/** UTF-8 bytes of text awaiting synthesis. */
	speechQueueBytes: 32 * 1024,
	/** Segments of the ephemeral transcript. */
	transcriptSegments: 256,
	/** UTF-8 bytes of the ephemeral transcript. */
	transcriptBytes: 64 * 1024,
	/** Longest unmuted silence on the input stream before voice fails as stalled. */
	inputStallMs: 2000,
	/** How long a media offer may wait for its attachment. */
	mediaOfferTtlMs: 10_000,
	/** Active voice sessions one host serves at once. */
	sessionsPerHost: 4,
} as const);

// ============================================================================
// Live value
// ============================================================================

export const VoiceLifecycleSchema = stringEnum(["off", "starting", "active", "stopping"]);
export type VoiceLifecycle = Static<typeof VoiceLifecycleSchema>;

/** Why voice cannot start here, each distinct: the client shows the right remedy. */
export const VoiceUnavailableReasonSchema = stringEnum([
	"disabled",
	"native_media_unavailable",
	"auth_unavailable",
	"provider_unavailable",
	"remote_transport_unavailable",
	"capacity",
]);
export type VoiceUnavailableReason = Static<typeof VoiceUnavailableReasonSchema>;

export const VoiceAvailabilitySchema = Type.Union([
	Type.Object({ available: Type.Literal(true) }, closed),
	Type.Object({ available: Type.Literal(false), reason: VoiceUnavailableReasonSchema }, closed),
]);
export type VoiceAvailability = Static<typeof VoiceAvailabilitySchema>;

/** Safe failure codes: never provider payloads, transcripts, or credentials. */
export const VoiceErrorCodeSchema = stringEnum([
	"attach_timeout",
	"auth_unavailable",
	"native_media_unavailable",
	"provider_failed",
	"media_lost",
	"media_invalid",
	"media_overrun",
	"input_stalled",
	"slow_reader",
	"owner_detached",
	"speech_backlog",
	"transcript_overflow",
	"conversation_changed",
	"capacity",
	"stopped",
]);
export type VoiceErrorCode = Static<typeof VoiceErrorCodeSchema>;

export const VoiceErrorSchema = Type.Object(
	{ code: VoiceErrorCodeSchema, message: Type.String({ maxLength: 512 }) },
	closed,
);
export type VoiceError = Static<typeof VoiceErrorSchema>;

/**
 * Voice usage, separate from model token usage. `audioSeconds` is the
 * provider's cumulative snapshot; `partial` when the session ended without a
 * final snapshot. Never a quota or a price.
 */
export const VoiceUsageSchema = Type.Union([
	Type.Object({ available: Type.Literal(false) }, closed),
	Type.Object(
		{
			available: Type.Literal(true),
			audioSeconds: Type.Number({ minimum: 0 }),
			partial: Type.Boolean(),
		},
		closed,
	),
]);
export type VoiceUsage = Static<typeof VoiceUsageSchema>;

/**
 * The live `voice` value: availability, lifecycle, the epoch, the owner (an
 * opaque client id; other clients see that one exists), the input and
 * output axes, the retained safe error, and usage.
 */
export const LiveVoiceValueSchema = Type.Object(
	{
		kind: Type.Literal("voice"),
		availability: VoiceAvailabilitySchema,
		lifecycle: VoiceLifecycleSchema,
		epoch: Type.Integer({ minimum: 0, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
		owner: Type.Optional(Type.Object({ client: Type.String({ minLength: 1, maxLength: 128 }) }, closed)),
		input: stringEnum(["muted", "listening"]),
		output: stringEnum(["idle", "speaking"]),
		error: Type.Optional(VoiceErrorSchema),
		usage: VoiceUsageSchema,
	},
	closed,
);
export type LiveVoiceValue = Static<typeof LiveVoiceValueSchema>;

// ============================================================================
// Intent payloads
// ============================================================================

/** Opaque, single-use, short-lived: it names a pending attachment and grants nothing by itself. */
export const VoiceMediaOfferIdSchema = Type.String({ pattern: "^[A-Za-z0-9_-]{16,128}$" });

export const VoiceStartOutputSchema = Type.Object(
	{
		epoch: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
		media: Type.Object(
			{
				offerId: VoiceMediaOfferIdSchema,
				format: VoiceMediaFormatSchema,
				expiresAt: RpcEpochMillisecondsSchema,
			},
			closed,
		),
	},
	closed,
);
export type VoiceStartOutput = Static<typeof VoiceStartOutputSchema>;

/** Stop and interruption name the exact epoch they target: a late one never closes its replacement. */
export const VoiceEpochInputSchema = Type.Object(
	{ epoch: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }) },
	closed,
);
export type VoiceEpochInput = Static<typeof VoiceEpochInputSchema>;
