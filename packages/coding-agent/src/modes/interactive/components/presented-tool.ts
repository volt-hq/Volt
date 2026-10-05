/**
 * A tool call in the TUI transcript drawn from its presentation (RFC §8.3,
 * Q9): the generic tool card around what the call's presenter returns for
 * its arguments, state, and result. The TUI hosts the conversation in
 * process, so it presents calls itself from the session's presenters; until
 * it becomes a client of the host (Phase 6) it does not read the live lane.
 *
 * Streaming arguments and partial results present again at most every
 * {@link STREAMING_RENDER_INTERVAL_MS}; a running call's elapsed time ticks
 * every second. Work the call started (a background job) shows live under it.
 */

import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import { PRESENTATION_MAX_SERIALIZED_BYTES, type ToolPresentation } from "@hansjm10/volt-protocol";
import { type Component, createRenderFrame, getCapabilities, type RenderFrame, type TUI } from "@hansjm10/volt-tui";
import {
	type PresenterSet,
	presentToolCall,
	type ToolPresentInput,
	type ToolPresentResult,
} from "../../../core/ui/presentation.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import type { UiIntentSink } from "../ui-node/intents.ts";
import { ToolCard, type ToolCardImage, type ToolCardState, type ToolCardWork } from "../ui-node/tool-card.ts";
import { StreamingRenderCoalescer } from "./streaming-render-coalescer.ts";

export interface PresentedToolOptions {
	readonly showImages?: boolean;
	readonly imageWidthCells?: number;
	/** A live call: its elapsed time ticks while it runs. Replayed calls show none. */
	readonly liveProgress?: boolean;
	/** The work the call started, read at every render. */
	readonly work?: () => readonly ToolCardWork[];
	/** Where the presentation's actions send their intents. */
	readonly intents?: UiIntentSink;
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text and image blocks of a result. */
function resultContent(content: ReadonlyArray<{ type: string; text?: string; data?: string; mimeType?: string }>) {
	return content.flatMap((block): (TextContent | ImageContent)[] => {
		if (block.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
		if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
			return [{ type: "image", data: block.data, mimeType: block.mimeType }];
		}
		return [];
	});
}

/**
 * One tool call drawn from its presentation. The call presents with the
 * presenters `presenters()` returns when it presents: after extensions are
 * enabled or disabled, `refreshPresentation()` presents it again, so a
 * disabled extension's presenter no longer draws it.
 */
export class PresentedToolComponent implements Component {
	private readonly toolName: string;
	private readonly presenters: () => PresenterSet;
	private readonly ui: TUI;
	private readonly cwd: string;
	private readonly options: PresentedToolOptions;
	private args: Record<string, unknown>;
	private argsComplete = false;
	private executionStarted = false;
	private result: ToolPresentResult | undefined;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private startedAt: number | undefined;
	private endedAt: number | undefined;
	private presentation: ToolPresentation | undefined;
	private card: ToolCard;
	/** PNG versions of the result's other images, for terminals that place PNG only, by source data. */
	private readonly converted = new Map<string, ToolCardImage>();
	private ticker: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private readonly coalescer = new StreamingRenderCoalescer<void>(() => {
		this.present();
		this.sync();
		this.ui.requestRender();
	});

	constructor(
		toolName: string,
		args: unknown,
		presenters: () => PresenterSet,
		ui: TUI,
		cwd: string,
		options: PresentedToolOptions = {},
	) {
		this.toolName = toolName;
		this.args = isRecord(args) ? args : {};
		this.presenters = presenters;
		this.ui = ui;
		this.cwd = cwd;
		this.options = options;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.present();
		this.card = this.createCard();
		if (options.liveProgress) {
			this.ticker = setInterval(() => {
				if (this.startedAt !== undefined && this.endedAt === undefined) {
					this.sync();
					this.ui.requestRender();
				}
			}, 1000);
			this.ticker.unref?.();
		}
	}

	updateArgs(args: unknown): void {
		if (this.disposed) return;
		this.args = isRecord(args) ? args : {};
		if (this.argsComplete || this.executionStarted || this.result) this.coalescer.commitNow();
		else this.coalescer.update();
	}

	markExecutionStarted(): void {
		if (this.options.liveProgress) this.startedAt ??= Date.now();
		this.executionStarted = true;
		this.coalescer.commitNow();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.coalescer.commitNow();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: unknown;
			isError: boolean;
		},
		isPartial = false,
	): void {
		if (this.disposed) return;
		this.result = {
			content: resultContent(result.content),
			...(result.details === undefined ? {} : { details: result.details }),
			isError: result.isError,
			partial: isPartial,
		};
		if (!isPartial) {
			this.argsComplete = true;
			if (this.startedAt !== undefined) this.endedAt ??= Date.now();
			this.stopTicker();
			this.coalescer.commitNow();
			this.convertImages();
		} else {
			this.coalescer.update();
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.sync();
	}

	setShowImages(show: boolean): void {
		if (this.showImages === show) return;
		this.showImages = show;
		this.replaceCard();
	}

	setImageWidthCells(width: number): void {
		const cells = Math.max(1, Math.floor(width));
		if (this.imageWidthCells === cells) return;
		this.imageWidthCells = cells;
		this.replaceCard();
	}

	/** Present the call again with the presenters there are now: extensions were enabled or disabled. */
	refreshPresentation(): void {
		if (this.disposed) return;
		this.present();
		this.sync();
	}

	/** Re-read the call's work: its job changed. */
	invalidate(): void {
		this.card.invalidate();
		this.sync();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.coalescer.dispose();
		this.stopTicker();
		this.card.dispose();
		this.converted.clear();
	}

	render(width: number): RenderFrame {
		if (this.disposed) return createRenderFrame([]);
		return this.card.render(width);
	}

	private stopTicker(): void {
		if (this.ticker !== undefined) clearInterval(this.ticker);
		this.ticker = undefined;
	}

	private state(): ToolCardState {
		if (this.result !== undefined && !this.result.partial) return "done";
		return this.executionStarted || this.result !== undefined ? "running" : "pending";
	}

	private present(): void {
		const state = this.state();
		const input: ToolPresentInput = {
			args: this.args,
			argsComplete: this.argsComplete || state !== "pending",
			state,
			...(this.result === undefined ? {} : { result: this.result }),
			cwd: this.cwd,
		};
		this.presentation = presentToolCall(
			this.presenters().tool(this.toolName),
			this.toolName,
			input,
			PRESENTATION_MAX_SERIALIZED_BYTES,
		);
	}

	private createCard(): ToolCard {
		return new ToolCard(this.props(), {
			showImages: this.showImages,
			imageWidthCells: this.imageWidthCells,
			...(this.options.intents === undefined ? {} : { intents: this.options.intents }),
		});
	}

	private replaceCard(): void {
		if (this.disposed) return;
		this.card.dispose();
		this.card = this.createCard();
	}

	private sync(): void {
		if (this.disposed) return;
		this.card.setProps(this.props());
	}

	private props() {
		const state = this.state();
		const elapsedMs =
			this.startedAt === undefined ? undefined : Math.max(0, (this.endedAt ?? Date.now()) - this.startedAt);
		const work = this.options.work?.() ?? [];
		return {
			presentation: this.presentation ?? { title: this.toolName },
			state,
			isError: state === "done" && this.result?.isError === true,
			expanded: this.expanded,
			...(elapsedMs === undefined ? {} : { elapsedMs }),
			images: this.showImages ? this.images() : [],
			...(work.length === 0 ? {} : { work }),
		};
	}

	/** The result's images the terminal can show: other formats as PNG where it places PNG only. */
	private images(): ToolCardImage[] {
		if (this.result === undefined || this.result.partial) return [];
		const pngOnly = getCapabilities().images === "kitty" || getCapabilities().images === "sixel";
		return this.result.content.flatMap((block): ToolCardImage[] => {
			if (block.type !== "image" || !IMAGE_MIME_TYPES.has(block.mimeType)) return [];
			if (!pngOnly || block.mimeType === "image/png") {
				return [{ data: block.data, mimeType: block.mimeType as ToolCardImage["mimeType"] }];
			}
			const png = this.converted.get(block.data);
			return png === undefined ? [] : [png];
		});
	}

	/** Convert the result's non-PNG images for terminals that place PNG only; each image converts once. */
	private convertImages(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty" && caps.images !== "sixel") return;
		for (const block of this.result?.content ?? []) {
			if (block.type !== "image" || block.mimeType === "image/png" || this.converted.has(block.data)) continue;
			const source = block.data;
			void convertToPng(source, block.mimeType)
				.then((converted) => {
					if (!converted || this.disposed || converted.mimeType !== "image/png") return;
					this.converted.set(source, { data: converted.data, mimeType: "image/png" });
					this.sync();
					this.ui.requestRender();
				})
				.catch(() => {});
		}
	}
}
