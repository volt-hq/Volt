import { describe, expect, it, vi } from "vitest";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { VIEWER_BUFFER_MAX_EVENTS, ViewerFeedRegistry, type ViewerFeedSession } from "../src/daemon/viewer-feed.ts";

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

	it("drops the buffer past the event cap and sends only a truncated marker", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);

		for (let index = 0; index < VIEWER_BUFFER_MAX_EVENTS + 5; index++) {
			session.emit({ type: "message_delta", index });
		}
		expect(registry.subscribe("vf-1", "c-1")).toBe(true);
		const events = viewerEvents(sent);
		expect(events).toHaveLength(1);
		expect(events[0]?.event.event).toEqual({ kind: "truncated" });

		// Live events still stream after the truncation marker.
		session.emit({ type: "agent_end" });
		expect(viewerEvents(sent)).toHaveLength(2);
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

	it("unsubscribe stops forwarding without ending the drain", () => {
		const { registry, sent } = createRegistry();
		const { session } = createFeedSession();
		registry.start("vf-1", "c-1", session);
		registry.subscribe("vf-1", "c-1");
		expect(registry.unsubscribe("vf-1", "c-1")).toBe(true);
		session.emit({ type: "message_delta" });
		expect(viewerEvents(sent)).toHaveLength(0);
		expect(registry.has("vf-1")).toBe(true);
	});
});
