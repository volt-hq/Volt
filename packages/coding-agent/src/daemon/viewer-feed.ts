import type { ControlEvent } from "./control-protocol.ts";

/**
 * Lease drains a TUI waits on (§4.3): while the daemon finishes its turn in a
 * session a TUI is acquiring, the TUI may stop that turn (`viewer_abort`),
 * and it hears when the drain ends (`viewer_end`). Only the drain requester's
 * control connection may stop the turn. Lease drains are deleted with the
 * worker registry (Phase 7).
 */

/** Structural view of the draining session as the registry needs it. */
export interface ViewerFeedSession {
	abort(source?: "remote_request"): Promise<void> | void;
}

interface ViewerFeed {
	readonly connectionId: string;
	readonly session: ViewerFeedSession;
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

	/** A drain started for the requesting connection. */
	start(viewerFeedId: string, connectionId: string, session: ViewerFeedSession): void {
		if (this.feeds.has(viewerFeedId)) return;
		this.feeds.set(viewerFeedId, { connectionId, session });
	}

	/** viewer_abort: stop the draining turn (non-destructive abort, §7.4). */
	async abort(viewerFeedId: string, connectionId: string): Promise<boolean> {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed || feed.connectionId !== connectionId) return false;
		await feed.session.abort("remote_request");
		return true;
	}

	/** Drain ended: emit viewer_end (best-effort). */
	end(viewerFeedId: string, reason: "granted" | "cancelled" | "error"): void {
		const feed = this.feeds.get(viewerFeedId);
		if (!feed) return;
		this.feeds.delete(viewerFeedId);
		this.effects.sendTo(feed.connectionId, { type: "viewer_end", viewerFeedId, reason });
	}

	has(viewerFeedId: string): boolean {
		return this.feeds.has(viewerFeedId);
	}
}
