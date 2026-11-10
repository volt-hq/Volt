import { type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	boltSeparation,
	LoadingScreenComponent,
	rasterizeBolt,
} from "../src/modes/interactive/components/loading-screen.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** The loop's phases, as the app times them: apart, the snap, joined, and the drift apart. */
const SNAP_START_MS = 350;
const JOINED_MS = 350 + 1150;
const DRIFT_START_MS = 350 + 1150 + 1100;
const CYCLE_MS = 3150;

function screenOf(rows: number): { ui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { ui: { terminal: { rows }, requestRender } as unknown as TUI, requestRender };
}

/** The columns a half's pixels span in a pixel map. */
function columnsOf(pixels: readonly string[], pixel: string): { first: number; last: number } {
	const columns = pixels.flatMap((row) => [...row].flatMap((cell, column) => (cell === pixel ? [column] : [])));
	return { first: Math.min(...columns), last: Math.max(...columns) };
}

describe("the loading screen's bolt", () => {
	it("holds its halves apart, snaps them together past joined, holds, and eases apart again", () => {
		expect(boltSeparation(0)).toBe(1);
		expect(boltSeparation(SNAP_START_MS - 1)).toBe(1);

		const snap = Array.from({ length: 115 }, (_, index) => boltSeparation(SNAP_START_MS + index * 10));
		expect(snap[0]).toBe(1);
		// The spring overshoots: the halves press together before they settle.
		expect(Math.min(...snap)).toBeLessThan(-0.03);
		expect(Math.min(...snap)).toBeGreaterThan(-0.1);
		expect(boltSeparation(JOINED_MS)).toBeCloseTo(0, 1);
		expect(boltSeparation(DRIFT_START_MS - 1)).toBeCloseTo(0, 2);

		const drift = Array.from({ length: 56 }, (_, index) => boltSeparation(DRIFT_START_MS + index * 10));
		expect(drift[0]).toBeCloseTo(0, 2);
		for (let index = 1; index < drift.length; index++) {
			expect(drift[index]!).toBeGreaterThanOrEqual(drift[index - 1]!);
		}
		expect(boltSeparation(CYCLE_MS - 1)).toBeCloseTo(1, 2);
		// It loops.
		expect(boltSeparation(CYCLE_MS + 900)).toBe(boltSeparation(900));
	});

	it("draws both halves, further from each other the more they part", () => {
		const joined = rasterizeBolt(0, 40);
		const apart = rasterizeBolt(1, 40);
		for (const pixels of [joined, apart]) {
			expect(pixels).toHaveLength(40);
			expect(new Set(pixels.map((row) => row.length)).size).toBe(1);
			expect(pixels.join("")).toMatch(/d/);
			expect(pixels.join("")).toMatch(/l/);
		}
		// The dark half moves right and up, the light half left and down.
		expect(columnsOf(apart, "d").last).toBeGreaterThan(columnsOf(joined, "d").last);
		expect(columnsOf(apart, "l").first).toBeLessThan(columnsOf(joined, "l").first);
		expect(apart.findIndex((row) => row.includes("d"))).toBeLessThan(joined.findIndex((row) => row.includes("d")));
		// Apart, no row holds both halves: joined, they meet on one.
		expect(apart.some((row) => row.includes("d") && row.includes("l"))).toBe(false);
		expect(joined.some((row) => row.includes("d") && row.includes("l"))).toBe(true);
	});
});

describe("LoadingScreenComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fills the terminal's rows with the bolt over its message and what the TUI waits for", () => {
		const { ui } = screenOf(30);
		const screen = new LoadingScreenComponent(ui);
		screen.start("Starting Volt");
		try {
			screen.setDetail("Starting daemon... (3s)");
			const lines = screen.render(100).lines;
			expect(lines).toHaveLength(30);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			const text = lines.map(stripAnsi);
			const message = text.findIndex((line) => line.includes("Starting Volt"));
			expect(text[message + 1]).toContain("Starting daemon... (3s)");
			// The bolt is above the message, and both are centered.
			const bolt = text.slice(0, message).filter((line) => /[▀▄█]/.test(line));
			expect(bolt.length).toBeGreaterThanOrEqual(10);
			expect(text[message]!.indexOf("Starting Volt")).toBe(Math.floor((100 - "Starting Volt".length) / 2));
		} finally {
			screen.stop();
		}
	});

	it("shows its message alone where the terminal is too low for the bolt", () => {
		const { ui } = screenOf(6);
		const screen = new LoadingScreenComponent(ui);
		screen.start("Starting a new session");
		try {
			const text = screen.render(40).lines.map(stripAnsi);
			expect(text).toHaveLength(6);
			expect(text.join("\n")).toContain("Starting a new session");
			expect(text.join("\n")).not.toMatch(/[▀▄█]/);
		} finally {
			screen.stop();
		}
	});

	it("animates from the snap: it asks for a render as the halves move, and none once stopped", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const { ui, requestRender } = screenOf(30);
		const screen = new LoadingScreenComponent(ui);
		screen.start("Starting Volt");
		const apart = screen.render(100).lines;

		// The halves are already closing a fifth of a second in, and have joined after the snap.
		vi.advanceTimersByTime(200);
		expect(requestRender).toHaveBeenCalled();
		expect(screen.render(100).lines).not.toEqual(apart);
		vi.advanceTimersByTime(1300);
		const joined = screen.render(100).lines;
		expect(joined).not.toEqual(apart);

		// Nothing moves while the halves hold joined.
		requestRender.mockClear();
		vi.advanceTimersByTime(300);
		expect(requestRender).not.toHaveBeenCalled();
		expect(screen.render(100).lines).toEqual(joined);

		screen.stop();
		vi.advanceTimersByTime(3000);
		expect(requestRender).not.toHaveBeenCalled();
	});
});
