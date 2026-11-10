import {
	type Component,
	createRenderFrame,
	type RenderFrame,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { APP_NAME } from "../../../config.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { renderHalfBlocks } from "./logo.ts";

/**
 * The loop of the Volt app's loading mark (volt-hq/volt-app, VoltLogoSnapLoopTiming): the bolt's
 * halves hold apart, snap together on a spring that overshoots, hold joined, and ease apart again.
 */
const APART_HOLD_MS = 350;
const SNAP_MS = 1150;
const JOINED_HOLD_MS = 1100;
const DRIFT_MS = 550;
const CYCLE_MS = APART_HOLD_MS + SNAP_MS + JOINED_HOLD_MS + DRIFT_MS;
/** The snap's spring, as SwiftUI's `Spring(duration:bounce:)` defines one. */
const SNAP_BOUNCE = 0.32;

/** How far apart the bolt's halves are `elapsedMs` into the loop: 1 apart, 0 joined, below 0 while the snap overshoots. */
export function boltSeparation(elapsedMs: number): number {
	const phase = ((elapsedMs % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
	if (phase < APART_HOLD_MS) return 1;
	const driftStart = APART_HOLD_MS + SNAP_MS + JOINED_HOLD_MS;
	if (phase < driftStart) {
		// The spring runs on through the joined hold, where it has settled, so the two meet without a seam.
		const seconds = (phase - APART_HOLD_MS) / 1000;
		const frequency = (2 * Math.PI) / (SNAP_MS / 1000);
		const decay = (1 - SNAP_BOUNCE) * frequency;
		const damped = Math.sqrt(frequency * frequency - decay * decay);
		return Math.exp(-decay * seconds) * (Math.cos(damped * seconds) + (decay / damped) * Math.sin(damped * seconds));
	}
	// Ease in and out: the CSS cubic-bezier(0.42, 0, 0.58, 1), solved for its parameter at this progress.
	const progress = Math.min(1, (phase - driftStart) / DRIFT_MS);
	let low = 0;
	let high = 1;
	for (let i = 0; i < 20; i++) {
		const s = (low + high) / 2;
		if (1.26 * s * (1 - s) ** 2 + 1.74 * s ** 2 * (1 - s) + s ** 3 < progress) low = s;
		else high = s;
	}
	const s = (low + high) / 2;
	return 3 * s ** 2 - 2 * s ** 3;
}

type Point = readonly [x: number, y: number];

interface BoltHalf {
	/** Its pixel in the half-block pixel map: the bolt's dark or light half. */
	readonly pixel: "d" | "l";
	readonly points: readonly Point[];
	/** What it turns about as it parts: the center of its bounding box. */
	readonly center: Point;
	/** Where it sits, and how far it turns, when apart. */
	readonly apartOffset: Point;
	readonly apartDegrees: number;
}

/** The bolt's halves in the logo's 102x134 design space, as the app draws them (VoltLogo.swift). */
const BOLT_HALVES: readonly BoltHalf[] = [
	{
		pixel: "d",
		points: [
			[48.4, 62.2],
			[42.4, 4.2],
			[86.4, 70.2],
			[54.4, 70.2],
		],
		center: [64.4, 37.2],
		apartOffset: [14, -9],
		apartDegrees: 4,
	},
	{
		pixel: "l",
		points: [
			[52, 72],
			[58, 130],
			[14, 64],
			[46, 64],
		],
		center: [36, 97],
		apartOffset: [-14, 9],
		apartDegrees: -4,
	},
];

/** The design space the animation moves in: the joined bolt at its center, with room for the halves apart. */
const CANVAS = { left: -3, top: -8, width: 108, height: 150 };
/** Samples per pixel side; a pixel shows the half that covers most of it, when one covers at least half. */
const SAMPLES = 3;

function isInside(points: readonly Point[], x: number, y: number): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const [xi, yi] = points[i]!;
		const [xj, yj] = points[j]!;
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/**
 * Draw the bolt with its halves `separation` apart as a pixel map `pixelRows` high, for
 * {@link renderHalfBlocks}: "d" and "l" are its dark and light halves.
 */
export function rasterizeBolt(separation: number, pixelRows: number): string[] {
	const unitsPerPixel = CANVAS.height / pixelRows;
	const pixelColumns = Math.max(1, Math.round(CANVAS.width / unitsPerPixel));
	const halves = BOLT_HALVES.map((half) => {
		const radians = (half.apartDegrees * separation * Math.PI) / 180;
		const cos = Math.cos(radians);
		const sin = Math.sin(radians);
		return {
			pixel: half.pixel,
			points: half.points.map(([x, y]): Point => {
				const dx = x - half.center[0];
				const dy = y - half.center[1];
				return [
					half.center[0] + dx * cos - dy * sin + half.apartOffset[0] * separation,
					half.center[1] + dx * sin + dy * cos + half.apartOffset[1] * separation,
				];
			}),
		};
	});
	const rows: string[] = [];
	for (let row = 0; row < pixelRows; row++) {
		let pixels = "";
		for (let column = 0; column < pixelColumns; column++) {
			let pixel = " ";
			let most = (SAMPLES * SAMPLES) / 2;
			for (const half of halves) {
				let covered = 0;
				for (let sample = 0; sample < SAMPLES * SAMPLES; sample++) {
					const x = CANVAS.left + (column + ((sample % SAMPLES) + 0.5) / SAMPLES) * unitsPerPixel;
					const y = CANVAS.top + (row + (Math.floor(sample / SAMPLES) + 0.5) / SAMPLES) * unitsPerPixel;
					if (isInside(half.points, x, y)) covered++;
				}
				if (covered > most) {
					most = covered;
					pixel = half.pixel;
				}
			}
			pixels += pixel;
		}
		rows.push(pixels);
	}
	return rows;
}

const FRAME_INTERVAL_MS = 33;
/** The separations the animation draws between joined and apart: finer than a pixel of the largest bolt. */
const SEPARATION_STEPS = 64;
const MAX_BOLT_ROWS = 24;
/** A bolt lower than this does not read as one: the screen shows its text alone. */
const MIN_BOLT_ROWS = 6;

/**
 * The full-screen loading animation: the Volt bolt's halves parting and snapping together as the
 * app's loading mark does, centered over what the TUI waits for. It fills the terminal's rows.
 */
export class LoadingScreenComponent implements Component {
	private readonly ui: TUI;
	private message = "";
	private detail: string | undefined;
	private startedAt = 0;
	private timer: NodeJS.Timeout | undefined;
	/** The separation step the last render drew. */
	private shownStep: number | undefined;
	private cache: { key: string; lines: string[] } | undefined;

	constructor(ui: TUI) {
		this.ui = ui;
	}

	/** Start the animation at its snap, over `message`. */
	start(message: string): void {
		this.stop();
		this.message = message;
		// The loop holds its halves apart first; a load starts where they snap together.
		this.startedAt = performance.now() - APART_HOLD_MS;
		this.timer = setInterval(() => {
			if (this.step() !== this.shownStep) this.ui.requestRender();
		}, FRAME_INTERVAL_MS);
		this.timer.unref();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** What the TUI waits for meanwhile, under the message: none when undefined. */
	setDetail(detail: string | undefined): void {
		if (detail === this.detail) return;
		this.detail = detail;
		if (this.timer !== undefined) this.ui.requestRender();
	}

	invalidate(): void {
		this.cache = undefined;
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const rows = Math.max(1, this.ui.terminal.rows);
		const step = this.step();
		const key = `${width}:${rows}:${step}:${this.message}\n${this.detail ?? ""}`;
		if (this.cache?.key !== key) this.cache = { key, lines: this.compose(width, rows, step / SEPARATION_STEPS) };
		this.shownStep = step;
		return createRenderFrame(this.cache.lines);
	}

	private step(): number {
		return Math.round(boltSeparation(performance.now() - this.startedAt) * SEPARATION_STEPS);
	}

	private compose(width: number, rows: number, separation: number): string[] {
		const centered = (line: string, lineWidth = visibleWidth(line)): string =>
			" ".repeat(Math.max(0, Math.floor((width - lineWidth) / 2))) + line;
		const text = [
			theme.fg("muted", truncateToWidth(this.message, width, "")),
			...(this.detail === undefined ? [] : [theme.fg("dim", truncateToWidth(this.detail, width, ""))]),
		].map((line) => centered(line));

		// The bolt is the Volt mark: an app renamed via voltConfig.name shows its text alone. It takes most of
		// the screen's height, over a blank row and the message, as wide as its two pixels a row allow.
		const boltRows =
			APP_NAME === "volt"
				? Math.min(
						MAX_BOLT_ROWS,
						Math.floor(rows * 0.6),
						rows - 3,
						Math.floor((width * CANVAS.height) / (2 * CANVAS.width)),
					)
				: 0;
		const bolt = boltRows < MIN_BOLT_ROWS ? [] : renderHalfBlocks(rasterizeBolt(separation, boltRows * 2));
		const boltWidth = Math.round((boltRows * 2 * CANVAS.width) / CANVAS.height);
		const body = [...bolt.map((line) => centered(line, boltWidth)), ...(bolt.length > 0 ? [""] : []), ...text];

		// The bolt and the message sit in the middle; the detail hangs below without moving them.
		const top = Math.max(0, Math.floor((rows - (body.length - (text.length - 1))) / 2));
		const lines = [...Array<string>(top).fill(""), ...body].slice(0, rows);
		while (lines.length < rows) lines.push("");
		return lines;
	}
}
