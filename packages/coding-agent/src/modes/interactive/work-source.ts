/**
 * The TUI's view of the work of the conversation it shows: the records its
 * fold holds, as a client folds them, with the live `work/<workId>` values
 * the live view receives. Actions go through the work intents and output
 * through the `work_output` query, as for any client; a conversation work
 * opens shows read-only: the open conversation, or a closed one's log.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import { CLIENT_WORK_FINISHED_MAX, type ClientWorkItem } from "@hansjm10/volt-protocol";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { type IntentContext, intentRegistry } from "../../core/protocol/intents/index.ts";
import { queryRegistry } from "../../core/protocol/queries/index.ts";
import { SessionManager } from "../../core/session-manager.ts";
import { linkedSubagentConversation } from "../../core/subagents/work.ts";
import type {
	LiveWorkValue,
	WorkConversation,
	WorkItemView,
	WorkOpenResult,
	WorkOutputTail,
	WorkSource,
} from "./components/work-inspector.ts";

/** What the TUI reads its conversation's work through. */
export interface TuiWorkSourceHost {
	/** The conversation the TUI shows. */
	conversation(): HostedConversation;
	/** The TUI's intent context, for the work intents and `work_output`. */
	intentContext(): IntentContext;
}

/** A record as a client folds it: metadata only, without input, output text, or result data. */
export function clientWorkItem(record: WorkRecord): ClientWorkItem {
	const { summary, child, output } = record.result ?? {};
	const result = {
		...(summary === undefined ? {} : { summary }),
		...(child === undefined ? {} : { child }),
		...(output === undefined ? {} : { output: { truncated: output.truncated } }),
	};
	return {
		workId: record.workId,
		kind: record.kind,
		title: record.title,
		...(record.parentWorkId === undefined ? {} : { parentWorkId: record.parentWorkId }),
		cancellable: record.cancellable,
		delivery: record.delivery,
		resume: record.resume,
		...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
		...(record.child === undefined ? {} : { child: record.child }),
		state: record.state,
		...(record.outcome === undefined ? {} : { outcome: record.outcome }),
		...(record.progress === undefined ? {} : { progress: record.progress }),
		...(record.detail === undefined ? {} : { detail: record.detail }),
		...(Object.keys(result).length === 0 ? {} : { result }),
		...(record.error === undefined ? {} : { error: record.error }),
		startedOrdinal: record.startedOrdinal,
		updatedOrdinal: record.updatedOrdinal,
		...(record.finishedOrdinal === undefined ? {} : { finishedOrdinal: record.finishedOrdinal }),
	};
}

function isMessageEntry(entry: unknown): entry is { type: "message"; message: unknown } {
	return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message";
}

/** An open conversation, read-only: its messages and the one streaming, refreshed as it changes. */
function openConversationView(title: string, child: HostedConversation): WorkConversation {
	let messages: readonly unknown[] = [];
	const read = (): void => {
		if (child.closed) return;
		try {
			const state = child.session.state;
			messages = state.streamingMessage === undefined ? state.messages : [...state.messages, state.streamingMessage];
		} catch {
			// A conversation that closed keeps what was read last.
		}
	};
	read();
	const listeners = new Set<() => void>();
	const unsubscribe = child.session.subscribe(() => {
		read();
		for (const listener of [...listeners]) listener();
	});
	return {
		title,
		get live() {
			return !child.closed;
		},
		messages: () => messages,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		dispose() {
			listeners.clear();
			unsubscribe();
		},
	};
}

/** A closed conversation's log, read once without taking its lock. */
async function closedConversationView(title: string, record: WorkRecord): Promise<WorkConversation> {
	const ref = record.child?.ref;
	if (!ref) throw new Error("The conversation of this work was not kept");
	const manager = await SessionManager.openReadOnly(ref);
	let messages: unknown[];
	try {
		messages = manager.getBranch().flatMap((entry) => (isMessageEntry(entry) ? [entry.message] : []));
	} finally {
		await manager.closePersistence();
	}
	return {
		title,
		live: false,
		messages: () => messages,
		subscribe: () => () => undefined,
		dispose: () => undefined,
	};
}

export class TuiWorkSource implements WorkSource {
	private readonly host: TuiWorkSourceHost;
	private readonly live = new Map<string, LiveWorkValue>();
	private readonly listeners = new Set<() => void>();
	private unsubscribeWork: (() => void) | undefined;

	constructor(host: TuiWorkSourceHost) {
		this.host = host;
	}

	/** Follow the work of the conversation the TUI shows now; live values of another are dropped. */
	bind(conversation: HostedConversation): void {
		this.unsubscribeWork?.();
		this.live.clear();
		this.unsubscribeWork = conversation.work.subscribe(() => this.changed());
		this.changed();
	}

	/** Stop following. */
	dispose(): void {
		this.unsubscribeWork?.();
		this.unsubscribeWork = undefined;
		this.live.clear();
		this.listeners.clear();
	}

	/** A live value changed; none: the work's executor detached. */
	setLive(workId: string, value: LiveWorkValue | undefined): void {
		if (value) this.live.set(workId, value);
		else this.live.delete(workId);
		this.changed();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** The record of `workId`, open or finished. */
	record(workId: string): WorkRecord | undefined {
		return this.host.conversation().work.get(workId);
	}

	items(): WorkItemView[] {
		const conversation = this.host.conversation();
		const work = conversation.work;
		const records = work.list();
		const open = records.filter((record) => record.outcome === undefined).reverse();
		const finished = records
			.filter((record) => record.outcome !== undefined)
			.sort((left, right) => (right.finishedOrdinal ?? 0) - (left.finishedOrdinal ?? 0))
			.slice(0, CLIENT_WORK_FINISHED_MAX);
		const time = (ordinal: number | undefined): number | undefined => {
			if (ordinal === undefined) return undefined;
			const timestamp = conversation.session.sessionManager.getCommittedEntryAt(ordinal)?.timestamp;
			const parsed = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
			return Number.isFinite(parsed) ? parsed : undefined;
		};
		return [...open, ...finished].map((record) => {
			const suspended = work.suspended(record);
			const live = this.live.get(record.workId);
			const startedAt = time(record.startedOrdinal);
			const finishedAt = time(record.finishedOrdinal);
			return {
				item: clientWorkItem(record),
				...(live === undefined ? {} : { live }),
				suspended,
				...(startedAt === undefined ? {} : { startedAt }),
				...(finishedAt === undefined ? {} : { finishedAt }),
				actions: {
					cancel: work.cancellable(record),
					resume: suspended && record.state === "running",
					open: work.opens(record),
				},
			};
		});
	}

	async output(workId: string): Promise<WorkOutputTail> {
		const ctx = this.host.intentContext();
		const first = await queryRegistry.run(ctx, "work_output", { workId });
		if (first.nextOffset === null) {
			return { text: first.text, truncated: first.truncated, partial: false, final: first.final };
		}
		// The newest chunk: the inspector shows the tail.
		const offset = Math.max(0, first.totalScalars - (first.nextOffset - first.offset));
		const last = await queryRegistry.run(ctx, "work_output", { workId, offset });
		return { text: last.text, truncated: last.truncated, partial: offset > 0, final: last.final };
	}

	async cancel(workId: string): Promise<void> {
		await intentRegistry.invoke(this.host.intentContext(), "cancel_work", { workId });
	}

	async resume(workId: string): Promise<void> {
		await intentRegistry.invoke(this.host.intentContext(), "resume_work", { workId });
	}

	async open(workId: string): Promise<WorkOpenResult> {
		const { outcome } = await intentRegistry.invoke(this.host.intentContext(), "open_work", { workId });
		if ("cancelled" in outcome || outcome.moved) return { kind: "moved" };
		const conversation = this.host.conversation();
		const record = conversation.work.get(workId);
		const title = record?.title ?? outcome.conversation;
		const child = linkedSubagentConversation(conversation, outcome.conversation);
		if (child) return { kind: "view", conversation: openConversationView(title, child) };
		if (!record || record.child?.conversation !== outcome.conversation) {
			throw new Error("The conversation of this work is not open");
		}
		return { kind: "view", conversation: await closedConversationView(title, record) };
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Observers never affect work.
			}
		}
	}
}
