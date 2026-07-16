import { Buffer } from "node:buffer";
import { RpcSessionEventEncoder } from "../core/rpc/message-deltas.ts";
import type { ControlEvent } from "./control-protocol.ts";

/**
 * Read-only viewer feeds for lease drains (§4.3): from drain start, every
 * AgentSessionEvent of the draining runtime is captured; events are buffered
 * until the acquiring TUI sends viewer_subscribe, then flushed and streamed
 * live as viewer_event control messages. The feed is delivered only to the
 * drain requester's control connection.
 */

export const VIEWER_BUFFER_MAX_EVENTS = 2000;
export const VIEWER_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

/** Structural view of AgentSession as the feed needs it. */
export interface ViewerFeedSession {
	subscribe(handler: (event: unknown) => void): () => void;
	abort(): Promise<void> | void;
}

interface BufferedViewerEvent {
	event: unknown;
	byteLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolCallDeltaSnapshot(value: unknown): boolean {
	if (!isRecord(value) || value.type !== "message_update" || !isRecord(value.message)) {
		return false;
	}
	return isRecord(value.assistantMessageEvent) && value.assistantMessageEvent.type === "toolcall_delta";
}

interface ViewerFeed {
	viewerFeedId: string;
	connectionId: string;
	session: ViewerFeedSession;
	unsubscribeSession: () => void;
	/** Buffered events awaiting viewer_subscribe; null once flushed (live). */
	buffer: BufferedViewerEvent[] | null;
	bufferedBytes: number;
	/** Buffer overflowed: buffer dropped, TUI gets {kind:"truncated"} first. */
	truncated: boolean;
	seq: number;
	subscribed: boolean;
	ended: boolean;
	/** Delta framing state for this feed's single ordered delivery stream. */
	eventEncoder: RpcSessionEventEncoder;
}

export interface ViewerFeedEffects {
	/** Deliver a control event to a specific connection; false when it is gone. */
	sendTo(connectionId: string, event: ControlEvent): boolean;
}

export class ViewerFeedRegistry {
	private readonly effects: ViewerFeedEffects;
	private readonly feeds = new Map<string, ViewerFeed>();

	constructor(effects: ViewerFeedEffects) {
		this.effects = effects;
	}

	/** Begin capturing the draining runtime's events for the requesting connection. */
	start(viewerFeedId: string, connectionId: string, session: ViewerFeedSession): void {
		if (this.feeds.has(viewerFeedId)) {
			return;
		}
		const feed: ViewerFeed = {
			viewerFeedId,
			connectionId,
			session,
			unsubscribeSession: () => {},
			buffer: [],
			bufferedBytes: 0,
			truncated: false,
			seq: 0,
			subscribed: false,
			ended: false,
			eventEncoder: new RpcSessionEventEncoder(),
		};
		feed.unsubscribeSession = session.subscribe((event) => {
			this.onSessionEvent(feed, event);
		});
		this.feeds.set(viewerFeedId, feed);
	}

	private onSessionEvent(feed: ViewerFeed, event: unknown): void {
		if (feed.ended) {
			return;
		}
		if (feed.subscribed) {
			this.emit(feed, this.encodeSessionEvent(feed, event));
			return;
		}
		if (feed.truncated || feed.buffer === null) {
			return;
		}
		const encodedEvent = this.encodeSessionEvent(feed, event);
		let serializedEvent: string;
		try {
			const serialized = JSON.stringify(encodedEvent);
			if (serialized === undefined) {
				feed.eventEncoder = new RpcSessionEventEncoder();
				return;
			}
			serializedEvent = serialized;
		} catch {
			// Unserializable events cannot cross the control plane anyway. Reset the
			// encoder so the next deliverable update carries a fresh snapshot.
			feed.eventEncoder = new RpcSessionEventEncoder();
			return;
		}
		const eventBytes = Buffer.byteLength(serializedEvent, "utf8");
		const previousEvent = feed.buffer[feed.buffer.length - 1];
		const replacePrevious =
			previousEvent !== undefined &&
			isToolCallDeltaSnapshot(previousEvent.event) &&
			isToolCallDeltaSnapshot(encodedEvent);
		const nextEventCount = feed.buffer.length + (replacePrevious ? 0 : 1);
		const nextBufferedBytes = feed.bufferedBytes - (replacePrevious ? previousEvent.byteLength : 0) + eventBytes;
		if (nextEventCount > VIEWER_BUFFER_MAX_EVENTS || nextBufferedBytes > VIEWER_BUFFER_MAX_BYTES) {
			// Cap exceeded: drop everything; the TUI shows a spinner and relies on
			// the post-grant session file load for truth.
			feed.buffer = null;
			feed.bufferedBytes = 0;
			feed.truncated = true;
			// Buffered history is gone. Any later live frame must not depend on it.
			feed.eventEncoder = new RpcSessionEventEncoder();
			return;
		}
		// Buffer the exact detached JSON value that will cross the control plane.
		// Provider streams mutate nested message blocks in place after emission.
		// Consecutive tool-call snapshots supersede one another when a provider
		// cannot expose the raw argument prefix needed to resume delta framing.
		const bufferedEvent: BufferedViewerEvent = { event: JSON.parse(serializedEvent), byteLength: eventBytes };
		if (replacePrevious) {
			feed.buffer[feed.buffer.length - 1] = bufferedEvent;
		} else {
			feed.buffer.push(bufferedEvent);
		}
		feed.bufferedBytes = nextBufferedBytes;
	}

	private encodeSessionEvent(feed: ViewerFeed, event: unknown): unknown {
		return typeof event === "object" && event !== null ? feed.eventEncoder.encode(event) : event;
	}

	private emit(feed: ViewerFeed, event: unknown): void {
		this.effects.sendTo(feed.connectionId, {
			type: "viewer_event",
			viewerFeedId: feed.viewerFeedId,
			seq: feed.seq++,
			event,
		});
	}

	/**
	 * viewer_subscribe from the drain requester: flush the buffer (or the
	 * truncation marker) and switch to live forwarding. Returns false for an
	 * unknown feed or a connection that is not the drain requester.
	 */
	subscribe(viewerFeedId: string, connectionId: string): boolean {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.ended || feed.connectionId !== connectionId) {
			return false;
		}
		if (feed.subscribed) {
			return true;
		}
		feed.subscribed = true;
		if (feed.truncated) {
			this.emit(feed, { kind: "truncated" });
		} else if (feed.buffer) {
			for (const entry of feed.buffer) {
				this.emit(feed, entry.event);
			}
		}
		feed.buffer = null;
		feed.bufferedBytes = 0;
		return true;
	}

	/** Stop forwarding without ending the drain (TUI dismissed the overlay). */
	unsubscribe(viewerFeedId: string, connectionId: string): boolean {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.connectionId !== connectionId) {
			return false;
		}
		feed.subscribed = false;
		feed.buffer = null;
		feed.bufferedBytes = 0;
		// Events are dropped while unsubscribed, so resumption needs a snapshot.
		feed.eventEncoder = new RpcSessionEventEncoder();
		return true;
	}

	/** viewer_abort: stop the draining turn (non-destructive abort, §7.4). */
	async abort(viewerFeedId: string, connectionId: string): Promise<boolean> {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.ended || feed.connectionId !== connectionId) {
			return false;
		}
		await feed.session.abort();
		return true;
	}

	/** Drain ended: emit viewer_end (best-effort) and tear the feed down. */
	end(viewerFeedId: string, reason: "granted" | "cancelled" | "error"): void {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed) {
			return;
		}
		feed.ended = true;
		feed.unsubscribeSession();
		this.feeds.delete(viewerFeedId);
		this.effects.sendTo(feed.connectionId, { type: "viewer_end", viewerFeedId, reason });
	}

	has(viewerFeedId: string): boolean {
		return this.feeds.has(viewerFeedId);
	}
}
