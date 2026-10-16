/**
 * A scripted voice provider for the suite: the test drives provider events
 * (`emit`) and inspects what the session sent it (audio frames, appended
 * speech by channel and delegation, interruptions, mute changes, close).
 * No audio engine, no network, no credentials.
 */

import type { VoiceAvailability } from "@hansjm10/volt-protocol";
import type {
	VoiceProvider,
	VoiceProviderEvent,
	VoiceProviderSession,
	VoiceProviderSessionOptions,
	VoiceSpeechChannel,
} from "../../src/core/voice/provider.ts";
import { VoiceProviderError } from "../../src/core/voice/provider.ts";

export interface FakeAppendedSpeech {
	readonly text: string;
	readonly channel: VoiceSpeechChannel;
	readonly delegationId: string | undefined;
}

export class FakeVoiceProviderSession implements VoiceProviderSession {
	readonly instructions: string;
	readonly frames: Int16Array[] = [];
	readonly appended: FakeAppendedSpeech[] = [];
	readonly muteChanges: boolean[] = [];
	interrupts = 0;
	closed = false;
	closeDelayMs = 0;
	/** Reject the next speech appends with this code. */
	failAppendsWith: VoiceProviderError | undefined;
	/** Resolves appends only when released, to make the queue observable. */
	holdAppends = false;
	private readonly held: Array<() => void> = [];
	private readonly onEvent: (event: VoiceProviderEvent) => void;
	private readonly onClosed: () => void;

	constructor(options: VoiceProviderSessionOptions, onClosed: () => void) {
		this.instructions = options.instructions;
		this.onEvent = options.onEvent;
		this.onClosed = onClosed;
	}

	/** Drive a provider event into the session. */
	emit(event: VoiceProviderEvent): void {
		this.onEvent(event);
	}

	/** Release every held append. */
	releaseAppends(): void {
		for (const release of this.held.splice(0)) release();
	}

	sendAudio(frame: Int16Array): void {
		this.frames.push(frame);
	}

	setInputMuted(muted: boolean): void {
		this.muteChanges.push(muted);
	}

	private async append(entry: FakeAppendedSpeech): Promise<void> {
		if (this.failAppendsWith) throw this.failAppendsWith;
		if (this.holdAppends) await new Promise<void>((resolve) => this.held.push(resolve));
		this.appended.push(entry);
	}

	appendSpeech(text: string, channel: VoiceSpeechChannel): Promise<void> {
		return this.append({ text, channel, delegationId: undefined });
	}

	appendDelegationSpeech(delegationId: string, text: string, channel: VoiceSpeechChannel): Promise<void> {
		return this.append({ text, channel, delegationId });
	}

	interrupt(): void {
		this.interrupts += 1;
	}

	async close(timeoutMs: number): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.closeDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, Math.min(this.closeDelayMs, timeoutMs)));
		}
		this.onClosed();
	}
}

export class FakeVoiceProvider implements VoiceProvider {
	readonly name: string;
	readonly sessions: FakeVoiceProviderSession[] = [];
	availabilityValue: VoiceAvailability = { available: true };
	/** Reject the next start with this error. */
	failStartWith: VoiceProviderError | undefined;
	/** Delay each start so a stop can race it. */
	startDelayMs = 0;

	constructor(name = "fake") {
		this.name = name;
	}

	availability(): VoiceAvailability {
		return this.availabilityValue;
	}

	/** The newest session the provider opened. */
	get current(): FakeVoiceProviderSession {
		const session = this.sessions.at(-1);
		if (!session) throw new Error("the fake voice provider has no session");
		return session;
	}

	async start(options: VoiceProviderSessionOptions): Promise<FakeVoiceProviderSession> {
		if (this.startDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.startDelayMs));
		if (this.failStartWith) throw this.failStartWith;
		const session = new FakeVoiceProviderSession(options, () => undefined);
		this.sessions.push(session);
		queueMicrotask(() => options.onEvent({ type: "ready" }));
		return session;
	}
}

export { VoiceProviderError };
