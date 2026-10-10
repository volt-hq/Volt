/**
 * The TUI's work rendering: the work inspector over a work source, the
 * footer's work line, work notices, and the `UiNode` mapping they render
 * kind detail with.
 */

import type { ClientWorkItem, WorkNoticeDetails } from "@hansjm10/volt-protocol";
import { getKeybindings, setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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
import { queuedWorkNoticeLine, workOutcomeLine } from "../src/modes/interactive/components/work-notice.ts";
import { WorkStatus } from "../src/modes/interactive/components/work-status.ts";
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

describe("work status list", () => {
	const HINT = /(?:Alt|Option)\+J$/;
	const live = (workId: string, progress: string): Pick<WorkItemView, "live"> => ({
		live: { kind: "work", workId, progress: { text: progress } },
	});

	/** Every line fits each width, and the work keeps its number of lines. */
	function expectFits(status: WorkStatus, lines: number): void {
		for (const width of [1, 10, 20, 40, 120]) {
			text(status, width);
			expect(status.render(width).lines).toHaveLength(lines);
		}
	}

	it("shows nothing without open work", () => {
		const status = new WorkStatus(() => new FakeSource([view(item("done", { outcome: "completed" }))]));
		expect(status.render(80).lines).toEqual([]);
		expect(new WorkStatus(() => undefined).render(80).lines).toEqual([]);
	});

	it("shows one item's state, kind, title, elapsed time, and progress on one line", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(100_000);
		const source = new FakeSource([
			view(item("job-1", { title: "npm run check" }), { startedAt: 88_000, ...live("job-1", "PASS 12 of 40") }),
		]);
		const status = new WorkStatus(() => source);
		expect(text(status)).toMatch(
			/^Work · ● running · job · npm run check · 12\.0s · PASS 12 of 40\s+(?:Alt|Option)\+J$/,
		);
		vi.setSystemTime(101_000);
		expect(text(status)).toContain("npm run check · 13.0s · PASS 12 of 40");
		// Suspended work shows no elapsed time; checkpointed progress shows without a live value.
		source.views = [
			view(item("agent-1", { kind: "subagent", title: "scout", resume: true, progress: { text: "grep auth" } }), {
				startedAt: 50_000,
				suspended: true,
			}),
		];
		expect(text(status)).toMatch(/^Work · ‖ suspended · subagent · scout · grep auth\s+(?:Alt|Option)\+J$/);
		expectFits(status, 1);
	});

	it("shows the work one tool call started as one group: its first item, and its newest progress", () => {
		const source = new FakeSource([
			view(
				item("agent-1", {
					kind: "subagent",
					title: "general: audit",
					toolCallId: "call-1",
					startedOrdinal: 3,
				}),
				live("agent-1", "read src/auth.ts"),
			),
			view(item("job-1", { title: "audit", toolCallId: "call-1", startedOrdinal: 2 }), live("job-1", "partial")),
		]);
		const status = new WorkStatus(() => source);
		const single = text(status);
		expect(single).toMatch(/^Work · ● running · job · audit · read src\/auth\.ts\s+(?:Alt|Option)\+J$/);
		expect(single).not.toContain("· +");
		expectFits(status, 1);
		// Past two items, the group says how many more it holds.
		source.views = [1, 2, 3, 4].map((n) =>
			view(
				item(`agent-${n}`, { kind: "subagent", title: `scout ${n}`, toolCallId: "call-p", startedOrdinal: n }),
				n === 4 ? {} : live(`agent-${n}`, `step ${n}`),
			),
		);
		expect(text(status)).toMatch(/^Work · ● running · subagent · scout 1 · step 3 · \+3\s+(?:Alt|Option)\+J$/);
		expectFits(status, 1);
	});

	it("shows a group's most active state and its elapsed time, whichever item started first", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(100_000);
		const child = (
			n: number,
			workOverrides: Partial<ClientWorkItem> = {},
			viewOverrides: Partial<WorkItemView> = {},
		) =>
			view(
				item(`agent-${n}`, {
					kind: "subagent",
					title: `scout ${n}`,
					resume: true,
					toolCallId: "call-p",
					startedOrdinal: n,
					...workOverrides,
				}),
				{ startedAt: 90_000 + n * 1_000, ...viewOverrides },
			);
		// A parallel call's children after a restart, the newer one resumed.
		const source = new FakeSource([
			child(1, {}, { suspended: true }),
			child(2, {}, live("agent-2", "read a.ts")),
			child(3, {}, { suspended: true }),
		]);
		const status = new WorkStatus(() => source, { terminalRows: () => 24 });
		expect(text(status)).toMatch(
			/^Work · ● running · subagent · scout 1 · 8\.0s · read a\.ts · \+2\s+(?:Alt|Option)\+J$/,
		);
		// The counts and the rows take the same state.
		source.views.push(view(item("job-1", { title: "npm test", startedOrdinal: 4 })));
		expect(text(status).split("\n")).toEqual([
			expect.stringMatching(/^Work · 2 running\s+(?:Alt|Option)\+J$/),
			"  ● · subagent · scout 1 · 8.0s · read a.ts · +2",
			"  ● · job · npm test",
		]);
		// Cancelling only the oldest child leaves the group running.
		source.views = [child(1, { state: "cancelling" }), child(2)];
		expect(text(status)).toMatch(/^Work · ● running · subagent · scout 1 · 8\.0s\s+(?:Alt|Option)\+J$/);
		// Cancelling counts before suspended.
		source.views = [child(1, {}, { suspended: true }), child(2, { state: "cancelling" })];
		expect(text(status)).toMatch(/^Work · ◌ cancelling · subagent · scout 1 · 8\.0s\s+(?:Alt|Option)\+J$/);
	});

	it("shows several groups as counts per state, then one row each", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(100_000);
		const source = new FakeSource([
			view(item("job-2", { title: "sleep 120", startedOrdinal: 5 }), { startedAt: 95_000 }),
			view(
				item("agent-1", { kind: "subagent", title: "general: audit", toolCallId: "call-1", startedOrdinal: 4 }),
				live("agent-1", "grep TODO"),
			),
			view(item("job-1", { title: "audit", toolCallId: "call-1", startedOrdinal: 3 })),
			view(
				item("action-1", {
					kind: "host_action",
					title: "Install rust-analyzer",
					state: "awaiting_approval",
					startedOrdinal: 2,
				}),
			),
		]);
		const status = new WorkStatus(() => source, { terminalRows: () => 24 });
		const lines = text(status).split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatch(/^Work · 2 running · 1 awaiting approval\s+/);
		expect(lines[0]).toMatch(HINT);
		expect(lines.slice(1)).toEqual([
			"  ● · job · sleep 120 · 5.0s",
			"  ● · job · audit · grep TODO",
			"  ? awaiting approval · host_action · Install rust-analyzer",
		]);
		expectFits(status, 4);
		// Without the terminal's height, several groups show as rows too.
		expect(new WorkStatus(() => source).render(80).lines).toHaveLength(4);
	});

	it("shows two rows and how many more groups there are past three", () => {
		const source = new FakeSource(
			[5, 4, 3, 2, 1].map((n) => view(item(`job-${n}`, { title: `job ${n}`, startedOrdinal: n }))),
		);
		const status = new WorkStatus(() => source, { terminalRows: () => 24 });
		const lines = text(status).split("\n");
		expect(lines[0]).toMatch(/^Work · 5 running\s+(?:Alt|Option)\+J$/);
		expect(lines.slice(1)).toEqual(["  ● · job · job 5", "  ● · job · job 4", "  +3 more"]);
		expectFits(status, 4);
	});

	it("shows only the counts on a terminal shorter than the list needs", () => {
		let rows = 19;
		const source = new FakeSource([
			view(item("job-1", { title: "npm test", startedOrdinal: 2 })),
			view(item("agent-1", { kind: "subagent", title: "scout", resume: true, startedOrdinal: 1 }), {
				suspended: true,
			}),
		]);
		const status = new WorkStatus(() => source, { terminalRows: () => rows });
		expect(text(status)).toMatch(/^Work · 1 running · 1 suspended\s+(?:Alt|Option)\+J$/);
		expectFits(status, 1);
		rows = 20;
		expect(text(status).split("\n")).toEqual([
			expect.stringMatching(/^Work · 1 running · 1 suspended\s+(?:Alt|Option)\+J$/),
			"  ● · job · npm test",
			"  ‖ suspended · subagent · scout",
		]);
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
