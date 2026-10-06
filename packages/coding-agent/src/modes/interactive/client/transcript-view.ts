/**
 * The TUI's transcript (architecture rewrite §10): the store's transcript as
 * rows in a container (user and assistant messages, tool calls, user shell
 * commands, custom messages, and summaries), then what streams: the
 * assistant message the live lane builds and the tool calls it runs. Rows
 * draw the projected entries' payloads and the presentations the host
 * computed: a committed call's `view.presentation`, a running call's live
 * `presentation` as its `patch`es left it, a custom message's
 * `view.presentation`. The view runs no presenter; a call the host has not
 * presented yet (its arguments still stream) shows its tool's name.
 *
 * Entries appended to the transcript append rows; any other change of the
 * transcript (a compaction, another branch) draws it afresh. A snapshot of
 * the same conversation keeps the rows of the entries it still shows and
 * presents them as the snapshot does.
 */

import {
	type AssistantMessage,
	createProviderError,
	type ImageContent,
	type JsonValue,
	type TextContent,
} from "@hansjm10/volt-ai";
import {
	type LiveItem,
	type LiveStreamingTool,
	type MessagePresentation,
	type ProjectedEntry,
	type ToolPresentation,
	type TranscriptItem,
	WORK_NOTICE_CUSTOM_TYPE,
} from "@hansjm10/volt-protocol";
import { type Component, type Container, type MarkdownTheme, Spacer, type TUI } from "@hansjm10/volt-tui";
import {
	type CustomMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
} from "../../../core/messages.ts";
import { parseSkillBlock } from "../../../core/skill-block.ts";
import type { TruncationResult } from "../../../core/tools/truncate.ts";
import { AssistantMessageComponent } from "../components/assistant-message.ts";
import { BashExecutionComponent } from "../components/bash-execution.ts";
import { BranchSummaryMessageComponent } from "../components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../components/compaction-summary-message.ts";
import { PresentedMessageComponent } from "../components/presented-message.ts";
import { SkillInvocationMessageComponent } from "../components/skill-invocation-message.ts";
import { isCoalescableAssistantUpdate, StreamingRenderCoalescer } from "../components/streaming-render-coalescer.ts";
import { ToolCallRow } from "../components/tool-call-row.ts";
import { UserMessageComponent } from "../components/user-message.ts";
import type { ToolCardWork } from "../ui-node/tool-card.ts";
import type { TuiStore } from "./tui-store.ts";

type MessageEntry = Extract<ProjectedEntry, { type: "message" }>;

/** What the transcript draws with, from the TUI. */
export interface TranscriptViewHost {
	readonly ui: TUI;
	markdownTheme(): MarkdownTheme;
	hideThinkingBlock(): boolean;
	toolsExpanded(): boolean;
	showImages(): boolean;
	imageWidthCells(): number;
	/** The work a tool call started, read at every render of its row. */
	toolCallWork(toolCallId: string): readonly ToolCardWork[];
	/**
	 * The row the TUI showed a user shell command in while it ran, which
	 * stands for the command's entry once it commits; none when it showed none.
	 */
	takeLocalBashRow(command: string): Component | undefined;
	/** A work notice entered the transcript: it left the queue. */
	workNoticeShown(): void;
}

interface Streaming {
	readonly component: AssistantMessageComponent;
	readonly coalescer: StreamingRenderCoalescer<AssistantMessage>;
	/** When the streaming message started: another start is another message. */
	readonly timestamp: number;
	/** The tool calls the message made so far, whose rows leave with it unless it commits. */
	readonly calls: string[];
}

function textOf(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** A tool item's presentation. */
function toolPresentation(view: TranscriptItem | undefined): ToolPresentation | undefined {
	const presentation = view?.presentation;
	return presentation !== undefined && "title" in presentation && presentation.title !== undefined
		? { ...presentation, title: presentation.title }
		: undefined;
}

/** A presented custom message's presentation. */
function messagePresentation(view: TranscriptItem | undefined): MessagePresentation | undefined {
	const presentation = view?.presentation;
	if (presentation?.body === undefined) return undefined;
	return {
		...(presentation.title === undefined ? {} : { title: presentation.title }),
		...(presentation.summary === undefined ? {} : { summary: presentation.summary }),
		body: presentation.body,
	};
}

/** An item that starts, ends, or structures the streaming message: drawn at once, never coalesced. */
function isStreamBoundary(item: LiveItem): boolean {
	if (item.type === "assistant_delta") return !isCoalescableAssistantUpdate(item.event.type);
	return item.type === "assistant_start" || item.type === "assistant_end";
}

/** Whether `next` is `rendered` with entries appended. */
function extendsRendered(rendered: readonly ProjectedEntry[], next: readonly ProjectedEntry[]): boolean {
	if (rendered.length === 0) return true;
	return (
		next.length >= rendered.length &&
		next[0]?.id === rendered[0]?.id &&
		next[rendered.length - 1]?.id === rendered[rendered.length - 1]?.id
	);
}

export class TranscriptView {
	private readonly store: TuiStore;
	private readonly container: Container;
	private readonly host: TranscriptViewHost;
	/** The transcript entries drawn, in order. */
	private rendered: ProjectedEntry[] = [];
	/** The newest projection of each entry drawn, by id: what its row presents. */
	private readonly entries = new Map<string, ProjectedEntry>();
	/** Tool call rows, by tool call id. */
	private readonly tools = new Map<string, ToolCallRow>();
	/** Tool calls whose result entry is drawn. */
	private readonly committed = new Set<string>();
	/** Custom message rows, by entry id. */
	private readonly messages = new Map<string, PresentedMessageComponent>();
	/** The running calls as their rows show them: a call the live lane did not change draws nothing new. */
	private readonly shownTools = new Map<string, LiveStreamingTool>();
	private streaming: Streaming | undefined;

	constructor(store: TuiStore, container: Container, host: TranscriptViewHost) {
		this.store = store;
		this.container = container;
		this.host = host;
	}

	/** Draw the store's transcript afresh in the cleared container, then what streams. */
	rebuild(): void {
		this.container.clear();
		this.show();
	}

	/** Draw the store's transcript after what the container shows, then what streams. */
	show(): void {
		this.dispose();
		const transcript = this.store.transcript();
		for (const entry of transcript) this.append(entry, false);
		this.rendered = [...transcript];
		this.showLive([]);
		this.host.ui.requestRender();
	}

	/**
	 * Show what the store changed: rows for entries appended to the
	 * transcript, or the transcript afresh when it changed otherwise; then
	 * what streams, after `items`.
	 */
	sync(items: readonly LiveItem[] = []): void {
		const next = this.store.transcript();
		if (!extendsRendered(this.rendered, next)) {
			this.rebuild();
			return;
		}
		for (const entry of next.slice(this.rendered.length)) {
			this.append(entry, true);
			this.rendered.push(entry);
		}
		this.showLive(items);
		this.host.ui.requestRender();
	}

	/**
	 * The store holds a snapshot of the conversation it showed: keep the rows
	 * of the entries the transcript still shows, presented as the snapshot
	 * presents them, and draw the rest; afresh when the transcript changed
	 * otherwise.
	 */
	refresh(): void {
		const next = this.store.transcript();
		if (!extendsRendered(this.rendered, next)) {
			this.rebuild();
			return;
		}
		for (const entry of next.slice(0, this.rendered.length)) this.represent(entry);
		for (const entry of next.slice(this.rendered.length)) this.append(entry, false);
		this.rendered = [...next];
		this.showLive([]);
		this.host.ui.requestRender();
	}

	/** Re-read the work of the tool calls in `toolCallIds`: it changed. */
	invalidateWork(toolCallIds: ReadonlySet<string>): void {
		for (const toolCallId of toolCallIds) this.tools.get(toolCallId)?.invalidate();
	}

	/** Apply `change` to every tool call row. */
	forEachToolRow(change: (row: ToolCallRow) => void): void {
		for (const row of this.tools.values()) change(row);
	}

	/** Release the rows' timers and coalescers. */
	dispose(): void {
		this.streaming?.coalescer.dispose();
		this.streaming = undefined;
		for (const row of this.tools.values()) row.dispose();
		for (const message of this.messages.values()) message.dispose();
		this.tools.clear();
		this.committed.clear();
		this.messages.clear();
		this.shownTools.clear();
		this.entries.clear();
		this.rendered = [];
	}

	private add(component: Component): void {
		this.container.addChild(component);
	}

	/** Expandable components follow the TUI's tool expansion. */
	private addExpandable(component: Component & { setExpanded(expanded: boolean): void }): void {
		component.setExpanded(this.host.toolsExpanded());
		this.add(component);
	}

	private append(entry: ProjectedEntry, live: boolean): void {
		this.entries.set(entry.id, entry);
		switch (entry.type) {
			case "message":
				this.appendMessage(entry, live);
				return;
			case "custom_message":
				if (entry.payload?.display) {
					this.appendCustom(entry, {
						role: "custom",
						customType: entry.payload.customType,
						content: entry.payload.content,
						display: true,
						...(entry.payload.details === undefined ? {} : { details: entry.payload.details }),
						timestamp: new Date(entry.timestamp).getTime(),
					});
				}
				return;
			case "compaction":
				if (!entry.payload) return;
				this.add(new Spacer(1));
				this.addExpandable(
					new CompactionSummaryMessageComponent(
						createCompactionSummaryMessage(entry.payload.summary, entry.payload.tokensBefore, entry.timestamp),
						this.host.markdownTheme(),
					),
				);
				return;
			case "branch_summary":
				if (!entry.payload?.summary) return;
				this.add(new Spacer(1));
				this.addExpandable(
					new BranchSummaryMessageComponent(
						createBranchSummaryMessage(entry.payload.summary, entry.payload.fromId, entry.timestamp),
						this.host.markdownTheme(),
					),
				);
				return;
			default:
				return;
		}
	}

	private appendMessage(entry: MessageEntry, live: boolean): void {
		const message = entry.payload?.message;
		if (!message) return;
		switch (message.role) {
			case "user": {
				const text = textOf(message.content);
				if (!text) return;
				if (this.container.children.length > 0) this.add(new Spacer(1));
				const skillBlock = parseSkillBlock(text);
				if (!skillBlock) {
					this.add(new UserMessageComponent(text, this.host.markdownTheme()));
					return;
				}
				this.addExpandable(new SkillInvocationMessageComponent(skillBlock, this.host.markdownTheme()));
				if (skillBlock.userMessage) {
					this.add(new Spacer(1));
					this.add(new UserMessageComponent(skillBlock.userMessage, this.host.markdownTheme()));
				}
				return;
			}
			case "assistant":
				this.appendAssistant(message, live);
				return;
			case "toolResult": {
				const row = this.tools.get(message.toolCallId) ?? this.createRow(message.toolName, message.toolCallId);
				this.committed.add(message.toolCallId);
				this.shownTools.delete(message.toolCallId);
				row.update({
					...this.presentationOf(row, toolPresentation(entry.view)),
					state: "done",
					isError: message.isError,
					content: message.content,
				});
				return;
			}
			case "bashExecution": {
				if (live && this.host.takeLocalBashRow(message.command)) return;
				const component = new BashExecutionComponent(message.command, this.host.ui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.add(component);
				return;
			}
			case "custom":
				if (message.display) this.appendCustom(entry, { ...message, display: true });
				return;
			default:
				return;
		}
	}

	/**
	 * An assistant message and its tool calls: the message that streamed
	 * becomes the committed one, with the rows of the calls it made. The calls
	 * of a message that was aborted or failed show why they never ran.
	 */
	private appendAssistant(message: AssistantMessage, live: boolean): void {
		const streaming = this.streaming;
		const aborted = message.stopReason === "aborted" || message.stopReason === "error";
		let shown = message;
		let reason = message.stopReason === "error" ? message.error?.message || "Error" : "Operation aborted";
		if (live && message.stopReason === "aborted") {
			const attempts = this.store.phase?.retry?.attempt ?? 0;
			if (attempts > 0) reason = `Aborted after ${attempts} retry attempt${attempts > 1 ? "s" : ""}`;
			shown = { ...message, error: createProviderError("aborted", reason) };
		}
		if (live && streaming !== undefined) {
			this.streaming = undefined;
			streaming.coalescer.finish(shown);
		} else {
			this.add(new AssistantMessageComponent(shown, this.host.hideThinkingBlock(), this.host.markdownTheme()));
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const row = this.tools.get(block.id) ?? this.createRow(block.name, block.id);
			if (aborted && !this.committed.has(block.id)) {
				this.committed.add(block.id);
				row.update({
					presentation: {
						title: row.presentation?.title ?? block.name,
						summary: [{ type: "text", key: "error", text: reason, token: "error" }],
					},
					state: "done",
					isError: true,
				});
			}
		}
	}

	/** A row's presentation: `presentation`, else the one it shows, else none (its tool's name). */
	private presentationOf(
		row: ToolCallRow,
		presentation: ToolPresentation | undefined,
	): { presentation?: ToolPresentation } {
		const shown = presentation ?? row.presentation;
		return shown === undefined ? {} : { presentation: shown };
	}

	private appendCustom(entry: ProjectedEntry, message: CustomMessage<JsonValue>): void {
		const component = new PresentedMessageComponent(
			message,
			() => {
				const current = this.entries.get(entry.id);
				return current?.type === "message" || current?.type === "custom_message"
					? messagePresentation(current.view)
					: undefined;
			},
			this.host.markdownTheme(),
		);
		this.messages.set(entry.id, component);
		this.addExpandable(component);
		if (message.customType === WORK_NOTICE_CUSTOM_TYPE) this.host.workNoticeShown();
	}

	/** Present a drawn entry as its newer projection does. */
	private represent(entry: ProjectedEntry): void {
		this.entries.set(entry.id, entry);
		this.messages.get(entry.id)?.refreshPresentation();
		if (entry.type !== "message") return;
		const message = entry.payload?.message;
		if (message?.role !== "toolResult") return;
		const row = this.tools.get(message.toolCallId);
		const presentation = toolPresentation(entry.view);
		if (!row || presentation === undefined) return;
		row.update({ presentation, state: "done", isError: message.isError, content: message.content });
	}

	private createRow(toolName: string, toolCallId: string): ToolCallRow {
		const row = new ToolCallRow(toolName, this.host.ui, {
			showImages: this.host.showImages(),
			imageWidthCells: this.host.imageWidthCells(),
			work: () => this.host.toolCallWork(toolCallId),
		});
		this.tools.set(toolCallId, row);
		this.addExpandable(row);
		return row;
	}

	/** What streams: the assistant message the live lane builds, with its calls, and the calls that run. */
	private showLive(items: readonly LiveItem[]): void {
		const live = this.store.live;
		const assistant = live.assistant;
		let streaming = this.streaming;
		if (streaming !== undefined && streaming.timestamp !== assistant?.message.timestamp) {
			// The message stopped streaming without its entry, or another one started: its rows leave with it.
			this.dropStreaming(streaming);
			streaming = undefined;
		}
		if (assistant !== undefined) {
			if (streaming === undefined) {
				const component = new AssistantMessageComponent(
					undefined,
					this.host.hideThinkingBlock(),
					this.host.markdownTheme(),
				);
				this.add(component);
				const coalescer = new StreamingRenderCoalescer<AssistantMessage>((message) => {
					component.updateContent(message);
					this.host.ui.requestRender();
				});
				streaming = { component, coalescer, timestamp: assistant.message.timestamp, calls: [] };
				this.streaming = streaming;
				coalescer.commitNow(assistant.message);
			} else if (items.some(isStreamBoundary)) {
				streaming.coalescer.commitNow(assistant.message);
			} else {
				streaming.coalescer.update(assistant.message);
			}
			for (const block of assistant.message.content) {
				if (block.type !== "toolCall" || this.tools.has(block.id)) continue;
				this.createRow(block.name, block.id);
				streaming.calls.push(block.id);
			}
		}
		for (const [toolCallId, tool] of live.tools) {
			if (this.committed.has(toolCallId) || this.shownTools.get(toolCallId) === tool) continue;
			this.shownTools.set(toolCallId, tool);
			const row = this.tools.get(toolCallId) ?? this.createRow(tool.toolName, toolCallId);
			row.update({
				...this.presentationOf(row, tool.presentation),
				state: tool.ended ? "done" : "running",
				...(tool.isError === undefined ? {} : { isError: tool.isError }),
			});
		}
	}

	private dropStreaming(streaming: Streaming): void {
		if (this.streaming === streaming) this.streaming = undefined;
		streaming.coalescer.dispose();
		this.container.removeChild(streaming.component);
		for (const toolCallId of streaming.calls) {
			const row = this.tools.get(toolCallId);
			if (!row || this.committed.has(toolCallId)) continue;
			row.dispose();
			this.container.removeChild(row);
			this.tools.delete(toolCallId);
		}
	}
}
