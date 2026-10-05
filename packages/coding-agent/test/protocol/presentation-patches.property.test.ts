/**
 * Live presentation patches (RFC §8.3): a client that applies a running
 * call's presentation changes in order holds the presentation the host
 * computed last, through the live fold, whatever the output's chunking.
 */

import type { LiveItem, ToolPresentation } from "@hansjm10/volt-protocol";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	emptyLiveFold,
	foldLiveItems,
	LivePatchError,
	liveStreamingItems,
	patchToolPresentation,
} from "../../src/core/protocol/live-fold.ts";
import { presentBash } from "../../src/core/tools/presenters.ts";
import { type PresenterSet, presentToolCall, type ToolPresentInput } from "../../src/core/ui/presentation.ts";
import { presentationChange, ToolPresentationState } from "../../src/core/ui/presentation-state.ts";

const BASH: PresenterSet = {
	generation: 0,
	tool: () => ({ present: presentBash, policy: { owner: "host" } }),
	message: () => undefined,
};

function bashInput(text: string, done: boolean, omitted = 0): ToolPresentInput {
	return {
		args: { command: "build" },
		argsComplete: true,
		state: done ? "done" : "running",
		result: {
			content: [{ type: "text", text }],
			...(omitted > 0
				? {
						details: {
							truncation: {
								truncated: true,
								totalLines: omitted + text.split("\n").length,
								outputLines: text.split("\n").length,
							},
						},
					}
				: {}),
			isError: false,
			partial: !done,
		},
		cwd: "/workspace",
	};
}

/** Output as successive snapshots: each chunk appended, the newest `keep` lines retained, as the bash tool keeps them. */
function snapshots(chunks: readonly string[], keep: number): { text: string; omitted: number }[] {
	let output = "";
	return chunks.map((chunk) => {
		output += chunk;
		const lines = output.split("\n");
		const omitted = Math.max(0, lines.length - keep);
		return { text: lines.slice(omitted).join("\n"), omitted };
	});
}

const chunk = fc
	.array(
		fc.oneof(
			fc.constantFrom("\n", "\n\n"),
			fc.stringMatching(/^[a-z0-9 ]{1,12}$/),
			fc.constantFrom("\x1b[31merr\x1b[0m"),
		),
		{
			minLength: 1,
			maxLength: 6,
		},
	)
	.map((parts) => parts.join(""));

describe("live presentation patches", () => {
	afterEach(() => vi.useRealTimers());

	it("applied in order, streaming changes give the final presentation", () => {
		fc.assert(
			fc.property(
				fc.array(chunk, { minLength: 1, maxLength: 25 }),
				fc.integer({ min: 3, max: 40 }),
				(chunks, keep) => {
					let held: ToolPresentation | undefined;
					const states = snapshots(chunks, keep);
					states.forEach((state, index) => {
						const done = index === states.length - 1;
						const next = presentToolCall(
							BASH.tool("bash"),
							"bash",
							bashInput(state.text, done, state.omitted),
							64 * 1024,
						);
						const change = presentationChange(held, next);
						if (change === undefined) {
							expect(held).toEqual(next);
							return;
						}
						held =
							"presentation" in change
								? change.presentation
								: patchToolPresentation(held as ToolPresentation, change.patch);
						expect(held).toEqual(next);
					});
				},
			),
			{ numRuns: 200 },
		);
	});

	it("appends output lines instead of resending them", () => {
		const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}\n`).join("");
		const first = presentToolCall(BASH.tool("bash"), "bash", bashInput(lines(8), false), 64 * 1024);
		const next = presentToolCall(BASH.tool("bash"), "bash", bashInput(lines(10), false), 64 * 1024);
		const change = presentationChange(first, next);
		expect(change && "patch" in change ? change.patch.body : undefined).toEqual([
			{ op: "append_lines", path: ["output"], lines: ["line 8", "line 9"] },
		]);
		// The collapsed tail moves on by the same lines, counting the ones it no longer shows.
		expect(change && "patch" in change ? change.patch.summary : undefined).toEqual([
			{ op: "append_lines", path: ["tail"], lines: ["line 8", "line 9"], omittedLines: 5 },
		]);
	});

	it("coalesces a running call's partial results and folds to what the host presented", () => {
		vi.useFakeTimers();
		const items: LiveItem[] = [];
		let fold = emptyLiveFold();
		const publish = (item: LiveItem): void => {
			items.push(item);
			fold = foldLiveItems(fold, [item]);
		};
		const state = new ToolPresentationState({
			presenters: () => BASH,
			cwd: () => "/workspace",
			held: (id) => fold.tools.get(id)?.presentation,
			update: (toolCallId, toolName, change) =>
				publish({ type: "tool", op: "update", toolCallId, toolName, ...change }),
		});
		publish({
			type: "tool",
			op: "start",
			toolCallId: "c",
			toolName: "bash",
			args: { command: "build" },
			presentation: state.start("c", "bash", { command: "build" }),
		});
		let output = "";
		for (let index = 0; index < 20; index++) {
			output += `line ${index}\n`;
			state.update("c", { content: [{ type: "text", text: output }] });
			vi.advanceTimersByTime(20);
		}
		vi.advanceTimersByTime(100);
		const updates = items.filter((item) => item.type === "tool" && item.op === "update");
		// Twenty partial results in 400 ms present at most once per 100 ms.
		expect(updates.length).toBeGreaterThan(0);
		expect(updates.length).toBeLessThanOrEqual(5);
		expect(updates.every((item) => item.type === "tool" && item.patch !== undefined)).toBe(true);
		const change = state.end(
			"c",
			"bash",
			{ command: "build" },
			{ content: [{ type: "text", text: output }], isError: false },
		);
		publish({ type: "tool", op: "end", toolCallId: "c", toolName: "bash", isError: false, ...change });
		expect(fold.tools.get("c")?.presentation).toEqual(
			presentToolCall(BASH.tool("bash"), "bash", bashInput(output, true), 64 * 1024),
		);
		state.close();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("replays a patched presentation with a reset, and refuses a patch of a call it does not hold", () => {
		const first = presentToolCall(BASH.tool("bash"), "bash", bashInput("one\n", false), 64 * 1024);
		const next = presentToolCall(BASH.tool("bash"), "bash", bashInput("one\ntwo\n", false), 64 * 1024);
		const change = presentationChange(first, next);
		if (!change || !("patch" in change)) throw new Error("Expected a patch");
		const fold = foldLiveItems(emptyLiveFold(), [
			{ type: "tool", op: "start", toolCallId: "c", toolName: "bash", presentation: first },
			{ type: "tool", op: "update", toolCallId: "c", toolName: "bash", patch: change.patch },
		]);
		const replayed = foldLiveItems(emptyLiveFold(), liveStreamingItems(fold));
		expect(replayed.tools.get("c")?.presentation).toEqual(next);
		expect(() =>
			foldLiveItems(emptyLiveFold(), [
				{ type: "tool", op: "update", toolCallId: "x", toolName: "bash", patch: change.patch },
			]),
		).toThrow(LivePatchError);
	});
});
