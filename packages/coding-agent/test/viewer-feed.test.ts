import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { RpcMessageDeltaDecoder } from "../src/core/rpc/message-deltas.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import {
	VIEWER_BUFFER_MAX_BYTES,
	VIEWER_BUFFER_MAX_EVENTS,
	ViewerFeedRegistry,
	type ViewerFeedSession,
} from "../src/daemon/viewer-feed.ts";

function createFeedSession() {
	const handlers = new Set<(event: unknown) => void>();
	const abort = vi.fn(async () => {});
	const session: ViewerFeedSession & { emit(event: unknown): void; abort: typeof abort } = {
		subscribe(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
		abort,
		emit(event: unknown) {
			for (const handler of Array.from(handlers)) {
				handler(event);
			}
		},
	};
	return { session, handlers };
}

function assistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantTextUpdate(text: string, assistantMessageEvent: Record<string, unknown>) {
	const message = assistantMessage(text);
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { ...assistantMessageEvent, partial: message },
	};
}

function createRegistry() {
	const sent: Array<{ connectionId: string; event: ControlEvent }> = [];
	const registry = new ViewerFeedRegistry({
		sendTo: (connectionId, event) => {
			sent.push({ connectionId, event });
			return true;
		},
	});
	return { registry, sent };
}

function viewerEvents(sent: Array<{ connectionId: string; event: ControlEvent }>) {
	return sent.filter((entry) => entry.event.type === "viewer_event") as Array<{
		connectionId: string;
		event: Extract<ControlEvent, { type: "viewer_event" }>;
	}>;
}

describe("ViewerFeedRegistry (§4.3)", () => {
	it("buffers events from drain start and flushes them in order on subscribe, then streams live", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		session.emit({ type: "message_delta", n: 1 });
		session.emit({ type: "message_delta", n: 2 });
		expect(sent).toHaveLength(0);

		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		let events = viewerEvents(sent);
		expect(events.map((entry) => entry.event.seq)).toEqual([0, 1]);
		expect(events.map((entry) => (entry.event.event as { n: number }).n)).toEqual([1, 2]);
		expect(events.every((entry) => entry.connectionId === "c-1")).toBe(true);

		session.emit({ type: "agent_end", n: 3 });
		events = viewerEvents(sent);
		expect(events).toHaveLength(3);
		expect(events[2]?.event.seq).toBe(2);
	});

	it("delta-encodes buffered and live updates after message_start while keeping terminal messages full", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		session.emit(assistantTextUpdate("", { type: "text_start", contentIndex: 0 }));
		session.emit(assistantTextUpdate("buffered", { type: "text_delta", contentIndex: 0, delta: "buffered" }));
		expect(registry.subscribe("vf-1", "c-1")).toBe(true);

		let events = viewerEvents(sent);
		expect(events).toHaveLength(3);
		expect(events[0]?.event.event).toMatchObject({ type: "message_start", message: { role: "assistant" } });
		for (const entry of events.slice(1)) {
			const event = entry.event.event as Record<string, unknown>;
			expect(event).not.toHaveProperty("message");
			expect(event.assistantMessageEvent).not.toHaveProperty("partial");
		}

		session.emit(assistantTextUpdate("buffered live", { type: "text_delta", contentIndex: 0, delta: " live" }));
		const finalMessage = assistantMessage("buffered live");
		session.emit({ type: "message_end", message: finalMessage });
		events = viewerEvents(sent);
		expect(events[3]?.event.event).not.toHaveProperty("message");
		expect(events[4]?.event.event).toEqual({ type: "message_end", message: finalMessage });
	});

	it("starts a mid-message feed with a snapshot and reconstructs buffered and live deltas", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		session.emit(assistantTextUpdate("mid", { type: "text_delta", contentIndex: 0, delta: "mid" }));
		session.emit(assistantTextUpdate("mid-buffered", { type: "text_delta", contentIndex: 0, delta: "-buffered" }));
		expect(registry.subscribe("vf-1", "c-1")).toBe(true);

		let events = viewerEvents(sent);
		expect(events[0]?.event.event).toHaveProperty("message");
		expect(events[1]?.event.event).not.toHaveProperty("message");

		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode(events[0]?.event.event);
		const buffered = decoder.decode(events[1]?.event.event) as {
			message?: { content?: Array<{ text?: string }> };
		};
		expect(buffered.message?.content?.[0]?.text).toBe("mid-buffered");

		session.emit(assistantTextUpdate("mid-buffered-live", { type: "text_delta", contentIndex: 0, delta: "-live" }));
		events = viewerEvents(sent);
		expect(events[2]?.event.event).not.toHaveProperty("message");
		const live = decoder.decode(events[2]?.event.event) as {
			message?: { content?: Array<{ text?: string }> };
		};
		expect(live.message?.content?.[0]?.text).toBe("mid-buffered-live");
	});

	it("detaches buffered snapshots from provider mutations before replay", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		const content = [{ type: "text", text: "A" }];
		const partial = { role: "assistant", content };
		session.emit({
			type: "message_update",
			message: { ...partial },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "A", partial },
		});
		content[0]!.text += "B";
		session.emit({
			type: "message_update",
			message: { ...partial },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "B", partial },
		});

		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		const events = viewerEvents(sent);
		expect(events[0]?.event.event).toMatchObject({
			message: { content: [{ type: "text", text: "A" }] },
		});
		const decoder = new RpcMessageDeltaDecoder();
		decoder.decode(events[0]?.event.event);
		const decoded = decoder.decode(events[1]?.event.event) as {
			message?: { content?: Array<{ text?: string }> };
		};
		expect(decoded.message?.content?.[0]?.text).toBe("AB");
	});

	it("keeps a long accumulated stream below the byte cap with delta-only buffering", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });

		const delta = "x".repeat(1024);
		let accumulated = "";
		let repeatedMessageBytes = 0;
		for (let index = 0; index < 128; index++) {
			accumulated += delta;
			repeatedMessageBytes += accumulated.length;
			session.emit(assistantTextUpdate(accumulated, { type: "text_delta", contentIndex: 0, delta }));
		}
		expect(repeatedMessageBytes).toBeGreaterThan(VIEWER_BUFFER_MAX_BYTES);

		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		const events = viewerEvents(sent);
		expect(events).toHaveLength(129);
		expect(events.some((entry) => (entry.event.event as { kind?: string }).kind === "truncated")).toBe(false);
		expect(events.slice(1).every((entry) => !("message" in (entry.event.event as Record<string, unknown>)))).toBe(
			true,
		);
		expect(
			events.reduce((bytes, entry) => bytes + Buffer.byteLength(JSON.stringify(entry.event.event), "utf8"), 0),
		).toBeLessThan(VIEWER_BUFFER_MAX_BYTES);
	});

	it("applies the byte cap to UTF-8 wire bytes", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		const event = { type: "message_delta", payload: "é".repeat(Math.floor(VIEWER_BUFFER_MAX_BYTES / 2)) };
		const serialized = JSON.stringify(event);
		expect(serialized.length).toBeLessThan(VIEWER_BUFFER_MAX_BYTES);
		expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(VIEWER_BUFFER_MAX_BYTES);
		session.emit(event);

		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		const events = viewerEvents(sent);
		expect(events).toHaveLength(1);
		expect(events[0]?.event.event).toEqual({ kind: "truncated" });
	});

	it("drops the buffer past the event cap and sends only a truncated marker", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });

		for (let index = 0; index < VIEWER_BUFFER_MAX_EVENTS + 5; index++) {
			session.emit({ type: "message_delta", index });
		}
		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		let events = viewerEvents(sent);
		expect(events).toHaveLength(1);
		expect(events[0]?.event.event).toEqual({ kind: "truncated" });

		// Live events still stream after the truncation marker, and the broken
		// replay history forces the next update to carry a fresh snapshot.
		session.emit(assistantTextUpdate("after truncation", { type: "text_delta", contentIndex: 0, delta: "x" }));
		events = viewerEvents(sent);
		expect(events[1]?.event.event).toHaveProperty("message");
		session.emit({ type: "agent_end" });
		expect(viewerEvents(sent)).toHaveLength(3);
	});

	it("rejects subscribe/abort from a connection that is not the drain requester", async () => {
		const { registry } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		expect(registry.subscribe("vf-1", "c-other")).toBe(false);
		expect(await registry.abort("vf-1", "c-other")).toBe(false);
		expect(registry.subscribe("vf-nope", "c-1")).toBe(false);
	});

	it("abort stops the draining turn via the session", async () => {
		const { registry } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		expect(await registry.abort("vf-1", "c-1")).toBe(true);
		expect(session.abort).toHaveBeenCalledTimes(1);
	});

	it("end emits viewer_end, unsubscribes from the session, and tears the feed down", () => {
		const { registry, sent } = createRegistry();
		const { session, handlers } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		registry.subscribe("vf-1", "c-1");

		registry.end("vf-1", "granted");
		expect(handlers.size).toBe(0);
		expect(registry.has("vf-1")).toBe(false);
		const ends = sent.filter((entry) => entry.event.type === "viewer_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.event).toEqual({ type: "viewer_end", viewerFeedId: "vf-1", reason: "granted" });

		// Events after end are ignored.
		session.emit({ type: "message_delta" });
		expect(viewerEvents(sent)).toHaveLength(0);
	});

	it("unsubscribe stops forwarding and resumes with a fresh snapshot", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		registry.subscribe("vf-1", "c-1");
		session.emit({ type: "message_start", message: { role: "assistant", content: [] } });
		expect(viewerEvents(sent)).toHaveLength(1);

		expect(registry.unsubscribe("vf-1", "c-1")).toBe(true);
		session.emit(assistantTextUpdate("missed", { type: "text_delta", contentIndex: 0, delta: "missed" }));
		expect(viewerEvents(sent)).toHaveLength(1);
		expect(registry.has("vf-1")).toBe(true);

		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		session.emit(assistantTextUpdate("missed resumed", { type: "text_delta", contentIndex: 0, delta: " resumed" }));
		const events = viewerEvents(sent);
		expect(events).toHaveLength(2);
		expect(events[1]?.event.event).toHaveProperty("message");
	});
});
