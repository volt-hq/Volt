import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent, AgentRunSnapshot } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, JsonObject } from "@hansjm10/volt-ai";
import { writeToolProgressCapture } from "./tool-progress-capture.ts";

export const TOOL_PROGRESS_MAX_CALLS = 16;
export const TOOL_PROGRESS_SAMPLE_BYTES = 4096;

export interface ToolProgress {
	callId: string;
	contentIndex?: number;
	name: string;
	provider: string;
	model: string;
	phase: "preparing" | "ready" | "executing" | "completed" | "failed" | "not_started" | "interrupted";
	startedAt: number;
	phaseStartedAt: number;
	lastEventAt: number;
	endedAt?: number;
	executionStarted: boolean;
	argumentBytes: number;
	argumentEvents: number;
	rawArgumentSample: string;
	sampleTruncated: boolean;
}

interface TrackedTool extends ToolProgress {
	lastCodeUnit?: number;
	sampleBytes: number;
	identityKey?: string;
	generation: number;
}

interface QueueMetrics {
	queuedEvents: number;
	peakQueuedEvents: number;
	queuedBytes: number;
	peakQueuedBytes: number;
	waitingConsumers: number;
}

type CaptureWriter = (path: string, content: string) => Promise<void>;

interface PendingCapture {
	content: string;
	promise: Promise<string>;
	resolve(path: string): void;
	reject(error: unknown): void;
}

const GUARD_DIAGNOSTICS = new Set([
	"tool_argument_generation_limit",
	"invalid_tool_arguments",
	"assistant_stream_queue_limit",
	"assistant_stream_processing_error",
]);

/** Cap before allocating a buffer, preserving complete UTF-8 characters. */
function prefixBytes(text: string, bytes: number): string {
	const prefix = text.slice(0, bytes);
	let used = 0;
	let end = 0;
	for (const character of prefix) {
		const size = Buffer.byteLength(character);
		if (used + size > bytes) break;
		used += size;
		end += character.length;
	}
	return prefix.slice(0, end);
}

/** Match a bounded decoded view, but cut the original prefix at the corresponding raw offset. */
function redactSample(sample: string): string {
	let decoded = "";
	const offsets: number[] = [];
	const escapes: Record<string, string> = {
		'"': '"',
		"\\": "\\",
		"/": "/",
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
	};
	for (let index = 0; index < sample.length; index++) {
		const start = index;
		let character = sample[index]!;
		if (character === "\\") {
			const next = sample[index + 1];
			if (next === "u" && /^[\da-f]{4}$/i.test(sample.slice(index + 2, index + 6))) {
				character = String.fromCharCode(Number.parseInt(sample.slice(index + 2, index + 6), 16));
				index += 5;
			} else if (next !== undefined && escapes[next] !== undefined) {
				character = escapes[next]!;
				index++;
			}
		}
		decoded += character;
		offsets.push(start);
	}
	const credential =
		/\b(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key|private[_ -]?key|access[_-]?key)|[\w-]*auth[\w-]*|cookies?|credentials?|bearer|headers?)\b|\bsk-[A-Za-z0-9]/i.exec(
			decoded,
		);
	// Once a recognizable marker appears, discard the entire affected suffix. No
	// completed JSON value or closing PEM envelope is needed to hide its contents.
	return credential ? `${sample.slice(0, offsets[credential.index])}[redacted]` : sample;
}

function callKey(id: string): string {
	return createHash("sha256").update(id).digest("hex");
}

/** Passive, bounded diagnostics. Never retains assistant prose, reasoning, tool output, or request metadata. */
export class ToolProgressDiagnostics {
	private calls = new Map<number, TrackedTool>();
	private contentCalls = new Map<number, number>();
	private nextCallIdentity = 0;
	private generation = 0;
	private provider = "";
	private model = "";
	private omittedCalls = 0;
	private eventCount = 0;
	private lastEventAt?: number;
	private runtimeAbort?: { source: string; timestamp: number };
	private diagnostics: { type: string; timestamp: number; details: JsonObject }[] = [];
	private queueMetrics?: () => QueueMetrics;
	private disposed = false;
	private readonly directory: string;
	private readonly sessionId: () => string;
	private readonly writer: CaptureWriter;
	private activeCapture?: Promise<string>;
	private pendingCapture?: PendingCapture;

	constructor(agentDir: string, sessionId: () => string, writer: CaptureWriter = writeToolProgressCapture) {
		this.directory = join(agentDir, "debug");
		this.sessionId = sessionId;
		this.writer = writer;
	}

	setQueueMetricsReader(reader: () => QueueMetrics): void {
		if (this.disposed) return;
		this.queueMetrics = reader;
	}

	observe(event: AgentEvent, activeRun?: Pick<AgentRunSnapshot, "source" | "diagnosticTimestamp">): void {
		if (this.disposed) return;
		const now = Date.now();
		if (event.type === "agent_start") {
			this.calls.clear();
			this.contentCalls.clear();
			this.nextCallIdentity = 0;
			this.generation = 0;
			this.omittedCalls = 0;
			this.eventCount = 0;
			this.diagnostics = [];
			this.runtimeAbort = undefined;
			this.queueMetrics = undefined;
		}
		this.eventCount++;
		this.lastEventAt = now;
		if (activeRun?.source !== undefined && activeRun.diagnosticTimestamp !== undefined) {
			this.runtimeAbort = { source: prefixBytes(activeRun.source, 128), timestamp: activeRun.diagnosticTimestamp };
		}
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.generation++;
			this.provider = prefixBytes(event.message.provider, 256);
			this.model = prefixBytes(event.message.model, 256);
			this.contentCalls.clear();
		}
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "toolcall_start") {
				const identity = this.addCall(update.id, update.name, now, update.contentIndex);
				this.contentCalls.set(update.contentIndex, identity);
			} else if (update.type === "toolcall_delta") {
				const id = this.contentCalls.get(update.contentIndex);
				const call = id === undefined ? undefined : this.calls.get(id);
				if (call) {
					this.updateIdentity(call, update.id, update.name);
					const delta = update.argsTextDelta;
					call.argumentBytes += Buffer.byteLength(delta);
					// A UTF-16 surrogate pair may straddle provider chunks.
					if (
						call.lastCodeUnit !== undefined &&
						call.lastCodeUnit >= 0xd800 &&
						call.lastCodeUnit <= 0xdbff &&
						delta.charCodeAt(0) >= 0xdc00 &&
						delta.charCodeAt(0) <= 0xdfff
					)
						call.argumentBytes -= 2;
					if (delta.length > 0) call.lastCodeUnit = delta.charCodeAt(delta.length - 1);
					call.argumentEvents++;
					call.lastEventAt = now;
					const remaining = TOOL_PROGRESS_SAMPLE_BYTES - call.sampleBytes;
					// Never skip omitted input to fill spare bytes with a later chunk.
					// Recheck a full, untruncated sample: a trailing high surrogate
					// may combine with this delta and no longer fit the byte limit.
					if (!call.sampleTruncated) {
						call.rawArgumentSample = prefixBytes(
							call.rawArgumentSample + delta.slice(0, remaining + 2),
							TOOL_PROGRESS_SAMPLE_BYTES,
						);
						call.sampleBytes = Buffer.byteLength(call.rawArgumentSample);
					}
					call.sampleTruncated = call.argumentBytes > call.sampleBytes;
				}
			} else if (update.type === "toolcall_end") {
				const identity = this.contentCalls.get(update.contentIndex);
				const call = identity === undefined ? undefined : this.calls.get(identity);
				if (call) {
					this.updateIdentity(call, update.toolCall.id, update.toolCall.name);
					this.setPhase(call, "ready", now);
				}
			}
		}
		if (event.type === "tool_execution_start") {
			const existing = this.findCall(event.toolCallId);
			if (existing !== "ambiguous") {
				const call = existing ?? this.calls.get(this.addCall(event.toolCallId, event.toolName, now))!;
				call.executionStarted = true;
				this.setPhase(call, "executing", now);
			}
		} else if (event.type === "tool_execution_update") {
			const call = this.findCall(event.toolCallId);
			if (call && call !== "ambiguous") call.lastEventAt = now;
		} else if (event.type === "tool_execution_end") {
			const call = this.findCall(event.toolCallId);
			if (call && call !== "ambiguous") {
				const interrupted = this.runtimeAbort !== undefined && this.runtimeAbort.timestamp >= call.phaseStartedAt;
				this.setPhase(call, event.isError ? (interrupted ? "interrupted" : "failed") : "completed", now);
				call.endedAt = now;
			}
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this.finishMessage(event.message, now);
		} else if (event.type === "agent_end") {
			this.releaseQueueReader();
			for (const call of this.calls.values()) {
				if (call.endedAt === undefined) {
					this.setPhase(call, call.executionStarted ? "interrupted" : "not_started", now);
					call.endedAt = now;
				}
			}
		}
	}

	private updateIdentity(call: TrackedTool, id: string | undefined, name: string | undefined): void {
		if (id !== undefined) {
			call.callId = prefixBytes(id, 256);
			call.identityKey = id ? callKey(id) : undefined;
		}
		if (name !== undefined) call.name = prefixBytes(name, 256);
	}

	/** A bounded scan avoids ambiguous lookups when provisional or reused IDs collide. */
	private findCall(id: string): TrackedTool | "ambiguous" | undefined {
		if (!id) return undefined;
		const key = callKey(id);
		let found: TrackedTool | undefined;
		let ambiguous = false;
		for (const call of this.calls.values()) {
			if (call.identityKey !== key) continue;
			if (!found || call.generation > found.generation) {
				found = call;
				ambiguous = false;
			} else if (call.generation === found.generation) ambiguous = true;
		}
		return ambiguous ? "ambiguous" : found;
	}

	private addCall(id: string, name: string, now: number, contentIndex?: number): number {
		if (this.calls.size >= TOOL_PROGRESS_MAX_CALLS) {
			const evicted = this.calls.keys().next().value!;
			this.calls.delete(evicted);
			for (const [index, identity] of this.contentCalls) if (identity === evicted) this.contentCalls.delete(index);
			this.omittedCalls++;
		}
		const call: TrackedTool = {
			callId: prefixBytes(id, 256),
			contentIndex,
			name: prefixBytes(name, 256),
			provider: this.provider,
			model: this.model,
			phase: "preparing",
			startedAt: now,
			phaseStartedAt: now,
			lastEventAt: now,
			executionStarted: false,
			argumentBytes: 0,
			argumentEvents: 0,
			rawArgumentSample: "",
			sampleTruncated: false,
			sampleBytes: 0,
			identityKey: id ? callKey(id) : undefined,
			generation: this.generation,
		};
		const identity = this.nextCallIdentity++;
		this.calls.set(identity, call);
		return identity;
	}

	private setPhase(call: TrackedTool, phase: ToolProgress["phase"], now: number): void {
		call.phase = phase;
		call.phaseStartedAt = now;
		call.lastEventAt = now;
	}

	private releaseQueueReader(): void {
		// A closed stream retains its final message; keep only numbers once it finishes.
		const queueMetrics = this.queueMetrics?.();
		this.queueMetrics = queueMetrics === undefined ? undefined : () => queueMetrics;
	}

	private finishMessage(message: AssistantMessage, now: number): void {
		this.releaseQueueReader();
		let guardFailure = false;
		for (const diagnostic of message.diagnostics ?? []) {
			if (diagnostic.type !== "runtime_abort" && !GUARD_DIAGNOSTICS.has(diagnostic.type)) continue;
			const details: JsonObject = {};
			for (const [key, value] of Object.entries(diagnostic.details ?? {}).slice(0, 32)) {
				if (typeof value === "number" && Number.isFinite(value)) details[prefixBytes(key, 64)] = value;
				else if ((key === "source" || key === "limit" || key === "code") && typeof value === "string")
					details[key] = prefixBytes(value, 128);
			}
			this.diagnostics.push({ type: diagnostic.type, timestamp: diagnostic.timestamp, details });
			if (this.diagnostics.length > 16) this.diagnostics.shift();
			guardFailure ||= GUARD_DIAGNOSTICS.has(diagnostic.type);
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			for (const id of this.contentCalls.values()) {
				const call = this.calls.get(id);
				if (call && call.endedAt === undefined) {
					this.setPhase(call, call.executionStarted ? "interrupted" : "not_started", now);
					call.endedAt = now;
				}
			}
		}
		if (guardFailure) {
			void this.capture("safeguard").catch(() => {
				/* A diagnostic write must never change the run outcome. */
			});
		}
	}

	executionState(callId: string): "not_started" | "interrupted" | "unknown" {
		const call = this.findCall(callId);
		return call && call !== "ambiguous" ? (call.executionStarted ? "interrupted" : "not_started") : "unknown";
	}

	snapshot() {
		const now = Date.now();
		const queue = this.queueMetrics?.();
		return {
			sessionId: prefixBytes(this.sessionId(), 256),
			capturedAt: now,
			eventCountSource: "normalized_consumer" as const,
			eventCount: this.eventCount,
			lastEventAt: this.lastEventAt,
			runtimeAbort: this.runtimeAbort ? { ...this.runtimeAbort } : undefined,
			omittedCalls: this.omittedCalls,
			queue: queue
				? {
						available: true as const,
						queuedEvents: queue.queuedEvents,
						peakQueuedEvents: queue.peakQueuedEvents,
						queuedBytes: queue.queuedBytes,
						peakQueuedBytes: queue.peakQueuedBytes,
						waitingConsumers: queue.waitingConsumers,
					}
				: { available: false as const },
			diagnostics: structuredClone(this.diagnostics),
			calls: [...this.calls.values()].map(
				({
					lastCodeUnit: _lastCodeUnit,
					sampleBytes: _sampleBytes,
					identityKey: _identityKey,
					generation: _generation,
					...call
				}) => {
					const rawArgumentSample = prefixBytes(redactSample(call.rawArgumentSample), TOOL_PROGRESS_SAMPLE_BYTES);
					return {
						...call,
						elapsedMs: Math.max(0, (call.endedAt ?? now) - call.startedAt),
						phaseElapsedMs: Math.max(0, (call.endedAt ?? now) - call.phaseStartedAt),
						sampleRedacted: rawArgumentSample !== call.rawArgumentSample,
						rawArgumentSample,
					};
				},
			),
		};
	}

	capture(reason: "manual" | "safeguard" = "manual"): Promise<string> {
		try {
			if (this.disposed) throw new Error("Cannot capture tool progress after session disposal.");
			// Serialize now: queued writes must not inspect a later run or retain live state.
			const content = JSON.stringify({ reason, ...this.snapshot() }, null, 2);
			if (!this.activeCapture) return this.startCapture(content);
			if (this.pendingCapture) {
				this.pendingCapture.content = content;
				return this.pendingCapture.promise;
			}
			let resolve!: (path: string) => void;
			let reject!: (error: unknown) => void;
			const promise = new Promise<string>((resolvePromise, rejectPromise) => {
				resolve = resolvePromise;
				reject = rejectPromise;
			});
			void promise.catch(() => {});
			this.pendingCapture = { content, promise, resolve, reject };
			return promise;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private startCapture(content: string): Promise<string> {
		const path = join(this.directory, "tool-progress-latest.json");
		const capture = Promise.resolve()
			.then(() => this.writer(path, content))
			.then(() => path)
			.finally(() => {
				this.activeCapture = undefined;
				const pending = this.pendingCapture;
				this.pendingCapture = undefined;
				if (pending) void this.startCapture(pending.content).then(pending.resolve, pending.reject);
			});
		this.activeCapture = capture;
		void capture.catch(() => {});
		return capture;
	}

	/** An explicit close/test barrier; normal provider events never join capture I/O. */
	async waitForCapture(): Promise<void> {
		while (this.activeCapture) await this.activeCapture.catch(() => {});
	}

	dispose(): void {
		this.disposed = true;
		// The active and latest queued snapshots are already immutable and bounded.
		// Preserve a queued safeguard capture while rejecting any new requests.
		this.calls.clear();
		this.contentCalls.clear();
		this.diagnostics = [];
		this.runtimeAbort = undefined;
		this.queueMetrics = undefined;
	}
}
