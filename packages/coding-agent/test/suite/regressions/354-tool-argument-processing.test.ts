import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Text, type TUI } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../../src/core/extensions/types.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { STREAMING_RENDER_INTERVAL_MS } from "../../../src/modes/interactive/components/streaming-render-coalescer.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { createHarness } from "../harness.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

describe("tool argument processing (#354)", () => {
	it("executes a large valid edit exactly once with unchanged Unicode and newline bytes", async () => {
		const harness = await createHarness({ tools: [createEditTool(process.cwd())] });
		try {
			const path = join(harness.tempDir, "large.txt");
			const newText = 'λ🌲\nline with "quote" and a backslash \\\n'.repeat(2048);
			await writeFile(path, "before", "utf8");
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("edit", { path, oldText: "before", newText }, { id: "large-edit" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Edited."),
			]);
			await harness.session.prompt("Apply the edit.");
			expect(await readFile(path)).toEqual(Buffer.from(newText));
			expect(harness.eventsOfType("tool_execution_start")).toHaveLength(1);
			expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
			expect(harness.eventsOfType("tool_execution_end")[0]).toMatchObject({
				toolCallId: "large-edit",
				isError: false,
			});
			const deltas = harness
				.eventsOfType("message_update")
				.flatMap((event) =>
					event.assistantMessageEvent.type === "toolcall_delta" ? [event.assistantMessageEvent.argsTextDelta] : [],
				);
			expect(deltas.join("")).toBe(JSON.stringify({ path, oldText: "before", newText }));
		} finally {
			await harness.cleanupAsync();
		}
	});

	it("bounds preview renders per tool and flushes the latest arguments at completion", () => {
		vi.useFakeTimers();
		const rendered: unknown[] = [];
		const definition: ToolDefinition = {
			name: "preview",
			label: "preview",
			description: "preview",
			parameters: Type.Object({ text: Type.String() }),
			execute: async () => ({ content: [], details: {} }),
			renderCall: (args) => {
				rendered.push(args);
				return new Text("preview", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"preview",
			"call-1",
			{},
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		try {
			for (let index = 0; index < 1000; index++) component.updateArgs({ text: String(index) });
			expect(rendered).toEqual([{}, { text: "0" }]);
			vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS);
			expect(rendered.at(-1)).toEqual({ text: "999" });
			component.updateArgs({ text: "final" });
			component.setArgsComplete();
			expect(rendered.at(-1)).toEqual({ text: "final" });
			const count = rendered.length;
			vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS * 2);
			expect(rendered).toHaveLength(count);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			component.dispose();
		}
	});

	it("cancels queued previews on disposal and shows failures immediately", () => {
		vi.useFakeTimers();
		const renderCall = vi.fn(() => new Text("preview", 0, 0));
		const definition: ToolDefinition = {
			name: "preview",
			label: "preview",
			description: "preview",
			parameters: Type.Object({}),
			execute: async () => ({ content: [], details: {} }),
			renderCall,
		};
		const component = new ToolExecutionComponent(
			"preview",
			"call-1",
			{},
			{},
			definition,
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateArgs({ step: 1 });
		component.updateArgs({ step: 2 });
		component.updateResult({ content: [{ type: "text", text: "Stopped" }], isError: true });
		expect(component.render(80).lines.join("\n")).toContain("[failure]");
		component.dispose();
		const count = renderCall.mock.calls.length;
		vi.advanceTimersByTime(STREAMING_RENDER_INTERVAL_MS * 2);
		expect(renderCall).toHaveBeenCalledTimes(count);
		expect(vi.getTimerCount()).toBe(0);
	});
});
