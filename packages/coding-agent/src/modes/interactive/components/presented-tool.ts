/**
 * A tool call the TUI presents itself from presenters in its own process:
 * the review workflow's inline view of its pass sessions, which run in the
 * TUI's process until that view reads the review's hosted pass conversation
 * (Phase 6). The transcript's rows draw what the host presented instead
 * (tool-call-row.ts).
 *
 * Streaming arguments and partial results present again at most every
 * {@link STREAMING_RENDER_INTERVAL_MS}; a running call's elapsed time ticks
 * every second.
 */

import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import { PRESENTATION_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol";
import type { Component, RenderFrame, TUI } from "@hansjm10/volt-tui";
import {
	type PresenterSet,
	presentToolCall,
	type ToolPresentInput,
	type ToolPresentResult,
} from "../../../core/ui/presentation.ts";
import type { UiIntentSink } from "../ui-node/intents.ts";
import type { ToolCardState, ToolCardWork } from "../ui-node/tool-card.ts";
import { StreamingRenderCoalescer } from "./streaming-render-coalescer.ts";
import { ToolCallRow } from "./tool-call-row.ts";

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
 * One tool call presented with the presenters `presenters()` returns when it
 * presents: after extensions are enabled or disabled,
 * `refreshPresentation()` presents it again, so a disabled extension's
 * presenter no longer draws it.
 */
export class PresentedToolComponent implements Component {
	private readonly toolName: string;
	private readonly presenters: () => PresenterSet;
	private readonly cwd: string;
	private args: Record<string, unknown>;
	private argsComplete = false;
	private executionStarted = false;
	private result: ToolPresentResult | undefined;
	private readonly row: ToolCallRow;
	private disposed = false;
	private readonly coalescer: StreamingRenderCoalescer<void>;

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
		this.cwd = cwd;
		this.row = new ToolCallRow(toolName, ui, {
			...(options.showImages === undefined ? {} : { showImages: options.showImages }),
			...(options.imageWidthCells === undefined ? {} : { imageWidthCells: options.imageWidthCells }),
			timed: options.liveProgress === true,
			...(options.work === undefined ? {} : { work: options.work }),
			...(options.intents === undefined ? {} : { intents: options.intents }),
		});
		this.coalescer = new StreamingRenderCoalescer<void>(() => {
			this.present();
			ui.requestRender();
		});
		this.present();
	}

	updateArgs(args: unknown): void {
		if (this.disposed) return;
		this.args = isRecord(args) ? args : {};
		if (this.argsComplete || this.executionStarted || this.result) this.coalescer.commitNow();
		else this.coalescer.update();
	}

	markExecutionStarted(): void {
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
			this.coalescer.commitNow();
		} else {
			this.coalescer.update();
		}
	}

	setExpanded(expanded: boolean): void {
		this.row.setExpanded(expanded);
	}

	setShowImages(show: boolean): void {
		this.row.setShowImages(show);
	}

	setImageWidthCells(width: number): void {
		this.row.setImageWidthCells(width);
	}

	/** Present the call again with the presenters there are now: extensions were enabled or disabled. */
	refreshPresentation(): void {
		if (this.disposed) return;
		this.present();
	}

	/** Re-read the call's work: its job changed. */
	invalidate(): void {
		this.row.invalidate();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.coalescer.dispose();
		this.row.dispose();
	}

	render(width: number): RenderFrame {
		return this.row.render(width);
	}

	private state(): ToolCardState {
		if (this.result !== undefined && !this.result.partial) return "done";
		return this.executionStarted || this.result !== undefined ? "running" : "pending";
	}

	private present(): void {
		if (this.disposed) return;
		const state = this.state();
		const input: ToolPresentInput = {
			args: this.args,
			argsComplete: this.argsComplete || state !== "pending",
			state,
			...(this.result === undefined ? {} : { result: this.result }),
			cwd: this.cwd,
		};
		this.row.update({
			presentation: presentToolCall(
				this.presenters().tool(this.toolName),
				this.toolName,
				input,
				PRESENTATION_MAX_SERIALIZED_BYTES,
			),
			state,
			isError: this.result?.isError === true,
			...(this.result === undefined || this.result.partial ? {} : { content: this.result.content }),
		});
	}
}
