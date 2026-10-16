/**
 * Local self-test without any provider: two media engines in one process
 * exchange SDP directly, one streams a WAV clip to the other, and the
 * receiver's decoded loudness is checked. Verifies werift ICE/DTLS/SRTP,
 * Opus encode/decode, the RTP pacer, and clean shutdown on this machine.
 */

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MediaEngine } from "./media.ts";
import { frames, readWav, resampleTo24k, rms, sliceMs, toDbfs } from "./pcm.ts";

const { values } = parseArgs({ options: { wav: { type: "string" }, "end-ms": { type: "string" } } });
if (!values.wav) {
	console.error("usage: node --conditions=volt-source src/selftest.ts --wav <file.wav> [--end-ms N]");
	process.exit(2);
}
const clip = readWav(resolve(values.wav));
const samples = sliceMs(resampleTo24k(clip), 0, values["end-ms"] === undefined ? undefined : Number(values["end-ms"]));
const clipFrames = frames(samples);
console.error(`clip: ${clip.sampleRate} Hz -> 24 kHz, ${clipFrames.length} frames, source rms ${toDbfs(rms(samples)).toFixed(1)} dBFS`);

const started = performance.now();
const caller = new MediaEngine({ onConnectionState: (state) => console.error(`caller: ${state}`) });
const callee = new MediaEngine({ onConnectionState: (state) => console.error(`callee: ${state}`) });

const offer = await caller.createOffer();
console.error(`offer: ${offer.length} bytes, candidates ${caller.localCandidateTypes().join(",")}`);
await callee.peer.setRemoteDescription({ type: "offer", sdp: offer });
const answer = await callee.peer.createAnswer();
await callee.peer.setLocalDescription(answer);
await caller.acceptAnswer(callee.peer.localDescription!.sdp);
await Promise.all([caller.waitConnected(15_000), callee.waitConnected(15_000)]);
await Promise.all([caller.waitRemoteTrack(5_000), callee.waitRemoteTrack(5_000)]);
console.error(`connected in ${Math.round(performance.now() - started)} ms, codec ${caller.negotiatedCodec()}`);

await caller.sendFrames(clipFrames);
await new Promise((resolve) => setTimeout(resolve, 300));
const received = callee.receive;
console.error(
	`callee received ${received.packets} packets, ${received.decodedSamples / 24_000}s decoded, ${received.nonSilentFrames} loud frames, peak ${toDbfs(received.peakRms).toFixed(1)} dBFS, decode failures ${received.decodeFailures}`,
);
await caller.close();
await callee.close();
const ok = received.packets >= clipFrames.length * 0.9 && received.nonSilentFrames > 0 && received.decodeFailures === 0;
console.error(ok ? "selftest: ok" : "selftest: FAILED");
setTimeout(() => {
	console.error(`selftest: process did not exit; lingering ${process.getActiveResourcesInfo().join(",")}`);
	process.exit(3);
}, 3000).unref();
process.exitCode = ok ? 0 : 1;
