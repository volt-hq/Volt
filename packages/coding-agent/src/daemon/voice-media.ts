/**
 * Daemon-side voice media (docs/daemon-voice-design.md, "Media attachment"):
 * the budget every media attachment of the daemon draws on, a TUI's and a
 * paired device's alike, and the key that binds a device's media stream to
 * its conversation stream.
 */

import { VOICE_LIMITS } from "@hansjm10/volt-protocol";

/** One held media attachment; releasing it twice releases it once. */
export interface VoiceMediaLease {
	release(): void;
}

/**
 * The media attachments the daemon holds at once, across its workers. A
 * provider session opens only once media attached and ends with it, so this
 * also bounds the billed voice sessions of the daemon. A new attachment past
 * the limit is refused; none held is evicted.
 */
export class VoiceMediaBudget {
	readonly limit: number;
	private held = 0;

	constructor(limit: number = VOICE_LIMITS.sessionsPerHost) {
		this.limit = limit;
	}

	get active(): number {
		return this.held;
	}

	tryAcquire(): VoiceMediaLease | undefined {
		if (this.held >= this.limit) return undefined;
		this.held += 1;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this.held -= 1;
			},
		};
	}
}

/**
 * The voice client key of a device's conversation stream: the worker binds
 * the voice session it starts to it, and the daemon names it in the media
 * relay of a stream on the same connection, so media attaches only beside
 * the very conversation stream that started voice.
 */
export function irohVoiceClientKey(clientNodeId: string, connectionId: string, streamId: string): string {
	return `iroh:${clientNodeId}:${connectionId}:${streamId}`;
}
