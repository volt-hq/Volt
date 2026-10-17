/**
 * A client's microphone and speaker for voice (docs/daemon-voice-design.md,
 * milestone 4): an installed audio tool in a child process captures and
 * plays raw PCM in the voice media format (signed 16-bit little-endian,
 * 24 kHz, mono). Volt links no audio library: PulseAudio's `parec` and
 * `pacat` (which PipeWire serves as well), SoX, or ALSA's `arecord` and
 * `aplay`. None of them cancels echo, so the voice client keeps its
 * microphone silent while it plays unless the user opts into full duplex.
 *
 * A capture runs from `openCapture` until `stop()`, and is not reused: a
 * muted client stops capturing. Playback starts its tool at the first frame
 * and kills it to drop what it holds (`flush()`), so an interruption is
 * silent at once rather than after the tool's buffers drain. A tool that
 * exits on its own is a failure, reported with the end of what it printed.
 */

import type { ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { VOICE_FRAME_BYTES, VOICE_LIMITS, VOICE_MEDIA_FORMAT } from "@hansjm10/volt-protocol";
import { spawnProcess } from "../../utils/child-process.ts";

export type VoiceAudioToolName = "pulse" | "sox" | "alsa";

/** The `voice.audio` setting: a tool by name, or the first one installed. */
export type VoiceAudioPreference = "auto" | VoiceAudioToolName;

export interface AudioCommand {
	readonly command: string;
	readonly args: readonly string[];
}

export interface VoiceAudioTools {
	readonly name: VoiceAudioToolName;
	readonly capture: AudioCommand;
	readonly playback: AudioCommand;
}

const RATE = String(VOICE_MEDIA_FORMAT.sampleRate);
const SOX_RAW = ["-t", "raw", "-r", RATE, "-e", "signed-integer", "-b", "16", "-c", "1", "-L"];
/** One frame per read and write: SoX's default buffer holds about 85 ms. */
const SOX_BUFFER = ["--buffer", String(VOICE_FRAME_BYTES)];
const ALSA_RAW = ["-q", "-t", "raw", "-f", "S16_LE", "-r", RATE, "-c", "1"];

export const VOICE_AUDIO_TOOLS: Readonly<Record<VoiceAudioToolName, VoiceAudioTools>> = Object.freeze({
	pulse: {
		name: "pulse",
		capture: {
			command: "parec",
			args: ["--raw", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--latency-msec=20"],
		},
		playback: {
			command: "pacat",
			args: ["--playback", "--raw", "--format=s16le", `--rate=${RATE}`, "--channels=1", "--latency-msec=60"],
		},
	},
	sox: {
		name: "sox",
		capture: { command: "sox", args: ["-q", ...SOX_BUFFER, "-d", ...SOX_RAW, "-"] },
		playback: { command: "sox", args: ["-q", ...SOX_BUFFER, ...SOX_RAW, "-", "-d"] },
	},
	alsa: {
		name: "alsa",
		capture: { command: "arecord", args: [...ALSA_RAW, "--buffer-time=40000"] },
		playback: { command: "aplay", args: [...ALSA_RAW, "--buffer-time=80000"] },
	},
});

/** The tools `auto` tries on `platform`, in order. */
export function voiceAudioToolOrder(platform: NodeJS.Platform): readonly VoiceAudioToolName[] {
	return platform === "linux" ? ["pulse", "sox", "alsa"] : ["sox"];
}

/** Whether `command` is an executable file on `env`'s PATH. */
function onPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	// Windows matches extensions in any case; a lowercase copy finds them where a filesystem does not.
	const extensions =
		platform === "win32"
			? [
					"",
					...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
						.split(";")
						.filter(Boolean)
						.flatMap((extension) => [extension, extension.toLowerCase()]),
				]
			: [""];
	for (const directory of (env.PATH ?? env.Path ?? "").split(delimiter)) {
		if (!directory) continue;
		for (const extension of extensions) {
			const path = join(directory, command + extension);
			try {
				if (!statSync(path).isFile()) continue;
				accessSync(path, platform === "win32" ? constants.F_OK : constants.X_OK);
				return true;
			} catch {
				// Not here.
			}
		}
	}
	return false;
}

/** The tools `preference` names when both of their commands are installed; for `auto`, the first such. */
export function findVoiceAudioTools(
	preference: VoiceAudioPreference,
	options: { readonly platform?: NodeJS.Platform; readonly env?: NodeJS.ProcessEnv } = {},
): VoiceAudioTools | undefined {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const names = preference === "auto" ? voiceAudioToolOrder(platform) : [preference];
	for (const name of names) {
		const tools = VOICE_AUDIO_TOOLS[name];
		if (onPath(tools.capture.command, env, platform) && onPath(tools.playback.command, env, platform)) return tools;
	}
	return undefined;
}

// ============================================================================
// Running audio
// ============================================================================

/** A running capture: frames reach its handler until `stop()`. */
export interface VoiceCapture {
	stop(): void;
}

export interface VoicePlayback {
	/** Queue one frame; false when it was dropped because the speaker is too far behind. */
	write(frame: Buffer): boolean;
	/** Drop what is queued or playing, at once. */
	flush(): void;
	close(): void;
}

export interface VoiceCaptureHandlers {
	/** One frame of exactly `VOICE_FRAME_BYTES`; valid only during the call. */
	onFrame(frame: Buffer): void;
	onFailure(message: string): void;
}

/** A client's microphone and speaker. */
export interface VoiceAudio {
	/** What the client tells its user it captures with. */
	readonly label: string;
	openCapture(handlers: VoiceCaptureHandlers): VoiceCapture;
	openPlayback(handlers: { onFailure(message: string): void }): VoicePlayback;
}

/** How much of what an audio tool printed a failure shows. */
const STDERR_TAIL_BYTES = 512;
/** Audio queued for the speaker beyond what its tool took: as much as the media budget allows a direction. */
const PLAYBACK_QUEUE_BYTES = (VOICE_LIMITS.queuedAudioMs / VOICE_MEDIA_FORMAT.frameMs) * VOICE_FRAME_BYTES;

/** Keep the end of a child's stderr, for its failure. */
function stderrTail(child: ChildProcess): () => string {
	let tail = Buffer.alloc(0);
	child.stderr?.on("data", (chunk: Buffer) => {
		tail = Buffer.concat([tail, chunk]);
		if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
	});
	return () =>
		tail
			.toString("utf8")
			.replace(/[\u0000-\u001f\u007f]+/g, " ")
			.trim();
}

/** Watch `child` until `isStopped()`: an error, or an exit it was not asked for, is a failure. */
function watchChild(
	child: ChildProcess,
	command: string,
	isStopped: () => boolean,
	onFailure: (message: string) => void,
): void {
	const tail = stderrTail(child);
	let reported = false;
	const report = (message: string) => {
		if (reported || isStopped()) return;
		reported = true;
		onFailure(message);
	};
	child.on("error", (error) => report(`${command}: ${error.message}`));
	child.on("exit", (code, signal) => {
		const printed = tail();
		const how = signal === null ? `with code ${code}` : `on ${signal}`;
		report(`${command} exited ${how}${printed ? `: ${printed}` : ""}`);
	});
}

/** The voice audio of an installed tool, each capture and playback in its own child process. */
export class SpawnedVoiceAudio implements VoiceAudio {
	private readonly tools: VoiceAudioTools;
	readonly label: string;

	constructor(tools: VoiceAudioTools) {
		this.tools = tools;
		this.label = `${tools.capture.command}/${tools.playback.command}`;
	}

	openCapture(handlers: VoiceCaptureHandlers): VoiceCapture {
		const { command, args } = this.tools.capture;
		let stopped = false;
		const child = spawnProcess(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		watchChild(child, command, () => stopped, handlers.onFailure);
		let pending = Buffer.alloc(0);
		child.stdout?.on("data", (chunk: Buffer) => {
			if (stopped) return;
			let bytes = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
			while (bytes.length >= VOICE_FRAME_BYTES && !stopped) {
				handlers.onFrame(bytes.subarray(0, VOICE_FRAME_BYTES));
				bytes = bytes.subarray(VOICE_FRAME_BYTES);
			}
			pending = Buffer.from(bytes);
		});
		return {
			stop() {
				if (stopped) return;
				stopped = true;
				child.stdout?.destroy();
				child.kill("SIGTERM");
			},
		};
	}

	openPlayback(handlers: { onFailure(message: string): void }): VoicePlayback {
		const { command, args } = this.tools.playback;
		let player: { readonly child: ChildProcess; stopped: boolean } | undefined;
		let closed = false;
		const kill = () => {
			const current = player;
			player = undefined;
			if (!current) return;
			current.stopped = true;
			current.child.stdin?.destroy();
			current.child.kill("SIGKILL");
		};
		const start = () => {
			const child = spawnProcess(command, [...args], { stdio: ["pipe", "ignore", "pipe"] });
			const started = { child, stopped: false };
			watchChild(
				child,
				command,
				() => started.stopped,
				(message) => {
					if (player === started) player = undefined;
					handlers.onFailure(message);
				},
			);
			// A player that died closes its input; the exit reports why.
			child.stdin?.on("error", () => undefined);
			player = started;
			return started;
		};
		return {
			write(frame) {
				if (closed) return false;
				const stdin = (player ?? start()).child.stdin;
				if (!stdin || stdin.destroyed || stdin.writableLength >= PLAYBACK_QUEUE_BYTES) return false;
				stdin.write(Buffer.from(frame));
				return true;
			},
			flush: kill,
			close() {
				closed = true;
				kill();
			},
		};
	}
}
