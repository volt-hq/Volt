import type { AssistantStreamFragment } from "./fragments.ts";

export const TOOL_ARGUMENT_BATCH_INTERVAL_MS = 16;
export const TOOL_ARGUMENT_BATCH_MAX_CHARS = 64 * 1024;
export const TOOL_ARGUMENT_BATCH_MAX_FRAGMENTS = 1024;

/** Combines adjacent argument deltas with unchanged identity before parsing or snapshot creation. */
export class ToolArgumentCoalescer {
	private contentIndex: number | undefined;
	private id: string | undefined;
	private name: string | undefined;
	private chunks: string[] = [];
	private chars = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly emit: (fragment: AssistantStreamFragment) => void;
	private readonly onError: (error: unknown) => void;

	constructor(emit: (fragment: AssistantStreamFragment) => void, onError: (error: unknown) => void) {
		this.emit = emit;
		this.onError = onError;
	}

	push(fragment: AssistantStreamFragment): void {
		if (
			fragment.type === "toolcall_delta" &&
			fragment.contentIndex === this.contentIndex &&
			(fragment.id === undefined || fragment.id === this.id) &&
			(fragment.name === undefined || fragment.name === this.name) &&
			fragment.argsTextDelta.length <= TOOL_ARGUMENT_BATCH_MAX_CHARS
		) {
			if (
				this.chars + fragment.argsTextDelta.length > TOOL_ARGUMENT_BATCH_MAX_CHARS ||
				this.chunks.length >= TOOL_ARGUMENT_BATCH_MAX_FRAGMENTS
			) {
				this.flushPending();
			}
			this.chunks.push(fragment.argsTextDelta);
			this.chars += fragment.argsTextDelta.length;
			return;
		}

		// Identity updates, interleaving, and semantic boundaries retain their exact order.
		this.flush();
		this.emit(fragment);
		if (fragment.type === "toolcall_delta") {
			this.contentIndex = fragment.contentIndex;
			this.id = fragment.id;
			this.name = fragment.name;
			this.timer = setTimeout(() => {
				try {
					this.flush();
				} catch (error) {
					this.onError(error);
				}
			}, TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		}
	}

	flush(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		try {
			this.flushPending();
		} finally {
			this.contentIndex = undefined;
			this.id = undefined;
			this.name = undefined;
		}
	}

	dispose(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.contentIndex = undefined;
		this.id = undefined;
		this.name = undefined;
		this.chunks = [];
		this.chars = 0;
	}

	private flushPending(): void {
		if (this.chunks.length === 0 || this.contentIndex === undefined) return;
		const delta = this.chunks.join("");
		this.chunks = [];
		this.chars = 0;
		this.emit({ type: "toolcall_delta", contentIndex: this.contentIndex, argsTextDelta: delta });
	}
}
