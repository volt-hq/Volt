/**
 * One subscription's writer (RFC §6.1): the projected entries of a
 * conversation from a position, and its live lane.
 *
 * Entries are read lazily from the log by a cursor, never queued: the writer
 * projects what the log holds after the cursor whenever the log advances or a
 * live frame is due. Live frames are queued with the log position they were
 * published at (`basedOn`). Invariant W: a live frame is written only after
 * every visible entry up to its `basedOn`, so a client never sees streaming
 * state ahead of the entries it builds on. A batch whose last entries the
 * profile hides ends with a `head` frame, so the client's position covers
 * them.
 *
 * `seq` restarts at 1 with every live reset. When the queued live frames
 * outgrow the profile's bound, they are dropped and the subscription takes a
 * fresh reset from the live state instead; entries are never dropped.
 */

import {
	type ClientSnapshot,
	clientActiveBranch,
	clientFold,
	clientSnapshot,
	type HostFrame,
	type HostRequestKind,
	type LiveItem,
	type ProjectedEntry,
} from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import type { LiveUpdate } from "../../host/live-state.ts";
import type { SessionManager } from "../../session-manager.ts";
import { plainNoticeText } from "../../ui/extension-ui.ts";
import type { Profile } from "../profiles.ts";
import { conversationProjectionSource, projectEntry, sessionProjectionSource } from "../projection/entries.ts";
import type { ProjectionSource } from "../projection/transcript.ts";

/** Where a subscription writes its frames, in order. */
export interface SubscriptionSink {
	send(frame: HostFrame): void;
}

export interface SubscriptionOptions {
	readonly subscriptionId: string;
	/** The id the subscription's live view attaches to the conversation's live state under. */
	readonly liveClientId: string;
	/** The host client the subscription belongs to: requests asked of that client reach the subscription. */
	readonly liveOwner?: string;
	readonly conversation: HostedConversation;
	readonly profile: Profile;
	readonly sink: SubscriptionSink;
	/** Whether the subscriber receives the live lane. */
	readonly live: boolean;
	/** Whether the subscriber is asked host requests of `kind`. */
	readonly accepts: (kind: HostRequestKind) => boolean;
}

interface QueuedLive {
	readonly basedOn: number;
	readonly reset: boolean;
	readonly items: readonly LiveItem[];
	/** Serialized size, measured only for frames queued while the writer runs. */
	readonly bytes: number;
}

export type SubscriptionEnd =
	| { readonly reason: "unsubscribed" | "closed" | "lost" | "shutdown" }
	| { readonly reason: "moved"; readonly target: string };

/** The projected entries of a log up to `ordinal`, in order. */
export function projectLog(
	conversation: HostedConversation,
	profile: Profile,
	afterOrdinal: number,
	throughOrdinal: number,
): ProjectedEntry[] {
	return projectEntries(
		conversation.session.sessionManager,
		conversationProjectionSource(conversation.session),
		profile,
		afterOrdinal,
		throughOrdinal,
	);
}

function projectEntries(
	sessionManager: SessionManager,
	source: ProjectionSource,
	profile: Profile,
	afterOrdinal: number,
	throughOrdinal: number,
): ProjectedEntry[] {
	const projected: ProjectedEntry[] = [];
	for (const entry of sessionManager.committedEntriesAfter(afterOrdinal, throughOrdinal - afterOrdinal)) {
		const entryFrame = projectEntry(entry, source, profile);
		if (entryFrame) projected.push(entryFrame);
	}
	return projected;
}

/**
 * A snapshot of a log at `ordinal` for `profile`: the fold of its projection,
 * with at most the profile's tail of entries. A log read without its runtime
 * presents with the built-in presenters.
 */
export function logSnapshot(
	sessionManager: SessionManager,
	profile: Profile,
	ordinal: number,
	source: ProjectionSource = sessionProjectionSource(sessionManager),
): ClientSnapshot {
	const projected = projectEntries(sessionManager, source, profile, 0, ordinal);
	const state = clientFold(projected);
	const tail = profile.limits.snapshotTail;
	return projected.length <= tail
		? clientSnapshot(state)
		: { ...clientSnapshot(state), entries: clientActiveBranch(state).slice(-tail), earlier: true };
}

/** Whether a subscription from `after` starts with a snapshot: from `snapshot`, past the log, or further back than the profile replays. */
export function subscriptionSnapshots(
	conversation: HostedConversation,
	profile: Profile,
	after: number | "snapshot",
): boolean {
	const head = conversation.session.sessionManager.getOrdinal();
	return after === "snapshot" || after > head || head - after > profile.limits.maxReplay;
}

/**
 * What a subscription from `after` costs of its connection's read budget: one
 * read for a snapshot or a live start, and one per snapshot tail of entries a
 * resume replays.
 */
export function subscriptionReads(
	conversation: HostedConversation,
	profile: Profile,
	after: number | "snapshot",
): number {
	if (subscriptionSnapshots(conversation, profile, after) || after === "snapshot") return 1;
	const replayed = conversation.session.sessionManager.getOrdinal() - after;
	return Math.max(1, Math.ceil(replayed / profile.limits.snapshotTail));
}

export class Subscription {
	readonly id: string;
	readonly conversation: HostedConversation;
	private readonly options: SubscriptionOptions;
	private readonly source: ProjectionSource;
	/** The newest ordinal the subscriber's position covers. */
	private cursor = 0;
	private readonly queue: QueuedLive[] = [];
	private queuedBytes = 0;
	private seq = 0;
	/** The `basedOn` of the newest queued live frame. */
	private basedOn = 0;
	private pumping = false;
	private again = false;
	private replacingLive = false;
	private detachLive: (() => void) | undefined;
	private releaseGit: (() => void) | undefined;
	private unsubscribeLog: (() => void) | undefined;
	private ended = false;

	constructor(options: SubscriptionOptions) {
		this.options = options;
		this.id = options.subscriptionId;
		this.conversation = options.conversation;
		this.source = conversationProjectionSource(options.conversation.session);
	}

	get isEnded(): boolean {
		return this.ended;
	}

	/** Whether the subscription carries the live lane. */
	get receivesLive(): boolean {
		return this.options.live;
	}

	/**
	 * Start after the subscriber's position, or from a snapshot. A position
	 * past the log, or further back than the profile replays, is answered with
	 * a snapshot at the current position.
	 */
	start(after: number | "snapshot"): void {
		const sessionManager = this.conversation.session.sessionManager;
		if (subscriptionSnapshots(this.conversation, this.options.profile, after)) {
			this.writeSnapshot(sessionManager.getOrdinal());
		} else {
			this.cursor = after as number;
		}
		this.unsubscribeLog = sessionManager.subscribeOrdinal(() => this.pump());
		if (this.options.live) {
			this.releaseGit = this.conversation.session.gitContextProvider.retainObservation();
			this.attachLive();
		}
		this.pump();
	}

	/** Write what is due: queued live frames after the entries they build on, then the log's tail. */
	pump(): void {
		if (this.ended) return;
		if (this.pumping) {
			this.again = true;
			return;
		}
		this.pumping = true;
		try {
			do {
				this.again = false;
				for (let frame = this.queue.shift(); frame !== undefined && !this.ended; frame = this.queue.shift()) {
					this.queuedBytes -= frame.bytes;
					this.writeEntriesThrough(frame.basedOn);
					this.writeLive(frame);
				}
				if (!this.ended) this.writeEntriesThrough(this.conversation.session.sessionManager.getOrdinal());
			} while (this.again && !this.ended);
		} finally {
			this.pumping = false;
		}
	}

	/**
	 * A transient notice on the live lane; it changes no streaming scope. Its
	 * text, such as an extension's error, reaches the client without terminal
	 * controls and bounded.
	 */
	notice(level: "info" | "warning" | "error", message: string, source?: string): void {
		if (!this.options.live || this.ended) return;
		this.receive({
			reset: false,
			basedOn: this.basedOn,
			items: [
				{ type: "notice", level, message: plainNoticeText(message), ...(source === undefined ? {} : { source }) },
			],
		});
	}

	/** End the subscription: what the log holds is written first, then `ended`. */
	end(end: SubscriptionEnd): void {
		if (this.ended) return;
		this.pump();
		this.ended = true;
		this.release();
		this.options.sink.send(
			end.reason === "moved"
				? { type: "ended", subscriptionId: this.id, reason: "moved", target: end.target }
				: { type: "ended", subscriptionId: this.id, reason: end.reason },
		);
	}

	/** Stop without a frame: the connection is gone. */
	dispose(): void {
		if (this.ended) return;
		this.ended = true;
		this.release();
	}

	private release(): void {
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.unsubscribeLog?.();
		this.unsubscribeLog = undefined;
		this.replacingLive = true;
		this.detachLive?.();
		this.detachLive = undefined;
		this.releaseGit?.();
		this.releaseGit = undefined;
	}

	private attachLive(): void {
		this.detachLive = this.conversation.liveState.attach(this.options.liveClientId, {
			...(this.options.liveOwner === undefined ? {} : { owner: this.options.liveOwner }),
			acceptsHostRequest: (kind) => this.options.accepts(kind),
			apply: (update) => this.receive(update),
		});
	}

	private receive(update: LiveUpdate): void {
		if (this.ended || this.replacingLive) return;
		// A reset replaces whatever is queued.
		if (update.reset) {
			this.queue.length = 0;
			this.queuedBytes = 0;
		}
		const bytes = this.pumping ? JSON.stringify(update.items).length : 0;
		this.queue.push({ basedOn: update.basedOn, reset: update.reset, items: update.items, bytes });
		this.basedOn = update.basedOn;
		this.queuedBytes += bytes;
		if (this.queuedBytes > this.options.profile.limits.liveQueueBytes) {
			this.replaceLive();
			return;
		}
		this.pump();
	}

	/** Drop the queued live frames and start over from a reset of the current live state. */
	private replaceLive(): void {
		this.queue.length = 0;
		this.queuedBytes = 0;
		this.replacingLive = true;
		try {
			this.detachLive?.();
		} finally {
			this.replacingLive = false;
		}
		this.attachLive();
	}

	private writeSnapshot(ordinal: number): void {
		this.options.sink.send({
			type: "snapshot",
			subscriptionId: this.id,
			conversation: this.conversation.id,
			ordinal,
			state: logSnapshot(this.conversation.session.sessionManager, this.options.profile, ordinal, this.source),
		});
		this.cursor = ordinal;
	}

	/** Write the visible entries up to `ordinal`, and `head` when the last of them are hidden. */
	private writeEntriesThrough(ordinal: number): void {
		if (ordinal <= this.cursor) return;
		const entries = this.conversation.session.sessionManager.committedEntriesAfter(
			this.cursor,
			ordinal - this.cursor,
		);
		if (entries.length === 0) return;
		let written = this.cursor;
		for (const entry of entries) {
			const projected = projectEntry(entry, this.source, this.options.profile);
			if (!projected) continue;
			this.options.sink.send({ type: "entry", subscriptionId: this.id, entry: projected });
			written = entry.ordinal;
		}
		const last = entries[entries.length - 1]!.ordinal;
		if (written < last) this.options.sink.send({ type: "head", subscriptionId: this.id, ordinal: last });
		this.cursor = last;
	}

	private writeLive(frame: QueuedLive): void {
		this.seq = frame.reset ? 1 : this.seq + 1;
		this.options.sink.send({
			type: "live",
			subscriptionId: this.id,
			basedOn: frame.basedOn,
			seq: this.seq,
			...(frame.reset ? { reset: true } : {}),
			items: [...frame.items],
		});
	}
}
