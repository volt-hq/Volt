/**
 * The work inspector (RFC §7.3, §10): every work item of the conversation in
 * one list, whatever its kind. An item's detail shows its state, progress,
 * kind detail (`UiNode`), result summary or error, and its output's newest
 * text, read with `work_output` again whenever its live value changes; the
 * actions are the ones its kind allows:
 * cancel, resume suspended work, and open the conversation it runs in or
 * produced. A conversation the work runs in opens as a read-only view, which
 * loads its older entries as it scrolls up when it has them, and lists its
 * own work, whose conversations open the same way at any depth.
 * Inspecting never starts inference or stops work by itself.
 */

import type { ClientWorkItem, LiveValue, UiNode } from "@hansjm10/volt-protocol";
import {
	type Component,
	createRenderFrame,
	getKeybindings,
	type Keybinding,
	Markdown,
	type RenderFrame,
	SelectList,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { formatDuration } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { createUiNodeView } from "../ui-node/registry.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/** A live `work/<workId>` value: present while this host's executor runs the work. */
export type LiveWorkValue = Extract<LiveValue, { kind: "work" }>;

/** What a client may do with an item, as its kind and state allow. */
export interface WorkActions {
	readonly cancel: boolean;
	readonly resume: boolean;
	readonly open: boolean;
}

/** One work item as the inspector shows it: its record as a client folds it, and its live value. */
export interface WorkItemView {
	readonly item: ClientWorkItem;
	readonly live?: LiveWorkValue;
	/** Open work of a resumable kind that no executor runs: it waits for a resume or a cancel. */
	readonly suspended: boolean;
	/** When the item started and finished, in epoch milliseconds, as the log recorded it. */
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly actions: WorkActions;
}

/** The newest output of an item. */
export interface WorkOutputTail {
	readonly text: string;
	/** The work dropped older output. */
	readonly truncated: boolean;
	/** Only the newest part of the output was read. */
	readonly partial: boolean;
	/** The work finished: the output no longer changes. */
	readonly final: boolean;
}

/** A conversation an item runs in or produced, read-only. */
export interface WorkConversation {
	readonly title: string;
	/** Whether the conversation is open and may still change. */
	readonly live: boolean;
	/** Whether older entries than its messages show remain to load. */
	readonly earlier?: boolean;
	/** Its own work: the conversations it links open from it. */
	readonly work?: WorkSource;
	/** Its messages, oldest first, and the one streaming now. */
	messages(): readonly unknown[];
	/** Load the messages before the oldest one shown. */
	loadEarlier?(): Promise<void>;
	subscribe(listener: () => void): () => void;
	dispose(): void;
}

/** What opening an item did: moved the client, or gave a read-only view of a conversation. */
export type WorkOpenResult =
	| { readonly kind: "moved" }
	| { readonly kind: "view"; readonly conversation: WorkConversation };

/** What the inspector reads and acts through. */
export interface WorkSource {
	/** The conversation's work: open items, then the newest finished ones. */
	items(): readonly WorkItemView[];
	/** Observe changes of the items and their live values. */
	subscribe(listener: () => void): () => void;
	output(workId: string): Promise<WorkOutputTail>;
	cancel(workId: string): Promise<void>;
	resume(workId: string): Promise<void>;
	open(workId: string): Promise<WorkOpenResult>;
}

export interface WorkInspectorOptions {
	getHeight: () => number;
	requestRender: () => void;
	onClose: () => void;
	/** The item to show first. */
	workId?: string;
	/** The conversation whose work it shows, when it is not the TUI's own. */
	title?: string;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Work text stays literal: no terminal controls or bidi overrides; tabs become spaces. */
export function workDisplayText(text: string): string {
	return stripAnsi(text).replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "").replace(/\t/g, "   ");
}

/** An item's state as one word: its outcome once finished, else its open state. */
export function workStateLabel(view: Pick<WorkItemView, "item" | "live" | "suspended">): string {
	const { item } = view;
	if (item.outcome !== undefined) return item.outcome;
	if (view.suspended) return "suspended";
	if (item.state === "awaiting_approval") return "awaiting approval";
	return item.state;
}

const STATE_STYLES: Record<string, { glyph: string; color: "accent" | "warning" | "success" | "error" | "muted" }> = {
	running: { glyph: "●", color: "accent" },
	cancelling: { glyph: "◌", color: "warning" },
	"awaiting approval": { glyph: "?", color: "warning" },
	suspended: { glyph: "‖", color: "warning" },
	completed: { glyph: "✓", color: "success" },
	failed: { glyph: "✗", color: "error" },
	cancelled: { glyph: "○", color: "muted" },
	interrupted: { glyph: "○", color: "muted" },
};

/** An item's state, styled, with its glyph. */
export function styledWorkState(view: Pick<WorkItemView, "item" | "live" | "suspended">): string {
	const label = workStateLabel(view);
	const style = STATE_STYLES[label] ?? { glyph: "●", color: "muted" as const };
	return theme.fg(style.color, `${style.glyph} ${label}`);
}

/** How long an item ran or runs; empty for suspended work, and when the log has no start time. */
export function workTiming(
	view: Pick<WorkItemView, "startedAt" | "finishedAt" | "item" | "suspended">,
	now = Date.now(),
): string {
	if (view.startedAt === undefined || view.suspended) return "";
	const end = view.item.outcome === undefined ? now : (view.finishedAt ?? now);
	return formatDuration(Math.max(0, end - view.startedAt));
}

/** The title on one line. */
export function workTitle(item: Pick<ClientWorkItem, "title">): string {
	return workDisplayText(item.title).replace(/\s+/g, " ").trim() || "(untitled)";
}

/** The progress an item reports: its live value's while it runs here, else its latest checkpoint's. */
function progressOf(view: WorkItemView): { progress?: ClientWorkItem["progress"]; detail?: UiNode } {
	if (view.live) {
		return {
			...(view.live.progress === undefined ? {} : { progress: view.live.progress }),
			...(view.live.detail === undefined ? {} : { detail: view.live.detail }),
		};
	}
	return {
		...(view.item.progress === undefined ? {} : { progress: view.item.progress }),
		...(view.item.detail === undefined ? {} : { detail: view.item.detail }),
	};
}

/** An item's progress and kind detail as `UiNode` data. */
export function workProgressNodes(view: WorkItemView): UiNode[] {
	const { progress, detail } = progressOf(view);
	const nodes: UiNode[] = [];
	if (progress?.text) nodes.push({ type: "text", key: "work:progress-text", text: progress.text, token: "muted" });
	if (progress?.value !== undefined) {
		nodes.push({
			type: "progress",
			key: "work:progress-value",
			kind: "determinate",
			value: progress.value,
			...(progress.max === undefined ? {} : { max: progress.max }),
		});
	}
	if (progress?.steps && progress.steps.length > 0) {
		nodes.push({
			type: "progress",
			key: "work:progress-steps",
			kind: "steps",
			steps: progress.steps.map((step) => ({ key: step.key, label: step.label, status: step.status })),
		});
	}
	// The kind's own key is replaced: keys are unique among the nodes above.
	if (detail) nodes.push({ ...detail, key: "work:detail" });
	return nodes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return workDisplayText(content);
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) => {
			if (!isRecord(block)) return [];
			if (block.type === "text" && typeof block.text === "string") return [workDisplayText(block.text)];
			return block.type === "image" ? ["[image]"] : [];
		})
		.join("\n")
		.trim();
}

function toolSummary(args: unknown): string {
	if (!isRecord(args)) return "";
	for (const key of ["command", "task", "agent", "path", "query", "symbol", "action", "tool", "server"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return workDisplayText(value).replace(/\s+/g, " ").trim();
	}
	return "";
}

/** A conversation's messages as transcript lines: user and assistant text, tool calls with their outcome. */
export function conversationLines(messages: readonly unknown[], width: number): string[] {
	const lines: string[] = [];
	const failed = new Set<string>();
	const settled = new Set<string>();
	for (const message of messages) {
		if (isRecord(message) && message.role === "toolResult" && typeof message.toolCallId === "string") {
			settled.add(message.toolCallId);
			if (message.isError === true) failed.add(message.toolCallId);
		}
	}
	for (const message of messages) {
		if (!isRecord(message)) continue;
		if (message.role === "user" || message.role === "custom") {
			const text = contentText(message.content);
			if (!text) continue;
			lines.push("");
			for (const line of wrapTextWithAnsi(theme.fg("userMessageText", text), Math.max(1, width - 2))) {
				lines.push(`${theme.fg("dim", "› ")}${line}`);
			}
			continue;
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
				lines.push("");
				lines.push(...new Markdown(workDisplayText(block.text), 0, 0, getMarkdownTheme()).render(width).lines);
			} else if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
				const glyph = failed.has(block.id)
					? theme.fg("error", "✗")
					: settled.has(block.id)
						? theme.fg("success", "✓")
						: theme.fg("accent", "●");
				const summary = toolSummary(block.arguments);
				lines.push(
					truncateToWidth(
						`${glyph} ${theme.bold(theme.fg("toolTitle", workDisplayText(block.name)))}${summary ? theme.fg("muted", `  ${summary}`) : ""}`,
						width,
					),
				);
			}
		}
		if (typeof message.errorMessage === "string" && message.errorMessage) {
			lines.push(...wrapTextWithAnsi(theme.fg("error", workDisplayText(message.errorMessage)), width));
		}
	}
	return lines;
}

type Mode = "list" | "detail" | "confirm" | "conversation";

/** Local UI only: inspecting and closing this view never starts inference or stops work. */
export class WorkInspector implements Component {
	private readonly source: WorkSource;
	private readonly options: WorkInspectorOptions;
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly detailView = createUiNodeView();
	private list?: SelectList;
	private mode: Mode = "list";
	private selectedId?: string;
	private notice?: string;
	private disposed = false;
	// Output of the item in detail.
	private output?: { workId: string; tail: WorkOutputTail; key: string };
	/** The read in flight: its item, and the change it reads after. */
	private outputFetch?: { workId: string; key: string };
	private follow = true;
	private scrollTop = 0;
	private viewportRows = 1;
	private rowCount = 0;
	// The conversation opened from the item in detail.
	private conversation?: { view: WorkConversation; unsubscribe: () => void };
	/** The opened conversation's own work, shown over this inspector until it closes. */
	private nested?: WorkInspector;

	constructor(source: WorkSource, options: WorkInspectorOptions) {
		this.source = source;
		this.options = options;
		this.selectedId = options.workId;
		if (options.workId !== undefined) this.mode = "detail";
		this.unsubscribe = source.subscribe(() => this.refresh());
		// Running work's timing ticks.
		this.timer = setInterval(() => {
			if (this.disposed || !this.source.items().some((view) => view.item.outcome === undefined)) return;
			this.options.requestRender();
		}, 1000);
		this.timer.unref?.();
		this.syncOutput();
	}

	/** The item the inspector shows in detail, when it shows one (not the list). */
	get detailWorkId(): string | undefined {
		return this.mode === "list" ? undefined : this.selectedId;
	}

	/** Show `workId` in detail. */
	show(workId: string): void {
		if (this.disposed) return;
		this.closeConversation();
		this.showDetail(workId);
		this.options.requestRender();
	}

	/** Re-read the source: a changed item may need its output read again. */
	refresh(): void {
		if (this.disposed) return;
		this.syncOutput();
		this.options.requestRender();
	}

	invalidate(): void {
		this.detailView.invalidate();
		this.nested?.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		clearInterval(this.timer);
		this.closeNested();
		this.closeConversation();
		this.detailView.dispose();
	}

	private close(): void {
		this.dispose();
		this.options.onClose();
	}

	private selected(): WorkItemView | undefined {
		return this.source.items().find((view) => view.item.workId === this.selectedId);
	}

	/** In the list, keep an item selected: the first one once the selected one is gone. */
	private ensureSelection(items: readonly WorkItemView[]): void {
		if (this.mode === "list" && !items.some((view) => view.item.workId === this.selectedId)) {
			this.selectedId = items[0]?.item.workId;
		}
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		const keys = getKeybindings();
		if (keys.matches(data, "app.work.open")) {
			this.close();
			return;
		}
		if (this.nested) {
			this.nested.handleInput(data);
			return;
		}
		this.ensureSelection(this.source.items());
		const view = this.selected();
		switch (this.mode) {
			case "confirm":
				if (keys.matches(data, "tui.select.confirm") && view) {
					this.mode = "detail";
					this.act(() => this.source.cancel(view.item.workId), "This work can no longer be cancelled");
				} else if (keys.matches(data, "tui.select.cancel")) {
					this.mode = "detail";
				}
				break;
			case "conversation":
				if (keys.matches(data, "tui.select.cancel")) {
					this.closeConversation();
					this.mode = "detail";
					this.resetScroll();
				} else if (keys.matches(data, "tui.select.confirm")) {
					this.openNested();
				} else {
					this.loadEarlierAtTop(data);
					this.scroll(data);
				}
				break;
			case "detail":
				if (keys.matches(data, "tui.select.cancel")) {
					this.mode = "list";
					this.notice = undefined;
				} else if (
					!this.action(data, view) &&
					!(view && keys.matches(data, "tui.select.confirm") && this.open(view))
				) {
					this.scroll(data);
				}
				break;
			case "list":
				if (keys.matches(data, "tui.select.cancel")) {
					this.close();
					return;
				}
				if (keys.matches(data, "tui.select.confirm")) {
					if (view) this.showDetail(view.item.workId);
				} else if (!this.action(data, view)) this.list?.handleInput(data);
				break;
		}
		this.options.requestRender();
	}

	/** Cancel or resume `view` when `data` asks to and its kind allows it. */
	private action(data: string, view: WorkItemView | undefined): boolean {
		const keys = getKeybindings();
		if (!view) return false;
		if (keys.matches(data, "app.work.cancel")) {
			if (view.actions.cancel) {
				this.mode = "confirm";
				this.notice = undefined;
			}
			return true;
		}
		if (keys.matches(data, "app.work.resume")) {
			if (view.actions.resume) this.act(() => this.source.resume(view.item.workId), "This work could not resume");
			return true;
		}
		return false;
	}

	/** Open the conversation `view` runs in or produced, when its kind opens it. */
	private open(view: WorkItemView): boolean {
		if (!view.actions.open) return false;
		const workId = view.item.workId;
		this.notice = undefined;
		void this.source.open(workId).then(
			(opened) => {
				if (opened.kind !== "view") return;
				if (this.disposed || this.selectedId !== workId || this.mode !== "detail") {
					opened.conversation.dispose();
					return;
				}
				this.closeConversation();
				this.conversation = {
					view: opened.conversation,
					unsubscribe: opened.conversation.subscribe(() => this.options.requestRender()),
				};
				this.mode = "conversation";
				this.resetScroll();
				this.options.requestRender();
			},
			(error: unknown) => {
				this.notice = error instanceof Error ? error.message : String(error);
				this.options.requestRender();
			},
		);
		return true;
	}

	private act(run: () => Promise<void>, failure: string): void {
		this.notice = undefined;
		void run().catch((error: unknown) => {
			this.notice = error instanceof Error && error.message ? error.message : failure;
			this.options.requestRender();
		});
	}

	private showDetail(workId: string): void {
		this.selectedId = workId;
		this.mode = "detail";
		this.notice = undefined;
		this.output = undefined;
		this.resetScroll();
		this.syncOutput();
	}

	private closeConversation(): void {
		this.closeNested();
		const conversation = this.conversation;
		this.conversation = undefined;
		conversation?.unsubscribe();
		conversation?.view.dispose();
	}

	/** Show the opened conversation's own work over this inspector, when it has any. */
	private openNested(): void {
		const view = this.conversation?.view;
		const work = view?.work;
		if (!view || !work || work.items().length === 0) return;
		this.closeNested();
		const nested = new WorkInspector(work, {
			getHeight: this.options.getHeight,
			requestRender: this.options.requestRender,
			title: view.title,
			onClose: () => {
				if (this.nested === nested) this.nested = undefined;
				this.options.requestRender();
			},
		});
		this.nested = nested;
	}

	private closeNested(): void {
		const nested = this.nested;
		this.nested = undefined;
		nested?.dispose();
	}

	/** Moving up from the top of a conversation that has older entries loads them. */
	private loadEarlierAtTop(data: string): void {
		const view = this.conversation?.view;
		if (!view?.earlier || !view.loadEarlier || (this.follow && this.rowCount > this.viewportRows)) return;
		if (this.scrollTop > 0) return;
		const keys = getKeybindings();
		const upward =
			keys.matches(data, "tui.select.up") ||
			keys.matches(data, "tui.select.pageUp") ||
			keys.matches(data, "tui.altScreen.top");
		if (!upward) return;
		const before = this.rowCount;
		void view.loadEarlier().then(
			() => {
				if (this.disposed || this.conversation?.view !== view) return;
				// The rows shown stay where they are: the loaded ones come before them.
				this.follow = false;
				this.scrollTop = Math.max(0, this.scrollTop + (this.rowCount - before));
				this.options.requestRender();
			},
			(error: unknown) => {
				this.notice = error instanceof Error ? error.message : String(error);
				this.options.requestRender();
			},
		);
	}

	private resetScroll(): void {
		this.follow = true;
		this.scrollTop = 0;
	}

	private scroll(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "app.work.follow")) {
			this.follow = true;
			return;
		}
		if (keys.matches(data, "tui.altScreen.top")) {
			this.follow = false;
			this.scrollTop = 0;
			return;
		}
		const movement = keys.matches(data, "tui.select.pageUp")
			? -this.viewportRows
			: keys.matches(data, "tui.select.pageDown")
				? this.viewportRows
				: keys.matches(data, "tui.select.up")
					? -1
					: keys.matches(data, "tui.select.down")
						? 1
						: 0;
		if (movement === 0) return;
		this.follow = false;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop + movement, this.rowCount - this.viewportRows));
		if (movement > 0 && this.scrollTop >= this.rowCount - this.viewportRows) this.follow = true;
	}

	/**
	 * Read the selected item's output again when it may have changed: its live
	 * value changed (output, or the progress its kind reports with it), or it
	 * finished.
	 */
	private syncOutput(): void {
		if (this.mode === "list" || this.selectedId === undefined) return;
		const view = this.selected();
		if (!view) return;
		const workId = view.item.workId;
		const { detail: _detail, ...live } = view.live ?? { kind: "work", workId };
		const key = `${JSON.stringify(live)}:${view.item.outcome ?? view.item.state}`;
		if (this.outputFetch?.workId === workId && this.outputFetch.key === key) return;
		if (this.output?.workId === workId && this.output.key === key) return;
		const fetch = { workId, key };
		this.outputFetch = fetch;
		void this.source.output(workId).then(
			(tail) => {
				if (this.disposed || this.outputFetch !== fetch) return;
				this.outputFetch = undefined;
				this.output = { workId, tail, key };
				this.options.requestRender();
			},
			() => {
				if (this.outputFetch === fetch) this.outputFetch = undefined;
			},
		);
	}

	render(width: number): RenderFrame {
		if (this.nested) return this.nested.render(width);
		const height = Math.max(1, this.options.getHeight());
		const innerWidth = Math.max(1, width - 4);
		const items = this.source.items();
		this.ensureSelection(items);
		const view = this.selected();
		if (this.mode !== "list" && !view) this.mode = "list";
		let lines: string[];
		let footer: string[];
		switch (this.mode) {
			case "confirm":
				({ lines, footer } = this.renderConfirm(view!, innerWidth));
				break;
			case "conversation":
				({ lines, footer } = this.renderConversation(innerWidth, height));
				break;
			case "detail":
				({ lines, footer } = this.renderDetail(view!, innerWidth, height));
				break;
			default:
				({ lines, footer } = this.renderList(items, view, innerWidth, height));
		}
		if (this.notice) lines.push(...wrapTextWithAnsi(theme.fg("warning", this.notice), innerWidth));
		// Fixed-height framing keeps the overlay stationary as work reports progress; controls are reserved first.
		if (height < 6 || width < 8) {
			return createRenderFrame([...lines, ...footer].slice(-height).map((line) => truncateToWidth(line, width)));
		}
		const visibleFooter = footer.slice(-Math.min(footer.length, height - 4));
		const bodyRows = Math.max(0, height - visibleFooter.length - 3);
		const body = lines.slice(0, bodyRows);
		while (body.length < bodyRows) body.push("");
		const heading = this.options.title === undefined ? "Work" : `Work · ${workDisplayText(this.options.title)}`;
		const title = truncateToWidth(`─ ${heading.replace(/\s+/g, " ")} `, width - 2, "");
		const border = (text: string) => theme.fg("borderAccent", text);
		return createRenderFrame([
			border(`╭${title}${"─".repeat(Math.max(0, width - 2 - visibleWidth(title)))}╮`),
			...[...body, "", ...visibleFooter].map((line) => {
				const content = truncateToWidth(line, innerWidth);
				return `${border("│")} ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} ${border("│")}`;
			}),
			border(`╰${"─".repeat(width - 2)}╯`),
		]);
	}

	private heading(view: WorkItemView): string {
		const timing = workTiming(view);
		return `${theme.bold(theme.fg("toolTitle", workDisplayText(view.item.kind)))} · ${styledWorkState(view)}${timing ? theme.fg("dim", ` · ${timing}`) : ""}`;
	}

	private renderList(
		items: readonly WorkItemView[],
		selected: WorkItemView | undefined,
		width: number,
		height: number,
	): { lines: string[]; footer: string[] } {
		const lines: string[] = [];
		const footer = this.hints(
			[
				[["tui.select.up", "tui.select.down"], "select"],
				["tui.select.confirm", "details"],
				...(selected?.actions.cancel ? [["app.work.cancel", "cancel"] as const] : []),
				...(selected?.actions.resume ? [["app.work.resume", "resume"] as const] : []),
				["tui.select.cancel", "close"],
			],
			width,
		);
		if (items.length === 0) {
			this.list = undefined;
			lines.push(theme.fg("muted", "No work in this conversation."));
			return { lines, footer };
		}
		const counts = new Map<string, number>();
		for (const view of items) counts.set(workStateLabel(view), (counts.get(workStateLabel(view)) ?? 0) + 1);
		lines.push(theme.fg("muted", [...counts].map(([label, count]) => `${count} ${label}`).join(" · ")));
		const maxVisible = Math.max(1, Math.min(8, height - footer.length - 10));
		this.list = new SelectList(
			items.map((view) => ({
				value: view.item.workId,
				label: [styledWorkState(view), workDisplayText(view.item.kind), workTiming(view), workTitle(view.item)]
					.filter(Boolean)
					.join(" · "),
			})),
			maxVisible,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("muted", text),
			},
		);
		this.list.setSelectedIndex(items.findIndex((view) => view.item.workId === this.selectedId));
		this.list.onSelectionChange = (item) => {
			this.selectedId = item.value;
			this.notice = undefined;
		};
		this.list.onSelect = (item) => this.showDetail(item.value);
		lines.push(...this.list.render(width).lines);
		if (selected) {
			lines.push("", this.heading(selected), truncateToWidth(workTitle(selected.item), width));
			lines.push(...this.summaryLines(selected, width).slice(0, 4));
		}
		return { lines, footer };
	}

	/** Progress while open; the result summary or error once finished. */
	private summaryLines(view: WorkItemView, width: number): string[] {
		const { item } = view;
		const lines: string[] = [];
		const progress = progressOf(view).progress;
		if (item.outcome === undefined && progress?.text) {
			lines.push(...wrapTextWithAnsi(theme.fg("muted", workDisplayText(progress.text)), width));
		}
		if (item.result?.summary) {
			lines.push(...wrapTextWithAnsi(theme.fg("text", workDisplayText(item.result.summary)), width));
		}
		if (item.error) lines.push(...wrapTextWithAnsi(theme.fg("error", workDisplayText(item.error)), width));
		return lines;
	}

	private renderDetail(view: WorkItemView, width: number, height: number): { lines: string[]; footer: string[] } {
		const footer = this.hints(
			[
				[["tui.select.up", "tui.select.down"], "scroll"],
				["app.work.follow", "follow"],
				...(view.actions.open ? [["tui.select.confirm", "open"] as const] : []),
				...(view.actions.cancel ? [["app.work.cancel", "cancel"] as const] : []),
				...(view.actions.resume ? [["app.work.resume", "resume"] as const] : []),
				["tui.select.cancel", "back"],
			],
			width,
		);
		const lines = [this.heading(view), ...wrapTextWithAnsi(workTitle(view.item), width)];
		lines.push(theme.fg("dim", view.item.workId));
		let detail: string[];
		try {
			this.detailView.update(workProgressNodes(view));
			detail = [...this.detailView.render(width).lines];
		} catch {
			// Detail the mapping cannot reconcile shows nothing rather than stopping the inspector.
			this.detailView.dispose();
			detail = [];
		}
		if (detail.length > 0) lines.push("", ...detail);
		const summary = view.item.outcome === undefined ? [] : this.summaryLines(view, width);
		if (summary.length > 0) lines.push("", ...summary);
		const output = this.output?.workId === view.item.workId ? this.output.tail : undefined;
		const text = output ? workDisplayText(output.text).trimEnd() : "";
		const outputLines = text ? text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width)) : [];
		const footerRows = Math.min(footer.length, Math.max(1, height - 4));
		// Metadata keeps at most half the body; the output scrolls below it.
		const metadataRows = Math.max(1, Math.floor((height - footerRows - 4) / 2));
		const kept = lines.length <= metadataRows ? lines : [...lines.slice(0, metadataRows - 1), theme.fg("dim", "…")];
		if (outputLines.length === 0) {
			if (output?.final) kept.push("", theme.fg("dim", "No output was produced"));
			this.rowCount = 0;
			return { lines: kept, footer };
		}
		kept.push("");
		this.viewportRows = Math.max(1, height - kept.length - footerRows - 5);
		this.rowCount = outputLines.length;
		const maximum = Math.max(0, outputLines.length - this.viewportRows);
		this.scrollTop = this.follow ? maximum : Math.min(this.scrollTop, maximum);
		kept.push(
			theme.fg(
				"dim",
				`${this.follow ? "Following latest" : "Scroll paused"}${output?.truncated ? " · older output dropped" : output?.partial ? " · newest part" : ""} · lines ${this.scrollTop + 1}-${Math.min(this.scrollTop + this.viewportRows, outputLines.length)} / ${outputLines.length}`,
			),
		);
		kept.push(
			...outputLines
				.slice(this.scrollTop, this.scrollTop + this.viewportRows)
				.map((line) => theme.fg("toolOutput", line)),
		);
		return { lines: kept, footer };
	}

	private renderConfirm(view: WorkItemView, width: number): { lines: string[]; footer: string[] } {
		return {
			lines: [
				"",
				...wrapTextWithAnsi(theme.fg("warning", "Cancel this work? Other work continues."), width),
				...wrapTextWithAnsi(workTitle(view.item), width),
				theme.fg("dim", view.item.workId),
			],
			footer: this.hints(
				[
					["tui.select.confirm", "confirm cancellation"],
					["tui.select.cancel", "keep it"],
				],
				width,
			),
		};
	}

	private renderConversation(width: number, height: number): { lines: string[]; footer: string[] } {
		const conversation = this.conversation?.view;
		const work = conversation?.work?.items().length ?? 0;
		const footer = this.hints(
			[
				[["tui.select.up", "tui.select.down"], "scroll"],
				["app.work.follow", "follow"],
				...(work > 0 ? [["tui.select.confirm", `its work (${work})`] as const] : []),
				["tui.select.cancel", "back"],
			],
			width,
		);
		if (!conversation) return { lines: [], footer };
		const heading = `${theme.bold(theme.fg("accent", workDisplayText(conversation.title)))}${theme.fg("dim", conversation.live ? " · read-only" : " · closed, read-only")}`;
		const transcript = conversationLines(conversation.messages(), width);
		const content = transcript.length > 0 ? transcript : ["", theme.fg("muted", "No messages yet.")];
		if (conversation.earlier) {
			content.unshift(
				theme.fg("dim", `↑ Earlier entries: ${keyDisplayText("tui.select.up")} at the top loads them`),
			);
		}
		const footerRows = Math.min(footer.length, Math.max(1, height - 4));
		this.viewportRows = Math.max(1, height - footerRows - 5);
		this.rowCount = content.length;
		const maximum = Math.max(0, content.length - this.viewportRows);
		this.scrollTop = this.follow ? maximum : Math.min(this.scrollTop, maximum);
		return {
			lines: [truncateToWidth(heading, width), ...content.slice(this.scrollTop, this.scrollTop + this.viewportRows)],
			footer,
		};
	}

	private hints(items: readonly (readonly [Keybinding | readonly Keybinding[], string])[], width: number): string[] {
		return wrapTextWithAnsi(
			theme.fg(
				"dim",
				items
					.flatMap(([action, description]) => {
						const actions = typeof action === "string" ? [action] : action;
						const keys = actions.map(keyDisplayText).filter(Boolean).join(" / ");
						return keys ? [`${keys} ${description}`] : [];
					})
					.join(" · "),
			),
			width,
		);
	}
}
