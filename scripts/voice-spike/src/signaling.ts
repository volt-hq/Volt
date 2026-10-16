/**
 * The Codex V3 ("frameless bidi") subscription signaling path, reproduced
 * from codex-rs rust-v0.161.0 (`codex-api/src/endpoint/realtime_call.rs`,
 * `realtime_websocket/{methods,methods_frameless_bidi,protocol_frameless_bidi}.rs`,
 * `core/src/{client,realtime_conversation}.rs`):
 *
 * 1. `POST {backend}/realtime/calls?intent=quicksilver&architecture=avas`
 *    with JSON `{sdp, session}` and the ChatGPT bearer; the body is the SDP
 *    answer and the `Location` header carries the call id.
 * 2. A sideband WebSocket at `wss://api.openai.com/v1/live/{callId}` with the
 *    same auth headers; it carries transcripts, turn completion, delegation
 *    requests, and accepts context appends on the `speakable` and
 *    `commentary` channels.
 *
 * Nothing here logs headers, SDP, or payload text; callers receive parsed
 * events and decide what is safe to record.
 */

import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import type { CodexSubscriptionAuth } from "./auth.ts";

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const LIVE_SIDEBAND_BASE_URL = "https://api.openai.com/v1";
export const LIVE_MODEL = "gpt-live-1-codex";
export const LIVE_DEFAULT_VOICE = "cove";
/** `CONTEXT_APPEND_MAX_BYTES` in methods_frameless_bidi.rs. */
const CONTEXT_APPEND_MAX_BYTES = 500;

export type ContextChannel = "speakable" | "commentary";

export interface LiveSessionConfig {
	readonly instructions: string;
	readonly voice?: string;
	readonly model?: string;
}

export interface LiveCall {
	readonly callId: string;
	readonly answerSdp: string;
	readonly httpStatus: number;
	readonly durationMs: number;
}

export type LiveEvent =
	| { type: "session.started" | "session.updated"; sessionId: string | undefined }
	| { type: "input_transcript.added"; text: string }
	| { type: "output_transcript.added"; text: string }
	| { type: "turn.done"; role: "user" | "assistant" | string; transcript: string }
	/** Not parsed by Codex; marks a turn's onset (a user one is the barge-in signal). */
	| { type: "turn.created"; role: string }
	| { type: "delegation.created"; itemId: string; inputText: string }
	| { type: "output_audio.delta"; bytes: number }
	/** The sideband mirrors call audio as base64; the Codex parser ignores these too. */
	| { type: "audio_mirror"; eventType: string; bytes: number }
	| { type: "error"; message: string }
	/** `shape` lists top-level keys plus `turn.role`/`item.type` discriminators; never values. */
	| { type: "unknown"; eventType: string; shape: string };

export interface SidebandOptions {
	readonly realtimeSessionId: string;
	readonly onEvent: (event: LiveEvent, raw: Record<string, unknown>) => void;
	readonly onClose: (code: number, reason: string) => void;
}

function userAgent(): string {
	return `volt-voice-spike (${platform()} ${release()}; ${arch()})`;
}

function baseHeaders(auth: CodexSubscriptionAuth, realtimeSessionId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${auth.accessToken}`,
		"chatgpt-account-id": auth.accountId,
		originator: "volt",
		"User-Agent": userAgent(),
		// `realtime_request_headers` for the FramelessBidi parser.
		"openai-alpha": "quicksilver=v2",
		"x-session-id": realtimeSessionId,
		// `build_session_headers`.
		"session-id": realtimeSessionId,
		"thread-id": realtimeSessionId,
	};
}

/** `is_realtime_call_id_segment` + `decode_call_id_from_location`. */
function callIdFromLocation(location: string): string | undefined {
	const path = location.split("?")[0] ?? location;
	const segments = path.split("/").reverse();
	return segments.find(
		(segment) =>
			(segment.startsWith("rtc_") && segment.length > 4) ||
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment),
	);
}

/** `session_json` in methods_frameless_bidi.rs, with `id` removed as `create_with_session_and_headers` does. */
export function liveSessionJson(config: LiveSessionConfig): Record<string, unknown> {
	return {
		model: config.model ?? LIVE_MODEL,
		instructions: config.instructions,
		audio: { output: { voice: config.voice ?? LIVE_DEFAULT_VOICE } },
		delegation: { type: "client" },
	};
}

export async function createLiveCall(
	auth: CodexSubscriptionAuth,
	realtimeSessionId: string,
	offerSdp: string,
	config: LiveSessionConfig,
	signal: AbortSignal,
): Promise<LiveCall> {
	const url = `${CODEX_BACKEND_BASE_URL}/realtime/calls?intent=quicksilver&architecture=avas`;
	const started = performance.now();
	const response = await fetch(url, {
		method: "POST",
		headers: { ...baseHeaders(auth, realtimeSessionId), "content-type": "application/json" },
		body: JSON.stringify({ sdp: offerSdp, session: liveSessionJson(config) }),
		signal,
	});
	const durationMs = Math.round(performance.now() - started);
	const body = await response.text();
	if (!response.ok) {
		// The body may carry provider error payloads; report only its size and a short safe prefix of JSON error codes.
		let code: string | undefined;
		try {
			const parsed = JSON.parse(body) as { error?: { code?: unknown; type?: unknown } };
			code = [parsed.error?.type, parsed.error?.code].filter((value) => typeof value === "string").join("/");
		} catch {
			code = undefined;
		}
		throw new Error(
			`realtime call creation failed: HTTP ${response.status}${code ? ` (${code})` : ""}, ${body.length} bytes`,
		);
	}
	const location = response.headers.get("location");
	const callId = location ? callIdFromLocation(location) : undefined;
	if (!callId) throw new Error("realtime call response carries no call id in its Location header");
	if (!body.startsWith("v=0")) throw new Error(`realtime call response is not an SDP answer (${body.length} bytes)`);
	return { callId, answerSdp: body, httpStatus: response.status, durationMs };
}

function parseLiveEvent(raw: Record<string, unknown>): LiveEvent {
	const type = typeof raw.type === "string" ? raw.type : "";
	const item = raw.item as Record<string, unknown> | undefined;
	switch (type) {
		case "session.started":
		case "session.updated": {
			const session = raw.session as Record<string, unknown> | undefined;
			return { type, sessionId: typeof session?.id === "string" ? session.id : undefined };
		}
		case "input_transcript.added":
		case "output_transcript.added":
			return { type, text: typeof item?.text === "string" ? item.text : "" };
		case "turn.done": {
			const turn = raw.turn as Record<string, unknown> | undefined;
			return {
				type,
				role: typeof turn?.role === "string" ? turn.role : "",
				transcript: typeof turn?.transcript === "string" ? turn.transcript : "",
			};
		}
		case "turn.created": {
			const turn = raw.turn as Record<string, unknown> | undefined;
			return { type, role: typeof turn?.role === "string" ? turn.role : "" };
		}
		case "delegation.created": {
			const content = Array.isArray(item?.content) ? (item.content as Record<string, unknown>[]) : [];
			return {
				type,
				itemId: typeof item?.id === "string" ? item.id : "",
				inputText: content
					.filter((part) => part.type === "input_text" && typeof part.text === "string")
					.map((part) => part.text as string)
					.join(""),
			};
		}
		case "output_audio.delta":
			return { type, bytes: typeof raw.audio === "string" ? raw.audio.length : 0 };
		case "session.input_audio.append":
		case "session.output_audio.delta": {
			const audio = typeof raw.audio === "string" ? raw.audio.length : 0;
			return { type: "audio_mirror", eventType: type, bytes: audio };
		}
		case "error": {
			const error = raw.error as Record<string, unknown> | undefined;
			const message =
				typeof raw.message === "string"
					? raw.message
					: typeof error?.message === "string"
						? error.message
						: "unknown error";
			return { type, message };
		}
		default: {
			const turn = raw.turn as Record<string, unknown> | undefined;
			const shape = Object.keys(raw)
				.filter((key) => key !== "type")
				.map((key) => {
					if (key === "turn" && typeof turn?.role === "string") return `turn{role=${turn.role},${Object.keys(turn).join("|")}}`;
					if (key === "item" && typeof item?.type === "string") return `item{type=${item.type}}`;
					const nested = raw[key];
					// Usage snapshots: record their field names so the adapter can plan on them; never their values.
					if ((key === "usage" || key === "usage_limit") && nested && typeof nested === "object") {
						return `${key}{${Object.keys(nested as Record<string, unknown>).join("|")}}`;
					}
					return key;
				})
				.join(",");
			return { type: "unknown", eventType: type || "<untyped>", shape };
		}
	}
}

export class LiveSideband {
	private readonly socket: WebSocket;
	private readonly opened: Promise<void>;
	private closedByUs = false;
	sentFrames = 0;
	receivedFrames = 0;

	private constructor(socket: WebSocket, options: SidebandOptions) {
		this.socket = socket;
		this.opened = new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener(
				"error",
				() => reject(new Error("sideband websocket failed to connect (handshake rejected or network error)")),
				{ once: true },
			);
		});
		socket.addEventListener("message", (event) => {
			this.receivedFrames += 1;
			const data = typeof event.data === "string" ? event.data : undefined;
			if (data === undefined) return;
			let raw: Record<string, unknown>;
			try {
				raw = JSON.parse(data) as Record<string, unknown>;
			} catch {
				options.onEvent({ type: "unknown", eventType: "<unparseable>", shape: "" }, {});
				return;
			}
			options.onEvent(parseLiveEvent(raw), raw);
		});
		socket.addEventListener("close", (event) => options.onClose(event.code, event.reason));
	}

	static async connect(auth: CodexSubscriptionAuth, callId: string, options: SidebandOptions): Promise<LiveSideband> {
		// `websocket_url_from_api_url_for_call`: FramelessBidi appends the call id as a path segment of /v1/live.
		const url = new URL(`${LIVE_SIDEBAND_BASE_URL}/live/${encodeURIComponent(callId)}`);
		url.protocol = "wss:";
		const headers = baseHeaders(auth, options.realtimeSessionId);
		// Node's undici WebSocket accepts request headers through this non-standard init field.
		const socket = new WebSocket(url, { headers } as unknown as string[]);
		const sideband = new LiveSideband(socket, options);
		await sideband.opened;
		return sideband;
	}

	private send(payload: Record<string, unknown>): void {
		if (this.socket.readyState !== WebSocket.OPEN) throw new Error("sideband websocket is not open");
		this.socket.send(JSON.stringify(payload));
		this.sentFrames += 1;
	}

	/** `context_append_chunks`: split on UTF-8 byte boundaries at 500 bytes. */
	private static chunks(text: string): string[] {
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length <= CONTEXT_APPEND_MAX_BYTES) return [text];
		const out: string[] = [];
		let start = 0;
		while (start < bytes.length) {
			let end = Math.min(start + CONTEXT_APPEND_MAX_BYTES, bytes.length);
			while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
			out.push(bytes.subarray(start, end).toString("utf8"));
			start = end;
		}
		return out;
	}

	/** `session.context.append`: standalone assistant text injection. */
	appendSessionContext(text: string, channel: ContextChannel): number {
		const chunks = LiveSideband.chunks(text);
		for (const chunk of chunks) {
			this.send({ type: "session.context.append", channel, content: [{ type: "input_text", text: chunk }] });
		}
		return chunks.length;
	}

	/** `delegation.context.append`: assistant text correlated to a provider delegation item. */
	appendDelegationContext(delegationItemId: string, text: string, channel: ContextChannel): number {
		const chunks = LiveSideband.chunks(text);
		for (const chunk of chunks) {
			this.send({
				type: "delegation.context.append",
				delegation_item_id: delegationItemId,
				channel,
				content: [{ type: "input_text", text: chunk }],
			});
		}
		return chunks.length;
	}

	/** `session.close`, then the socket. */
	async close(): Promise<void> {
		this.closedByUs = true;
		if (this.socket.readyState === WebSocket.OPEN) {
			try {
				this.send({ type: "session.close" });
			} catch {
				// Closing anyway.
			}
		}
		const closed = new Promise<void>((resolve) => {
			if (this.socket.readyState === WebSocket.CLOSED) return resolve();
			this.socket.addEventListener("close", () => resolve(), { once: true });
		});
		this.socket.close(1000, "spike done");
		await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3000).unref())]);
	}

	get wasClosedByUs(): boolean {
		return this.closedByUs;
	}
}

export function newRealtimeSessionId(): string {
	return randomUUID();
}
