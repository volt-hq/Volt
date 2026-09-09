import type {
	ActiveToolCallState,
	AssistantMessage,
	AssistantMessageEvent,
	StreamOptions,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import { AssistantMessageEventStream, EventStreamOverflowError } from "../utils/event-stream.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import type { JsonObject } from "../utils/json-value.ts";
import type { AssistantMessageInit, AssistantMessageMetaPatch, AssistantStreamFragment } from "./fragments.ts";
import { ToolArgumentCoalescer } from "./tool-argument-coalescer.ts";
import { ToolArgumentGuard, type ToolArgumentLimitFailure } from "./tool-argument-guard.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type StreamBlockKind = "text" | "thinking" | "toolCall";

interface StreamBlockState {
	kind: StreamBlockKind;
	open: boolean;
}

type SnapshotEvent = Extract<AssistantMessageEvent, { snapshot: AssistantMessage }>;
type SnapshotEventInput = SnapshotEvent extends infer Event
	? Event extends SnapshotEvent
		? Omit<Event, "snapshot" | "toolState">
		: never
	: never;

/**
 * Converts provider fragments into immutable, internally consistent public
 * events. This is the only accumulator in the provider streaming pipeline.
 */
export class AssistantStreamNormalizer {
	readonly stream = new AssistantMessageEventStream((error) => this.processingErrorEvent(error));
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly guard: ToolArgumentGuard;
	private readonly cleanupSignal: () => void;

	private message: AssistantMessage | undefined;
	private seq = -1;
	private terminal = false;
	private readonly blocks = new Map<number, StreamBlockState>();
	private readonly toolArgsText = new Map<number, string>();
	private toolArgumentFailure: string | undefined;
	private readonly toolArgumentCoalescer = new ToolArgumentCoalescer(
		(fragment) => this.pushImmediately(fragment),
		(error) => this.failProcessing(error),
	);

	constructor(options?: Pick<StreamOptions, "signal" | "toolArgumentLimits">) {
		this.signal = this.controller.signal;
		this.guard = new ToolArgumentGuard(options?.toolArgumentLimits, (failure) =>
			this.failToolArgumentGeneration(failure),
		);
		const parentSignal = options?.signal;
		const onAbort = () => {
			this.toolArgumentCoalescer.dispose();
			this.guard.dispose();
			this.controller.abort(parentSignal?.reason);
		};
		if (parentSignal?.aborted) onAbort();
		else parentSignal?.addEventListener("abort", onAbort, { once: true });
		this.cleanupSignal = () => parentSignal?.removeEventListener("abort", onAbort);
	}

	push(fragment: AssistantStreamFragment): void {
		if (this.terminal) return;
		try {
			if (!this.validateConfiguration(fragment.type === "start" ? fragment.init : undefined)) return;
			if (fragment.type === "toolcall_delta") {
				this.ensureStarted();
				// An implicit start is a semantic boundary too. Publish the preceding
				// call's buffered delta before ensureOpenBlock emits that start.
				if (!this.blocks.has(fragment.contentIndex)) this.toolArgumentCoalescer.flush();
				if (!this.ensureOpenBlock(fragment.contentIndex, "toolCall")) return;
				// Charge each raw provider delta before any batching, concatenation, or parsing.
				if (!this.guard.append(fragment.contentIndex, fragment.argsTextDelta)) return;
			}
			this.toolArgumentCoalescer.push(fragment);
		} catch (error) {
			this.failProcessing(error);
			throw error;
		}
	}

	private pushImmediately(fragment: AssistantStreamFragment): void {
		if (this.terminal) {
			return;
		}
		if (!this.validateConfiguration(fragment.type === "start" ? fragment.init : undefined)) return;

		switch (fragment.type) {
			case "start":
				this.handleStart(fragment.init);
				break;
			case "meta":
				this.ensureStarted();
				this.applyMeta(fragment.patch);
				break;
			case "text_start":
				this.startText(fragment.contentIndex);
				break;
			case "text_delta":
				this.appendText(fragment.contentIndex, fragment.delta);
				break;
			case "text_end":
				this.endText(fragment.contentIndex, fragment.content, fragment.textSignature);
				break;
			case "thinking_start":
				this.startThinking(fragment.contentIndex, fragment.content, fragment.thinkingSignature, fragment.redacted);
				break;
			case "thinking_delta":
				this.appendThinking(fragment.contentIndex, fragment.delta, fragment.signatureDelta);
				break;
			case "thinking_end":
				this.endThinking(fragment.contentIndex, fragment.content, fragment.thinkingSignature, fragment.redacted);
				break;
			case "toolcall_start":
				this.startToolCall(fragment.contentIndex, fragment.id, fragment.name);
				break;
			case "toolcall_delta":
				this.appendToolCall(fragment.contentIndex, fragment.argsTextDelta, fragment.id, fragment.name);
				break;
			case "toolcall_end":
				this.endToolCall(
					fragment.contentIndex,
					fragment.toolCall,
					fragment.thoughtSignature,
					fragment.argumentsText,
				);
				break;
			case "done":
				this.finishSuccess(fragment.reason, fragment.usage);
				break;
			case "error":
				this.finishError(fragment.reason, fragment.errorMessage, fragment.diagnostics, fragment.usage);
				break;
		}
	}

	/** Reject invalid local limits before an adapter starts asynchronous provider work. */
	validateConfiguration(init?: AssistantMessageInit): boolean {
		if (this.terminal) return false;
		if (!this.guard.configurationError) return true;
		if (init && !this.message) this.handleStart(init);
		this.failToolArgumentGeneration({
			message: this.guard.configurationError,
			diagnostic: {
				type: "tool_argument_generation_limit",
				timestamp: Date.now(),
				details: { code: "invalid_configuration" },
			},
		});
		return false;
	}

	/** Check authoritative raw arguments before an adapter retains them for completion. */
	checkToolArgumentsText(contentIndex: number, text: string): boolean {
		return !this.terminal && this.guard.replace(contentIndex, text);
	}

	/** Bound native arguments before an adapter serializes them into preview deltas. */
	checkToolArgumentsObject(contentIndex: number, value: JsonObject): boolean {
		return !this.terminal && this.guard.inspectObject(contentIndex, value);
	}

	/** Charge a native replacement before an adapter retains it without a preview delta. */
	checkToolArgumentsObjectReplacement(contentIndex: number, value: JsonObject): boolean {
		return !this.terminal && this.guard.replaceObject(contentIndex, value);
	}

	/** Finish a fragment source, synthesizing an error if it omitted a terminal fragment. */
	end(): void {
		if (this.terminal) {
			return;
		}
		this.push({ type: "error", reason: "error", errorMessage: "Assistant stream ended without a terminal fragment" });
	}

	private failProcessing(error: unknown): void {
		if (this.terminal) return;
		try {
			this.stream.push(this.processingErrorEvent(error));
		} catch (overflow) {
			// The overflow factory already installed a bounded error terminal.
			if (!(overflow instanceof EventStreamOverflowError)) throw overflow;
		}
	}

	private processingErrorEvent(error: unknown): Extract<AssistantMessageEvent, { type: "error" }> {
		this.terminal = true;
		this.cleanup();
		this.controller.abort(error);
		// Drop incomplete content after queue overload: retaining the oversized snapshot
		// in the terminal would defeat the queue budget. Never expose it as an executable call.
		const message: AssistantMessage = {
			role: "assistant",
			api: this.message?.api ?? "unknown",
			provider: this.message?.provider ?? "unknown",
			model: this.message?.model ?? "unknown",
			timestamp: this.message?.timestamp ?? Date.now(),
			usage: this.message?.usage ?? cloneAndFreeze(EMPTY_USAGE),
			content: cloneAndFreeze<AssistantMessage["content"]>([]),
			stopReason: "error",
			errorMessage:
				error instanceof EventStreamOverflowError
					? error.message
					: "Assistant stream processing failed. No tools from this response were executed. Retry explicitly.",
			diagnostics: freezeDiagnostics([
				{
					type:
						error instanceof EventStreamOverflowError
							? "assistant_stream_queue_limit"
							: "assistant_stream_processing_error",
					timestamp: Date.now(),
					details: error instanceof EventStreamOverflowError ? { limit: error.limit, code: error.code } : {},
				},
			]),
		};
		this.message = Object.freeze(message);
		return Object.freeze({ type: "error", seq: this.nextSeq(), reason: "error", error: this.message });
	}

	private handleStart(init: AssistantMessageInit): void {
		if (this.message) {
			this.recordViolation("duplicate_start");
			return;
		}

		const content: AssistantMessage["content"] = [];
		Object.freeze(content);
		const usage = cloneAndFreeze(init.usage ?? EMPTY_USAGE);
		const diagnostics = init.diagnostics ? freezeDiagnostics(init.diagnostics) : undefined;
		this.message = Object.freeze({
			role: "assistant",
			content,
			api: init.api,
			provider: init.provider,
			model: init.model,
			...(init.responseModel === undefined ? {} : { responseModel: init.responseModel }),
			...(init.responseId === undefined ? {} : { responseId: init.responseId }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			usage,
			stopReason: "stop",
			timestamp: init.timestamp,
		});
		this.emitSnapshot({ type: "start", seq: this.nextSeq() });
	}

	private ensureStarted(): void {
		if (this.message) {
			return;
		}
		this.handleStart({ api: "unknown", provider: "unknown", model: "unknown", timestamp: Date.now() });
		this.recordViolation("missing_start");
	}

	private applyMeta(patch: AssistantMessageMetaPatch): void {
		const message = this.requireMessage();
		let usage = message.usage;
		if (patch.usage) {
			usage = cloneAndFreeze({
				...message.usage,
				...patch.usage,
				cost: {
					...message.usage.cost,
					...patch.usage.cost,
				},
			});
		}

		let diagnostics = message.diagnostics;
		if (patch.diagnostics && patch.diagnostics.length > 0) {
			diagnostics = Object.freeze([
				...(message.diagnostics ?? []),
				...patch.diagnostics.map((diagnostic) => cloneAndFreeze(diagnostic)),
			]) as AssistantMessageDiagnostic[];
		}

		this.message = Object.freeze({
			...message,
			...(patch.responseId === undefined ? {} : { responseId: patch.responseId }),
			...(patch.responseModel === undefined ? {} : { responseModel: patch.responseModel }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			usage,
		});
	}

	private startText(contentIndex: number): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "text")) {
			return;
		}
		this.replaceBlock(contentIndex, Object.freeze({ type: "text", text: "" }));
		this.blocks.set(contentIndex, { kind: "text", open: true });
		this.emitSnapshot({ type: "text_start", seq: this.nextSeq(), contentIndex });
	}

	private appendText(contentIndex: number, delta: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "text")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "text") {
			this.recordViolation("block_type_mismatch", contentIndex, "text");
			return;
		}
		this.replaceBlock(contentIndex, Object.freeze({ ...block, text: block.text + delta }));
		this.emitSnapshot({ type: "text_delta", seq: this.nextSeq(), contentIndex, delta });
	}

	private endText(contentIndex: number, content?: string, textSignature?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "text")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "text") {
			this.recordViolation("block_type_mismatch", contentIndex, "text");
			return;
		}
		const finalContent = content ?? block.text;
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				text: finalContent,
				...(textSignature === undefined ? {} : { textSignature }),
			}),
		);
		this.closeBlock(contentIndex);
		this.emitSnapshot({ type: "text_end", seq: this.nextSeq(), contentIndex, content: finalContent });
	}

	private startThinking(contentIndex: number, content?: string, thinkingSignature?: string, redacted?: boolean): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "thinking")) {
			return;
		}
		const block = Object.freeze({
			type: "thinking",
			thinking: content ?? "",
			...(thinkingSignature === undefined ? {} : { thinkingSignature }),
			...(redacted === undefined ? {} : { redacted }),
		});
		this.replaceBlock(contentIndex, block);
		this.blocks.set(contentIndex, { kind: "thinking", open: true });
		this.emitSnapshot({
			type: "thinking_start",
			seq: this.nextSeq(),
			contentIndex,
			...(block.redacted === undefined ? {} : { redacted: block.redacted }),
		});
	}

	private appendThinking(contentIndex: number, delta: string, signatureDelta?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "thinking")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "thinking") {
			this.recordViolation("block_type_mismatch", contentIndex, "thinking");
			return;
		}
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				thinking: block.thinking + delta,
				...(signatureDelta === undefined
					? {}
					: { thinkingSignature: (block.thinkingSignature ?? "") + signatureDelta }),
			}),
		);
		this.emitSnapshot({ type: "thinking_delta", seq: this.nextSeq(), contentIndex, delta });
	}

	private endThinking(contentIndex: number, content?: string, thinkingSignature?: string, redacted?: boolean): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "thinking")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "thinking") {
			this.recordViolation("block_type_mismatch", contentIndex, "thinking");
			return;
		}
		const finalContent = content ?? block.thinking;
		const finalBlock = Object.freeze({
			...block,
			thinking: finalContent,
			...(thinkingSignature === undefined ? {} : { thinkingSignature }),
			...(redacted === undefined ? {} : { redacted }),
		});
		this.replaceBlock(contentIndex, finalBlock);
		this.closeBlock(contentIndex);
		this.emitSnapshot({
			type: "thinking_end",
			seq: this.nextSeq(),
			contentIndex,
			content: finalContent,
			...(finalBlock.redacted === undefined ? {} : { redacted: finalBlock.redacted }),
		});
	}

	private startToolCall(contentIndex: number, id?: string, name?: string): void {
		this.ensureStarted();
		if (!this.canStartBlock(contentIndex, "toolCall")) {
			return;
		}
		const argumentsValue = Object.freeze({});
		const block = Object.freeze({ type: "toolCall", id: id ?? "", name: name ?? "", arguments: argumentsValue });
		this.replaceBlock(contentIndex, block);
		this.blocks.set(contentIndex, { kind: "toolCall", open: true });
		this.toolArgsText.set(contentIndex, "");
		this.guard.start(contentIndex);
		this.emitSnapshot({
			type: "toolcall_start",
			seq: this.nextSeq(),
			contentIndex,
			id: block.id,
			name: block.name,
		});
	}

	private appendToolCall(contentIndex: number, argsTextDelta: string, id?: string, name?: string): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "toolCall")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "toolCall") {
			this.recordViolation("block_type_mismatch", contentIndex, "toolCall");
			return;
		}
		const argsText = (this.toolArgsText.get(contentIndex) ?? "") + argsTextDelta;
		this.toolArgsText.set(contentIndex, argsText);
		const argumentsValue = cloneAndFreeze(parseStreamingJson<JsonObject>(argsText));
		this.replaceBlock(
			contentIndex,
			Object.freeze({
				...block,
				...(id === undefined ? {} : { id }),
				...(name === undefined ? {} : { name }),
				arguments: argumentsValue,
			}),
		);
		this.emitSnapshot({
			type: "toolcall_delta",
			seq: this.nextSeq(),
			contentIndex,
			argsTextDelta,
			...(id === undefined ? {} : { id }),
			...(name === undefined ? {} : { name }),
		});
	}

	private endToolCall(
		contentIndex: number,
		toolCall?: ToolCall,
		thoughtSignature?: string,
		argumentsText?: string,
	): void {
		this.ensureStarted();
		if (!this.ensureOpenBlock(contentIndex, "toolCall")) {
			return;
		}
		const block = this.requireMessage().content[contentIndex];
		if (block?.type !== "toolCall") {
			this.recordViolation("block_type_mismatch", contentIndex, "toolCall");
			return;
		}
		if (argumentsText !== undefined && !this.guard.replace(contentIndex, argumentsText)) return;
		if (argumentsText === undefined && toolCall && !this.guard.replaceObject(contentIndex, toolCall.arguments))
			return;
		if (!this.guard.complete(contentIndex)) return;
		let finalToolCall = block;
		try {
			// Tolerant parsing is only a preview. Only an explicit end may admit
			// the complete provider payload, never the last repaired object.
			const raw =
				argumentsText ?? (toolCall ? JSON.stringify(toolCall.arguments) : this.toolArgsText.get(contentIndex));
			const argumentsValue: unknown = JSON.parse(raw ?? "");
			if (argumentsValue === null || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
				throw new Error("Expected a JSON object");
			}
			finalToolCall = cloneToolCall({
				...(toolCall ?? block),
				arguments: argumentsValue as JsonObject,
				...(thoughtSignature === undefined ? {} : { thoughtSignature }),
			});
		} catch {
			this.rejectToolArguments("invalid_json", contentIndex);
		}
		this.closeToolCall(contentIndex, finalToolCall);
	}

	/** Close a preview on failure without admitting it as a completed call. */
	private closeToolCall(contentIndex: number, finalToolCall: ToolCall): void {
		this.replaceBlock(contentIndex, finalToolCall);
		this.toolArgsText.delete(contentIndex);
		this.closeBlock(contentIndex);
		this.emitSnapshot({
			type: "toolcall_end",
			seq: this.nextSeq(),
			contentIndex,
			toolCall: finalToolCall,
		});
	}

	private finishSuccess(reason: "stop" | "length" | "toolUse", usage?: Usage): void {
		this.ensureStarted();
		for (const [contentIndex, state] of this.blocks) {
			if (state.kind !== "toolCall") continue;
			if (reason === "length") this.rejectToolArguments("length_limit", contentIndex);
			else if (state.open) this.rejectToolArguments("missing_completion", contentIndex);
		}
		if (this.toolArgumentFailure) {
			this.finishError("error", this.toolArgumentFailure, undefined, usage);
			return;
		}
		this.closeOpenBlocks();
		if (this.terminal) return;
		if (usage) {
			this.applyMeta({ usage });
		}
		const message = this.requireMessage();
		this.message = Object.freeze({ ...message, stopReason: reason });
		this.terminal = true;
		this.cleanup();
		this.stream.push(
			Object.freeze({
				type: "done",
				seq: this.nextSeq(),
				reason,
				message: this.message,
			}) satisfies AssistantMessageEvent,
		);
	}

	private finishError(
		reason: "aborted" | "error",
		errorMessage: string,
		diagnostics?: AssistantMessageDiagnostic[],
		usage?: Usage,
	): void {
		this.ensureStarted();
		const failureDiagnostics = [...(this.requireMessage().diagnostics ?? []), ...(diagnostics ?? [])];
		const hasGenerationLimit = failureDiagnostics.some(
			(diagnostic) => diagnostic.type === "tool_argument_generation_limit",
		);
		// An error terminal already prevents every tool in this response from executing.
		// Preserve the provider cause for retry policy instead of treating an interrupted
		// stream as a successful response with missing tool completion. Actual argument
		// validation failures remain authoritative below and in the retained diagnostics.
		this.closeOpenBlocks();
		if (this.terminal) return;
		if (usage || diagnostics) {
			this.applyMeta({ ...(usage === undefined ? {} : { usage }), diagnostics });
		}
		const message = this.requireMessage();
		this.message = Object.freeze({
			...message,
			stopReason: reason,
			errorMessage: hasGenerationLimit ? errorMessage : (this.toolArgumentFailure ?? errorMessage),
		});
		this.terminal = true;
		this.cleanup();
		this.stream.push(
			Object.freeze({
				type: "error",
				seq: this.nextSeq(),
				reason,
				error: this.message,
			}) satisfies AssistantMessageEvent,
		);
	}

	private failToolArgumentGeneration(failure: ToolArgumentLimitFailure): void {
		if (this.terminal) return;
		// A limit is not tool completion. Retain only already-bounded preview content.
		for (const [contentIndex, state] of this.blocks) {
			if (state.kind === "toolCall") this.closeBlock(contentIndex);
		}
		this.toolArgsText.clear();
		try {
			this.finishError("error", failure.message, [failure.diagnostic]);
		} catch (error) {
			// A deadline may fire while the consumer queue is already full. Its
			// overflow factory installed the terminal; never throw out of the timer.
			if (!(error instanceof EventStreamOverflowError)) throw error;
		} finally {
			this.controller.abort(failure);
		}
	}

	private cleanup(): void {
		this.toolArgumentCoalescer.dispose();
		this.guard.dispose();
		this.cleanupSignal();
		this.toolArgsText.clear();
	}

	private closeOpenBlocks(): void {
		const openBlocks = [...this.blocks.entries()]
			.filter(([, state]) => state.open)
			.sort(([left], [right]) => left - right);
		for (const [contentIndex, state] of openBlocks) {
			switch (state.kind) {
				case "text":
					this.endText(contentIndex);
					break;
				case "thinking":
					this.endThinking(contentIndex);
					break;
				case "toolCall":
					this.closeToolCall(contentIndex, this.requireMessage().content[contentIndex] as ToolCall);
					break;
			}
		}
	}

	private rejectToolArguments(
		code: "invalid_json" | "missing_completion" | "length_limit",
		contentIndex: number,
	): void {
		if (this.toolArgumentFailure) return;
		this.toolArgumentFailure =
			code === "invalid_json"
				? "Tool arguments must be a complete, valid JSON object. No tools were executed."
				: code === "length_limit"
					? "The response reached its length limit while generating tool calls. No tools were executed."
					: "The provider did not complete its tool-call response. No tools were executed.";
		this.applyMeta({
			diagnostics: [{ type: "invalid_tool_arguments", timestamp: Date.now(), details: { code, contentIndex } }],
		});
	}

	private ensureOpenBlock(contentIndex: number, kind: StreamBlockKind): boolean {
		if (!this.isValidContentIndex(contentIndex)) {
			this.recordViolation("invalid_content_index", contentIndex, kind);
			return false;
		}

		const state = this.blocks.get(contentIndex);
		if (!state) {
			if (contentIndex !== this.requireMessage().content.length) {
				this.recordViolation("unopened_non_dense_block", contentIndex, kind);
				return false;
			}
			switch (kind) {
				case "text":
					this.startText(contentIndex);
					break;
				case "thinking":
					this.startThinking(contentIndex);
					break;
				case "toolCall":
					this.startToolCall(contentIndex);
					break;
			}
			return true;
		}

		if (!state.open) {
			this.recordViolation("fragment_after_block_end", contentIndex, kind);
			return false;
		}
		if (state.kind !== kind) {
			this.recordViolation("block_type_mismatch", contentIndex, kind);
			return false;
		}
		return true;
	}

	private canStartBlock(contentIndex: number, kind: StreamBlockKind): boolean {
		if (!this.isValidContentIndex(contentIndex) || contentIndex !== this.requireMessage().content.length) {
			this.recordViolation("non_dense_block_start", contentIndex, kind);
			return false;
		}
		if (this.blocks.has(contentIndex)) {
			this.recordViolation("duplicate_block_start", contentIndex, kind);
			return false;
		}
		return true;
	}

	private isValidContentIndex(contentIndex: number): boolean {
		return Number.isSafeInteger(contentIndex) && contentIndex >= 0;
	}

	private closeBlock(contentIndex: number): void {
		const state = this.blocks.get(contentIndex);
		if (state) {
			this.blocks.set(contentIndex, { ...state, open: false });
		}
	}

	private replaceBlock(contentIndex: number, block: AssistantMessage["content"][number]): void {
		const message = this.requireMessage();
		const content = [...message.content];
		content[contentIndex] = block;
		this.message = Object.freeze({
			...message,
			content: Object.freeze(content) as AssistantMessage["content"],
		});
	}

	private recordViolation(code: string, contentIndex?: number, blockKind?: StreamBlockKind): void {
		if (!this.message) {
			return;
		}
		const diagnostic = {
			type: "assistant_stream_contract_violation",
			timestamp: Date.now(),
			details: {
				code,
				...(contentIndex === undefined ? {} : { contentIndex }),
				...(blockKind === undefined ? {} : { blockKind }),
			},
		} satisfies AssistantMessageDiagnostic;
		this.applyMeta({ diagnostics: [diagnostic] });
	}

	private emitSnapshot(event: SnapshotEventInput): void {
		this.stream.push(
			Object.freeze({
				...event,
				snapshot: this.requireMessage(),
				toolState: this.createToolState(),
			}) as SnapshotEvent,
		);
	}

	private createToolState(): readonly ActiveToolCallState[] {
		return Object.freeze(
			[...this.toolArgsText.entries()]
				.sort(([left], [right]) => left - right)
				.map(([contentIndex, argsText]) => Object.freeze({ contentIndex, argsText })),
		);
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}

	private requireMessage(): AssistantMessage {
		if (!this.message) {
			throw new Error("Assistant stream normalizer has no message");
		}
		return this.message;
	}
}

function cloneToolCall(toolCall: ToolCall): ToolCall {
	return Object.freeze({
		type: "toolCall",
		id: toolCall.id,
		name: toolCall.name,
		arguments: cloneAndFreeze(toolCall.arguments),
		...(toolCall.thoughtSignature === undefined ? {} : { thoughtSignature: toolCall.thoughtSignature }),
	});
}

function freezeDiagnostics(diagnostics: AssistantMessageDiagnostic[]): AssistantMessageDiagnostic[] {
	return Object.freeze(diagnostics.map((diagnostic) => cloneAndFreeze(diagnostic))) as AssistantMessageDiagnostic[];
}

function cloneAndFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
	}
	if (value === null || typeof value !== "object") {
		return value;
	}
	const clone = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneAndFreeze(entry)]));
	return Object.freeze(clone) as T;
}
