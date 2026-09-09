import type { TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("live tool progress", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());
	it("shows preparation then execution elapsed time without changing lifecycle states", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const component = new ToolExecutionComponent(
			"edit",
			"call",
			{ path: "file.ts" },
			{ liveProgress: true },
			undefined,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);
		try {
			vi.advanceTimersByTime(2200);
			expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[pending] Preparing Edit · 2.2s");
			expect(requestRender).toHaveBeenCalledTimes(2);
			component.setArgsComplete();
			expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[pending] Ready");
			component.markExecutionStarted();
			vi.advanceTimersByTime(1100);
			expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[running] Applying Edit · 1.1s");
			component.updateResult({ content: [], isError: false });
			const calls = requestRender.mock.calls.length;
			vi.advanceTimersByTime(5000);
			expect(requestRender).toHaveBeenCalledTimes(calls);
			expect(stripAnsi(component.render(80).lines.join("\n"))).toContain("[success]");
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
