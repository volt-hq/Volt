/**
 * The bounded in-memory structures a voice session keeps (`VOICE_LIMITS`):
 * the serial speech queue and the ephemeral transcript window. Overflow is
 * reported, never silently absorbed: the session stops voice visibly rather
 * than cut a request or pretend an omitted answer was spoken.
 */

import { VOICE_LIMITS } from "@hansjm10/volt-protocol";

export class VoiceBoundExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "VoiceBoundExceededError";
	}
}

export interface SpeechBlock {
	/** The canonical entry the text came from. */
	readonly entryId: string;
	readonly text: string;
	readonly channel: "speakable" | "commentary";
	/** The utterance the block answers, when one is open. */
	readonly utteranceId: string | undefined;
}

/** Completed assistant blocks awaiting synthesis, bounded by count and UTF-8 size. */
export class SpeechQueue {
	private readonly blocks: SpeechBlock[] = [];
	private bytes = 0;

	get length(): number {
		return this.blocks.length;
	}

	get byteLength(): number {
		return this.bytes;
	}

	push(block: SpeechBlock): void {
		const size = Buffer.byteLength(block.text, "utf8");
		if (
			this.blocks.length + 1 > VOICE_LIMITS.speechQueueBlocks ||
			this.bytes + size > VOICE_LIMITS.speechQueueBytes
		) {
			throw new VoiceBoundExceededError(
				`speech queue would exceed ${VOICE_LIMITS.speechQueueBlocks} blocks or ${VOICE_LIMITS.speechQueueBytes} bytes`,
			);
		}
		this.blocks.push(block);
		this.bytes += size;
	}

	shift(): SpeechBlock | undefined {
		const block = this.blocks.shift();
		if (block) this.bytes -= Buffer.byteLength(block.text, "utf8");
		return block;
	}

	clear(): void {
		this.blocks.length = 0;
		this.bytes = 0;
	}
}

export interface TranscriptSegment {
	readonly role: "user" | "assistant";
	readonly text: string;
	/** `true` once the provider completed the turn the segment belongs to. */
	readonly final: boolean;
}

/** The ephemeral labeled transcript: provider speech and user transcripts, never canonical messages. */
export class TranscriptWindow {
	private readonly segments: TranscriptSegment[] = [];
	private bytes = 0;

	get length(): number {
		return this.segments.length;
	}

	get byteLength(): number {
		return this.bytes;
	}

	push(segment: TranscriptSegment): void {
		const size = Buffer.byteLength(segment.text, "utf8");
		if (
			this.segments.length + 1 > VOICE_LIMITS.transcriptSegments ||
			this.bytes + size > VOICE_LIMITS.transcriptBytes
		) {
			throw new VoiceBoundExceededError(
				`transcript would exceed ${VOICE_LIMITS.transcriptSegments} segments or ${VOICE_LIMITS.transcriptBytes} bytes`,
			);
		}
		this.segments.push(segment);
		this.bytes += size;
	}

	/** A snapshot; the window itself stays in memory only. */
	list(): readonly TranscriptSegment[] {
		return [...this.segments];
	}

	clear(): void {
		this.segments.length = 0;
		this.bytes = 0;
	}
}

/**
 * A token bucket over frames: the client may run ahead of real time by the
 * application's queued-audio budget, no more.
 */
export class FrameRateLimiter {
	private tokens: number;
	private last: number;
	private readonly capacity: number;
	private readonly perMs: number;

	constructor(framesPerSecond: number, burstMs: number, now: number) {
		this.capacity = Math.max(1, Math.round((framesPerSecond * burstMs) / 1000));
		this.perMs = framesPerSecond / 1000;
		this.tokens = this.capacity;
		this.last = now;
	}

	/** Whether one more frame fits now. */
	admit(now: number): boolean {
		const elapsed = Math.max(0, now - this.last);
		this.last = now;
		this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.perMs);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}
