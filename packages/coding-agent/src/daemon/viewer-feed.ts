import { stripAssistantMessageEventPartial } from "../core/rpc/message-deltas.ts";
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

interface ViewerFeed {
	viewerFeedId: string;
	connectionId: string;
	session: ViewerFeedSession;
	unsubscribeSession: () => void;
	/** Buffered events awaiting viewer_subscribe; null once flushed (live). */
	buffer: unknown[] | null;
	bufferedBytes: number;
	/** Buffer overflowed: buffer dropped, TUI gets {kind:"truncated"} first. */
	truncated: boolean;
	seq: number;
	subscribed: boolean;
	ended: boolean;
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
		};
		feed.unsubscribeSession = session.subscribe((event) => {
			// message_update events duplicate the accumulated partial as
			// assistantMessageEvent.partial; dropping it halves buffer pressure
			// against VIEWER_BUFFER_MAX_BYTES (the drain viewer reads `message`).
			this.onSessionEvent(feed, stripAssistantMessageEventPartial(event));
		});
		this.feeds.set(viewerFeedId, feed);
	}

	private onSessionEvent(feed: ViewerFeed, event: unknown): void {
		if (feed.ended) {
			return;
		}
		if (feed.subscribed) {
			this.emit(feed, event);
			return;
		}
		if (feed.truncated || feed.buffer === null) {
			return;
		}
		let eventBytes = 0;
		try {
			eventBytes = JSON.stringify(event)?.length ?? 0;
		} catch {
			// Unserializable events cannot cross the control plane anyway.
			return;
		}
		if (
			feed.buffer.length + 1 > VIEWER_BUFFER_MAX_EVENTS ||
			feed.bufferedBytes + eventBytes > VIEWER_BUFFER_MAX_BYTES
		) {
			// Cap exceeded: drop everything; the TUI shows a spinner and relies on
			// the post-grant session file load for truth.
			feed.buffer = null;
			feed.bufferedBytes = 0;
			feed.truncated = true;
			return;
		}
		feed.buffer.push(event);
		feed.bufferedBytes += eventBytes;
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
			for (const event of feed.buffer) {
				this.emit(feed, event);
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
