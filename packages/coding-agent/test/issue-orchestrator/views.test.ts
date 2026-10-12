/**
 * What the issue orchestrator shows: a panel with a row per issue, those
 * that need someone first, the rest counted; actions to open running agents,
 * refresh, and stop; rendered in the TUI, within a panel's rows with its
 * actions in view. Its work's progress lists the issues as steps, within
 * what a live work value holds.
 */

import type { UiCardNode, UiNode, UiTableNode } from "@hansjm10/volt-protocol";
import { setCapabilities, setKeybindings } from "@hansjm10/volt-tui";
import { beforeEach, describe, expect, it } from "vitest";
import type { OrchestratorSnapshot } from "../../examples/extensions/issue-orchestrator/orchestrator.ts";
import { issueSteps, panel } from "../../examples/extensions/issue-orchestrator/views.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { initTheme } from "../../src/core/theme/runtime.ts";
import { DEFAULT_PANEL_MAX_ROWS, UiPanels } from "../../src/modes/interactive/ui-node/panels.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const COMMAND = "extension.command.issue-orchestrator.orchestrate";
const NOW = 10_000_000;

function snapshot(overrides: Partial<OrchestratorSnapshot> = {}): OrchestratorSnapshot {
	return {
		repo: "o/r",
		running: [
			{ issue: 1, title: "Implement it", role: "implement", runId: "sa_1", startedAt: NOW - 23 * 60_000 },
			{ issue: 2, title: "Set up", role: "review", startedAt: NOW },
		],
		retrying: [{ issue: 3, title: "Flaky", failures: 2, dueAt: NOW + 1_000, error: "provider overloaded" }],
		waiting: [
			{ issue: 4, title: "Checks", reason: "CI checks are running" },
			// Due a retry and waiting for a slot: shown once, as retrying.
			{ issue: 3, title: "Flaky", reason: "waiting for a free agent slot" },
		],
		handedOff: [
			{ issue: 5, title: "Approved", reason: "Pull request #105 was reviewed clean.", ready: true },
			{ issue: 6, title: "Stuck", reason: "did not converge", ready: false },
		],
		finished: [{ issue: 7, title: "Merged", reason: "merged pull request #107" }],
		totals: { runs: 9, tokens: 100, cost: 3.5 },
		...overrides,
	};
}

function card(value: OrchestratorSnapshot): UiCardNode {
	const node = panel(value, COMMAND, NOW).node;
	if (node.type !== "card") throw new Error(`expected a card, got ${node.type}`);
	return node;
}

function children(node: UiCardNode): UiNode[] {
	return node.sections?.flatMap((section) => section.children) ?? [];
}

function table(node: UiCardNode): UiTableNode {
	const found = children(node).find((child): child is UiTableNode => child.type === "table");
	if (!found) throw new Error("no table");
	return found;
}

/** A styled cell as plain text. */
function plain(cell: UiTableNode["rows"][number]["cells"][number]): string {
	return typeof cell === "string" ? cell : cell.map((span) => span.text).join("");
}

describe("issue orchestrator work progress", () => {
	it("lists every issue as a step, in the panel's order, its status in the step's", () => {
		expect(issueSteps(snapshot(), NOW)).toEqual([
			{ key: "1", label: "#1 Implement it · implementing · for 23m", status: "active" },
			{ key: "2", label: "#2 Set up · reviewing · setting up its checkout", status: "active" },
			{ key: "6", label: "#6 Stuck · needs you · did not converge", status: "failed" },
			{ key: "5", label: "#5 Approved · ready to merge · Pull request #105 was reviewed clean.", status: "done" },
			{ key: "3", label: "#3 Flaky · retrying · 2 failures: provider overloaded", status: "pending" },
			{ key: "4", label: "#4 Checks · waiting · CI checks are running", status: "pending" },
			{ key: "7", label: "#7 Merged · done · merged pull request #107", status: "done" },
		]);
	});

	it("counts the issues past what a live work value holds in a last step", () => {
		const many = (count: number, title: string) =>
			Array.from({ length: count }, (_, index) => ({
				issue: 100 + index,
				title,
				reason: "waiting for a free agent slot",
			}));
		const capped = issueSteps(
			snapshot({ running: [], retrying: [], handedOff: [], finished: [], waiting: many(40, "T") }),
			NOW,
		);
		expect(capped).toHaveLength(30);
		expect(capped.at(-1)).toEqual({ key: "more", label: "+11 more: 11 waiting", status: "pending" });

		// Long titles in a script of multi-byte characters fill the bytes before the count.
		const wide = issueSteps(
			snapshot({ running: [], retrying: [], handedOff: [], finished: [], waiting: many(40, "試".repeat(200)) }),
			NOW,
		);
		expect(wide.length).toBeLessThan(30);
		expect(wide.at(-1)).toMatchObject({
			key: "more",
			label: `+${41 - wide.length} more: ${41 - wide.length} waiting`,
		});
		expect(Buffer.byteLength(JSON.stringify({ text: "x".repeat(2_000), steps: wide }))).toBeLessThan(8 * 1024);
	});
});

describe("issue orchestrator panel", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	});

	it("lists running issues first, then those for a human, and counts the ones past its room", () => {
		const node = card(snapshot());
		expect(node.title).toBe("Issue orchestrator · o/r");
		expect(node.badges).toEqual([
			{ label: "2 running", token: "accent" },
			{ label: "1 needs you", token: "warning" },
			{ label: "1 ready", token: "success" },
			{ label: "$3.50", token: "muted" },
		]);
		expect(table(node).rows.map((row) => row.cells.map(plain))).toEqual([
			["#1 Implement it", "● implementing", "for 23m"],
			["#2 Set up", "● reviewing", "setting up its checkout"],
			["#6 Stuck", "▲ needs you", "did not converge"],
			["#5 Approved", "✓ ready to merge", "Pull request #105 was reviewed clean."],
			["#3 Flaky", "↻ retrying", "2 failures: provider overloaded"],
		]);
		expect(children(node).at(-1)).toMatchObject({ type: "text", text: "+2 more: 1 waiting, 1 done" });
	});

	it("opens running agents, refreshes, and stops", () => {
		expect(card(snapshot()).actions).toEqual([
			{ id: "open-1", label: "Open #1", intent: { type: "open_work", input: { workId: "sa_1" } } },
			{ id: "refresh", label: "Refresh", intent: { type: COMMAND, input: { arguments: "refresh" } } },
			{ id: "stop", label: "Stop", destructive: true, intent: { type: COMMAND, input: { arguments: "stop" } } },
		]);
	});

	it("says when no issue needs work, and why a tick failed", () => {
		const idle = card(
			snapshot({ running: [], retrying: [], waiting: [], handedOff: [], finished: [], error: "GitHub: down" }),
		);
		expect(children(idle)).toEqual([
			{ type: "text", key: "error", text: [{ text: "✗ GitHub: down", token: "error" }] },
			{ type: "text", key: "idle", text: "No labeled issues need work.", token: "muted" },
		]);
		expect(idle.badges?.map((badge) => badge.label)).toEqual(["0 running", "$3.50"]);
	});

	it("keeps its actions in view within a terminal panel's rows", () => {
		const many = Array.from({ length: 20 }, (_, index) => ({
			issue: 100 + index,
			title: `Issue ${100 + index} with a title long enough to be cut`,
			reason: "waiting for a free agent slot",
		}));
		const worst = snapshot({ waiting: many, error: `GitHub: ${"unavailable ".repeat(40)}` });
		for (const width of [60, 80, 120]) {
			const panels = new UiPanels({ mode: () => "regular" });
			const value = panel(worst, COMMAND, NOW);
			panels.set("orchestrator", { placement: "aboveEditor", node: value.node });
			const lines = panels.aboveEditor.render(width).lines.map((line) => stripAnsi(line).trimEnd());
			expect(lines.length).toBeLessThanOrEqual(DEFAULT_PANEL_MAX_ROWS);
			expect(lines.some((line) => line.includes("more rows"))).toBe(false);
			expect(lines.at(-2)).toContain("[ Stop ]");
			expect(lines).toContainEqual(expect.stringContaining("+23 more: 1 ready, 1 retrying, 20 waiting, 1 done"));
		}
	});
});
