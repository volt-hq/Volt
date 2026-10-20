import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { ToolPresentation } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditTool } from "../../../src/core/tools/edit.ts";
import { HOST_UI_POLICY, type PresenterSet, type ToolPresenter } from "../../../src/core/ui/presentation.ts";
import {
	ArgumentPresentations,
	PRESENTATION_COALESCE_MS,
	ToolPresentationState,
} from "../../../src/core/ui/presentation-state.ts";
import { createHarness } from "../harness.ts";

/** Host presenters for the preview tool. */
function presenters(present: ToolPresenter): PresenterSet {
	return {
		generation: 0,
		tool: () => ({ present, policy: HOST_UI_POLICY }),
		message: () => undefined,
	};
}
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

	it("bounds host preview presentations per tool and flushes the latest arguments at completion", () => {
		vi.useFakeTimers();
		const present = vi.fn<ToolPresenter>((input) => ({ title: `preview ${String(input.args.text)}` }));
		const published = vi.fn<(id: string, presentation: ToolPresentation) => void>();
		const state = new ArgumentPresentations({
			presenters: () => presenters(present),
			cwd: () => process.cwd(),
			publish: published,
		});
		try {
			for (let index = 0; index < 1000; index++) state.update("call", "preview", { text: String(index) }, false);
			expect(present).toHaveBeenCalledTimes(1);
			expect(published).toHaveBeenLastCalledWith("call", { title: "preview 0" });
			vi.advanceTimersByTime(PRESENTATION_COALESCE_MS);
			expect(present).toHaveBeenCalledTimes(2);
			expect(published).toHaveBeenLastCalledWith("call", { title: "preview 999" });
			state.update("call", "preview", { text: "queued" }, false);
			state.update("call", "preview", { text: "final" }, true);
			expect(present).toHaveBeenLastCalledWith(
				expect.objectContaining({ args: { text: "final" }, argsComplete: true, state: "pending" }),
			);
			expect(published).toHaveBeenLastCalledWith("call", { title: "preview final" });
			vi.advanceTimersByTime(PRESENTATION_COALESCE_MS * 2);
			expect(present).toHaveBeenCalledTimes(3);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			state.close();
		}
	});

	it.each(["clear", "close"] as const)("drops queued host argument previews on %s", (action) => {
		vi.useFakeTimers();
		const publish = vi.fn();
		const state = new ArgumentPresentations({
			presenters: () => presenters((input) => ({ title: `step ${String(input.args.step)}` })),
			cwd: () => process.cwd(),
			publish,
		});
		state.update("call", "preview", { step: 1 }, false);
		state.update("call", "preview", { step: 2 }, false);
		state[action]();
		vi.advanceTimersByTime(PRESENTATION_COALESCE_MS * 2);
		expect(publish).toHaveBeenCalledExactlyOnceWith("call", { title: "step 1" });
		expect(vi.getTimerCount()).toBe(0);
		state.close();
	});

	it("presents a host-side failure immediately and drops the queued partial result", () => {
		vi.useFakeTimers();
		const update = vi.fn();
		const state = new ToolPresentationState({
			presenters: () => presenters((input) => ({ title: input.result?.isError ? "Stopped" : "preview" })),
			cwd: () => process.cwd(),
			held: () => ({ title: "preview" }),
			update,
		});
		state.start("call", "preview", {});
		state.update("call", { content: [{ type: "text", text: "partial" }] });
		expect(state.end("call", "preview", {}, { content: [{ type: "text", text: "Stopped" }], isError: true })).toEqual(
			{ presentation: { title: "Stopped" } },
		);
		vi.advanceTimersByTime(PRESENTATION_COALESCE_MS * 2);
		expect(update).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		state.close();
	});
});
