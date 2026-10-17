/**
 * The TUI's voice (docs/daemon-voice-design.md, milestone 4): `/voice` and
 * the voice keys over a `VoiceClient` on the conversation the TUI shows,
 * with the installed audio tool the `voice.audio` setting picks. A start
 * says where audio goes and that anyone audible can prompt the
 * conversation; the footer shows whether voice listens, is muted, or speaks.
 * Voice ends when the TUI leaves the conversation and never restarts by
 * itself.
 */

import type { Duplex } from "node:stream";
import type { LiveVoiceValue, VoiceUnavailableReason } from "@hansjm10/volt-protocol";
import {
	findVoiceAudioTools,
	SpawnedVoiceAudio,
	VOICE_AUDIO_TOOLS,
	type VoiceAudio,
	type VoiceAudioPreference,
} from "../../client/voice/audio-tools.ts";
import { VoiceClient } from "../../client/voice/voice-client.ts";
import type { VoiceSettings } from "../../core/settings-manager.ts";
import { DEFAULT_VOICE_PROVIDER } from "../../core/voice/voice-service.ts";
import { voiceStatusLabel } from "./client/footer-model.ts";
import type { TuiStore } from "./client/tui-store.ts";

const PREFERENCES: ReadonlySet<string> = new Set(["auto", ...Object.keys(VOICE_AUDIO_TOOLS)]);

/** The installed tools of `preference`, each capture and playback in a child process. */
function spawnedAudio(preference: VoiceAudioPreference): VoiceAudio | undefined {
	const tools = findVoiceAudioTools(preference);
	return tools === undefined ? undefined : new SpawnedVoiceAudio(tools);
}

export interface TuiVoiceHost {
	readonly store: TuiStore;
	/** The connector's media attachment; undefined when the TUI's host offers none. */
	readonly openVoiceMedia: ((sessionId: string, offerId: string) => Promise<Duplex>) | undefined;
	voiceSettings(): VoiceSettings;
	/** A transient status line. */
	showStatus(message: string): void;
	/** A notice that stays in the transcript. */
	showWarning(message: string): void;
	requestRender(): void;
	/** The TUI quits: its voice ends without a word. */
	isShuttingDown(): boolean;
	/** How the keys that mute and interrupt voice read, for the start notice; empty when unbound. */
	keyText(action: "app.voice.mute" | "app.voice.interrupt"): string;
	/** The microphone and speaker of `preference`'s tools; undefined when none is installed. Tests substitute it. */
	audioFor?(preference: VoiceAudioPreference): VoiceAudio | undefined;
}

/** Why voice cannot start, as the host's `voice` value says, for the user. */
export function voiceUnavailableMessage(reason: VoiceUnavailableReason): string {
	switch (reason) {
		case "disabled":
			return "Voice is off. It is experimental: enable it under Voice in /settings, then try again.";
		case "native_media_unavailable":
			return "Voice is unavailable: this installation lacks its optional media engine (werift and opusscript).";
		case "auth_unavailable":
			return "Voice needs an OpenAI Codex subscription sign-in. Use /login, then try again.";
		case "provider_unavailable":
			return "Voice is unavailable: the voice.provider setting names a provider this host does not have.";
		case "capacity":
			return "The host runs as many voice sessions as it allows. Stop voice elsewhere, then try again.";
		default:
			return `Voice is unavailable: ${reason}`;
	}
}

/** What to install for `preference` on `platform` when its tools are missing. */
export function missingAudioToolMessage(preference: VoiceAudioPreference, platform: NodeJS.Platform): string {
	if (preference !== "auto") {
		const tools = VOICE_AUDIO_TOOLS[preference];
		const commands =
			tools.capture.command === tools.playback.command
				? tools.capture.command
				: `${tools.capture.command} and ${tools.playback.command}`;
		return `voice.audio is "${preference}", but ${commands} ${commands.includes(" and ") ? "are" : "is"} not on PATH.`;
	}
	if (platform === "linux") {
		return "Voice needs an audio tool on PATH: parec and pacat (PulseAudio or PipeWire), sox, or arecord and aplay (ALSA).";
	}
	if (platform === "darwin") return "Voice needs SoX for the microphone and speaker: brew install sox";
	return "Voice needs SoX (sox) on PATH for the microphone and speaker.";
}

export class TuiVoice {
	private readonly host: TuiVoiceHost;
	private client: VoiceClient | undefined;

	constructor(host: TuiVoiceHost) {
		this.host = host;
	}

	/** Whether this TUI's voice is on: its keys mute and interrupt it. */
	get on(): boolean {
		return this.client?.state === "on";
	}

	/** The client's voice, for tests. */
	get current(): VoiceClient | undefined {
		return this.client;
	}

	/** `/voice [on|off|mute|unmute]`; without an argument, toggle voice. */
	async command(argument: string): Promise<void> {
		switch (argument) {
			case "":
				return this.toggle();
			case "on":
				return this.start();
			case "off":
				return this.stop();
			case "mute":
			case "unmute":
				if (!this.setMuted(argument === "mute")) this.host.showStatus("Voice is off");
				return;
			default:
				this.host.showWarning("Usage: /voice [on|off|mute|unmute]");
		}
	}

	async toggle(): Promise<void> {
		if (this.client !== undefined && this.client.state !== "off") return this.stop();
		return this.start();
	}

	private voiceValue(): LiveVoiceValue | undefined {
		const value = this.host.store.value("voice");
		return value?.kind === "voice" ? value : undefined;
	}

	async start(): Promise<void> {
		if (this.client !== undefined && this.client.state !== "off") {
			this.host.showStatus("Voice is already on");
			return;
		}
		const openVoiceMedia = this.host.openVoiceMedia;
		const conversation = this.host.store.conversation;
		if (openVoiceMedia === undefined) {
			this.host.showWarning("Voice needs the Volt daemon to host the conversation.");
			return;
		}
		if (conversation === undefined) {
			this.host.showWarning("Voice needs a conversation: wait until it shows, then try again.");
			return;
		}
		const value = this.voiceValue();
		if (value === undefined) {
			this.host.showWarning("This host does not offer voice.");
			return;
		}
		if (!value.availability.available && value.lifecycle === "off") {
			this.host.showWarning(voiceUnavailableMessage(value.availability.reason));
			return;
		}
		const settings = this.host.voiceSettings();
		const preference = settings.audio ?? "auto";
		if (!PREFERENCES.has(preference)) {
			this.host.showWarning(`voice.audio must be one of ${[...PREFERENCES].join(", ")}.`);
			return;
		}
		const audio = this.host.audioFor ? this.host.audioFor(preference) : spawnedAudio(preference);
		if (audio === undefined) {
			this.host.showWarning(missingAudioToolMessage(preference, process.platform));
			return;
		}
		const duplex = settings.duplex === "full" ? "full" : "half";
		const client = new VoiceClient({
			client: this.host.store.client,
			openMedia: (offerId) => openVoiceMedia(conversation, offerId),
			audio,
			duplex,
			onChange: () => this.host.requestRender(),
			onEnded: (reason) => {
				if (this.client === client) this.client = undefined;
				if (this.host.isShuttingDown()) return;
				if (reason === undefined) this.host.showStatus("Voice stopped");
				else this.host.showWarning(`Voice ended: ${reason}`);
				this.host.requestRender();
			},
		});
		this.client = client;
		this.host.showWarning(
			`Voice sends your microphone audio and the assistant's replies to the voice provider (${settings.provider ?? DEFAULT_VOICE_PROVIDER}), ` +
				"whichever model /model uses. What you say is sent as your message as soon as you finish speaking, " +
				"and anyone audible to the microphone can prompt this conversation.",
		);
		try {
			await client.start();
		} catch (error) {
			if (this.client === client) this.client = undefined;
			this.host.showWarning(`Could not start voice: ${error instanceof Error ? error.message : String(error)}`);
			this.host.requestRender();
			return;
		}
		const keys = [
			this.keyHint("app.voice.mute", "mutes"),
			this.keyHint("app.voice.interrupt", "stops speech"),
			"/voice off stops voice",
		].filter((hint) => hint !== undefined);
		const echo =
			duplex === "half"
				? ' The microphone is silent while voice speaks; with headphones, set voice.duplex to "full" to talk over it.'
				: "";
		this.host.showStatus(`Voice is on (${audio.label}): ${keys.join(", ")}.${echo}`);
	}

	private keyHint(action: "app.voice.mute" | "app.voice.interrupt", what: string): string | undefined {
		const key = this.host.keyText(action);
		return key === "" ? undefined : `${key} ${what}`;
	}

	async stop(): Promise<void> {
		const client = this.client;
		if (client === undefined || client.state === "off") {
			this.host.showStatus("Voice is off");
			return;
		}
		await client.stop();
	}

	/** Mute or unmute the microphone; false when voice is off. */
	setMuted(muted: boolean): boolean {
		return this.client?.setMuted(muted) ?? false;
	}

	/** Toggle the microphone; false when voice is off. */
	toggleMute(): boolean {
		return this.client?.setMuted(!this.client.muted) ?? false;
	}

	/** Stop what voice says; false when voice is off. */
	interrupt(): boolean {
		return this.client?.interrupt() ?? false;
	}

	/** The conversation's live state changed: the host may have ended this TUI's voice. */
	observe(): void {
		this.client?.observe(this.voiceValue());
	}

	/** The footer's voice status. */
	footerLabel(connectionId: string | undefined): string | undefined {
		const client = this.client;
		const local =
			client === undefined ? undefined : { state: client.state, muted: client.muted, playing: client.playing };
		return voiceStatusLabel(this.voiceValue(), local, connectionId);
	}

	/** The TUI leaves the conversation its voice runs on: voice ends here, and on the host as the TUI detaches. */
	leave(): void {
		const client = this.client;
		this.client = undefined;
		client?.dispose("The TUI left the conversation");
	}
}
