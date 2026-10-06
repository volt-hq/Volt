/**
 * The live presentations of a conversation's running tool calls (RFC §8.3):
 * each call is presented when it starts, again at most once per
 * {@link PRESENTATION_COALESCE_MS} while partial results arrive, and once
 * more when it ends. A changed presentation reaches clients as the smallest
 * of a `patch` of its `summary` and `body` trees (`diffUiTree`), so streaming
 * output appends lines, or the whole `presentation` when anything else
 * changed. The diff starts from the presentation the live state holds for the
 * call, so a client that applies the items in order holds what the host does.
 * Before a call runs, while its arguments stream, it is presented as they
 * stand (`ArgumentPresentations`).
 */

import {
	diffUiTree,
	PRESENTATION_MAX_SERIALIZED_BYTES,
	type ToolPresentation,
	type ToolPresentationPatch,
} from "@hansjm10/volt-protocol";
import {
	type PresenterSet,
	presentToolCall,
	serializedBytes,
	type ToolPresentInput,
	type ToolPresentResult,
} from "./presentation.ts";

/** How often one call's presentation is updated at most while it streams. */
export const PRESENTATION_COALESCE_MS = 100;

/** What changed of a call's presentation: the whole presentation, a patch of its trees, or nothing. */
export type PresentationChange =
	| { readonly presentation: ToolPresentation }
	| { readonly patch: ToolPresentationPatch }
	| undefined;

/** The presentation without its trees: what a patch cannot change. */
function frame(presentation: ToolPresentation): string {
	const { summary: _summary, body: _body, ...rest } = presentation;
	return JSON.stringify(rest);
}

/**
 * What turns `held` into `next`: none when they are equal, a patch of the
 * trees when only they changed and the patch is smaller, else the whole
 * presentation.
 */
export function presentationChange(held: ToolPresentation | undefined, next: ToolPresentation): PresentationChange {
	if (held === undefined || frame(held) !== frame(next)) return { presentation: next };
	const summary = diffUiTree(held.summary ?? [], next.summary ?? []);
	const body = diffUiTree(held.body ?? [], next.body ?? []);
	if (summary.length === 0 && body.length === 0) return undefined;
	const patch: ToolPresentationPatch = {
		...(summary.length === 0 ? {} : { summary }),
		...(body.length === 0 ? {} : { body }),
	};
	return serializedBytes(patch) < serializedBytes(next) ? { patch } : { presentation: next };
}

interface LiveCall {
	readonly toolName: string;
	readonly args: Record<string, unknown>;
	result?: ToolPresentResult;
	timer?: ReturnType<typeof setTimeout>;
}

export interface ToolPresentationStateOptions {
	readonly presenters: () => PresenterSet;
	readonly cwd: () => string;
	/** The presentation the live state holds for a call: what the next change starts from. */
	readonly held: (toolCallId: string) => ToolPresentation | undefined;
	/** Publish a coalesced change of a running call. */
	readonly update: (toolCallId: string, toolName: string, change: NonNullable<PresentationChange>) => void;
	/** The bound presentations keep; `PRESENTATION_MAX_SERIALIZED_BYTES` by default. */
	readonly maxBytes?: number;
	readonly coalesceMs?: number;
}

/** The running calls of one conversation and their presentations. */
export class ToolPresentationState {
	private readonly options: ToolPresentationStateOptions;
	private readonly calls = new Map<string, LiveCall>();
	private closed = false;

	constructor(options: ToolPresentationStateOptions) {
		this.options = options;
	}

	/** A call started: its first presentation, which the start item carries. */
	start(toolCallId: string, toolName: string, args: Record<string, unknown>): ToolPresentation {
		this.drop(toolCallId);
		const call: LiveCall = { toolName, args };
		if (!this.closed) this.calls.set(toolCallId, call);
		return this.present(call, "running");
	}

	/** A partial result arrived: the call is presented again within {@link PRESENTATION_COALESCE_MS}. */
	update(toolCallId: string, result: Omit<ToolPresentResult, "partial" | "isError">): void {
		const call = this.calls.get(toolCallId);
		if (!call) return;
		call.result = { ...result, isError: false, partial: true };
		if (call.timer !== undefined) return;
		call.timer = setTimeout(() => {
			call.timer = undefined;
			if (this.calls.get(toolCallId) !== call) return;
			const change = presentationChange(this.options.held(toolCallId), this.present(call, "running"));
			if (change) this.options.update(toolCallId, call.toolName, change);
		}, this.options.coalesceMs ?? PRESENTATION_COALESCE_MS);
		call.timer.unref?.();
	}

	/**
	 * The call ended: what changed of its presentation with its final result,
	 * which the end item carries. A pending coalesced update is dropped.
	 */
	end(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown> | undefined,
		result: Omit<ToolPresentResult, "partial">,
	): PresentationChange {
		const call = this.calls.get(toolCallId);
		this.drop(toolCallId);
		const ended: LiveCall = { toolName, args: args ?? call?.args ?? {}, result: { ...result, partial: false } };
		return presentationChange(this.options.held(toolCallId), this.present(ended, "done"));
	}

	/** Forget a call: its result was committed or its stream ended. */
	drop(toolCallId: string): void {
		const call = this.calls.get(toolCallId);
		if (call?.timer !== undefined) clearTimeout(call.timer);
		this.calls.delete(toolCallId);
	}

	/** Stop presenting; pending updates are dropped. */
	close(): void {
		this.closed = true;
		for (const toolCallId of [...this.calls.keys()]) this.drop(toolCallId);
	}

	private present(call: LiveCall, state: ToolPresentInput["state"]): ToolPresentation {
		const input: ToolPresentInput = {
			args: call.args,
			argsComplete: true,
			state,
			...(call.result === undefined ? {} : { result: call.result }),
			cwd: this.options.cwd(),
		};
		return presentToolCall(
			this.options.presenters().tool(call.toolName),
			call.toolName,
			input,
			this.options.maxBytes ?? PRESENTATION_MAX_SERIALIZED_BYTES,
		);
	}
}

export interface ArgumentPresentationsOptions {
	readonly presenters: () => PresenterSet;
	readonly cwd: () => string;
	/** Publish how a call looks now. */
	readonly publish: (toolCallId: string, presentation: ToolPresentation) => void;
	readonly maxBytes?: number;
	readonly coalesceMs?: number;
}

interface StreamingCall {
	toolName: string;
	args: Record<string, unknown>;
	complete: boolean;
	/** The presentation published last, as JSON. */
	published?: string;
	timer?: ReturnType<typeof setTimeout>;
}

/**
 * How the tool calls of a streaming assistant message look while their
 * arguments stream (`pending`): a call is presented when it starts, again at
 * most once per {@link PRESENTATION_COALESCE_MS} while its arguments grow, and
 * at once when they are complete. A presentation equal to the one published
 * last is not published again.
 */
export class ArgumentPresentations {
	private readonly options: ArgumentPresentationsOptions;
	private readonly calls = new Map<string, StreamingCall>();
	private closed = false;

	constructor(options: ArgumentPresentationsOptions) {
		this.options = options;
	}

	/** The arguments of call `toolCallId` changed: as far as they streamed, or `complete`. */
	update(toolCallId: string, toolName: string, args: Record<string, unknown>, complete: boolean): void {
		if (this.closed) return;
		const existing = this.calls.get(toolCallId);
		const call: StreamingCall = existing ?? { toolName, args, complete };
		call.toolName = toolName;
		call.args = args;
		call.complete = complete;
		this.calls.set(toolCallId, call);
		if (existing === undefined || complete) {
			this.publish(toolCallId, call);
			return;
		}
		if (call.timer !== undefined) return;
		call.timer = setTimeout(() => {
			call.timer = undefined;
			if (this.calls.get(toolCallId) === call) this.publish(toolCallId, call);
		}, this.options.coalesceMs ?? PRESENTATION_COALESCE_MS);
		call.timer.unref?.();
	}

	/** The streaming message ended or committed: its calls are forgotten, and pending updates dropped. */
	clear(): void {
		for (const call of this.calls.values()) if (call.timer !== undefined) clearTimeout(call.timer);
		this.calls.clear();
	}

	/** Stop presenting. */
	close(): void {
		this.closed = true;
		this.clear();
	}

	private publish(toolCallId: string, call: StreamingCall): void {
		if (call.timer !== undefined) clearTimeout(call.timer);
		call.timer = undefined;
		const presentation = presentToolCall(
			this.options.presenters().tool(call.toolName),
			call.toolName,
			{ args: call.args, argsComplete: call.complete, state: "pending", cwd: this.options.cwd() },
			this.options.maxBytes ?? PRESENTATION_MAX_SERIALIZED_BYTES,
		);
		const json = JSON.stringify(presentation);
		if (json === call.published) return;
		call.published = json;
		this.options.publish(toolCallId, presentation);
	}
}
