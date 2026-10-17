/**
 * The TUI's audio tools for voice (docs/daemon-voice-design.md, milestone 4):
 * which installed tool `voice.audio` finds, and how a spawned capture and
 * playback behave, exercised with stand-in tools (Node scripts) that record
 * their arguments, print PCM, or swallow it, since CI has no sound devices.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { VOICE_FRAME_BYTES } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	findVoiceAudioTools,
	SpawnedVoiceAudio,
	VOICE_AUDIO_TOOLS,
	type VoiceAudioTools,
} from "../src/client/voice/audio-tools.ts";
import { missingAudioToolMessage } from "../src/modes/interactive/voice-control.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-voice-audio-"));
	roots.push(root);
	return root;
}

/** A directory of empty executables named `names`. */
function pathWith(...names: string[]): string {
	const dir = tempDir();
	for (const name of names) {
		writeFileSync(join(dir, name), "");
		chmodSync(join(dir, name), 0o755);
	}
	return dir;
}

/** A stand-in tool: a Node script at an absolute path that records its argv to `<path>.args`, then runs `body`. */
function standIn(dir: string, name: string, body: string): string {
	const path = join(dir, name);
	writeFileSync(
		path,
		`#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(${JSON.stringify(`${path}.args`)}, JSON.stringify(process.argv.slice(2)));\n${body}\n`,
	);
	chmodSync(path, 0o755);
	return path;
}

function recordedArgs(path: string): string[] {
	return JSON.parse(readFileSync(`${path}.args`, "utf8")) as string[];
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("finding voice audio tools", () => {
	it("prefers PulseAudio, then SoX, then ALSA on Linux, and needs both commands of a tool", () => {
		const linux = (dir: string) => findVoiceAudioTools("auto", { platform: "linux", env: { PATH: dir } })?.name;
		expect(linux(pathWith("parec", "pacat", "sox", "arecord", "aplay"))).toBe("pulse");
		expect(linux(pathWith("pacat", "sox", "arecord", "aplay"))).toBe("sox");
		expect(linux(pathWith("parec", "arecord", "aplay"))).toBe("alsa");
		expect(linux(pathWith("parec", "aplay"))).toBeUndefined();
		// Across PATH entries.
		expect(linux([pathWith("parec"), pathWith("pacat")].join(delimiter))).toBe("pulse");
	});

	it("uses SoX elsewhere, the named tool when the setting names one, and never a directory", () => {
		const both = pathWith("parec", "pacat", "sox");
		expect(findVoiceAudioTools("auto", { platform: "darwin", env: { PATH: both } })?.name).toBe("sox");
		expect(findVoiceAudioTools("auto", { platform: "darwin", env: { PATH: pathWith("parec", "pacat") } })).toBe(
			undefined,
		);
		expect(findVoiceAudioTools("alsa", { platform: "linux", env: { PATH: both } })).toBeUndefined();
		expect(findVoiceAudioTools("sox", { platform: "linux", env: { PATH: both } })?.name).toBe("sox");
		const dir = tempDir();
		mkdirSync(join(dir, "sox"));
		expect(findVoiceAudioTools("auto", { platform: "darwin", env: { PATH: dir } })).toBeUndefined();
		// Windows names executables by their extension.
		expect(
			findVoiceAudioTools("auto", { platform: "win32", env: { PATH: pathWith("sox.exe"), PATHEXT: ".EXE" } })?.name,
		).toBe("sox");
	});

	it("says what to install", () => {
		expect(missingAudioToolMessage("auto", "darwin")).toContain("brew install sox");
		expect(missingAudioToolMessage("auto", "linux")).toContain("parec and pacat");
		expect(missingAudioToolMessage("pulse", "linux")).toBe(
			'voice.audio is "pulse", but parec and pacat are not on PATH.',
		);
		expect(missingAudioToolMessage("sox", "linux")).toBe('voice.audio is "sox", but sox is not on PATH.');
	});
});

describe.skipIf(process.platform === "win32")("spawned voice audio", () => {
	function pulseWith(capture: string, playback: string): VoiceAudioTools {
		return {
			name: "pulse",
			capture: { ...VOICE_AUDIO_TOOLS.pulse.capture, command: capture },
			playback: { ...VOICE_AUDIO_TOOLS.pulse.playback, command: playback },
		};
	}

	it("captures 24 kHz mono s16le in whole frames, in order, until stopped", async () => {
		const dir = tempDir();
		// 10.5 frames in uneven writes, then the tool keeps running as a microphone does.
		const total = Math.floor(VOICE_FRAME_BYTES * 10.5);
		const parec = standIn(
			dir,
			"parec",
			`const bytes = Buffer.alloc(${total}); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
			 for (let at = 0; at < bytes.length; at += 333) process.stdout.write(bytes.subarray(at, at + 333));
			 setInterval(() => {}, 1000);`,
		);
		const audio = new SpawnedVoiceAudio(pulseWith(parec, join(dir, "pacat")));
		const frames: Buffer[] = [];
		const failures: string[] = [];
		const capture = audio.openCapture({
			onFrame: (frame) => frames.push(Buffer.from(frame)),
			onFailure: (message) => failures.push(message),
		});
		await until(() => frames.length === 10, "ten frames");
		expect(frames.every((frame) => frame.length === VOICE_FRAME_BYTES)).toBe(true);
		const joined = Buffer.concat(frames);
		expect(joined.every((byte, index) => byte === index % 251)).toBe(true);
		expect(recordedArgs(parec)).toEqual(
			expect.arrayContaining(["--raw", "--format=s16le", "--rate=24000", "--channels=1"]),
		);
		capture.stop();
		await new Promise((resolve) => setTimeout(resolve, 200));
		// A stop is not a failure.
		expect(failures).toEqual([]);
	});

	it("reports a capture tool that fails, with what it printed, and one that is missing", async () => {
		const dir = tempDir();
		const parec = standIn(dir, "parec", `process.stderr.write("Connection failure: refused\\n"); process.exit(1);`);
		const failures: string[] = [];
		new SpawnedVoiceAudio(pulseWith(parec, join(dir, "pacat"))).openCapture({
			onFrame: () => undefined,
			onFailure: (message) => failures.push(message),
		});
		await until(() => failures.length === 1, "the failure");
		expect(failures[0]).toBe(`${parec} exited with code 1: Connection failure: refused`);

		const missing: string[] = [];
		new SpawnedVoiceAudio(pulseWith(join(dir, "absent"), join(dir, "pacat"))).openCapture({
			onFrame: () => undefined,
			onFailure: (message) => missing.push(message),
		});
		await until(() => missing.length === 1, "the missing tool");
		expect(missing[0]).toContain("ENOENT");
	});

	it("plays frames through the tool, starts it again after a flush, and bounds what a stuck tool is given", async () => {
		const dir = tempDir();
		const out = join(dir, "played");
		const pacat = standIn(
			dir,
			"pacat",
			`process.stdin.on("data", (chunk) => fs.appendFileSync(${JSON.stringify(out)}, chunk));`,
		);
		const failures: string[] = [];
		const audio = new SpawnedVoiceAudio(pulseWith(join(dir, "parec"), pacat));
		const playback = audio.openPlayback({ onFailure: (message) => failures.push(message) });
		const frame = Buffer.alloc(VOICE_FRAME_BYTES, 7);
		expect(playback.write(frame)).toBe(true);
		expect(playback.write(frame)).toBe(true);
		await until(() => {
			try {
				return readFileSync(out).length === 2 * VOICE_FRAME_BYTES;
			} catch {
				return false;
			}
		}, "two played frames");
		expect(recordedArgs(pacat)).toEqual(
			expect.arrayContaining(["--playback", "--raw", "--format=s16le", "--rate=24000", "--channels=1"]),
		);
		// A flush kills the tool; the next frame starts another.
		playback.flush();
		expect(playback.write(frame)).toBe(true);
		await until(() => readFileSync(out).length === 3 * VOICE_FRAME_BYTES, "the frame after the flush");
		playback.close();
		expect(playback.write(frame)).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(failures).toEqual([]);

		// A tool that never reads: the pipe fills, then frames are dropped rather than queued without bound.
		const stuck = standIn(dir, "stuck", "setInterval(() => {}, 1000);");
		const stuckPlayback = new SpawnedVoiceAudio(pulseWith(join(dir, "parec"), stuck)).openPlayback({
			onFailure: (message) => failures.push(message),
		});
		let accepted = 0;
		for (let index = 0; index < 500; index++) if (stuckPlayback.write(frame)) accepted += 1;
		expect(accepted).toBeLessThan(500);
		stuckPlayback.close();
	});
});
