/**
 * The TUI's voice (docs/daemon-voice-design.md, milestone 4): `/voice` and
 * the voice keys as the TUI runs them, over its daemon connector, against
 * the real daemon and an in-process worker with the fake voice provider. The
 * microphone and speaker are stand-ins; the media attachment, envelopes,
 * ownership, and endings are real.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { VOICE_FRAME_SAMPLES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectThrough } from "../src/client/conversation-connector.ts";
import type { ProtocolClient } from "../src/client/protocol-client.ts";
import type { VoiceAudio, VoiceCapture, VoiceCaptureHandlers, VoicePlayback } from "../src/client/voice/audio-tools.ts";
import { VOICE_ECHO_TAIL_MS } from "../src/client/voice/voice-client.ts";
import type { ConversationOpenTarget } from "../src/daemon/control-protocol.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { TuiStore } from "../src/modes/interactive/client/tui-store.ts";
import { DaemonConnector, type DaemonConnectorDaemon } from "../src/modes/interactive/daemon-connector.ts";
import { missingAudioToolMessage, TuiVoice, voiceUnavailableMessage } from "../src/modes/interactive/voice-control.ts";
import { FakeVoiceProvider } from "./fixtures/fake-voice-provider.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { InProcessWorkerLauncher } from "./suite/in-process-worker-launcher.ts";
import { untilVoice, voiceValue } from "./suite/voice-fixture-client.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

class FakeCapture implements VoiceCapture {
	readonly handlers: VoiceCaptureHandlers;
	stopped = false;

	constructor(handlers: VoiceCaptureHandlers) {
		this.handlers = handlers;
	}

	/** The microphone hears a flat tone of `level`. */
	hear(level: number): void {
		const frame = Buffer.alloc(VOICE_FRAME_SAMPLES * 2);
		for (let index = 0; index < VOICE_FRAME_SAMPLES; index++) frame.writeInt16LE(level, index * 2);
		this.handlers.onFrame(frame);
	}

	fail(message: string): void {
		this.handlers.onFailure(message);
	}

	stop(): void {
		this.stopped = true;
	}
}

class FakePlayback implements VoicePlayback {
	/** The first sample of each frame played. */
	readonly played: number[] = [];
	flushes = 0;
	closed = false;

	write(frame: Buffer): boolean {
		if (this.closed) return false;
		this.played.push(frame.readInt16LE(0));
		return true;
	}

	flush(): void {
		this.flushes += 1;
	}

	close(): void {
		this.closed = true;
	}
}

class FakeAudio implements VoiceAudio {
	readonly label = "fake";
	readonly captures: FakeCapture[] = [];
	readonly playbacks: FakePlayback[] = [];

	openCapture(handlers: VoiceCaptureHandlers): FakeCapture {
		const capture = new FakeCapture(handlers);
		this.captures.push(capture);
		return capture;
	}

	openPlayback(): FakePlayback {
		const playback = new FakePlayback();
		this.playbacks.push(playback);
		return playback;
	}
}

interface Tui {
	readonly client: ProtocolClient;
	readonly store: TuiStore;
	readonly voice: TuiVoice;
	readonly audio: FakeAudio;
	readonly statuses: string[];
	readonly warnings: string[];
	/** Whether the TUI finds an audio tool. */
	audioInstalled: boolean;
	footer(): string | undefined;
}

/** The harness's daemon, reached as the connector reaches one: running already. */
function harnessDaemon(agentDir: string): DaemonConnectorDaemon {
	return {
		ensure: async () => ({ ...(await probeDaemon(agentDir)), spawned: false }),
		probe: (dir) => probeDaemon(dir),
		waitForExit: async () => "exited",
		isServiceProcess: async () => false,
	};
}

async function startHarness(options: { enabled?: boolean } = {}) {
	const provider = new FakeVoiceProvider();
	const harness = await createDaemonHarness({
		workerLauncher: new InProcessWorkerLauncher({ voiceProviders: new Map([["fake", provider]]) }),
		settings: { voice: { enabled: options.enabled ?? true, provider: "fake" } },
	});
	cleanups.push(() => harness.dispose());
	vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.agentDir);
	return { harness, provider };
}

/** A TUI process: its own connector (and client key), store, and voice, as interactive mode wires them. */
async function startTui(harness: DaemonHarness, target: ConversationOpenTarget = { kind: "new" }): Promise<Tui> {
	const cwd = harness.workspacePath;
	const connector = new DaemonConnector({
		agentDir: harness.agentDir,
		startup: { target, cwd },
		spawn: { env: {}, config: {}, cwd, persist: true, session: {} },
		daemon: harnessDaemon(harness.agentDir),
	});
	cleanups.push(() => connector.dispose());
	const store = new TuiStore();
	const client = await connectThrough(connector, { onClient: (connected) => store.attach(connected) });
	cleanups.push(() => client.stop());
	const audio = new FakeAudio();
	const statuses: string[] = [];
	const warnings: string[] = [];
	const tui: Tui = {
		client,
		store,
		audio,
		statuses,
		warnings,
		audioInstalled: true,
		voice: new TuiVoice({
			store,
			openVoiceMedia: connector.openVoiceMedia.bind(connector),
			voiceSettings: () => ({ provider: "fake" }),
			showStatus: (message) => statuses.push(message),
			showWarning: (message) => warnings.push(message),
			requestRender: () => undefined,
			isShuttingDown: () => false,
			keyText: (action) => (action === "app.voice.mute" ? "alt+m" : "alt+s"),
			audioFor: () => (tui.audioInstalled ? audio : undefined),
		}),
		footer: () => tui.voice.footerLabel(client.connectionId),
	};
	store.subscribe(() => tui.voice.observe());
	cleanups.push(() => tui.voice.leave());
	return tui;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the TUI's voice", () => {
	it("starts with /voice, carries the microphone up and voice down, mutes by closing the microphone, and stops without touching the agent", async () => {
		const { harness, provider } = await startHarness();
		const tui = await startTui(harness);
		await untilVoice(tui.client, (value) => value.availability.available, "voice available");
		expect(tui.footer()).toBeUndefined();

		await tui.voice.command("");
		expect(tui.warnings).toEqual([
			expect.stringContaining("to the voice provider (fake), whichever model /model uses"),
		]);
		expect(tui.statuses.at(-1)).toBe(
			'Voice is on (fake): alt+m mutes, alt+s stops speech, /voice off stops voice. The microphone is silent while voice speaks; with headphones, set voice.duplex to "full" to talk over it.',
		);
		await untilVoice(tui.client, (value) => value.lifecycle === "active", "active");
		expect(voiceValue(tui.client)?.owner?.client).toBe(tui.client.connectionId);
		expect(tui.footer()).toBe("voice: listening");

		const capture = tui.audio.captures[0]!;
		for (let index = 0; index < 3; index++) capture.hear(1234);
		await expect.poll(() => provider.current.frames.length).toBe(3);
		expect(provider.current.frames.every((frame) => frame.every((sample) => sample === 1234))).toBe(true);
		await untilVoice(tui.client, (value) => value.input === "listening", "listening");

		harness.faux.setResponses([fauxAssistantMessage("The tests pass.")]);
		provider.current.emit({ type: "user_turn_completed", turnId: "t1", transcript: "do the tests pass" });
		await expect.poll(() => provider.current.appended.length, { timeout: 10_000 }).toBe(1);

		// Voice speaks half a second: the speaker plays it, and the microphone sends silence meanwhile.
		const playback = tui.audio.playbacks[0]!;
		provider.current.emit({ type: "assistant_turn_started" });
		for (let index = 0; index < 25; index++) {
			provider.current.emit({ type: "audio", frame: new Int16Array(VOICE_FRAME_SAMPLES).fill(321) });
		}
		await expect.poll(() => playback.played.length).toBe(25);
		expect(tui.footer()).toBe("voice: speaking");
		capture.hear(1234);
		await expect.poll(() => provider.current.frames.length).toBe(4);
		expect(provider.current.frames[3]!.every((sample) => sample === 0)).toBe(true);
		// After it played and the echo tail passed, the microphone is heard again.
		await sleep(500 + VOICE_ECHO_TAIL_MS + 100);
		expect(tui.footer()).toBe("voice: listening");
		capture.hear(1234);
		await expect.poll(() => provider.current.frames.length).toBe(5);
		expect(provider.current.frames[4]!.every((sample) => sample === 1234)).toBe(true);

		// An interruption silences the speaker at once and discards the rest of what was said.
		provider.current.emit({ type: "assistant_turn_started" });
		provider.current.emit({ type: "audio", frame: new Int16Array(VOICE_FRAME_SAMPLES).fill(555) });
		await expect.poll(() => playback.played.at(-1)).toBe(555);
		expect(tui.voice.interrupt()).toBe(true);
		expect(playback.flushes).toBe(1);
		// Sent before the host heard the interruption: the TUI drops it.
		provider.current.emit({ type: "audio", frame: new Int16Array(VOICE_FRAME_SAMPLES).fill(666) });
		await expect.poll(() => provider.current.interrupts).toBe(1);
		await expect.poll(() => playback.flushes).toBe(2);
		expect(playback.played).not.toContain(666);
		expect(tui.voice.current?.diagnostics?.framesDroppedDown).toBe(1);
		provider.current.emit({ type: "assistant_turn_started" });
		provider.current.emit({ type: "audio", frame: new Int16Array(VOICE_FRAME_SAMPLES).fill(777) });
		await expect.poll(() => playback.played.at(-1)).toBe(777);
		expect(tui.client.phase?.operation ?? null).toBeNull();

		// Muting closes the microphone; unmuting opens a new one.
		expect(tui.voice.toggleMute()).toBe(true);
		expect(capture.stopped).toBe(true);
		expect(tui.footer()).toBe("voice: muted");
		await untilVoice(tui.client, (value) => value.input === "muted", "muted");
		expect(provider.current.muteChanges.at(-1)).toBe(true);
		capture.hear(1234);
		await sleep(50);
		expect(provider.current.frames).toHaveLength(5);
		await tui.voice.command("unmute");
		expect(tui.audio.captures).toHaveLength(2);
		expect(tui.footer()).toBe("voice: listening");
		// The host hears the unmute with the new microphone's first frame, however long the tool takes to start.
		await sleep(50);
		expect(voiceValue(tui.client)?.input).toBe("muted");
		tui.audio.captures[1]!.hear(1234);
		await untilVoice(tui.client, (value) => value.input === "listening", "listening again");
		expect(provider.current.frames).toHaveLength(6);

		await tui.voice.command("off");
		expect(tui.statuses.at(-1)).toBe("Voice stopped");
		await untilVoice(tui.client, (value) => value.lifecycle === "off", "off");
		expect(provider.current.closed).toBe(true);
		expect(tui.audio.captures[1]!.stopped).toBe(true);
		expect(playback.closed).toBe(true);
		expect(tui.footer()).toBeUndefined();
		// Nothing else was reported, and the conversation serves on.
		expect(tui.warnings).toHaveLength(1);
		harness.faux.setResponses([fauxAssistantMessage("still here")]);
		await tui.client.promptAndWait("typed after voice");
	}, 60_000);

	it("ends once, saying why, when the microphone fails, when the host ends voice, and when the TUI leaves", async () => {
		const { harness, provider } = await startHarness();
		const tui = await startTui(harness);
		await untilVoice(tui.client, (value) => value.availability.available, "voice available");
		const ended = () => tui.warnings.filter((warning) => warning.startsWith("Voice ended: "));

		await tui.voice.command("on");
		await untilVoice(tui.client, (value) => value.lifecycle === "active", "active");
		// A burst beyond real time (a tool's startup backlog) is dropped as stale rather than sent to overrun the host.
		for (let index = 0; index < 30; index++) tui.audio.captures[0]!.hear(1);
		await expect.poll(() => provider.current.frames.length).toBeGreaterThan(0);
		await sleep(100);
		const sent = provider.current.frames.length;
		expect(sent).toBeLessThanOrEqual(6);
		expect(tui.voice.current?.diagnostics?.framesDroppedUp).toBe(30 - sent);
		expect(voiceValue(tui.client)?.lifecycle).toBe("active");
		tui.audio.captures[0]!.fail("pacat exited with code 1: device unplugged");
		expect(ended()).toEqual(["Voice ended: Microphone: pacat exited with code 1: device unplugged"]);
		expect(tui.voice.on).toBe(false);
		expect(tui.audio.playbacks[0]!.closed).toBe(true);
		// The TUI stopped it on the host too.
		await untilVoice(tui.client, (value) => value.lifecycle === "off", "off");
		expect(voiceValue(tui.client)?.error).toBeUndefined();
		expect(provider.sessions[0]!.closed).toBe(true);

		await tui.voice.command("on");
		await untilVoice(tui.client, (value) => value.lifecycle === "active" && value.epoch === 2, "active again");
		provider.current.emit({ type: "failed", code: "provider_failed" });
		await expect.poll(() => ended().length).toBe(2);
		await untilVoice(tui.client, (value) => value.lifecycle === "off", "off again");
		expect(ended()[1]).toBe(`Voice ended: ${voiceValue(tui.client)?.error?.message}`);
		expect(tui.audio.captures[1]!.stopped).toBe(true);

		await tui.voice.command("on");
		await untilVoice(tui.client, (value) => value.lifecycle === "active" && value.epoch === 3, "active a third time");
		tui.voice.leave();
		expect(ended()[2]).toBe("Voice ended: The TUI left the conversation");
		await untilVoice(tui.client, (value) => value.lifecycle === "off", "off a third time");
		expect(voiceValue(tui.client)?.error?.code).toBe("media_lost");
		expect(provider.current.closed).toBe(true);
		expect(ended()).toHaveLength(3);
	}, 60_000);

	it("shows another client's voice and refuses to take it, and refuses without an audio tool", async () => {
		const { harness } = await startHarness();
		const owner = await startTui(harness);
		await untilVoice(owner.client, (value) => value.availability.available, "voice available");
		await owner.voice.command("on");
		await untilVoice(owner.client, (value) => value.lifecycle === "active", "active");

		const sessionId = owner.store.conversation;
		if (sessionId === undefined) throw new Error("the owner shows no conversation");
		const other = await startTui(harness, { kind: "session", sessionId });
		await untilVoice(other.client, (value) => value.lifecycle === "active", "the owner's voice");
		expect(other.footer()).toBe("voice: another client");
		await other.voice.command("on");
		expect(other.warnings.at(-1)).toBe("Could not start voice: Another client owns voice on this conversation");
		expect(other.voice.on).toBe(false);
		expect(other.voice.interrupt()).toBe(false);
		expect(other.audio.captures).toHaveLength(0);
		expect(owner.voice.on).toBe(true);

		await owner.voice.command("off");
		await untilVoice(other.client, (value) => value.lifecycle === "off", "off");
		other.audioInstalled = false;
		await other.voice.command("on");
		expect(other.warnings.at(-1)).toBe(missingAudioToolMessage("auto", process.platform));
		expect(voiceValue(other.client)?.lifecycle).toBe("off");
	}, 60_000);

	it("says how to enable voice when the host has it off", async () => {
		const { harness } = await startHarness({ enabled: false });
		const tui = await startTui(harness);
		await untilVoice(tui.client, (value) => !value.availability.available, "voice unavailable");
		await tui.voice.command("on");
		expect(tui.warnings).toEqual([voiceUnavailableMessage("disabled")]);
		expect(tui.audio.captures).toHaveLength(0);
		await tui.voice.command("mute");
		expect(tui.statuses.at(-1)).toBe("Voice is off");
	}, 60_000);
});
