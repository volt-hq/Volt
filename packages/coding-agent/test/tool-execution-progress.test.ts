import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("live tool progress", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());
	it.each([
		{
			toolName: "write",
			args: { path: "file.ts", content: "const value = 1;" },
			generating: "Generating content",
			executing: "Writing file",
		},
		{ toolName: "edit", args: { path: "file.ts" }, generating: "Generating edits", executing: "Applying edits" },
		{ toolName: "read", args: { path: "file.ts" }, generating: "Generating arguments", executing: "Executing" },
		{ toolName: "bash", args: { command: "echo hello" }, generating: "Generating arguments", executing: "Executing" },
		{ toolName: "custom_tool", args: {}, generating: "Generating arguments", executing: "Executing" },
	])(
		"distinguishes generation, queueing, and execution for $toolName",
		({ toolName, args, generating, executing }) => {
			vi.useFakeTimers();
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				toolName,
				"call",
				args,
				{ liveProgress: true },
				undefined,
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			try {
				vi.advanceTimersByTime(2000);
				expect(stripAnsi(component.render(80).lines.join("\n"))).toContain(`[streaming] ${generating} · 2.0s`);
				expect(requestRender).toHaveBeenCalledTimes(2);
				component.setArgsComplete();
				expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[queued] Waiting to run · 0.0s");
				vi.advanceTimersByTime(1000);
				component.setArgsComplete();
				expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[queued] Waiting to run · 1.0s");
				component.markExecutionStarted();
				vi.advanceTimersByTime(1000);
				expect(stripAnsi(component.render(80).lines.join("\n"))).toContain(`[running] ${executing} · 1.0s`);
				component.updateResult({ content: [{ type: "text", text: "working" }], isError: false }, true);
				vi.advanceTimersByTime(1000);
				const partial = stripAnsi(component.render(80).lines.join("\n"));
				expect(partial).toContain(`[running] ${executing} · 2.0s`);
				expect(partial).not.toContain("[partial]");
				component.updateResult({ content: [], isError: false });
				const calls = requestRender.mock.calls.length;
				vi.advanceTimersByTime(5000);
				expect(requestRender).toHaveBeenCalledTimes(calls);
				expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[success]");
			} finally {
				component.dispose();
			}
		},
	);
	it("labels a growing write preview as generation until execution begins", () => {
		vi.useFakeTimers();
		const component = new ToolExecutionComponent(
			"write",
			"call",
			{ path: "story.txt", content: "First line" },
			{ liveProgress: true },
			undefined,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		try {
			component.updateArgs({ path: "story.txt", content: "First line\nSecond line" });
			vi.advanceTimersByTime(1000);
			const preview = stripAnsi(component.render(80).lines.join("\n"));
			expect(preview).toContain("Second line");
			expect(preview).toContain("[streaming] Generating content");
			expect(preview).not.toContain("Writing file");
			expect(preview).not.toContain("[pending]");

			for (const phase of [
				{ status: "[streaming] Generating content", transition: () => {} },
				{ status: "[queued] Waiting to run", transition: () => component.setArgsComplete() },
				{ status: "[running] Writing file", transition: () => component.markExecutionStarted() },
			]) {
				phase.transition();
				for (const width of [20, 32, 80, 140]) {
					const lines = component.render(width).lines;
					for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					const text = lines.map(stripAnsi).join(" ").replace(/\s+/g, " ");
					expect(text).toContain("story.txt");
					expect(text).toContain(phase.status);
				}
			}
		} finally {
			component.dispose();
		}
	});

	it("does not animate historical calls as live generation", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"write",
			"call",
			{ path: "story.txt", content: "A story" },
			{},
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		try {
			vi.advanceTimersByTime(5000);
			expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[pending]");
			component.updateResult({ content: [], isError: false });
			const completed = stripAnsi(component.render(80).lines.join("\n"));
			expect(completed).toContain("[success]");
			expect(completed).not.toContain("Generating");
			expect(requestRender).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
		}
	});

	it("marks preparation failures never-started and stops ticking on disposal", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"edit",
			"call",
			{},
			{ liveProgress: true },
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [], isError: true });
		expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[failure] · not started");
		component.dispose();
		vi.advanceTimersByTime(5000);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
