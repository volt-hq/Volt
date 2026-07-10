import {
	type Component,
	getKeybindings,
	Markdown,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/volt-tui";
import type { SubagentActivity, SubagentActivityEvent, SubagentActivityStatus } from "../../../core/subagents/index.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const MAX_TOOL_ARGUMENT_CHARS = 800;
const MAX_TOOL_OUTPUT_CHARS = 4_000;
const MAX_TOOL_OUTPUT_LINES = 12;

export interface SubagentActivitySource {
	listActivities(): readonly SubagentActivity[];
	subscribeActivities(listener: () => void): () => void;
}

interface MessageTimelineItem {
	kind: "message";
	role: "user" | "assistant";
	text: string;
	streaming: boolean;
}

interface ToolTimelineItem {
	kind: "tool";
	toolCallId: string;
	toolName: string;
	args: unknown;
	status: "running" | "completed" | "failed";
	output?: string;
}

interface NoticeTimelineItem {
	kind: "notice";
	text: string;
}

type TimelineItem = MessageTimelineItem | ToolTimelineItem | NoticeTimelineItem;

function cleanTerminalText(value: string): string {
	return stripAnsi(value).replace(/\r\n?/g, "\n").replace(CONTROL_CHARACTERS, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeJson(value: unknown, maxChars: number): string {
	const seen = new WeakSet<object>();
	let text: string;
	try {
		text =
			JSON.stringify(value, (_key, item: unknown) => {
				if (typeof item === "bigint") return String(item);
				if (typeof item === "object" && item !== null) {
					if (seen.has(item)) return "[Circular]";
					seen.add(item);
				}
				return item;
			}) ?? String(value);
	} catch {
		text = String(value);
	}
	const clean = cleanTerminalText(text);
	return clean.length > maxChars ? `${clean.slice(0, Math.max(0, maxChars - 1))}…` : clean;
}

function extractContentText(content: unknown): string {
	if (typeof content === "string") return cleanTerminalText(content);
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const value of content) {
		const block = asRecord(value);
		if (!block) continue;
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(cleanTerminalText(block.text));
		} else if (block.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n").trim();
}

function extractMessage(value: unknown): { role: "user" | "assistant"; text: string } | undefined {
	const message = asRecord(value);
	if (!message) return undefined;
	const role = message.role === "custom" ? "user" : message.role;
	if (role !== "user" && role !== "assistant") return undefined;
	return { role, text: extractContentText(message.content) };
}

function extractToolOutput(value: unknown): string {
	if (typeof value === "string") return cleanTerminalText(value);
	const record = asRecord(value);
	if (!record) return "";
	const content = extractContentText(record.content);
	if (content) return content;
	if (typeof record.output === "string") return cleanTerminalText(record.output);
	if (typeof record.message === "string") return cleanTerminalText(record.message);
	return "";
}

function summarizeToolArgs(toolName: string, args: unknown): string {
	const record = asRecord(args);
	if (!record) return safeJson(args, 240);
	const preferredKeys =
		toolName === "bash"
			? ["command"]
			: toolName === "subagent"
				? ["agent", "task", "tasks", "chain"]
				: ["path", "query", "symbol", "action", "tool", "server", "command"];
	const summaries: string[] = [];
	for (const key of preferredKeys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) {
			summaries.push(`${key}=${cleanTerminalText(value).replace(/\s+/g, " ")}`);
		} else if (Array.isArray(value) && value.length > 0) {
			summaries.push(`${key}=${value.length}`);
		}
		if (summaries.length >= 2) break;
	}
	return summaries.length > 0 ? summaries.join(" · ") : safeJson(args, 240);
}

function formatDuration(activity: SubagentActivity): string {
	const elapsed = Math.max(0, (activity.finishedAt ?? Date.now()) - activity.startedAt);
	if (elapsed < 1_000) return "<1s";
	const seconds = Math.floor(elapsed / 1_000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function statusGlyph(status: SubagentActivityStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", "●");
		case "completed":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		case "aborted":
			return theme.fg("warning", "○");
	}
}

function statusLabel(status: SubagentActivityStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", status);
		case "completed":
			return theme.fg("success", status);
		case "failed":
			return theme.fg("error", status);
		case "aborted":
			return theme.fg("warning", status);
	}
}

function toolStatusGlyph(status: ToolTimelineItem["status"]): string {
	if (status === "running") return theme.fg("accent", "●");
	if (status === "failed") return theme.fg("error", "✗");
	return theme.fg("success", "✓");
}

function buildTimelineFromEvents(events: readonly SubagentActivityEvent[]): TimelineItem[] {
	const items: TimelineItem[] = [];
	const tools = new Map<string, ToolTimelineItem>();
	let activeMessage: MessageTimelineItem | undefined;

	for (const entry of events) {
		const event = entry.event;
		switch (event.type) {
			case "message_start": {
				const message = extractMessage(event.message);
				if (!message) break;
				activeMessage = { kind: "message", ...message, streaming: message.role === "assistant" };
				items.push(activeMessage);
				break;
			}
			case "message_update": {
				const message = extractMessage(event.message);
				if (!message) break;
				if (!activeMessage || activeMessage.role !== message.role) {
					activeMessage = { kind: "message", ...message, streaming: true };
					items.push(activeMessage);
				} else {
					activeMessage.text = message.text;
					activeMessage.streaming = true;
				}
				break;
			}
			case "message_end": {
				const message = extractMessage(event.message);
				if (!message) break;
				if (!activeMessage || activeMessage.role !== message.role) {
					items.push({ kind: "message", ...message, streaming: false });
				} else {
					activeMessage.text = message.text;
					activeMessage.streaming = false;
				}
				activeMessage = undefined;
				break;
			}
			case "tool_execution_start": {
				const item: ToolTimelineItem = {
					kind: "tool",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					status: "running",
				};
				items.push(item);
				tools.set(event.toolCallId, item);
				break;
			}
			case "tool_execution_update": {
				const item = tools.get(event.toolCallId);
				const output = extractToolOutput(event.partialResult);
				if (item && output) {
					item.output = output;
				}
				break;
			}
			case "tool_execution_end": {
				let item = tools.get(event.toolCallId);
				if (!item) {
					item = {
						kind: "tool",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: undefined,
						status: "running",
					};
					items.push(item);
					tools.set(event.toolCallId, item);
				}
				item.status = event.isError ? "failed" : "completed";
				const output = extractToolOutput("result" in event ? event.result : undefined);
				if (output) item.output = output;
				break;
			}
			case "auto_retry_start":
				items.push({ kind: "notice", text: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}` });
				break;
			case "compaction_start":
				items.push({ kind: "notice", text: `Compacting context (${event.reason})` });
				break;
		}
	}
	return items;
}

function buildTimelineFromTranscript(transcript: SubagentActivity["transcript"]): TimelineItem[] {
	const items: TimelineItem[] = [];
	const tools = new Map<string, ToolTimelineItem>();
	for (const value of transcript) {
		const record = asRecord(value);
		if (!record) continue;
		const message = extractMessage(record);
		if (message) {
			items.push({ kind: "message", ...message, streaming: false });
		}
		if (record.role === "assistant" && Array.isArray(record.content)) {
			for (const blockValue of record.content) {
				const block = asRecord(blockValue);
				if (!block || block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") {
					continue;
				}
				const tool: ToolTimelineItem = {
					kind: "tool",
					toolCallId: block.id,
					toolName: block.name,
					args: block.arguments,
					status: "completed",
				};
				items.push(tool);
				tools.set(block.id, tool);
			}
		}
		if (record.role === "toolResult" && typeof record.toolCallId === "string") {
			const tool = tools.get(record.toolCallId);
			if (tool) {
				tool.status = record.isError === true ? "failed" : "completed";
				tool.output = extractContentText(record.content);
			}
		}
	}
	return items;
}

function countToolCalls(activity: SubagentActivity): number {
	const ids = new Set<string>();
	for (const entry of activity.events) {
		if (entry.event.type === "tool_execution_start") ids.add(entry.event.toolCallId);
	}
	return ids.size || activity.sessionStats?.toolCalls || 0;
}

function limitToolOutput(text: string): { text: string; truncated: boolean } {
	const clean = cleanTerminalText(text);
	const limitedChars = clean.slice(0, MAX_TOOL_OUTPUT_CHARS);
	const lines = limitedChars.split("\n");
	const truncated = clean.length > limitedChars.length || lines.length > MAX_TOOL_OUTPUT_LINES;
	return { text: lines.slice(0, MAX_TOOL_OUTPUT_LINES).join("\n"), truncated };
}

function appendWrapped(
	lines: string[],
	prefix: string,
	text: string,
	width: number,
	color: (value: string) => string = (value) => value,
): void {
	const safePrefix = truncateToWidth(prefix, width, "");
	const prefixWidth = visibleWidth(safePrefix);
	const available = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(color(cleanTerminalText(text)), available);
	for (let index = 0; index < wrapped.length; index += 1) {
		const linePrefix = index === 0 ? safePrefix : " ".repeat(prefixWidth);
		lines.push(truncateToWidth(`${linePrefix}${wrapped[index] ?? ""}`, width, ""));
	}
}

function appendMarkdown(lines: string[], text: string, width: number): void {
	const prefix = "  ";
	const available = Math.max(1, width - visibleWidth(prefix));
	const rendered = new Markdown(cleanTerminalText(text), 0, 0, getMarkdownTheme()).render(available);
	for (const line of rendered) {
		lines.push(truncateToWidth(`${prefix}${line}`, width, ""));
	}
}

function navigationHint(description: string): string {
	return (
		theme.fg("dim", `${keyText("tui.select.up")}/${keyText("tui.select.down")}`) +
		theme.fg("muted", ` ${description}`)
	);
}

export class SubagentInspectorComponent implements Component {
	private activities: readonly SubagentActivity[] = [];
	private selectedIndex = 0;
	private view: "list" | "detail" = "list";
	private detailId: string | undefined;
	private detailScroll = 0;
	private followTail = false;
	private lastDetailMaxScroll = 0;
	private lastDetailPageSize = 1;
	private readonly source: SubagentActivitySource;
	private readonly tui: TUI;
	private readonly onClose: () => void;
	private readonly unsubscribe: () => void;
	private disposed = false;

	constructor(source: SubagentActivitySource, tui: TUI, onClose: () => void, initialActivityId?: string) {
		this.source = source;
		this.tui = tui;
		this.onClose = onClose;
		this.refreshActivities();
		if (initialActivityId) {
			const index = this.activities.findIndex((activity) => activity.id === initialActivityId);
			if (index >= 0) this.selectedIndex = index;
		}
		this.unsubscribe = this.source.subscribeActivities(() => {
			this.refreshActivities();
			this.tui.requestRender();
		});
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return this.view === "list" ? this.renderList(safeWidth) : this.renderDetail(safeWidth);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (this.view === "list") {
			if (keybindings.matches(data, "tui.select.up")) {
				this.moveSelection(-1);
			} else if (keybindings.matches(data, "tui.select.down")) {
				this.moveSelection(1);
			} else if (keybindings.matches(data, "tui.select.pageUp")) {
				this.moveSelection(-this.listPageSize());
			} else if (keybindings.matches(data, "tui.select.pageDown")) {
				this.moveSelection(this.listPageSize());
			} else if (keybindings.matches(data, "tui.select.confirm")) {
				this.openSelectedActivity();
			} else if (keybindings.matches(data, "tui.select.cancel")) {
				this.onClose();
				return;
			} else {
				return;
			}
		} else if (keybindings.matches(data, "tui.select.cancel")) {
			this.view = "list";
			this.detailId = undefined;
			this.followTail = false;
		} else if (keybindings.matches(data, "tui.select.up")) {
			this.scrollDetail(-1);
		} else if (keybindings.matches(data, "tui.select.down")) {
			this.scrollDetail(1);
		} else if (keybindings.matches(data, "tui.select.pageUp")) {
			this.scrollDetail(-Math.max(1, this.lastDetailPageSize - 2));
		} else if (keybindings.matches(data, "tui.select.pageDown")) {
			this.scrollDetail(Math.max(1, this.lastDetailPageSize - 2));
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private refreshActivities(): void {
		const selectedId = this.activities[this.selectedIndex]?.id;
		this.activities = [...this.source.listActivities()];
		if (selectedId) {
			const nextIndex = this.activities.findIndex((activity) => activity.id === selectedId);
			if (nextIndex >= 0) this.selectedIndex = nextIndex;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.activities.length - 1)));
		if (this.detailId && !this.activities.some((activity) => activity.id === this.detailId)) {
			this.view = "list";
			this.detailId = undefined;
		}
	}

	private moveSelection(delta: number): void {
		const length = this.activities.length;
		if (length === 0) return;
		this.selectedIndex = (((this.selectedIndex + delta) % length) + length) % length;
	}

	private openSelectedActivity(): void {
		const activity = this.activities[this.selectedIndex];
		if (!activity) return;
		this.view = "detail";
		this.detailId = activity.id;
		this.detailScroll = 0;
		this.followTail = activity.status === "running";
	}

	private scrollDetail(delta: number): void {
		if (delta < 0) this.followTail = false;
		this.detailScroll = Math.max(0, Math.min(this.lastDetailMaxScroll, this.detailScroll + delta));
		if (delta > 0 && this.detailScroll >= this.lastDetailMaxScroll) this.followTail = true;
	}

	private terminalRows(): number {
		return Math.max(6, this.tui.terminal.rows || 24);
	}

	private listPageSize(): number {
		return Math.max(1, Math.floor((this.terminalRows() - 4) / 2));
	}

	private renderList(width: number): string[] {
		const lines: string[] = [];
		lines.push(theme.fg("border", "─".repeat(width)));
		lines.push(
			truncateToWidth(
				`${theme.bold(theme.fg("accent", "Subagents"))}${theme.fg("muted", `  ${this.activities.length} this session`)}`,
				width,
				"",
			),
		);

		if (this.activities.length === 0) {
			lines.push(theme.fg("muted", truncateToWidth("  No subagents have run in this session.", width, "")));
		} else {
			const visibleCount = this.listPageSize();
			const start = Math.max(
				0,
				Math.min(this.selectedIndex - Math.floor(visibleCount / 2), this.activities.length - visibleCount),
			);
			const end = Math.min(this.activities.length, start + visibleCount);
			for (let index = start; index < end; index += 1) {
				const activity = this.activities[index];
				if (!activity) continue;
				const selected = index === this.selectedIndex;
				const cursor = selected ? theme.fg("accent", "› ") : "  ";
				const safeName = cleanTerminalText(activity.agent.name).replace(/\s+/g, " ");
				const name = selected ? theme.bold(theme.fg("accent", safeName)) : theme.bold(theme.fg("text", safeName));
				const source = activity.agent.source ? theme.fg("muted", ` (${activity.agent.source})`) : "";
				const tools = countToolCalls(activity);
				const metadata = `${statusLabel(activity.status)} · ${formatDuration(activity)}${tools > 0 ? ` · ${tools} tool${tools === 1 ? "" : "s"}` : ""}`;
				lines.push(
					truncateToWidth(
						`${cursor}${statusGlyph(activity.status)} ${name}${source}  ${theme.fg("dim", metadata)}`,
						width,
						"",
					),
				);
				const task = cleanTerminalText(activity.task ?? "Waiting for task…").replace(/\s+/g, " ");
				lines.push(truncateToWidth(`    ${theme.fg("muted", task)}`, width, ""));
			}
		}

		const position =
			this.activities.length > 0 ? theme.fg("muted", `  (${this.selectedIndex + 1}/${this.activities.length})`) : "";
		lines.push(
			truncateToWidth(
				`${navigationHint("navigate")}  ${keyHint("tui.select.confirm", "inspect")}  ${keyHint("tui.select.cancel", "close")}${position}`,
				width,
				"",
			),
		);
		lines.push(theme.fg("border", "─".repeat(width)));
		return lines;
	}

	private renderDetail(width: number): string[] {
		const activity = this.activities.find((candidate) => candidate.id === this.detailId);
		if (!activity) {
			this.view = "list";
			return this.renderList(width);
		}
		const lines: string[] = [theme.fg("border", "─".repeat(width))];
		const safeName = cleanTerminalText(activity.agent.name).replace(/\s+/g, " ");
		lines.push(
			truncateToWidth(
				`${theme.bold(theme.fg("accent", "Subagents"))}${theme.fg("muted", " / ")}${theme.bold(safeName)}  ${statusGlyph(activity.status)} ${statusLabel(activity.status)}`,
				width,
				"",
			),
		);

		const content = this.buildDetailLines(activity, width);
		const pageSize = Math.max(1, this.terminalRows() - 4);
		const maxScroll = Math.max(0, content.length - pageSize);
		this.lastDetailPageSize = pageSize;
		this.lastDetailMaxScroll = maxScroll;
		if (this.followTail) this.detailScroll = maxScroll;
		this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll));
		lines.push(...content.slice(this.detailScroll, this.detailScroll + pageSize));

		const first = content.length === 0 ? 0 : this.detailScroll + 1;
		const last = Math.min(content.length, this.detailScroll + pageSize);
		const position = content.length > pageSize ? theme.fg("muted", `  (${first}-${last}/${content.length})`) : "";
		lines.push(
			truncateToWidth(
				`${navigationHint("scroll")}  ${keyHint("tui.select.pageUp", "page")}  ${keyHint("tui.select.cancel", "back")}${position}`,
				width,
				"",
			),
		);
		lines.push(theme.fg("border", "─".repeat(width)));
		return lines;
	}

	private buildDetailLines(activity: SubagentActivity, width: number): string[] {
		const lines: string[] = [];
		const stats = activity.sessionStats;
		const metadata = [
			formatDuration(activity),
			`${countToolCalls(activity)} tools`,
			...(stats ? [`${stats.tokens.total} tokens`] : []),
		].join(" · ");
		appendWrapped(lines, "  ", metadata, width, (value) => theme.fg("muted", value));
		appendWrapped(lines, "  ", `session ${activity.sessionId}`, width, (value) => theme.fg("dim", value));

		if (activity.task) {
			lines.push("");
			lines.push(theme.bold(theme.fg("accent", "Task")));
			appendWrapped(lines, "  ", activity.task, width, (value) => theme.fg("text", value));
		}

		let timeline = buildTimelineFromEvents(activity.events);
		if (timeline.length === 0 && activity.transcript.length > 0) {
			timeline = buildTimelineFromTranscript(activity.transcript);
		}
		if (activity.droppedEvents > 0) {
			timeline.unshift({ kind: "notice", text: `${activity.droppedEvents} older live events omitted` });
		}

		for (const item of timeline) {
			if (item.kind === "message") {
				if (!item.text || (item.role === "user" && item.text.trim() === activity.task?.trim())) continue;
				lines.push("");
				const label = item.role === "user" ? "User" : item.streaming ? "Assistant (streaming)" : "Assistant";
				lines.push(theme.bold(theme.fg(item.role === "user" ? "accent" : "text", label)));
				if (item.role === "assistant") {
					appendMarkdown(lines, item.text, width);
				} else {
					appendWrapped(lines, "  ", item.text, width, (value) => theme.fg("text", value));
				}
				continue;
			}
			if (item.kind === "notice") {
				lines.push("");
				appendWrapped(lines, "  ", item.text, width, (value) => theme.fg("warning", value));
				continue;
			}

			lines.push("");
			const summary = summarizeToolArgs(item.toolName, item.args);
			appendWrapped(
				lines,
				"",
				`${toolStatusGlyph(item.status)} ${theme.bold(theme.fg("toolTitle", item.toolName))}${summary ? theme.fg("muted", `  ${summary}`) : ""}`,
				width,
			);
			if (item.args !== undefined) {
				appendWrapped(lines, "  ", `args: ${safeJson(item.args, MAX_TOOL_ARGUMENT_CHARS)}`, width, (value) =>
					theme.fg("dim", value),
				);
			}
			if (item.output) {
				const output = limitToolOutput(item.output);
				appendWrapped(lines, "  ", output.text, width, (value) =>
					theme.fg(item.status === "failed" ? "error" : "toolOutput", value),
				);
				if (output.truncated) {
					appendWrapped(lines, "  ", "… tool output truncated in inspector", width, (value) =>
						theme.fg("muted", value),
					);
				}
			}
		}

		if (timeline.length === 0) {
			lines.push("");
			appendWrapped(lines, "  ", "Waiting for the subagent to produce activity…", width, (value) =>
				theme.fg("muted", value),
			);
		}
		if (activity.error) {
			lines.push("");
			appendWrapped(lines, "  ", `Error: ${activity.error}`, width, (value) => theme.fg("error", value));
		}
		return lines;
	}
}
