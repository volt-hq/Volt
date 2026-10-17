/**
 * The voice sessions a host serves: one per top-level conversation, created
 * when a client first asks and disposed with the conversation. The service
 * gates on the conversation's settings (`voice.enabled`, off by default),
 * resolves the configured provider, bounds active sessions per host, and
 * is what the voice intents and the worker's media attachment call.
 */

import type { Duplex } from "node:stream";
import type { LiveVoiceValue, VoiceAvailability, VoiceStartOutput } from "@hansjm10/volt-protocol";
import { VOICE_LIMITS } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../host/hosted-conversation.ts";
import type { HostClient } from "../host/targets.ts";
import type { Profile } from "../protocol/profiles.ts";
import type { VoiceProvider } from "./provider.ts";
import { VoiceSession, VoiceStartError } from "./voice-session.ts";

export const DEFAULT_VOICE_PROVIDER = "openai-codex";

/** What the live frontend is told; it has no tools and defers work to the conversation's model. */
export const VOICE_FRONTEND_INSTRUCTIONS = [
	"You are the spoken voice of a coding assistant. Be brief and natural.",
	"The backend agent performs every task and answers every substantive question; defer such work to it and never claim you cannot.",
	"When you receive backend text, speak its key point to the user in one or two sentences without reading code, paths, or tables aloud.",
	"Acknowledge what the user said in a few words. Do not invent results.",
].join(" ");

export interface VoiceServiceOptions {
	/** The clients attached to a conversation: whether a media owner's control attachment still exists. */
	readonly clientsOf: (conversation: HostedConversation) => readonly HostClient[];
	/** The providers this host can start sessions with, by name. */
	readonly providers: ReadonlyMap<string, VoiceProvider>;
	readonly log?: (message: string) => void;
	readonly now?: () => number;
}

/** The client a voice intent runs for: its control attachment, and what its media must prove. */
export interface VoiceClient {
	readonly clientId: string;
	readonly clientKey: string;
}

export class VoiceService {
	private readonly options: VoiceServiceOptions;
	private readonly sessions = new Map<HostedConversation, VoiceSession>();
	private closed = false;

	constructor(options: VoiceServiceOptions) {
		this.options = options;
	}

	private providerFor(conversation: HostedConversation): VoiceProvider | undefined {
		const settings = conversation.session.settingsManager.getVoiceSettings();
		return this.options.providers.get(settings.provider ?? DEFAULT_VOICE_PROVIDER);
	}

	private activeCount(): number {
		let count = 0;
		for (const session of this.sessions.values()) if (session.state !== "off") count += 1;
		return count;
	}

	/** Whether voice could start on `conversation` now; opens nothing. */
	availability(conversation: HostedConversation): VoiceAvailability {
		if (this.closed || conversation.closed) return { available: false, reason: "disabled" };
		const settings = conversation.session.settingsManager.getVoiceSettings();
		if (settings.enabled !== true) return { available: false, reason: "disabled" };
		const provider = this.providerFor(conversation);
		if (!provider) return { available: false, reason: "provider_unavailable" };
		const session = this.sessions.get(conversation);
		if ((session === undefined || session.state === "off") && this.activeCount() >= VOICE_LIMITS.sessionsPerHost) {
			return { available: false, reason: "capacity" };
		}
		return provider.availability(conversation.services.authStorage);
	}

	/** The conversation's voice session, created on first use. */
	sessionFor(conversation: HostedConversation): VoiceSession {
		let session = this.sessions.get(conversation);
		if (session) return session;
		if (this.closed || conversation.closed) throw new VoiceStartError("unavailable", "Voice is unavailable here");
		const provider = this.providerFor(conversation);
		if (!provider) throw new VoiceStartError("unavailable", "No voice provider is configured");
		session = new VoiceSession({
			conversation,
			provider,
			instructions: VOICE_FRONTEND_INSTRUCTIONS,
			isOwnerAttached: (owner) =>
				this.options.clientsOf(conversation).some((client) => client.id === owner.clientId),
			availability: () => this.availability(conversation),
			onChange: (value) => this.publish(conversation, value),
			...(this.options.log === undefined ? {} : { log: this.options.log }),
			...(this.options.now === undefined ? {} : { now: this.options.now }),
		});
		this.sessions.set(conversation, session);
		const created = session;
		void conversation.whenClosed().then(() => {
			if (this.sessions.get(conversation) !== created) return;
			this.sessions.delete(conversation);
			void created.dispose();
		});
		return session;
	}

	private publish(conversation: HostedConversation, value: LiveVoiceValue): void {
		if (conversation.closed) return;
		try {
			conversation.liveState.set("voice", value);
		} catch {
			// A closed live state publishes nothing.
		}
	}

	/** Publish the conversation's current voice value, availability included. */
	publishAvailability(conversation: HostedConversation): void {
		const session = this.sessions.get(conversation);
		if (session) {
			this.publish(conversation, session.liveValue());
			return;
		}
		this.publish(conversation, {
			kind: "voice",
			availability: this.availability(conversation),
			lifecycle: "off",
			epoch: 0,
			input: "muted",
			output: "idle",
			usage: { available: false },
		});
	}

	/** Start voice for `client`; it hears assistant text as `profile`, its connection's projection, shows it. */
	start(
		conversation: HostedConversation,
		client: VoiceClient,
		intentId: string | undefined,
		profile: Profile,
	): VoiceStartOutput {
		const availability = this.availability(conversation);
		const existing = this.sessions.get(conversation);
		if (!availability.available && (existing === undefined || existing.state === "off")) {
			throw new VoiceStartError("unavailable", `Voice is unavailable: ${availability.reason}`);
		}
		return this.sessionFor(conversation).start(
			{ clientId: client.clientId, clientKey: client.clientKey, profile },
			intentId,
		);
	}

	/** Only the owner stops or interrupts its epoch; any other client is refused. */
	private ownedSession(conversation: HostedConversation, client: VoiceClient): VoiceSession | undefined {
		const session = this.sessions.get(conversation);
		if (!session || session.state === "off") return undefined;
		const owner = session.currentOwner;
		if (owner === undefined || owner.clientKey !== client.clientKey) {
			throw new VoiceStartError("owner_conflict", "Another client owns voice on this conversation");
		}
		return session;
	}

	stop(conversation: HostedConversation, client: VoiceClient, epoch: number): Promise<boolean> {
		const session = this.ownedSession(conversation, client);
		return session ? session.stop(epoch) : Promise.resolve(false);
	}

	interrupt(conversation: HostedConversation, client: VoiceClient, epoch: number): boolean {
		return this.ownedSession(conversation, client)?.interrupt(epoch) ?? false;
	}

	/**
	 * Attach a media stream a redeemed relay carries. Throws when no offer
	 * for `offerId` is pending for `clientKey` on `conversation`; the
	 * caller closes the stream then.
	 */
	attachMedia(conversation: HostedConversation, offerId: string, clientKey: string, stream: Duplex): void {
		const session = this.sessions.get(conversation);
		if (!session) throw new Error("No voice session is starting on this conversation");
		session.attachMedia(offerId, clientKey, stream);
	}

	/** Throws unless `attachMedia` with the same arguments would admit a stream now; consumes nothing. */
	assertMediaOffer(conversation: HostedConversation, offerId: string, clientKey: string): void {
		const session = this.sessions.get(conversation);
		if (!session) throw new Error("No voice session is starting on this conversation");
		session.assertMediaOffer(offerId, clientKey);
	}

	/** The host stops: every session ends, joined. */
	async close(): Promise<void> {
		this.closed = true;
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.allSettled(sessions.map((session) => session.dispose()));
	}

	/** Safe counters for status and tests. */
	diagnostics(conversation: HostedConversation) {
		return this.sessions.get(conversation)?.diagnostics;
	}

	/** The service as the intents see it on a connection whose client process is `clientKey`. */
	intentServices(clientKey: string): IntentVoiceServices {
		return {
			availability: (conversation) => this.availability(conversation),
			start: (conversation, clientId, intentId, profile) =>
				this.start(conversation, { clientId, clientKey }, intentId, profile),
			stop: (conversation, clientId, epoch) => this.stop(conversation, { clientId, clientKey }, epoch),
			interrupt: (conversation, clientId, epoch) => this.interrupt(conversation, { clientId, clientKey }, epoch),
			publishAvailability: (conversation) => this.publishAvailability(conversation),
		};
	}
}

/** What the voice intents need from their host; `clientId` is the invoking client's control attachment. */
export interface IntentVoiceServices {
	availability(conversation: HostedConversation): VoiceAvailability;
	/** Throws `VoiceStartError`. `profile` is the invoking connection's projection: what the owner may hear. */
	start(
		conversation: HostedConversation,
		clientId: string,
		intentId: string | undefined,
		profile: Profile,
	): VoiceStartOutput;
	/** False when `epoch` is not the live one; throws `VoiceStartError` for a non-owner. */
	stop(conversation: HostedConversation, clientId: string, epoch: number): Promise<boolean>;
	interrupt(conversation: HostedConversation, clientId: string, epoch: number): boolean;
	/** Publish whether voice could start on `conversation` now, as a settings change left it. */
	publishAvailability(conversation: HostedConversation): void;
}
