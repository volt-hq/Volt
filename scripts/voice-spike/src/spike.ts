/**
 * Daemon-voice milestone 1: native feasibility spike.
 *
 * Proves, against the already-authorized Codex subscription and without a
 * browser or the Codex CLI, that a headless Node process can:
 *   1. open a `gpt-live-1-codex` V3 WebRTC call with Volt's saved OAuth,
 *   2. stream prerecorded speech and receive a completed user turn whose
 *      transcript carries the complete expected phrase,
 *   3. receive non-silent spoken audio back,
 *   4. inject assistant text, standalone and correlated to a delegation,
 *      and hear it spoken,
 *   5. interrupt provider speech with new speech,
 *   6. close everything and exit cleanly.
 *
 * It records versions, durations, counts, and booleans. It never records
 * credentials, SDP, headers, audio, or transcript text (transcripts print
 * to stderr only with --show-transcripts).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { authFileFingerprint, loadCodexSubscriptionAuth } from "./auth.ts";
import { MediaEngine, type ReceiveStats, withTimeout } from "./media.ts";
import { frames, readWav, resampleTo24k, silenceFrames, sliceMs, toDbfs } from "./pcm.ts";
import {
	type ContextChannel,
	createLiveCall,
	LIVE_DEFAULT_VOICE,
	LIVE_MODEL,
	type LiveEvent,
	LiveSideband,
	newRealtimeSessionId,
} from "./signaling.ts";
import { containsMarker, matchTranscript, type TranscriptMatch } from "./transcript.ts";

const CODEX_REFERENCE = "openai/codex rust-v0.161.0";
/** Trailing silence after an utterance so server-side turn detection can end the turn. */
const TRAILING_SILENCE_MS = 1500;
const STANDALONE_MARKER = "The spike test number is forty two.";
const STANDALONE_MARKERS = ["forty two", "42"];
const DELEGATION_MARKER = "The delegated answer is purple elephant.";
const DELEGATION_MARKERS = ["purple elephant"];
const COMMENTARY_TEXT = "Still working on it, one moment.";
const LONG_SPEECH =
	"Here is a longer update so there is something to interrupt. " +
	"First, the repository builds cleanly on the current branch. " +
	"Second, the test suite passes except for one flaky timing test. " +
	"Third, the documentation was regenerated and the links were checked. " +
	"Fourth, the release notes were drafted and are waiting for review. " +
	"Fifth, nothing else needs attention right now.";

/** Instructions mirror Codex's backend prompt role split, minimal and without user identity. */
const INSTRUCTIONS = [
	"You are the spoken voice of a coding assistant. Be brief.",
	"The backend agent performs all tasks and answers substantive questions; defer such work to it.",
	"When you receive backend text, speak its key point to the user in one or two sentences.",
	"Acknowledge what the user said in a few words.",
].join(" ");

interface Options {
	wav: string;
	expect: string;
	wavStartMs: number;
	wavEndMs: number | undefined;
	wav2: string;
	expect2: string;
	wav2StartMs: number;
	wav2EndMs: number | undefined;
	report: string | undefined;
	showTranscripts: boolean;
	skipInterrupt: boolean;
	stepTimeoutMs: number;
	voice: string;
}

function parseOptions(): Options {
	const { values } = parseArgs({
		options: {
			wav: { type: "string" },
			expect: { type: "string" },
			"wav-start-ms": { type: "string" },
			"wav-end-ms": { type: "string" },
			wav2: { type: "string" },
			expect2: { type: "string" },
			"wav2-start-ms": { type: "string" },
			"wav2-end-ms": { type: "string" },
			report: { type: "string" },
			"show-transcripts": { type: "boolean", default: false },
			"skip-interrupt": { type: "boolean", default: false },
			"step-timeout-ms": { type: "string" },
			voice: { type: "string" },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help || !values.wav || !values.expect) {
		console.error(
			[
				"usage: npm run spike -- --wav <file.wav> --expect \"<phrase>\" [--wav-start-ms N] [--wav-end-ms N]",
				"           [--wav2 <file.wav> --expect2 \"<phrase>\" [--wav2-start-ms N] [--wav2-end-ms N]]",
				"           [--report <out.json>] [--show-transcripts] [--skip-interrupt] [--step-timeout-ms N] [--voice name]",
			].join("\n"),
		);
		process.exit(values.help ? 0 : 2);
	}
	const int = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));
	return {
		wav: resolve(values.wav),
		expect: values.expect,
		wavStartMs: int(values["wav-start-ms"]) ?? 0,
		wavEndMs: int(values["wav-end-ms"]),
		wav2: resolve(values.wav2 ?? values.wav),
		expect2: values.expect2 ?? values.expect,
		wav2StartMs: int(values["wav2-start-ms"]) ?? (values.wav2 ? 0 : (int(values["wav-start-ms"]) ?? 0)),
		wav2EndMs: int(values["wav2-end-ms"]) ?? (values.wav2 ? undefined : int(values["wav-end-ms"])),
		report: values.report === undefined ? undefined : resolve(values.report),
		showTranscripts: values["show-transcripts"],
		skipInterrupt: values["skip-interrupt"],
		stepTimeoutMs: int(values["step-timeout-ms"]) ?? 30_000,
		voice: values.voice ?? LIVE_DEFAULT_VOICE,
	};
}

interface PhaseAudio {
	packets: number;
	nonSilentFrames: number;
	seconds: number;
	peakDbfs: number;
	firstLoudAfterMs: number | undefined;
}

interface SpikeReport {
	spike: "daemon-voice-milestone-1";
	startedAt: string;
	versions: { node: string; werift: string; opusscript: string; codexReference: string; model: string; voice: string };
	auth: { expiresInMin: number; fileUnchanged: boolean | undefined };
	steps: Record<string, { ok: boolean; ms?: number; error?: string; [key: string]: unknown }>;
	events: Record<string, number>;
	mirroredAudioBytes: Record<string, number>;
	unknownEventShapes: string[];
	outcome: { passed: boolean; failedChecks: string[] };
	cleanup?: { ms: number; sidebandCloseCode?: number; activeResources: string[]; exitedNaturally?: boolean };
}

class Recorder {
	readonly t0 = performance.now();
	readonly eventCounts: Record<string, number> = {};
	/** Base64 payload bytes of the sideband's mirrored audio events, by type. */
	readonly mirroredAudioBytes: Record<string, number> = {};
	/** Key shapes of event types the Codex parser does not handle, one entry per type and shape. */
	readonly unknownShapes = new Set<string>();
	private readonly showTranscripts: boolean;

	constructor(showTranscripts: boolean) {
		this.showTranscripts = showTranscripts;
	}

	ms(): number {
		return Math.round(performance.now() - this.t0);
	}

	note(message: string): void {
		console.error(`[+${String(this.ms()).padStart(6)} ms] ${message}`);
	}

	event(event: LiveEvent): void {
		const key = event.type === "unknown" ? `unknown:${event.eventType}` : event.type;
		this.eventCounts[key] = (this.eventCounts[key] ?? 0) + 1;
		switch (event.type) {
			case "input_transcript.added":
			case "output_transcript.added":
				this.note(`${event.type} (${event.text.length} chars)${this.showTranscripts ? `: ${event.text}` : ""}`);
				break;
			case "turn.done":
				this.note(
					`turn.done role=${event.role} (${event.transcript.length} chars)${this.showTranscripts ? `: ${event.transcript}` : ""}`,
				);
				break;
			case "delegation.created":
				this.note(
					`delegation.created item=${event.itemId ? "yes" : "missing"} (${event.inputText.length} chars)${this.showTranscripts ? `: ${event.inputText}` : ""}`,
				);
				break;
			case "error":
				this.note(`provider error: ${event.message.length} chars${this.showTranscripts ? `: ${event.message}` : ""}`);
				break;
			case "session.started":
			case "session.updated":
				this.note(`${event.type} session=${event.sessionId ? "present" : "absent"}`);
				break;
			case "turn.created":
				this.note(`turn.created role=${event.role}`);
				break;
			case "output_audio.delta":
				break;
			case "audio_mirror":
				this.mirroredAudioBytes[event.eventType] = (this.mirroredAudioBytes[event.eventType] ?? 0) + event.bytes;
				break;
			case "unknown": {
				const entry = `${event.eventType} ${event.shape}`;
				// Note each type/shape once; `turn.delta` arrives per transcript word.
				if (!this.unknownShapes.has(entry)) {
					this.unknownShapes.add(entry);
					this.note(`event ${key} [${event.shape}]`);
				}
				break;
			}
			default:
				this.note(`event ${key}`);
		}
	}
}

/** Buffered sideband events with awaitable predicates; every wait owns exactly one timer and releases it. */
class EventWaiter {
	private readonly waiters = new Set<{ predicate: (event: LiveEvent) => boolean; resolve: (event: LiveEvent) => void }>();
	/** The last 200 events, for predicates that look back. */
	readonly recent: LiveEvent[] = [];

	push(event: LiveEvent): void {
		this.recent.push(event);
		if (this.recent.length > 200) this.recent.shift();
		for (const waiter of [...this.waiters]) {
			if (waiter.predicate(event)) {
				this.waiters.delete(waiter);
				waiter.resolve(event);
			}
		}
	}

	/** Resolves with the first event matching any predicate; rejects on timeout or on a provider error when `failOnError`. */
	wait<T extends LiveEvent>(
		predicates: readonly ((event: LiveEvent) => event is T)[],
		timeoutMs: number,
		what: string,
		failOnError = true,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const waiter = {
				predicate: (event: LiveEvent) =>
					predicates.some((predicate) => predicate(event)) || (failOnError && isError(event)),
				resolve: (event: LiveEvent) => {
					clearTimeout(timer);
					if (isError(event) && !predicates.some((predicate) => predicate(event))) {
						reject(new Error(`provider error while waiting for ${what} (${event.message.length} chars)`));
						return;
					}
					resolve(event as T);
				},
			};
			const timer = setTimeout(() => {
				this.waiters.delete(waiter);
				reject(new Error(`no ${what} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.waiters.add(waiter);
		});
	}
}

type TurnDoneEvent = Extract<LiveEvent, { type: "turn.done" }>;
type DelegationEvent = Extract<LiveEvent, { type: "delegation.created" }>;
const isUserTurnDone = (event: LiveEvent): event is TurnDoneEvent =>
	event.type === "turn.done" && event.role === "user";
const isAssistantTurnDone = (event: LiveEvent): event is TurnDoneEvent =>
	event.type === "turn.done" && event.role === "assistant";
const isUserTurnCreated = (event: LiveEvent): event is Extract<LiveEvent, { type: "turn.created" }> =>
	event.type === "turn.created" && event.role === "user";
const isDelegation = (event: LiveEvent): event is DelegationEvent =>
	event.type === "delegation.created";
const isError = (event: LiveEvent): event is Extract<LiveEvent, { type: "error" }> => event.type === "error";
/** The sideband acknowledges a context append with `session.context.appended`. */
const isContextAppended = (event: LiveEvent): event is Extract<LiveEvent, { type: "unknown" }> =>
	event.type === "unknown" && event.eventType === "session.context.appended";

function snapshot(stats: ReceiveStats): ReceiveStats {
	return { ...stats };
}

function phaseAudio(media: MediaEngine, before: ReceiveStats, phaseStartAt: number): PhaseAudio {
	const after = media.receive;
	return {
		packets: after.packets - before.packets,
		nonSilentFrames: after.nonSilentFrames - before.nonSilentFrames,
		seconds: Number(((after.decodedSamples - before.decodedSamples) / 24_000).toFixed(2)),
		peakDbfs: Number(toDbfs(after.peakRms).toFixed(1)),
		firstLoudAfterMs: media.firstLoudAfter(phaseStartAt),
	};
}

function installedVersion(name: string): string {
	const manifest = new URL(`../node_modules/${name}/package.json`, import.meta.url);
	return (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
}

function loadClip(path: string, startMs: number, endMs: number | undefined): Int16Array[] {
	const clip = readWav(path);
	const samples = sliceMs(resampleTo24k(clip), startMs, endMs);
	if (samples.length === 0) throw new Error(`${path}: the selected range is empty`);
	return frames(samples);
}

async function main(): Promise<void> {
	const options = parseOptions();
	const recorder = new Recorder(options.showTranscripts);
	const report: SpikeReport = {
		spike: "daemon-voice-milestone-1",
		startedAt: new Date().toISOString(),
		versions: {
			node: process.version,
			werift: installedVersion("werift"),
			opusscript: installedVersion("opusscript"),
			codexReference: CODEX_REFERENCE,
			model: LIVE_MODEL,
			voice: options.voice,
		},
		auth: { expiresInMin: 0, fileUnchanged: undefined },
		steps: {},
		events: recorder.eventCounts,
		mirroredAudioBytes: recorder.mirroredAudioBytes,
		unknownEventShapes: [],
		outcome: { passed: false, failedChecks: [] },
	};
	const failed = report.outcome.failedChecks;
	const check = (name: string, ok: boolean): boolean => {
		if (!ok) failed.push(name);
		return ok;
	};
	const writeReport = () => {
		if (!options.report) return;
		mkdirSync(dirname(options.report), { recursive: true });
		writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
	};

	let media: MediaEngine | undefined;
	let sideband: LiveSideband | undefined;
	let sidebandCloseCode: number | undefined;
	const waiter = new EventWaiter();
	const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
		const started = performance.now();
		const record: SpikeReport["steps"][string] = { ok: false };
		report.steps[name] = record;
		try {
			const value = await run();
			record.ok = true;
			record.ms = Math.round(performance.now() - started);
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			record.ms = Math.round(performance.now() - started);
			record.error = message;
			recorder.note(`step ${name} failed: ${message}`);
			throw error;
		}
	};

	try {
		// Step 0: auth, read-only.
		const auth = await step("auth", async () => {
			const loaded = loadCodexSubscriptionAuth();
			report.auth.expiresInMin = Math.round(loaded.expiresInMs / 60_000);
			recorder.note(`auth: openai-codex credential loaded, expires in ${report.auth.expiresInMin} min`);
			return loaded;
		});
		const authBefore = authFileFingerprint(auth.authPath);

		// Prerecorded speech.
		const clipA = loadClip(options.wav, options.wavStartMs, options.wavEndMs);
		const clipB = loadClip(options.wav2, options.wav2StartMs, options.wav2EndMs);
		recorder.note(`clips: A=${(clipA.length * 20) / 1000}s B=${(clipB.length * 20) / 1000}s`);

		// Step 1: native media + subscription call.
		media = new MediaEngine({
			onConnectionState: (state) => recorder.note(`peer connection: ${state}`),
		});
		const realtimeSessionId = newRealtimeSessionId();
		const offerSdp = await step("offer", () => media!.createOffer());
		report.steps.offer!.localCandidateTypes = media.localCandidateTypes();
		const call = await step("create_call", () =>
			createLiveCall(
				auth,
				realtimeSessionId,
				offerSdp,
				{ instructions: INSTRUCTIONS, voice: options.voice },
				AbortSignal.timeout(options.stepTimeoutMs),
			),
		);
		report.steps.create_call!.httpStatus = call.httpStatus;
		report.steps.create_call!.callIdShape = call.callId.startsWith("rtc_") ? "rtc_" : "uuid";
		recorder.note(`call created: HTTP ${call.httpStatus} in ${call.durationMs} ms`);
		await step("accept_answer", async () => {
			await media!.acceptAnswer(call.answerSdp);
			report.steps.accept_answer!.remoteCandidateTypes = media!.remoteCandidateTypes();
		});
		await step("ice_dtls_connected", () => media!.waitConnected(options.stepTimeoutMs));
		await step("remote_track", () => media!.waitRemoteTrack(5_000));
		report.steps.remote_track!.codec = media.negotiatedCodec();

		// Step 2: sideband.
		sideband = await step("sideband_connect", () =>
			LiveSideband.connect(auth, call.callId, {
				realtimeSessionId,
				onEvent: (event) => {
					recorder.event(event);
					waiter.push(event);
				},
				onClose: (code, reason) => {
					sidebandCloseCode = code;
					recorder.note(`sideband closed code=${code} reason=${reason.length} chars`);
				},
			}),
		);
		const sessionEvent = await waiter
			.wait(
				[
					(event): event is Extract<LiveEvent, { type: "session.started" | "session.updated" }> =>
						event.type === "session.started" || event.type === "session.updated",
				],
				5_000,
				"session.started",
			)
			.catch(() => undefined);
		report.steps.sideband_connect!.sessionEvent = sessionEvent?.type ?? "none";

		// Step 3: utterance A -> completed user turn -> spoken reply or delegation.
		const turnA = await step("user_turn_a", async () => {
			const before = snapshot(media!.receive);
			const sendStart = performance.now();
			// Registered before sending: the turn can complete before the trailing silence finishes.
			const turnDone = waiter.wait([isUserTurnDone], options.stepTimeoutMs + clipA.length * 20, "user turn.done");
			await media!.sendFrames([...clipA, ...silenceFrames(TRAILING_SILENCE_MS / 20)]);
			const speechEndAt = performance.now() - TRAILING_SILENCE_MS;
			const done = await turnDone;
			const match = matchTranscript(options.expect, done.transcript);
			report.steps.user_turn_a!.transcriptMatch = match;
			report.steps.user_turn_a!.turnDoneAfterSpeechEndMs = Math.round(performance.now() - speechEndAt);
			report.steps.user_turn_a!.inputTranscriptDeltas = recorder.eventCounts["input_transcript.added"] ?? 0;
			check("user_turn_a.complete_phrase", match.matched);
			return { before, sendStart, match };
		});

		const replyA = await step("assistant_reply_a", async () => {
			const phaseStart = performance.now();
			const first = await waiter.wait<TurnDoneEvent | DelegationEvent>(
				[isAssistantTurnDone, isDelegation],
				options.stepTimeoutMs,
				"assistant turn.done or delegation.created",
			);
			// Give audio a moment to drain after the turn completes.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			const audio = phaseAudio(media!, turnA.before, turnA.sendStart);
			report.steps.assistant_reply_a!.audio = audio;
			const delegation = first.type === "delegation.created" ? first : undefined;
			report.steps.assistant_reply_a!.kind = delegation ? "delegation" : "spoken";
			if (delegation) {
				const delegatedMatch = matchTranscript(options.expect, delegation.inputText);
				report.steps.assistant_reply_a!.delegationCarriesUserPhrase = delegatedMatch.matched;
				report.steps.assistant_reply_a!.delegationItemIdPresent = delegation.itemId.length > 0;
			}
			check("assistant_reply_a.non_silent_audio", audio.nonSilentFrames > 0);
			return { delegation, phaseStart };
		});

		// Step 4a: correlated injection (only when the provider delegated).
		if (replyA.delegation) {
			await step("inject_delegated", async () => {
				const before = snapshot(media!.receive);
				const at = performance.now();
				const chunks = sideband!.appendDelegationContext(replyA.delegation!.itemId, DELEGATION_MARKER, "speakable");
				const outcome = await waitSpoken(waiter, options.stepTimeoutMs, DELEGATION_MARKERS);
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				const audio = phaseAudio(media!, before, at);
				Object.assign(report.steps.inject_delegated!, { chunks, audio, ...outcome });
				check("inject_delegated.spoken", audio.nonSilentFrames > 0);
				check("inject_delegated.transcript_has_marker", outcome.markerInTranscript);
			});
		}

		// Step 4b: standalone injection.
		await step("inject_standalone", async () => {
			const before = snapshot(media!.receive);
			const at = performance.now();
			const chunks = sideband!.appendSessionContext(STANDALONE_MARKER, "speakable");
			const ack = waiter
				.wait([isContextAppended], options.stepTimeoutMs, "session.context.appended", false)
				.then(() => Math.round(performance.now() - at))
				.catch(() => undefined);
			const outcome = await waitSpoken(waiter, options.stepTimeoutMs, STANDALONE_MARKERS);
			report.steps.inject_standalone!.ackAfterMs = await ack;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const audio = phaseAudio(media!, before, at);
			Object.assign(report.steps.inject_standalone!, { chunks, audio, ...outcome });
			check("inject_standalone.spoken", audio.nonSilentFrames > 0);
			check("inject_standalone.transcript_has_marker", outcome.markerInTranscript);
		});

		// Step 4c: commentary channel (informational: records whether it is voiced).
		await step("inject_commentary", async () => {
			const before = snapshot(media!.receive);
			const at = performance.now();
			sideband!.appendSessionContext(COMMENTARY_TEXT, "commentary");
			const outcome = await waitSpoken(waiter, 8_000, ["working"]).catch(() => ({
				assistantTurnDone: false,
				outputTranscriptChars: 0,
				markerInTranscript: false,
			}));
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			const audio = phaseAudio(media!, before, at);
			Object.assign(report.steps.inject_commentary!, { audio, ...outcome, voiced: audio.nonSilentFrames > 0 });
		});

		// Step 5: interruption.
		if (!options.skipInterrupt) {
			await step("interrupt", async () => {
				const before = snapshot(media!.receive);
				const at = performance.now();
				sideband!.appendSessionContext(LONG_SPEECH, "speakable");
				// Wait for speech to be audibly under way.
				await withTimeout(
					new Promise<void>((resolve) => {
						const timer = setInterval(() => {
							const loudAt = media!.receive.lastNonSilentAt;
							const firstLoud = media!.receive.firstNonSilentAt;
							if (
								loudAt !== undefined &&
								loudAt > at &&
								media!.receive.nonSilentFrames - before.nonSilentFrames >= 30 &&
								firstLoud !== undefined
							) {
								clearInterval(timer);
								resolve();
							}
						}, 20);
					}),
					options.stepTimeoutMs,
					"long speech did not start",
				);
				const bargeAt = performance.now();
				recorder.note("barge-in: sending utterance B over provider speech");
				const bargeSend = media!.sendFrames([...clipB, ...silenceFrames(TRAILING_SILENCE_MS / 20)]);
				const loudBeforeBargeIn = media!.receive.nonSilentFrames - before.nonSilentFrames;
				const assistantTurnsBefore = recorder.eventCounts["turn.done"] ?? 0;
				// The onset signal a client would key its playback-epoch drop on.
				const onset = waiter
					.wait([isUserTurnCreated], options.stepTimeoutMs, "user turn.created", false)
					.then(() => ({
						afterBargeInMs: Math.round(performance.now() - bargeAt),
						providerSpeaking:
							media!.receive.lastNonSilentAt !== undefined && performance.now() - media!.receive.lastNonSilentAt < 500,
					}))
					.catch(() => undefined);
				const doneB = await waiter.wait([isUserTurnDone], options.stepTimeoutMs, "user turn.done for utterance B");
				const onsetSignal = await onset;
				const turnDoneBAt = performance.now();
				const loudAtTurnDoneB = media!.receive.nonSilentFrames;
				await bargeSend;
				const matchB = matchTranscript(options.expect2, doneB.transcript);
				// Does provider speech continue after the barge-in utterance completed as a user turn?
				await new Promise((resolve) => setTimeout(resolve, 2_500));
				const loudFramesAfterTurnDoneB = media!.receive.nonSilentFrames - loudAtTurnDoneB;
				const lastLoud = media!.receive.lastNonSilentAt ?? bargeAt;
				const stopDelayMs = Math.round(Math.max(0, lastLoud - bargeAt));
				const bargeDurationMs = clipB.length * 20;
				const stoppedDuringBargeIn = stopDelayMs < bargeDurationMs + 500;
				const stoppedAtTurnDone = loudFramesAfterTurnDoneB < 10;
				Object.assign(report.steps.interrupt!, {
					loudFramesBeforeBargeIn: loudBeforeBargeIn,
					bargeDurationMs,
					userTurnDoneAfterBargeInMs: Math.round(turnDoneBAt - bargeAt),
					stopDelayMs,
					loudFramesAfterTurnDoneB,
					turnDoneEventsDuringBargeIn: (recorder.eventCounts["turn.done"] ?? 0) - assistantTurnsBefore,
					onsetSignal: onsetSignal ?? null,
					// Finding, not a gate: V3 offers no cancel; the provider keeps speaking appended text through user speech.
					providerSpeechStoppedServerSide: stoppedDuringBargeIn || stoppedAtTurnDone,
					transcriptMatchB: matchB,
				});
				check("interrupt.user_turn_b_complete_phrase", matchB.matched);
				check("interrupt.onset_signal_during_provider_speech", onsetSignal?.providerSpeaking === true);
				// Let the provider react to B so the session is quiescent before cleanup.
				await waiter
					.wait<TurnDoneEvent | DelegationEvent>([isAssistantTurnDone, isDelegation], 15_000, "assistant turn.done or delegation after B", false)
					.catch(() => undefined);
			});
		}

		report.auth.fileUnchanged =
			authFileFingerprint(auth.authPath).size === authBefore.size &&
			authFileFingerprint(auth.authPath).mtimeMs === authBefore.mtimeMs;
		check("auth.file_unchanged", report.auth.fileUnchanged);
	} catch (error) {
		recorder.note(`spike aborted: ${error instanceof Error ? error.message : String(error)}`);
		failed.push("aborted");
	} finally {
		// Step 6: cleanup, bounded.
		const cleanupStart = performance.now();
		await sideband?.close().catch(() => undefined);
		await media?.close().catch(() => undefined);
		report.cleanup = {
			ms: Math.round(performance.now() - cleanupStart),
			...(sidebandCloseCode === undefined ? {} : { sidebandCloseCode }),
			activeResources: [...new Set(process.getActiveResourcesInfo())].sort(),
		};
		report.unknownEventShapes = [...recorder.unknownShapes].sort();
		report.outcome.passed = failed.length === 0;
		writeReport();
		recorder.note(`done: ${report.outcome.passed ? "PASSED" : `FAILED (${failed.join(", ")})`}`);
		console.log(JSON.stringify(report, null, 2));
		// A natural exit proves cleanup released every handle; the watchdog reports what lingers otherwise.
		const watchdog = setTimeout(() => {
			report.cleanup!.exitedNaturally = false;
			report.cleanup!.activeResources = [...new Set(process.getActiveResourcesInfo())].sort();
			writeReport();
			console.error(`process did not exit after cleanup; lingering: ${report.cleanup!.activeResources.join(", ")}`);
			process.exit(3);
		}, 5_000);
		watchdog.unref();
		process.exitCode = report.outcome.passed ? 0 : 1;
	}
}

async function waitSpoken(
	waiter: EventWaiter,
	timeoutMs: number,
	markers: readonly string[],
): Promise<{ assistantTurnDone: boolean; outputTranscriptChars: number; markerInTranscript: boolean }> {
	const startIndex = waiter.recent.length;
	const done = await waiter.wait([isAssistantTurnDone], timeoutMs, "assistant turn.done");
	const deltas = waiter.recent
		.slice(startIndex)
		.filter((event): event is Extract<LiveEvent, { type: "output_transcript.added" }> => event.type === "output_transcript.added")
		.map((event) => event.text)
		.join("");
	const transcript = done.transcript.length > 0 ? done.transcript : deltas;
	return {
		assistantTurnDone: true,
		outputTranscriptChars: transcript.length,
		markerInTranscript: containsMarker(transcript, markers) || containsMarker(deltas, markers),
	};
}

void main();
