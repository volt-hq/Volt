import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SubagentActivity, SubagentEvent } from "../src/core/subagents/index.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	type SubagentActivitySource,
	SubagentInspectorComponent,
} from "../src/modes/interactive/components/subagent-inspector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

class TestActivitySource implements SubagentActivitySource {
	activities: SubagentActivity[];
	private readonly listeners = new Set<() => void>();

	constructor(activities: SubagentActivity[]) {
		this.activities = activities;
	}

	listActivities(): readonly SubagentActivity[] {
		return this.activities;
	}

	subscribeActivities(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(): void {
		for (const listener of this.listeners) listener();
	}
}

function event(sequence: number, value: SubagentEvent): SubagentActivity["events"][number] {
	return { sequence, timestamp: 1_000 + sequence, event: value };
}

function messageEvent(type: "message_start" | "message_end", role: "user" | "assistant", text: string): SubagentEvent {
	return {
		type,
		message: {
			role,
			content: [{ type: "text", text }],
		},
	} as SubagentEvent;
}

function createActivity(overrides: Partial<SubagentActivity> = {}): SubagentActivity {
	return {
		id: "sa_scout",
		sessionId: "session_scout",
		agent: { name: "scout", source: "user" },
		task: "Inspect the auth flow and report risks",
		status: "completed",
		startedAt: 1_000,
		updatedAt: 2_000,
		finishedAt: 2_000,
		abortRequested: false,
		events: [
			event(0, messageEvent("message_start", "user", "Inspect the auth flow and report risks")),
			event(1, messageEvent("message_end", "user", "Inspect the auth flow and report risks")),
			event(2, messageEvent("message_start", "assistant", "I will inspect the relevant files.")),
			event(3, messageEvent("message_end", "assistant", "I will inspect the relevant files.")),
			event(4, {
				type: "tool_execution_start",
				toolCallId: "read-1",
				toolName: "read",
				args: { path: "src/auth.ts" },
			}),
			event(5, {
				type: "tool_execution_end",
				toolCallId: "read-1",
				toolName: "read",
				result: { content: [{ type: "text", text: "export function authenticate()" }] },
				isError: false,
			}),
			event(6, messageEvent("message_start", "assistant", "The auth flow lacks replay protection.")),
			event(7, messageEvent("message_end", "assistant", "The auth flow lacks replay protection.")),
		],
		droppedEvents: 0,
		transcript: [],
		...overrides,
	};
}

function createFakeTui(rows = 40): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return {
		tui: {
			terminal: { rows },
			requestRender,
		} as unknown as TUI,
		requestRender,
	};
}

describe("SubagentInspectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("navigates from the activity list into conversation and tool flow", () => {
		const source = new TestActivitySource([createActivity()]);
		const { tui } = createFakeTui();
		const close = vi.fn();
		const inspector = new SubagentInspectorComponent(source, tui, close);

		const list = stripAnsi(inspector.render(100).join("\n"));
		expect(list).toContain("Subagents");
		expect(list).toContain("scout (user)");
		expect(list).toContain("Inspect the auth flow");
		expect(list).toContain("completed");

		inspector.handleInput("\r");
		const detail = stripAnsi(inspector.render(100).join("\n"));
		expect(detail).toContain("Subagents / scout");
		expect(detail).toContain("Assistant");
		expect(detail).toContain("I will inspect the relevant files.");
		expect(detail).toContain("read");
		expect(detail).toContain("src/auth.ts");
		expect(detail).toContain("export function authenticate()");
		expect(detail).toContain("The auth flow lacks replay protection.");

		inspector.handleInput("\x1b");
		expect(stripAnsi(inspector.render(100).join("\n"))).toContain("1 this session");
		inspector.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});

	it("refreshes an open running activity as new events arrive", () => {
		const running = createActivity({
			status: "running",
			finishedAt: undefined,
			events: [event(0, messageEvent("message_start", "user", "Inspect the auth flow and report risks"))],
		});
		const source = new TestActivitySource([running]);
		const { tui, requestRender } = createFakeTui(16);
		const inspector = new SubagentInspectorComponent(source, tui, () => {});
		inspector.handleInput("\r");

		source.activities = [
			createActivity({
				status: "completed",
				events: [
					...running.events,
					event(1, messageEvent("message_end", "user", "Inspect the auth flow and report risks")),
					event(2, messageEvent("message_start", "assistant", "Live result arrived")),
					event(3, messageEvent("message_end", "assistant", "Live result arrived")),
				],
			}),
		];
		source.emit();

		expect(requestRender).toHaveBeenCalled();
		const rendered = stripAnsi(inspector.render(80).join("\n"));
		expect(rendered).toContain("completed");
		expect(rendered).toContain("Live result arrived");
	});

	it("clips list and detail rendering to narrow terminals", () => {
		const source = new TestActivitySource([
			createActivity({
				task: "A very long delegated task with enough text to overflow a narrow terminal several times",
			}),
		]);
		const { tui } = createFakeTui(12);
		const inspector = new SubagentInspectorComponent(source, tui, () => {});

		for (const line of inspector.render(24)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
		inspector.handleInput("\r");
		for (const line of inspector.render(24)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		}
	});
});
