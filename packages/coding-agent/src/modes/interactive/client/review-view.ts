/**
 * A review the TUI started, as its protocol client sees it (architecture
 * rewrite D2): the conversation's `review` work item, live as
 * `work/<workId>`, and the pass conversation the review runs in, which the
 * item's `child` names and which moves at each pass. The view observes each
 * pass read-only and draws its assistant messages and tool calls inline
 * below a header; the review's usage shows in the footer in place of the
 * conversation's, from the pass's model and live `usage` and the work's
 * cumulative accounting detail.
 */

import {
	type ClientState,
	type ClientWorkItem,
	clientActiveBranch,
	type LiveValue,
	type ProjectedEntry,
	type RpcCatalogModel,
	type UiNode,
} from "@hansjm10/volt-protocol";
import { Container, Spacer, Text } from "@hansjm10/volt-tui";
import type { ConversationObservation } from "../../../client/protocol-client.ts";
import { reviewUsageTotals } from "../../../core/review-presentation.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "../components/dynamic-border.ts";
import { latestCacheHitRate, type TransientUsage } from "./footer-model.ts";
import { type TranscriptSource, TranscriptView, type TranscriptViewHost } from "./transcript-view.ts";
import { type TuiStore, transcriptOf } from "./tui-store.ts";

type LiveWorkValue = Extract<LiveValue, { kind: "work" }>;
type PhaseValue = Extract<LiveValue, { kind: "phase" }>;

export interface ReviewViewOptions {
	readonly store: TuiStore;
	/** The review's work id: its run id. */
	readonly workId: string;
	/** Where the passes draw: the chat. */
	readonly container: Container;
	/** How the passes' rows draw. */
	readonly transcript: Omit<TranscriptViewHost, "pendingShellRows" | "workNoticeShown" | "toolCallWork">;
	/** The review's work or pass changed. */
	readonly onChange: () => void;
}

/** A pass the view observes. */
interface ObservedPass {
	readonly conversation: string;
	readonly observation: ConversationObservation;
	readonly unsubscribe: () => void;
}

/** Whether `entry` is a user message: a pass's prompt, which the inline view leaves out. */
function isUserMessage(entry: ProjectedEntry): boolean {
	return entry.type === "message" && entry.payload?.message.role === "user";
}

export class ReviewView {
	private readonly options: ReviewViewOptions;
	private readonly group = new Container();
	private readonly header = new Text("", 1, 0);
	/** The conversation the review runs as work of. */
	private readonly conversation: string | undefined;
	private pass: ObservedPass | undefined;
	/** The transcripts of the passes that ran: their rows stay in the chat until the view closes. */
	private readonly views: TranscriptView[] = [];
	private readonly ended = Promise.withResolvers<ClientWorkItem>();
	private readonly unsubscribeStore: () => void;

	constructor(options: ReviewViewOptions) {
		this.options = options;
		this.conversation = options.store.conversation;
		this.group.addChild(new Spacer(1));
		this.group.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.group.addChild(this.header);
		this.group.addChild(new Spacer(1));
		options.container.addChild(this.group);
		// Settled by dispose too, which nobody waits on then.
		void this.ended.promise.catch(() => undefined);
		this.unsubscribeStore = options.store.subscribe(() => this.follow());
		this.follow();
	}

	/** The review's work item, as the client fold holds it. */
	get item(): ClientWorkItem | undefined {
		return this.options.store.state.work.get(this.options.workId);
	}

	/** The review's live work value while it runs: its progress and accounting detail. */
	get live(): LiveWorkValue | undefined {
		const value = this.options.store.value(`work/${this.options.workId}`);
		return value?.kind === "work" ? value : undefined;
	}

	/** The review's progress text and accounting detail: live while it runs, else as its last checkpoint left them. */
	progress(): { readonly text?: string; readonly detail?: UiNode } {
		const live = this.live;
		const item = this.item;
		const text = live?.progress?.text ?? item?.progress?.text;
		const detail = live?.detail ?? item?.detail;
		return { ...(text === undefined ? {} : { text }), ...(detail === undefined ? {} : { detail }) };
	}

	/**
	 * Resolves with the review's work item once it finished; rejects when the
	 * TUI's client left the conversation the review runs in.
	 */
	finished(): Promise<ClientWorkItem> {
		return this.ended.promise;
	}

	/**
	 * The review's usage, for the footer: the model, thinking level, Fast
	 * mode, and context of the pass it runs in, with the review's cumulative
	 * token use and cost as its work's accounting reports them.
	 */
	usage(models: readonly RpcCatalogModel[] | undefined): TransientUsage | undefined {
		const observation = this.pass?.observation;
		const ref = observation?.state.model;
		if (observation === undefined || ref === null || ref === undefined) return undefined;
		const model = models?.find((candidate) => candidate.provider === ref.provider && candidate.id === ref.modelId);
		const value = observation.live.values.get("usage");
		const passUsage = value?.kind === "usage" ? value : undefined;
		const totals = reviewUsageTotals(this.progress().detail) ?? {
			input: passUsage?.tokens.input ?? 0,
			output: passUsage?.tokens.output ?? 0,
			cacheRead: passUsage?.tokens.cacheRead ?? 0,
			cacheWrite: passUsage?.tokens.cacheWrite ?? 0,
			cost: passUsage?.cost ?? 0,
		};
		const hitRate = latestCacheHitRate(observation.state.entries);
		return {
			model: {
				provider: ref.provider,
				id: ref.modelId,
				reasoning: model?.reasoning ?? false,
				contextWindow: model?.contextWindow ?? passUsage?.contextUsage?.contextWindow ?? 0,
			},
			thinkingLevel: observation.state.thinkingLevel,
			fastMode: observation.state.fastMode,
			usage: {
				...totals,
				...(hitRate === undefined ? {} : { latestCacheHitRate: hitRate }),
				...(passUsage?.contextUsage === undefined ? {} : { contextUsage: passUsage.contextUsage }),
			},
		};
	}

	/** Stop observing, and remove the passes from the chat. */
	dispose(): void {
		this.unsubscribeStore();
		this.stopPass();
		for (const view of this.views.splice(0)) view.dispose();
		this.options.container.removeChild(this.group);
		this.ended.reject(new Error("The review view closed"));
	}

	/** Follow the review's work: observe the pass it runs in now, and settle once it finished. */
	private follow(): void {
		const store = this.options.store;
		if (store.conversation !== undefined && store.conversation !== this.conversation) {
			this.ended.reject(new Error("The review goes on in the conversation it started in; see /work there"));
			return;
		}
		const item = this.item;
		const child = item?.child?.conversation;
		if (child !== undefined && child !== this.pass?.conversation) this.observe(child);
		this.showHeader();
		this.options.onChange();
		if (item?.outcome !== undefined) this.ended.resolve(item);
	}

	/** Observe the pass `conversation` runs: its rows draw below the passes before it. */
	private observe(conversation: string): void {
		this.stopPass();
		const observation = this.options.store.client.observe(conversation);
		const body = new Container();
		this.group.addChild(body);
		let cached: { readonly state: ClientState; readonly transcript: readonly ProjectedEntry[] } | undefined;
		const source: TranscriptSource = {
			transcript: () => {
				const state = observation.state;
				if (cached?.state !== state) {
					cached = {
						state,
						transcript: transcriptOf(clientActiveBranch(state)).filter((entry) => !isUserMessage(entry)),
					};
				}
				return cached.transcript;
			},
			get live() {
				return observation.live;
			},
			get phase(): PhaseValue | undefined {
				const value = observation.live.values.get("phase");
				return value?.kind === "phase" ? value : undefined;
			},
		};
		const view = new TranscriptView(source, body, {
			...this.options.transcript,
			pendingShellRows: new Container(),
			workNoticeShown: () => {},
			toolCallWork: () => [],
		});
		const unsubscribe = observation.onChange(() => {
			view.sync();
			this.showHeader();
			this.options.onChange();
		});
		this.pass = { conversation, observation, unsubscribe };
		this.views.push(view);
		view.show();
	}

	private stopPass(): void {
		const pass = this.pass;
		if (pass === undefined) return;
		this.pass = undefined;
		pass.unsubscribe();
		pass.observation.stop();
	}

	/** The header names what the review reviews and the model it runs with. */
	private showHeader(): void {
		const title = this.item?.title ?? "Review";
		const target = title.startsWith("Review ") ? title.slice("Review ".length) : title;
		const model = this.pass?.observation.state.model?.modelId;
		this.header.setText(theme.fg("accent", model ? `Reviewing ${target} with ${model}` : `Reviewing ${target}`));
	}
}
