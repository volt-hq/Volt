/**
 * Codex V3 ("frameless bidi") subscription signaling, as codex-rs
 * rust-v0.161.0 does it and scripts/voice-spike proved natively:
 *
 * 1. `POST {chatgpt backend}/realtime/calls?intent=quicksilver&architecture=avas`
 *    with JSON `{sdp, session}` and the ChatGPT bearer: the body is the SDP
 *    answer, the `Location` header carries the call id.
 * 2. A sideband WebSocket at `wss://api.openai.com/v1/live/{callId}` with the
 *    same headers: transcripts, turns, delegations, usage, and context
 *    appends on the `speakable` and `commentary` channels.
 *
 * Nothing here logs or returns headers, SDP, payload text, or the token;
 * the provider maps what it parses to safe `VoiceProviderEvent`s.
 */

import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";

export const CODEX_BACKEND_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const LIVE_SIDEBAND_BASE_URL = "https://api.openai.com/v1";
export const LIVE_MODEL = "gpt-live-1-codex";
export const LIVE_DEFAULT_VOICE = "cove";
/** `CONTEXT_APPEND_MAX_BYTES` in methods_frameless_bidi.rs. */
const CONTEXT_APPEND_MAX_BYTES = 500;

export type LiveContextChannel = "speakable" | "commentary";

/** The credential a call uses, held in memory for the call's duration only. */
export interface LiveCredential {
	readonly accessToken: string;
	readonly accountId: string;
}

export interface LiveSessionConfig {
	readonly instructions: string;
	readonly voice?: string;
	readonly model?: string;
}

export interface LiveCall {
	readonly callId: string;
	readonly answerSdp: string;
}

/** The sideband events the provider consumes; everything else is counted by type only. */
export type LiveSidebandEvent =
	| { readonly type: "session.started" | "session.updated" }
	| { readonly type: "turn.created"; readonly role: string; readonly turnId: string | undefined }
	| { readonly type: "input_transcript.added"; readonly text: string }
	| { readonly type: "output_transcript.added"; readonly text: string }
	| {
			readonly type: "turn.done";
			readonly role: string;
			readonly transcript: string;
			readonly turnId: string | undefined;
	  }
	| { readonly type: "delegation.created"; readonly itemId: string; readonly turnId: string | undefined }
	| { readonly type: "session.usage.updated"; readonly audioDurationMs: number | undefined }
	| { readonly type: "error"; readonly message: string }
	| { readonly type: "other"; readonly eventType: string };

export class LiveSignalingError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "LiveSignalingError";
		this.status = status;
	}
}

function headers(credential: LiveCredential, realtimeSessionId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${credential.accessToken}`,
		"chatgpt-account-id": credential.accountId,
		originator: "volt",
		"User-Agent": `volt (${platform()} ${release()}; ${arch()})`,
		"openai-alpha": "quicksilver=v2",
		"x-session-id": realtimeSessionId,
		"session-id": realtimeSessionId,
		"thread-id": realtimeSessionId,
	};
}

/** `decode_call_id_from_location` in realtime_call.rs. */
function callIdFromLocation(location: string): string | undefined {
	const path = location.split("?")[0] ?? location;
	return path
		.split("/")
		.reverse()
		.find(
			(segment) =>
				(segment.startsWith("rtc_") && segment.length > 4) ||
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment),
		);
}

export function newRealtimeSessionId(): string {
	return randomUUID();
}

export async function createLiveCall(
	credential: LiveCredential,
	realtimeSessionId: string,
	offerSdp: string,
	config: LiveSessionConfig,
	signal: AbortSignal,
): Promise<LiveCall> {
	const url = `${CODEX_BACKEND_BASE_URL}/realtime/calls?intent=quicksilver&architecture=avas`;
	const session = {
		model: config.model ?? LIVE_MODEL,
		instructions: config.instructions,
		audio: { output: { voice: config.voice ?? LIVE_DEFAULT_VOICE } },
		delegation: { type: "client" },
	};
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { ...headers(credential, realtimeSessionId), "content-type": "application/json" },
			body: JSON.stringify({ sdp: offerSdp, session }),
			signal,
		});
	} catch (error) {
		throw new LiveSignalingError(
			`realtime call request failed: ${error instanceof Error ? error.name : "network error"}`,
		);
	}
	const body = await response.text();
	if (!response.ok)
		throw new LiveSignalingError(`realtime call creation refused (HTTP ${response.status})`, response.status);
	const location = response.headers.get("location");
	const callId = location === null ? undefined : callIdFromLocation(location);
	if (!callId) throw new LiveSignalingError("realtime call response carries no call id");
	if (!body.startsWith("v=0")) throw new LiveSignalingError("realtime call response is not an SDP answer");
	return { callId, answerSdp: body };
}

function parseEvent(raw: Record<string, unknown>): LiveSidebandEvent {
	const type = typeof raw.type === "string" ? raw.type : "";
	const item = raw.item as Record<string, unknown> | undefined;
	const turn = raw.turn as Record<string, unknown> | undefined;
	switch (type) {
		case "session.started":
		case "session.updated":
			return { type };
		case "turn.created":
			return {
				type,
				role: typeof turn?.role === "string" ? turn.role : "",
				turnId: typeof turn?.id === "string" ? turn.id : undefined,
			};
		case "input_transcript.added":
		case "output_transcript.added":
			return { type, text: typeof item?.text === "string" ? item.text : "" };
		case "turn.done":
			return {
				type,
				role: typeof turn?.role === "string" ? turn.role : "",
				transcript: typeof turn?.transcript === "string" ? turn.transcript : "",
				turnId: typeof turn?.id === "string" ? turn.id : undefined,
			};
		case "delegation.created": {
			if (item?.type !== "delegation" || item.target !== "client" || typeof item.id !== "string") {
				return { type: "other", eventType: type };
			}
			// A turn reference is used only when the provider states it; nothing is inferred.
			const turnRef = item.turn_id ?? item.turnId;
			return { type, itemId: item.id, turnId: typeof turnRef === "string" ? turnRef : undefined };
		}
		case "session.usage.updated": {
			const usage = raw.usage as Record<string, unknown> | undefined;
			const duration = usage?.audio_duration_ms;
			return { type, audioDurationMs: typeof duration === "number" ? duration : undefined };
		}
		case "error": {
			const error = raw.error as Record<string, unknown> | undefined;
			return {
				type,
				message:
					typeof raw.message === "string"
						? raw.message
						: typeof error?.message === "string"
							? error.message
							: "unknown error",
			};
		}
		default:
			return { type: "other", eventType: type || "<untyped>" };
	}
}

export interface LiveSidebandOptions {
	readonly realtimeSessionId: string;
	readonly onEvent: (event: LiveSidebandEvent) => void;
	readonly onClose: (code: number) => void;
}

/** The sideband socket of one call. */
export class LiveSideband {
	private readonly socket: WebSocket;
	private readonly opened: Promise<void>;

	private constructor(socket: WebSocket, options: LiveSidebandOptions) {
		this.socket = socket;
		this.opened = new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve(), { once: true });
			socket.addEventListener("error", () => reject(new LiveSignalingError("sideband websocket refused")), {
				once: true,
			});
		});
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string") return;
			let raw: Record<string, unknown>;
			try {
				raw = JSON.parse(event.data) as Record<string, unknown>;
			} catch {
				options.onEvent({ type: "other", eventType: "<unparseable>" });
				return;
			}
			// The sideband mirrors the caller's own input audio; it is never consumed.
			if (raw.type === "session.input_audio.append" || raw.type === "session.output_audio.delta") return;
			options.onEvent(parseEvent(raw));
		});
		socket.addEventListener("close", (event) => options.onClose(event.code));
	}

	static async connect(
		credential: LiveCredential,
		callId: string,
		options: LiveSidebandOptions,
	): Promise<LiveSideband> {
		const url = new URL(`${LIVE_SIDEBAND_BASE_URL}/live/${encodeURIComponent(callId)}`);
		url.protocol = "wss:";
		// Node's WebSocket accepts request headers through this non-standard init field.
		const socket = new WebSocket(url, {
			headers: headers(credential, options.realtimeSessionId),
		} as unknown as string[]);
		const sideband = new LiveSideband(socket, options);
		await sideband.opened;
		return sideband;
	}

	private send(payload: Record<string, unknown>): void {
		if (this.socket.readyState !== WebSocket.OPEN) throw new LiveSignalingError("sideband websocket is not open");
		this.socket.send(JSON.stringify(payload));
	}

	/** `context_append_chunks`: 500-byte chunks on UTF-8 boundaries. */
	private static chunks(text: string): string[] {
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length <= CONTEXT_APPEND_MAX_BYTES) return [text];
		const out: string[] = [];
		let start = 0;
		while (start < bytes.length) {
			let end = Math.min(start + CONTEXT_APPEND_MAX_BYTES, bytes.length);
			while (end > start && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
			out.push(bytes.subarray(start, end).toString("utf8"));
			start = end;
		}
		return out;
	}

	appendSessionContext(text: string, channel: LiveContextChannel): void {
		for (const chunk of LiveSideband.chunks(text)) {
			this.send({ type: "session.context.append", channel, content: [{ type: "input_text", text: chunk }] });
		}
	}

	appendDelegationContext(delegationItemId: string, text: string, channel: LiveContextChannel): void {
		for (const chunk of LiveSideband.chunks(text)) {
			this.send({
				type: "delegation.context.append",
				delegation_item_id: delegationItemId,
				channel,
				content: [{ type: "input_text", text: chunk }],
			});
		}
	}

	/** `session.close`, then the socket; resolves once closed or after `timeoutMs`. */
	async close(timeoutMs: number): Promise<void> {
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
		this.socket.close(1000, "done");
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			closed,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
		clearTimeout(timer);
	}
}
