/**
 * The TUI's store (architecture rewrite §10): what the TUI knows of the
 * conversation it shows, as its protocol client holds it: the client fold of
 * the projected entries and the live fold of the live lane. Views read the
 * store and hear what changed.
 *
 * The transcript is the active branch from its newest compaction, as the
 * model sees the conversation: the compaction, the entries it kept, then
 * everything after it. When the client moves (`ended{moved}`), the store
 * holds nothing until the target's snapshot resets it: it is moving, and
 * what the TUI sends waits for the target (`settled`). A snapshot of the same
 * conversation (a resync, or a resubscription after a gap) resets it as well.
 * A subscription that ends otherwise (`ended{lost}`, at shutdown `closed`)
 * ends what the store shows.
 */

import {
	type ClientState,
	clientActiveBranch,
	emptyClientState,
	emptyLiveFold,
	type HostFrame,
	type LiveFoldState,
	type LiveItem,
	type LiveValue,
	type ProjectedEntry,
} from "@hansjm10/volt-protocol";
import type { ProtocolClient, ProtocolClientChange } from "../../../client/protocol-client.ts";

type CatalogName = Extract<HostFrame, { type: "changed" }>["catalog"];
type PhaseValue = Extract<LiveValue, { kind: "phase" }>;

/** What changed in the store. */
export type TuiStoreChange =
	/** A snapshot replaced what the store holds: of the conversation it moved to or connected on (`moved`), or of the same one. */
	| { readonly type: "reset"; readonly conversation: string; readonly moved: boolean }
	/** The client moves to `target`: the store holds nothing until the target's snapshot. */
	| { readonly type: "moving"; readonly target: string }
	/** Entries were appended to the log. */
	| { readonly type: "entries"; readonly entries: readonly ProjectedEntry[] }
	/** A live frame was applied; a reset replaced the live state. */
	| { readonly type: "live"; readonly reset: boolean; readonly items: readonly LiveItem[] }
	/** The host says a catalog changed. */
	| { readonly type: "changed"; readonly catalog: CatalogName }
	/** The subscription ended for good: the conversation lost its log, closed, or the host shut down. */
	| { readonly type: "ended"; readonly reason: "closed" | "lost" | "shutdown" };

/** The entry types a transcript shows. */
const TRANSCRIPT_ENTRY_TYPES: ReadonlySet<ProjectedEntry["type"]> = new Set([
	"message",
	"custom_message",
	"compaction",
	"branch_summary",
]);

function isTranscriptEntry(entry: ProjectedEntry): boolean {
	return TRANSCRIPT_ENTRY_TYPES.has(entry.type);
}

/**
 * The transcript of a branch (root first): from its newest compaction, the
 * compaction, the entries it kept before it, then the entries after it;
 * without one, the branch. Only the entry types a transcript shows.
 */
export function transcriptOf(branch: readonly ProjectedEntry[]): ProjectedEntry[] {
	let compactionIndex = -1;
	for (let index = branch.length - 1; index >= 0; index--) {
		if (branch[index]?.type === "compaction") {
			compactionIndex = index;
			break;
		}
	}
	if (compactionIndex === -1) return branch.filter(isTranscriptEntry);
	const compaction = branch[compactionIndex];
	const firstKeptId = compaction?.type === "compaction" ? compaction.payload?.firstKeptEntryId : undefined;
	const firstKept = firstKeptId === undefined ? -1 : branch.findIndex((entry) => entry.id === firstKeptId);
	const keptFrom = firstKept === -1 || firstKept > compactionIndex ? compactionIndex : firstKept;
	return [
		...(compaction === undefined ? [] : [compaction]),
		...branch.slice(keptFrom, compactionIndex).filter(isTranscriptEntry),
		...branch.slice(compactionIndex + 1).filter(isTranscriptEntry),
	];
}

interface ShowingWaiter {
	/** The conversation waited for; any one the client does not move away from when undefined. */
	readonly conversation: string | undefined;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

export class TuiStore {
	private attached: ProtocolClient | undefined;
	/** The conversation of the last snapshot, until the client moves. */
	private shown: string | undefined;
	/** The conversation the client moves to, until its snapshot resets the store. */
	private movingTo: string | undefined;
	private branchCache: { readonly state: ClientState; readonly branch: readonly ProjectedEntry[] } | undefined;
	private transcriptCache:
		| { readonly branch: readonly ProjectedEntry[]; readonly transcript: readonly ProjectedEntry[] }
		| undefined;
	private readonly listeners = new Set<(change: TuiStoreChange) => void>();
	private readonly waiters = new Set<ShowingWaiter>();

	/** Follow `client`: the store holds what it holds and hears every change from now on. */
	attach(client: ProtocolClient): void {
		if (this.attached) throw new Error("The store follows a client already");
		this.attached = client;
		client.onChange((change) => this.apply(change));
	}

	/** The client the store follows. */
	get client(): ProtocolClient {
		if (!this.attached) throw new Error("The store follows no client");
		return this.attached;
	}

	/** The client fold of the conversation. */
	get state(): ClientState {
		return this.attached?.state ?? emptyClientState();
	}

	/** The live state of the conversation: keyed values and what streams. */
	get live(): LiveFoldState {
		return this.attached?.live ?? emptyLiveFold();
	}

	/** The conversation the store shows: none before the first snapshot, and none while the client moves. */
	get conversation(): string | undefined {
		return this.shown;
	}

	/** The conversation the client moves to, until its snapshot resets the store. */
	get moving(): string | undefined {
		return this.movingTo;
	}

	/** The live value under `key`, if any. */
	value(key: string): LiveValue | undefined {
		return this.live.values.get(key);
	}

	/** The run phase. */
	get phase(): PhaseValue | undefined {
		const value = this.value("phase");
		return value?.kind === "phase" ? value : undefined;
	}

	/** The entries of the active branch the store holds, root first. */
	branch(): readonly ProjectedEntry[] {
		const state = this.state;
		const cached = this.branchCache;
		if (cached?.state === state) return cached.branch;
		const branch = cached === undefined ? clientActiveBranch(state) : extendedBranch(cached.branch, state);
		this.branchCache = { state, branch };
		return branch;
	}

	/** What the transcript shows: the active branch from its newest compaction (see {@link transcriptOf}). */
	transcript(): readonly ProjectedEntry[] {
		const branch = this.branch();
		const cached = this.transcriptCache;
		if (cached?.branch === branch) return cached.transcript;
		const transcript = cached === undefined ? transcriptOf(branch) : extendedTranscript(cached, branch);
		this.transcriptCache = { branch, transcript };
		return transcript;
	}

	/** Hear every change. */
	subscribe(listener: (change: TuiStoreChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Resolves once the store shows `conversation`: at once when it does, else
	 * when the snapshot of the conversation the client moves to reset it.
	 * Rejects when the subscription ends or the client fails first.
	 */
	showing(conversation: string): Promise<void> {
		if (this.shown === conversation) return Promise.resolve();
		return new Promise((resolve, reject) => this.waiters.add({ conversation, resolve, reject }));
	}

	/**
	 * Resolves once the store shows a conversation the client is not moving
	 * away from: at once unless the client moves, else once the snapshot of
	 * where it moves to reset the store. Rejects when the subscription ends or
	 * the client fails first. What the TUI sends while its client moves waits
	 * here, in the order it was sent.
	 */
	settled(): Promise<void> {
		if (this.movingTo === undefined) return Promise.resolve();
		return new Promise((resolve, reject) => this.waiters.add({ conversation: undefined, resolve, reject }));
	}

	/** Have the host project the conversation afresh: a reset follows, with the presentations it presents now. */
	resync(): void {
		this.attached?.resync();
	}

	private apply(change: ProtocolClientChange): void {
		if (change === undefined) {
			// A client that failed moves nowhere.
			this.movingTo = undefined;
			this.settleWaiters(new Error("The TUI's connection to its host ended"));
			return;
		}
		switch (change.type) {
			case "snapshot": {
				const moved = this.shown !== change.conversation;
				this.shown = change.conversation;
				this.movingTo = undefined;
				this.emit({ type: "reset", conversation: change.conversation, moved });
				this.settleWaiters();
				return;
			}
			case "entry":
				this.emit({ type: "entries", entries: [change.entry] });
				return;
			case "live":
				this.emit({ type: "live", reset: change.reset === true, items: change.items });
				return;
			case "ended":
				if (change.reason === "moved") {
					this.shown = undefined;
					this.movingTo = change.target;
					this.emit({ type: "moving", target: change.target });
				} else if (change.reason !== "unsubscribed") {
					this.shown = undefined;
					this.movingTo = undefined;
					this.emit({ type: "ended", reason: change.reason });
					this.settleWaiters(new Error(`The conversation's subscription ended: ${change.reason}`));
				}
				return;
			case "changed":
				this.emit({ type: "changed", catalog: change.catalog });
				return;
			default:
				return;
		}
	}

	private emit(change: TuiStoreChange): void {
		for (const listener of [...this.listeners]) listener(change);
	}

	/** Resolve the waiters for the conversation shown now, or reject every waiter with `error`. */
	private settleWaiters(error?: Error): void {
		for (const waiter of [...this.waiters]) {
			if (error !== undefined) waiter.reject(error);
			else if (waiter.conversation === this.shown || waiter.conversation === undefined) waiter.resolve();
			else continue;
			this.waiters.delete(waiter);
		}
	}
}

/**
 * The active branch of `state`, from `previous`: extended by the entries
 * after its tip when the leaf moved down from it, else read afresh.
 */
function extendedBranch(previous: readonly ProjectedEntry[], state: ClientState): readonly ProjectedEntry[] {
	const tip = previous.at(-1);
	if (tip !== undefined && state.leafId === tip.id && state.byId.get(tip.id) === tip) return previous;
	const added: ProjectedEntry[] = [];
	for (let id = state.leafId; id !== null; ) {
		const entry = state.byId.get(id);
		if (entry === undefined) break;
		if (entry === tip) return [...previous, ...added.reverse()];
		added.push(entry);
		// A long walk means the branch switched: reading it afresh costs the same.
		if (added.length > 64) break;
		id = entry.parentId;
	}
	return clientActiveBranch(state);
}

/** The transcript of `branch`, from the transcript of a branch it extends when no compaction was added. */
function extendedTranscript(
	previous: { readonly branch: readonly ProjectedEntry[]; readonly transcript: readonly ProjectedEntry[] },
	branch: readonly ProjectedEntry[],
): readonly ProjectedEntry[] {
	const length = previous.branch.length;
	const extendsPrevious = length > 0 && branch.length >= length && branch[length - 1] === previous.branch[length - 1];
	if (!extendsPrevious) return transcriptOf(branch);
	const added = branch.slice(length);
	if (added.some((entry) => entry.type === "compaction")) return transcriptOf(branch);
	const shown = added.filter(isTranscriptEntry);
	return shown.length === 0 ? previous.transcript : [...previous.transcript, ...shown];
}
