/**
 * The TUI's work rendering: the work inspector over a work source, the
 * footer's work line, work notices, and the `UiNode` mapping they render
 * kind detail with.
 */

import type { ClientWorkItem, UiNode, WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { getKeybindings, setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	conversationLines,
	type WorkConversation,
	WorkInspector,
	type WorkItemView,
	type WorkOpenResult,
	type WorkOutputTail,
	type WorkSource,
} from "../src/modes/interactive/components/work-inspector.ts";
import {
	queuedWorkNoticeLine,
	WorkNoticeComponent,
	workNoticeOwnText,
	workOutcomeLine,
} from "../src/modes/interactive/components/work-notice.ts";
import { WorkStatus } from "../src/modes/interactive/components/work-status.ts";
import { createUiNodeView } from "../src/modes/interactive/ui-node/index.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousBindings = getKeybindings();
const disposals: Array<() => void> = [];

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
	setKeybindings(previousBindings);
	vi.useRealTimers();
});

const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_K = "\x0b";
const CTRL_R = "\x12";
const PAGE_UP = "\x1b[5~";
const END = "\x1b[F";

function item(workId: string, overrides: Partial<ClientWorkItem> = {}): ClientWorkItem {
	return {
		workId,
		kind: "job",
		title: `Work ${workId}`,
		cancellable: true,
		delivery: "wake",
		resume: false,
		state: "running",
		startedOrdinal: 1,
		updatedOrdinal: 1,
		...overrides,
	};
}

function view(workItem: ClientWorkItem, overrides: Partial<WorkItemView> = {}): WorkItemView {
	return {
		item: workItem,
		suspended: false,
		actions: { cancel: workItem.outcome === undefined, resume: false, open: false },
		...overrides,
	};
}

/** A work source over a fixed list of items the test changes. */
class FakeSource implements WorkSource {
	views: WorkItemView[];
	outputs = new Map<string, WorkOutputTail>();
	readonly cancel = vi.fn(async (_workId: string) => {});
	readonly resume = vi.fn(async (_workId: string) => {});
	readonly open = vi.fn(async (_workId: string): Promise<WorkOpenResult> => ({ kind: "moved" }));
	readonly output = vi.fn(
		async (workId: string): Promise<WorkOutputTail> =>
			this.outputs.get(workId) ?? { text: "", truncated: false, partial: false, final: false },
	);
	private readonly listeners = new Set<() => void>();

	constructor(views: WorkItemView[]) {
		this.views = views;
	}

	items(): readonly WorkItemView[] {
		return this.views;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	get subscribers(): number {
		return this.listeners.size;
	}

	changed(): void {
		for (const listener of this.listeners) listener();
	}
}

function inspector(source: WorkSource, height = 24, workId?: string) {
	const requestRender = vi.fn();
	const onClose = vi.fn();
	const component = new WorkInspector(source, {
		getHeight: () => height,
		requestRender,
		onClose,
		...(workId === undefined ? {} : { workId }),
	});
	disposals.push(() => component.dispose());
	return { component, requestRender, onClose };
}

function text(component: { render(width: number): { lines: readonly string[] } }, width = 80): string {
	const frame = component.render(width);
	for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	return frame.lines.map(stripAnsi).join("\n");
}

describe("work inspector", () => {
	it("lists open work first with its state and kind, and fits narrow and wide terminals", () => {
		const source = new FakeSource([
			view(item("job-1", { title: "npm run check" })),
			view(item("agent-1", { kind: "subagent", title: "scout: inspect auth", resume: true }), {
				suspended: true,
				actions: { cancel: true, resume: true, open: true },
			}),
			view(item("action-1", { kind: "host_action", title: "Install rust-analyzer", state: "awaiting_approval" })),
			view(item("review-1", { kind: "review", title: "Review uncommitted changes", outcome: "completed" }), {
				actions: { cancel: false, resume: false, open: true },
			}),
			view(item("ext-1", { kind: "ext:swarm-review/run", title: "Swarm review", outcome: "failed", error: "boom" })),
		]);
		const { component } = inspector(source);
		const rendered = text(component);
		expect(rendered).toContain("1 running · 1 suspended · 1 awaiting approval · 1 completed · 1 failed");
		expect(rendered).toContain("● running · job");
		expect(rendered).toContain("‖ suspended · subagent");
		expect(rendered).toContain("? awaiting approval · host_action");
		expect(rendered).toContain("✓ completed · review");
		expect(rendered).toContain("✗ failed · ext:swarm-review/run");
		for (const width of [20, 40, 80, 120]) {
			text(component, width);
			expect(component.render(width).lines.length).toBeLessThanOrEqual(24);
		}
		expect(rendered).toContain("Ctrl+K cancel");
		expect(rendered).not.toContain("resume");
	});

	it("shows an item's progress, kind detail, result, and output tail, following new output", async () => {
		const running = view(
			item("job-1", {
				title: "vitest --run",
				progress: { text: "Checkpointed phase" },
			}),
			{
				live: {
					kind: "work",
					workId: "job-1",
					progress: {
						text: "Discovery pass: read",
						value: 1,
						max: 4,
						steps: [
							{ key: "a", label: "Wave 1", status: "done" },
							{ key: "b", label: "Wave 2", status: "active" },
						],
					},
					detail: {
						type: "keyValue",
						key: "review-usage",
						items: [{ key: "requests", label: "Requests", value: "3 (1 pending)" }],
					},
					output: { bytes: 10 },
				},
			},
		);
		const source = new FakeSource([running]);
		source.outputs.set("job-1", {
			text: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
			truncated: true,
			partial: false,
			final: false,
		});
		const { component } = inspector(source);
		component.handleInput(ENTER);
		await vi.waitFor(() => expect(text(component)).toContain("line 39"));
		const rendered = text(component);
		// The live value wins over the last checkpoint while the work runs here.
		expect(rendered).toContain("Discovery pass: read");
		expect(rendered).not.toContain("Checkpointed phase");
		expect(rendered).toContain("25%");
		expect(rendered).toContain("✓ Wave 1");
		expect(rendered).toContain("Requests: 3 (1 pending)");
		expect(rendered).toContain("Following latest · older output dropped");
		component.handleInput(PAGE_UP);
		expect(text(component)).toContain("Scroll paused");
		expect(text(component)).not.toContain("line 39");
		component.handleInput(END);
		expect(text(component)).toContain("Following latest");
		expect(text(component)).toContain("line 39");

		// More output: the inspector reads it again.
		source.views = [{ ...running, live: { ...running.live!, output: { bytes: 20 } } }];
		source.outputs.set("job-1", { text: "line 40", truncated: false, partial: false, final: false });
		source.changed();
		await vi.waitFor(() => expect(text(component)).toContain("line 40"));

		// Finished: the result's summary and error show.
		source.views = [
			view(
				item("job-1", {
					title: "vitest --run",
					outcome: "failed",
					error: "exit 1",
					result: { summary: "3 failed" },
				}),
			),
		];
		source.outputs.set("job-1", { text: "", truncated: false, partial: false, final: true });
		source.changed();
		await vi.waitFor(() => expect(text(component)).toContain("No output was produced"));
		expect(text(component)).toContain("✗ failed");
		expect(text(component)).toContain("3 failed");
		expect(text(component)).toContain("exit 1");
	});

	it("cancels only the selected work, after confirmation, when its kind allows it", async () => {
		const source = new FakeSource([
			view(item("first", { title: "First work" })),
			view(item("pinned", { title: "Pinned work", cancellable: false }), {
				actions: { cancel: false, resume: false, open: false },
			}),
		]);
		const { component, onClose } = inspector(source);
		text(component);
		component.handleInput(CTRL_K);
		expect(text(component)).toContain("Cancel this work?");
		expect(text(component)).toContain("First work");
		component.handleInput(ESCAPE);
		expect(source.cancel).not.toHaveBeenCalled();
		component.handleInput(CTRL_K);
		component.handleInput(ENTER);
		expect(source.cancel).toHaveBeenCalledExactlyOnceWith("first");
		// The kind keeps the other item from clients: no cancel is offered.
		component.handleInput(ESCAPE);
		component.handleInput("\x1b[B");
		expect(text(component)).not.toContain("Ctrl+K cancel");
		component.handleInput(CTRL_K);
		expect(text(component)).not.toContain("Cancel this work?");
		expect(source.cancel).toHaveBeenCalledOnce();
		component.handleInput(ESCAPE);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("resumes suspended work and reports a refusal", async () => {
		const suspended = view(item("agent-1", { kind: "subagent", resume: true }), {
			suspended: true,
			actions: { cancel: true, resume: true, open: false },
		});
		const source = new FakeSource([suspended, view(item("job-1"))]);
		const { component } = inspector(source, 24, "agent-1");
		expect(text(component)).toContain("Ctrl+R resume");
		component.handleInput(CTRL_R);
		expect(source.resume).toHaveBeenCalledExactlyOnceWith("agent-1");
		source.resume.mockRejectedValueOnce(new Error("Work agent-1 cannot resume: its log no longer exists"));
		component.handleInput(CTRL_R);
		await vi.waitFor(() => expect(text(component)).toContain("its log no longer exists"));
		// Running work offers no resume.
		component.handleInput(ESCAPE);
		text(component);
		component.handleInput("\x1b[B");
		component.handleInput(CTRL_R);
		expect(source.resume).toHaveBeenCalledTimes(2);
	});

	it("opens the conversation work runs in read-only, live or closed, and returns to the detail", async () => {
		const listeners = new Set<() => void>();
		let messages: unknown[] = [{ role: "user", content: "inspect auth" }];
		const disposed = vi.fn();
		const live: WorkConversation = {
			title: "scout: inspect auth",
			live: true,
			messages: () => messages,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			dispose: disposed,
		};
		const source = new FakeSource([
			view(item("agent-1", { kind: "subagent", title: "scout: inspect auth" }), {
				actions: { cancel: true, resume: false, open: true },
			}),
			view(item("job-1"), { actions: { cancel: true, resume: false, open: false } }),
		]);
		source.open.mockResolvedValueOnce({ kind: "view", conversation: live });
		const { component } = inspector(source, 24, "agent-1");
		expect(text(component)).toContain("Enter open");
		component.handleInput(ENTER);
		await vi.waitFor(() => expect(text(component)).toContain("read-only"));
		expect(text(component)).toContain("› inspect auth");
		messages = [
			...messages,
			{
				role: "assistant",
				content: [
					{ type: "text", text: "Reading the **auth** module." },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/auth.ts" } },
				],
			},
		];
		for (const listener of listeners) listener();
		expect(text(component)).toContain("Reading the auth module.");
		expect(text(component)).toContain("● read  src/auth.ts");
		component.handleInput(ESCAPE);
		expect(disposed).toHaveBeenCalledOnce();
		expect(text(component)).toContain("subagent · ● running");

		source.open.mockResolvedValueOnce({
			kind: "view",
			conversation: {
				title: "scout: inspect auth",
				live: false,
				messages: () => [{ role: "assistant", content: [{ type: "text", text: "Final report." }] }],
				subscribe: () => () => undefined,
				dispose: () => undefined,
			},
		});
		component.handleInput(ENTER);
		await vi.waitFor(() => expect(text(component)).toContain("closed, read-only"));
		expect(text(component)).toContain("Final report.");
		component.handleInput(ESCAPE);

		// A kind that opens nothing offers no open.
		component.handleInput(ESCAPE);
		text(component);
		component.handleInput("\x1b[B");
		component.handleInput(ENTER);
		expect(text(component)).not.toContain("Enter open");
		component.handleInput(ENTER);
		expect(source.open).toHaveBeenCalledTimes(2);
	});

	it("releases its timer and subscription when disposed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const source = new FakeSource([view(item("job-1"))]);
		const { component, requestRender } = inspector(source);
		expect(source.subscribers).toBe(1);
		component.dispose();
		expect(source.subscribers).toBe(0);
		requestRender.mockClear();
		source.changed();
		await vi.advanceTimersByTimeAsync(3000);
		expect(requestRender).not.toHaveBeenCalled();
	});
});

describe("conversation transcript lines", () => {
	it("shows user and assistant text, tool calls with their outcome, and keeps controls literal", () => {
		const lines = conversationLines(
			[
				{ role: "user", content: [{ type: "text", text: "task \x1b[31mred\x1b[0m" }] },
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "ok", name: "bash", arguments: { command: "ls" } },
						{ type: "toolCall", id: "bad", name: "read", arguments: { path: "missing" } },
					],
				},
				{ role: "toolResult", toolCallId: "ok", isError: false, content: [] },
				{ role: "toolResult", toolCallId: "bad", isError: true, content: [] },
			],
			60,
		)
			.map(stripAnsi)
			.join("\n");
		expect(lines).toContain("› task red");
		expect(lines).toContain("✓ bash  ls");
		expect(lines).toContain("✗ read  missing");
		expect(lines).not.toContain("\x1b");
	});
});

describe("work status line", () => {
	it("shows nothing without open work, one item's state and progress, or counts per state", () => {
		const source = new FakeSource([view(item("done", { outcome: "completed" }))]);
		const status = new WorkStatus(() => source);
		expect(status.render(80).lines).toEqual([]);
		source.views = [
			...source.views,
			view(item("job-1", { title: "npm run check" }), {
				live: { kind: "work", workId: "job-1", progress: { text: "PASS 12 of 40" } },
			}),
		];
		const single = text(status);
		expect(single).toMatch(/^Work · ● running · job · npm run check · PASS 12 of 40\s+(?:Alt|Option)\+J$/);
		source.views = [
			...source.views,
			view(item("agent-1", { kind: "subagent", resume: true }), { suspended: true }),
			view(item("action-1", { kind: "host_action", state: "awaiting_approval" })),
		];
		expect(text(status)).toMatch(/^Work · 1 running · 1 suspended · 1 awaiting approval\s+(?:Alt|Option)\+J$/);
		for (const width of [1, 10, 20, 40, 120]) {
			text(status, width);
			expect(status.render(width).lines).toHaveLength(1);
		}
	});

	it.each(["f6", "none"] as const)("right-aligns the configured shortcut or /work: %s", (binding) => {
		setKeybindings(new KeybindingsManager({ "app.work.open": binding === "f6" ? "f6" : [] }));
		const status = new WorkStatus(() => new FakeSource([view(item("job-1", { title: "x".repeat(200) }))]));
		const hint = binding === "f6" ? "F6" : "/work";
		for (const width of [40, 80, 120]) {
			const rendered = text(status, width);
			expect(visibleWidth(rendered)).toBe(width);
			expect(rendered.endsWith(hint)).toBe(true);
		}
	});
});

describe("work notices", () => {
	const details: WorkNoticeDetails = {
		workId: "ext-1",
		kind: "ext:swarm-review/run",
		title: "Swarm **review**",
		outcome: "completed",
		summary: "2 findings",
	};

	function notice(content: string, noticeDetails: unknown = details): CustomMessage {
		return {
			role: "custom",
			customType: "work_notice",
			content,
			display: true,
			details: noticeDetails as CustomMessage["details"],
			timestamp: Date.now(),
		} as CustomMessage;
	}

	it("keeps the host's own notice literal, and renders a kind's own text as Markdown", () => {
		const heading = "Swarm **review** (ext:swarm-review/run ext-1) completed.";
		const plain = text(new WorkNoticeComponent(notice(`${heading}\n2 findings`)));
		expect(plain).toContain("Swarm **review** (ext:swarm-review/run ext-1) completed.");
		expect(plain).toContain("2 findings");
		expect(workNoticeOwnText(`${heading}\n2 findings`, details)).toBeUndefined();

		const own = `${heading}\n## Findings\n- **High:** token leak`;
		expect(workNoticeOwnText(own, details)).toBe("## Findings\n- **High:** token leak");
		const rendered = text(new WorkNoticeComponent(notice(own)));
		// The heading names the work as data; the kind's text is Markdown.
		expect(rendered).toContain("Swarm **review** (ext:swarm-review/run ext-1) completed.");
		expect(rendered).toContain("High: token leak");
		expect(rendered).not.toContain("**High:**");
		expect(rendered).not.toContain("## Findings");

		// A notice whose text does not start with its heading stays literal.
		const forged = text(new WorkNoticeComponent(notice("**not** the heading")));
		expect(forged).toContain("**not** the heading");
		expect(text(new WorkNoticeComponent(notice("**literal**", undefined)))).toContain("**literal**");
	});

	it("names queued notices and the end of work that delivers none in one line", () => {
		expect(stripAnsi(queuedWorkNoticeLine(details))).toBe("Notice for the next turn: Swarm **review** completed");
		expect(
			workOutcomeLine(item("a", { title: "Install", outcome: "completed", result: { summary: "ok\nmore" } })),
		).toEqual({
			text: "Install completed: ok",
			warning: false,
		});
		expect(workOutcomeLine(item("a", { title: "Install", outcome: "failed", error: "denied" }))).toEqual({
			text: "Install failed: denied",
			warning: true,
		});
		expect(workOutcomeLine(item("a", { title: "Install", outcome: "cancelled" }))).toEqual({
			text: "Install cancelled",
			warning: false,
		});
	});
});

describe("UiNode mapping", () => {
	it("renders text, keyValue, progress, terminal, and list nodes, and placeholders for the rest", () => {
		const view = createUiNodeView();
		disposals.push(() => view.dispose());
		const nodes: UiNode[] = [
			{ type: "text", key: "t", text: [{ text: "bold", bold: true }, { text: " plain" }] },
			{ type: "keyValue", key: "kv", items: [{ label: "Tokens", value: "12 input" }] },
			{ type: "progress", key: "bar", kind: "determinate", value: 1, max: 2, label: "Half" },
			{
				type: "progress",
				key: "steps",
				kind: "steps",
				title: "Waves",
				steps: [
					{ label: "One", status: "done" },
					{ label: "Two", status: "failed", detail: "timeout" },
				],
			},
			{ type: "terminal", key: "out", lines: ["$ npm test", "ok"], omittedLines: 3 },
			{
				type: "list",
				key: "list",
				ordered: true,
				items: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
			{ type: "card", key: "card", title: "Not mapped yet" },
		];
		view.update(nodes);
		const rendered = text(view, 60);
		expect(rendered).toContain("bold plain");
		expect(rendered).toContain("Tokens: 12 input");
		expect(rendered).toContain("Half");
		expect(rendered).toContain("50%");
		expect(rendered).toContain("Waves (1/2)");
		expect(rendered).toContain("✗ Two  timeout");
		expect(rendered).toContain("$ npm test");
		expect(rendered).toContain("1. first");
		expect(rendered).toContain("2. second");
		expect(rendered).toContain("[card]");

		// Keyed updates keep retained components.
		const terminal = view.getComponent(["out"]);
		const more: UiNode = { type: "terminal", key: "out", lines: ["$ npm test", "ok", "done"], omittedLines: 3 };
		view.update(nodes.map((node) => (node.key === "out" ? more : node)));
		expect(view.getComponent(["out"])).toBe(terminal);
		expect(text(view, 60)).toContain("done");
	});
});
