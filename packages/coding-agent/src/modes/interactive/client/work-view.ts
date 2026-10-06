/**
 * The work of a conversation as the TUI's protocol client holds it (RFC §7.3,
 * §10): the work items of its client fold (open work and the newest finished
 * items) with the live `work/<workId>` values of its live fold, which a work
 * item has while an executor runs it. Actions go through the work intents and
 * output through the `work_output` query, as for any client.
 *
 * The conversation the TUI shows acts on its work. A conversation its work
 * opens shows read-only, observed beside it: the open conversation as it
 * changes, or a closed one's log; its own work opens the conversations it
 * links in turn, at any depth. A conversation observed from a bounded
 * snapshot pages its older entries with the `history` query.
 */

import {
	type ClientState,
	type ClientWorkItem,
	clientActiveBranch,
	HISTORY_PAGE_MAX_ENTRIES,
	type LiveFoldState,
	type LiveValue,
	type ProjectedEntry,
} from "@hansjm10/volt-protocol";
import type { ConversationObservation, ProtocolClient } from "../../../client/protocol-client.ts";
import type {
	LiveWorkValue,
	WorkConversation,
	WorkItemView,
	WorkOpenResult,
	WorkOutputTail,
	WorkSource,
} from "../components/work-inspector.ts";
import { transcriptOf } from "./tui-store.ts";

/** What a conversation's work reads: its client fold and live fold, and when they change. */
export interface WorkHolder {
	readonly state: ClientState;
	readonly live: LiveFoldState;
	/** Hear every change of the state or live state. */
	subscribe(listener: () => void): () => void;
}

export interface ConversationWorkOptions {
	/** The TUI's protocol client. */
	readonly client: () => ProtocolClient;
	readonly holder: WorkHolder;
	/** The observed conversation; none for the conversation the client is on. */
	readonly conversation?: string;
}

function workValue(value: LiveValue | undefined): LiveWorkValue | undefined {
	return value?.kind === "work" ? value : undefined;
}

function epoch(timestamp: string | undefined): number | undefined {
	if (timestamp === undefined) return undefined;
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** What a work row tracks of an item to know when its output may have changed. */
function outputKey(view: WorkItemView): string {
	return `${view.live?.output?.bytes ?? ""}:${view.item.outcome ?? view.item.state}`;
}

/**
 * The work of one conversation: the client's own, which the TUI acts on, or
 * an observed one, read-only, whose work opens the conversations it links.
 */
export class ConversationWork implements WorkSource {
	private readonly options: ConversationWorkOptions;
	private readonly listeners = new Set<() => void>();
	private unsubscribeHolder: (() => void) | undefined;
	/** The work map and live work values the listeners heard of last. */
	private seen: { work: ClientState["work"]; live: readonly LiveWorkValue[] } | undefined;
	private viewsCache:
		| { work: ClientState["work"]; values: LiveFoldState["values"]; views: WorkItemView[] }
		| undefined;
	/** The newest output of items tool calls show, by work id, what it was read after, and when. */
	private readonly outputs = new Map<string, { key: string; text?: string; version?: number; reading?: boolean }>();
	private outputReads = 0;

	constructor(options: ConversationWorkOptions) {
		this.options = options;
	}

	private get observeOnly(): boolean {
		return this.options.conversation !== undefined;
	}

	private get queryOptions(): { conversation?: string } {
		return this.options.conversation === undefined ? {} : { conversation: this.options.conversation };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		this.unsubscribeHolder ??= this.options.holder.subscribe(() => this.holderChanged());
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size > 0) return;
			this.unsubscribeHolder?.();
			this.unsubscribeHolder = undefined;
			this.seen = undefined;
		};
	}

	/** Stop hearing the holder and forget what was read. */
	dispose(): void {
		this.listeners.clear();
		this.unsubscribeHolder?.();
		this.unsubscribeHolder = undefined;
		this.seen = undefined;
		this.outputs.clear();
	}

	/** Every item, open first (newest first), then the newest finished ones. */
	items(): readonly WorkItemView[] {
		const { state, live } = this.options.holder;
		const cached = this.viewsCache;
		if (cached?.work === state.work && cached.values === live.values) return cached.views;
		const all = [...state.work.values()].map((item) => this.view(item, live));
		const open = all.filter((view) => view.item.outcome === undefined).reverse();
		const finished = all
			.filter((view) => view.item.outcome !== undefined)
			.sort((left, right) => (right.item.finishedOrdinal ?? 0) - (left.item.finishedOrdinal ?? 0));
		const views = [...open, ...finished];
		this.viewsCache = { work: state.work, values: live.values, views };
		return views;
	}

	/** The work the tool call `toolCallId` started. */
	itemsOfToolCall(toolCallId: string): WorkItemView[] {
		return this.items().filter((view) => view.item.toolCallId === toolCallId);
	}

	/** The item `workId`, open or finished. */
	item(workId: string): ClientWorkItem | undefined {
		return this.options.holder.state.work.get(workId);
	}

	/** Which read of `workId`'s newest output {@link newestOutput} holds: it changes with each read. */
	outputVersion(workId: string): number | undefined {
		return this.outputs.get(workId)?.version;
	}

	/**
	 * The newest output of `view` as last read, for a tool call's card; reading
	 * it again when it may have changed, after which the listeners hear of it.
	 */
	newestOutput(view: WorkItemView): string | undefined {
		const workId = view.item.workId;
		const key = outputKey(view);
		const held = this.outputs.get(workId);
		if (held?.key === key || held?.reading) return held.text;
		const kept = held?.text === undefined ? {} : { text: held.text, version: held.version };
		const reading = { key, ...kept, reading: true };
		this.outputs.set(workId, reading);
		void this.output(workId).then(
			(tail) => {
				if (this.outputs.get(workId) !== reading) return;
				this.outputs.set(workId, { key, text: tail.text, version: ++this.outputReads });
				this.notify();
			},
			() => {
				if (this.outputs.get(workId) === reading) this.outputs.set(workId, { key, ...kept });
			},
		);
		return held?.text;
	}

	async output(workId: string): Promise<WorkOutputTail> {
		const client = this.options.client();
		const first = await client.query("work_output", { workId }, this.queryOptions);
		if (first.nextOffset === null) {
			return { text: first.text, truncated: first.truncated, partial: false, final: first.final };
		}
		// The newest chunk: the inspector shows the tail.
		const offset = Math.max(0, first.totalScalars - (first.nextOffset - first.offset));
		const last = await client.query("work_output", { workId, offset }, this.queryOptions);
		return { text: last.text, truncated: last.truncated, partial: offset > 0, final: last.final };
	}

	async cancel(workId: string): Promise<void> {
		if (this.observeOnly) throw new Error("The work of another conversation is read-only here");
		await this.options.client().intent("cancel_work", { workId });
	}

	async resume(workId: string): Promise<void> {
		if (this.observeOnly) throw new Error("The work of another conversation is read-only here");
		await this.options.client().intent("resume_work", { workId });
	}

	async open(workId: string): Promise<WorkOpenResult> {
		const item = this.item(workId);
		const title = item?.title ?? workId;
		const client = this.options.client();
		if (this.observeOnly) {
			// The conversation another conversation's work links is observed as such: it was never this client's to open.
			const conversation = item?.child?.conversation;
			if (conversation === undefined) throw new Error("This work runs in no conversation of its own");
			return { kind: "view", conversation: await ObservedConversation.open(title, client, conversation) };
		}
		const accepted = await client.intent("open_work", { workId });
		const result = accepted.result;
		if (accepted.conversation !== undefined || result === undefined || "cancelled" in result) {
			return { kind: "moved" };
		}
		return { kind: "view", conversation: await ObservedConversation.open(title, client, result.conversation) };
	}

	private view(item: ClientWorkItem, live: LiveFoldState): WorkItemView {
		const value = workValue(live.values.get(`work/${item.workId}`));
		const open = item.outcome === undefined;
		const suspended = open && item.resume && value === undefined;
		const startedAt = epoch(item.startedAt);
		const finishedAt = epoch(item.finishedAt);
		return {
			item,
			...(value === undefined ? {} : { live: value }),
			suspended,
			...(startedAt === undefined ? {} : { startedAt }),
			...(finishedAt === undefined ? {} : { finishedAt }),
			actions: this.observeOnly
				? { cancel: false, resume: false, open: item.child !== undefined }
				: {
						// Suspended work this host cannot resume is cancellable too: nothing else could end it.
						cancel: open && (item.cancellable || (value === undefined && !item.resume)),
						resume: suspended && item.state === "running",
						open: item.opens === true,
					},
		};
	}

	private holderChanged(): void {
		const { state, live } = this.options.holder;
		const values: LiveWorkValue[] = [];
		for (const [key, value] of live.values) {
			const work = key.startsWith("work/") ? workValue(value) : undefined;
			if (work !== undefined) values.push(work);
		}
		const seen = this.seen;
		this.seen = { work: state.work, live: values };
		// The output of work the fold no longer holds is not shown any more.
		for (const workId of this.outputs.keys()) if (!state.work.has(workId)) this.outputs.delete(workId);
		if (
			seen !== undefined &&
			seen.work === state.work &&
			seen.live.length === values.length &&
			seen.live.every((value, index) => value === values[index])
		) {
			return;
		}
		this.notify();
	}

	private notify(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Observers never affect work.
			}
		}
	}
}

/** The messages a transcript of projected entries shows, oldest first. */
function messagesOf(entries: readonly ProjectedEntry[]): unknown[] {
	return entries.flatMap((entry): unknown[] => {
		if (entry.type === "message" && entry.payload?.message) return [entry.payload.message];
		if (entry.type === "custom_message" && entry.payload?.display) {
			return [{ role: "custom", content: entry.payload.content }];
		}
		return [];
	});
}

/**
 * A conversation the TUI reads but does not act on, observed through its
 * client: its transcript, what streams in it while it is open, and its own
 * work. Entries older than a bounded snapshot load a page at a time.
 */
export class ObservedConversation implements WorkConversation {
	readonly title: string;
	readonly work: ConversationWork;
	private readonly client: ProtocolClient;
	private readonly conversation: string;
	private readonly observation: ConversationObservation;
	/** Older entries of the active branch loaded with `history`, oldest first. */
	private earlierEntries: ProjectedEntry[] = [];
	private earlierLeft: boolean | undefined;
	private loading = false;
	private readonly listeners = new Set<() => void>();
	private readonly unsubscribe: () => void;
	private messageCache:
		| { state: ClientState; live: LiveFoldState; earlier: ProjectedEntry[]; messages: unknown[] }
		| undefined;

	/** Observe `conversation` until what it holds is current; throws when it ended without a snapshot. */
	static async open(title: string, client: ProtocolClient, conversation: string): Promise<ObservedConversation> {
		const observed = new ObservedConversation(title, client, conversation);
		const observation = observed.observation;
		await new Promise<void>((resolve) => {
			const settle = (): void => {
				if (!observation.caughtUp && observation.ended === undefined) return;
				unsubscribe();
				resolve();
			};
			const unsubscribe = observation.onChange(settle);
			settle();
		});
		if (!observation.received) {
			observed.dispose();
			throw new Error("The conversation of this work cannot be read");
		}
		return observed;
	}

	private constructor(title: string, client: ProtocolClient, conversation: string) {
		this.title = title;
		this.client = client;
		this.conversation = conversation;
		const observation = client.observe(conversation);
		this.observation = observation;
		this.unsubscribe = observation.onChange(() => this.changed());
		this.work = new ConversationWork({
			client: () => client,
			holder: {
				get state() {
					return observation.state;
				},
				get live() {
					return observation.live;
				},
				subscribe: (listener) => observation.onChange(listener),
			},
			conversation,
		});
	}

	get live(): boolean {
		return this.observation.ended === undefined;
	}

	/** Whether its snapshot arrived. */
	get received(): boolean {
		return this.observation.received;
	}

	/** Whether older entries remain to load. */
	get earlier(): boolean {
		return this.earlierLeft ?? this.observation.state.earlier;
	}

	messages(): readonly unknown[] {
		const { state, live } = this.observation;
		const cached = this.messageCache;
		if (cached?.state === state && cached.live === live && cached.earlier === this.earlierEntries) {
			return cached.messages;
		}
		const streaming = live.assistant?.message;
		const messages = [
			...messagesOf(this.earlierEntries),
			...messagesOf(transcriptOf(clientActiveBranch(state))),
			...(streaming === undefined ? [] : [streaming]),
		];
		this.messageCache = { state, live, earlier: this.earlierEntries, messages };
		return messages;
	}

	/** Load the page of entries before the oldest one held; nothing when none remain or a page loads. */
	async loadEarlier(): Promise<void> {
		if (!this.earlier || this.loading) return;
		const oldest = this.earlierEntries[0] ?? clientActiveBranch(this.observation.state)[0];
		if (oldest === undefined) return;
		this.loading = true;
		try {
			const page = await this.client.query(
				"history",
				{ before: oldest.ordinal, limit: HISTORY_PAGE_MAX_ENTRIES, branch: oldest.id },
				{ conversation: this.conversation },
			);
			// The branch walk starts at the oldest entry held, which the page repeats.
			const older = page.entries.filter((entry) => entry.ordinal < oldest.ordinal);
			this.earlierEntries = [...older, ...this.earlierEntries];
			this.earlierLeft = page.earlier;
		} finally {
			this.loading = false;
			this.changed();
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	dispose(): void {
		this.listeners.clear();
		this.unsubscribe();
		this.work.dispose();
		this.observation.stop();
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Observers never affect the conversation.
			}
		}
	}
}
