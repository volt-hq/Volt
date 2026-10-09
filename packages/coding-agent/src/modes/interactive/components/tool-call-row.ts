/**
 * A tool call in the TUI transcript (RFC §8.3, Q9): the generic tool card
 * around the call's presentation, which the host presents and the TUI only
 * draws. The card shows the call's state, its elapsed time while it runs (a
 * timed row ticks every second), its result's images once it is done, and the
 * work the call started, read at every render.
 */

import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import type { ToolPresentation } from "@hansjm10/volt-protocol";
import { type Component, createRenderFrame, getCapabilities, type RenderFrame, type TUI } from "@hansjm10/volt-tui";
import { convertToPng } from "../../../utils/image-convert.ts";
import type { UiIntentSink } from "../ui-node/intents.ts";
import { ToolCard, type ToolCardImage, type ToolCardState, type ToolCardWork } from "../ui-node/tool-card.ts";

export interface ToolCallRowOptions {
	readonly showImages?: boolean;
	readonly imageWidthCells?: number;
	/** The row times the call: from when it first runs until it is done. True by default. */
	readonly timed?: boolean;
	/** The work the call started, read at every render. */
	readonly work?: () => readonly ToolCardWork[];
	/** Where the presentation's actions send their intents. */
	readonly intents?: UiIntentSink;
}

/** How the call is now. */
export interface ToolCallRowUpdate {
	/** The call's presentation; without one the card shows the tool's name. */
	readonly presentation?: ToolPresentation;
	readonly state: ToolCardState;
	/** The call is done and its result is an error. */
	readonly isError?: boolean;
	/** The result's content: its images show under the card once the call is done. */
	readonly content?: readonly (TextContent | ImageContent)[];
}

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export class ToolCallRow implements Component {
	readonly toolName: string;
	private readonly ui: TUI;
	private readonly options: ToolCallRowOptions;
	private current: ToolCallRowUpdate = { state: "pending" };
	private expanded = false;
	private expandHint = true;
	private showImages: boolean;
	private imageWidthCells: number;
	private startedAt: number | undefined;
	private endedAt: number | undefined;
	private card: ToolCard;
	/** PNG versions of the result's other images, for terminals that place PNG only, by source data. */
	private readonly converted = new Map<string, ToolCardImage>();
	private ticker: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(toolName: string, ui: TUI, options: ToolCallRowOptions = {}) {
		this.toolName = toolName;
		this.ui = ui;
		this.options = options;
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.card = this.createCard();
	}

	/** The state the row shows. */
	get state(): ToolCardState {
		return this.current.state;
	}

	/** The presentation the row shows; none while the host has not presented the call. */
	get presentation(): ToolPresentation | undefined {
		return this.current.presentation;
	}

	/** Expanding shows more of the call: its presentation has a body. */
	get expandable(): boolean {
		const presentation = this.current.presentation;
		return presentation?.hidden !== true && (presentation?.body?.length ?? 0) > 0;
	}

	update(update: ToolCallRowUpdate): void {
		if (this.disposed) return;
		this.current = update;
		if (update.state === "running" && this.options.timed !== false && this.startedAt === undefined) {
			this.startedAt = Date.now();
			this.ticker = setInterval(() => {
				this.sync();
				this.ui.requestRender();
			}, 1000);
			this.ticker.unref?.();
		}
		if (update.state === "done") {
			if (this.startedAt !== undefined) this.endedAt ??= Date.now();
			this.stopTicker();
			this.convertImages();
		}
		this.sync();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.sync();
	}

	/** Whether the collapsed row says how to expand it. */
	setExpandHint(show: boolean): void {
		if (this.expandHint === show) return;
		this.expandHint = show;
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

	/** Re-read the call's work: it changed. */
	invalidate(): void {
		this.card.invalidate();
		this.sync();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
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
		const { presentation, state, isError } = this.current;
		const elapsedMs =
			this.startedAt === undefined ? undefined : Math.max(0, (this.endedAt ?? Date.now()) - this.startedAt);
		const work = this.options.work?.() ?? [];
		return {
			presentation: presentation ?? { title: this.toolName },
			state,
			isError: state === "done" && isError === true,
			expanded: this.expanded,
			expandHint: this.expandHint,
			...(elapsedMs === undefined ? {} : { elapsedMs }),
			images: this.showImages ? this.images() : [],
			...(work.length === 0 ? {} : { work }),
		};
	}

	/** The result's images the terminal can show: other formats as PNG where it places PNG only. */
	private images(): ToolCardImage[] {
		if (this.current.state !== "done") return [];
		const pngOnly = getCapabilities().images === "kitty" || getCapabilities().images === "sixel";
		return (this.current.content ?? []).flatMap((block): ToolCardImage[] => {
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
		for (const block of this.current.content ?? []) {
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
