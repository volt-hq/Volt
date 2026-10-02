import type {
	Api,
	Context,
	Model,
	ProviderError,
	ProviderPayloadMetadata,
	ProviderResponse,
	StopReason,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import type { AssistantMessageDiagnostic } from "../utils/diagnostics.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import type { JsonObject } from "../utils/json-value.ts";
import type { AssistantMessageInit, AssistantStreamFragment } from "./fragments.ts";
import { AssistantStreamNormalizer } from "./normalizer.ts";
import {
	classifyProviderError,
	createProviderError,
	ProviderStreamError,
	readRetryAfterMs,
} from "./provider-errors.ts";

/** Default cap on a server-requested retry delay. */
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
/** Backoff before the first retry when the server requests no delay; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 1_000;

const ABORT_MESSAGE = "Request was aborted";

/** Content and metadata fragments. The runner owns the terminal `done` and `error` fragments. */
export type ProviderContentFragment = Exclude<AssistantStreamFragment, { type: "done" | "error" }>;

/** Accepts provider fragments. The runner starts the message on the first fragment unless the provider sends `start`. */
export interface ProviderFragmentSink {
	push(fragment: ProviderContentFragment): void;
	/** Check authoritative raw arguments before retaining them. False means the stream already failed. */
	checkToolArgumentsText(contentIndex: number, text: string): boolean;
	/** Bound native arguments before serializing them into preview deltas. False means the stream already failed. */
	checkToolArgumentsObject(contentIndex: number, value: JsonObject): boolean;
	/** Charge a native replacement retained without a preview delta. False means the stream already failed. */
	checkToolArgumentsObjectReplacement(contentIndex: number, value: JsonObject): boolean;
}

export interface ProviderStreamSink<TStop, TUsage> extends ProviderFragmentSink {
	/** Record the provider's raw stop reason. The runner maps the last one with `mapStopReason` after parsing. */
	stop(stop: TStop): void;
	/** Report raw provider usage. The runner maps it with `mapUsage` and records the result on the message. */
	usage(usage: TUsage): void;
}

export interface ProviderStreamContext<TApi extends Api, TOptions extends StreamOptions> {
	readonly model: Model<TApi>;
	readonly context: Context;
	/** Caller options with the runner's signal, which aborts on caller abort or a local stream failure. */
	readonly options: TOptions & { signal: AbortSignal };
	/** Fragment sink for providers that report diagnostics while sending. */
	readonly fragments: ProviderFragmentSink;
}

export interface ProviderSendAttempt {
	/** Zero-based attempt number. */
	readonly index: number;
	readonly signal: AbortSignal;
}

export interface ProviderSendResult<TBody> {
	/** Accepted response status and headers, passed to `onResponse`. */
	response?: ProviderResponse;
	body: TBody;
}

export interface ProviderRequest<TPayload, TBody> {
	/**
	 * The wire payload. The runner passes it through `onPayload` once, before the first attempt.
	 * A provider without a wire payload (such as a test double) leaves it undefined and gets no `onPayload` call.
	 */
	payload: TPayload;
	/** Tool results the payload serializes, passed to `onPayload`. */
	metadata?: ProviderPayloadMetadata;
	/**
	 * Send one attempt, resolving once the provider accepted the request and before any of its
	 * body is parsed. Throw on rejection; the runner retries retryable failures.
	 */
	send(payload: TPayload, attempt: ProviderSendAttempt): Promise<ProviderSendResult<TBody>>;
	/** Runs once before the terminal fragment, after success or failure. */
	finish?(): Promise<void>;
}

export type StopReasonMapping =
	| { stopReason: Extract<StopReason, "stop" | "length" | "toolUse"> }
	| { stopReason: Extract<StopReason, "error" | "aborted">; error: ProviderError };

/**
 * A provider supplies request building and fragment parsing, plus the mapping functions the
 * runner calls for stop reasons, usage, and errors. The runner owns the normalizer lifecycle,
 * abort mapping, retries, and the terminal fragment.
 */
export interface StreamProvider<TApi extends Api, TOptions extends StreamOptions, TPayload, TBody, TStop, TUsage> {
	buildRequest(
		ctx: ProviderStreamContext<TApi, TOptions>,
	): ProviderRequest<TPayload, TBody> | Promise<ProviderRequest<TPayload, TBody>>;
	/** Parse an accepted response into fragments. Return early once a tool-argument check fails. */
	parse(
		body: TBody,
		sink: ProviderStreamSink<TStop, TUsage>,
		ctx: ProviderStreamContext<TApi, TOptions>,
	): Promise<void>;
	/** Map the last recorded stop reason, or `undefined` when the provider reported none. */
	mapStopReason(stop: TStop | undefined, ctx: ProviderStreamContext<TApi, TOptions>): StopReasonMapping;
	mapUsage(usage: TUsage, ctx: ProviderStreamContext<TApi, TOptions>): Usage | undefined;
	/**
	 * Classify a thrown failure. Omit to use `classifyProviderError`. Failures thrown as
	 * `ProviderStreamError` keep their own classification.
	 */
	mapError?(error: unknown, ctx: ProviderStreamContext<TApi, TOptions>): ProviderError;
}

interface ProviderFailure {
	error: ProviderError;
	diagnostics?: AssistantMessageDiagnostic[];
	retryAfterMs: number | undefined;
}

/**
 * Create a stream function from a provider definition.
 *
 * Retry policy: only a failed `send` retries, never a response whose body is being parsed. A
 * failure retries when its error is `retryable`, up to `maxRetries` times (default 0). Each retry
 * waits the server-requested delay (`retry-after-ms` or `retry-after`), or 1s doubling per attempt.
 * Backoff is capped at `maxRetryDelayMs` (default 60s, 0 disables the cap); a server-requested
 * delay above the cap fails the stream immediately with the requested delay in its message.
 */
export function createProviderStream<TApi extends Api, TOptions extends StreamOptions, TPayload, TBody, TStop, TUsage>(
	provider: StreamProvider<TApi, TOptions, TPayload, TBody, TStop, TUsage>,
): StreamFunction<TApi, TOptions> {
	return (model, context, options): AssistantMessageEventStream => {
		const normalizer = new AssistantStreamNormalizer(options);
		const init: AssistantMessageInit = {
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: Date.now(),
		};
		if (!normalizer.validateConfiguration(init)) return normalizer.stream;
		void runProviderStream(provider, normalizer, init, model, context, options);
		return normalizer.stream;
	};
}

async function runProviderStream<TApi extends Api, TOptions extends StreamOptions, TPayload, TBody, TStop, TUsage>(
	provider: StreamProvider<TApi, TOptions, TPayload, TBody, TStop, TUsage>,
	normalizer: AssistantStreamNormalizer,
	init: AssistantMessageInit,
	model: Model<TApi>,
	context: Context,
	callerOptions: TOptions | undefined,
): Promise<void> {
	const signal = normalizer.signal;
	const options = { ...callerOptions, signal } as TOptions & { signal: AbortSignal };
	let started = false;
	const ensureStarted = () => {
		if (started) return;
		started = true;
		normalizer.push({ type: "start", init });
	};
	const fragments: ProviderFragmentSink = {
		push(fragment) {
			if (fragment.type === "start") started = true;
			else ensureStarted();
			normalizer.push(fragment);
		},
		checkToolArgumentsText: (contentIndex, text) => normalizer.checkToolArgumentsText(contentIndex, text),
		checkToolArgumentsObject: (contentIndex, value) => normalizer.checkToolArgumentsObject(contentIndex, value),
		checkToolArgumentsObjectReplacement: (contentIndex, value) =>
			normalizer.checkToolArgumentsObjectReplacement(contentIndex, value),
	};
	const ctx: ProviderStreamContext<TApi, TOptions> = { model, context, options, fragments };
	let stop: TStop | undefined;
	const sink: ProviderStreamSink<TStop, TUsage> = {
		...fragments,
		stop(value) {
			stop = value;
		},
		usage(raw) {
			const usage = provider.mapUsage(raw, ctx);
			if (usage) fragments.push({ type: "meta", patch: { usage } });
		},
	};
	const describeFailure = (error: unknown): ProviderFailure =>
		error instanceof ProviderStreamError
			? {
					error: error.providerError,
					...(error.diagnostics === undefined ? {} : { diagnostics: error.diagnostics }),
					retryAfterMs: error.retryAfterMs,
				}
			: { error: mapProviderError(provider, error, ctx), retryAfterMs: readRetryAfterMs(error) };

	let finish: (() => Promise<void>) | undefined;
	const runFinish = async () => {
		const pending = finish;
		finish = undefined;
		await pending?.();
	};
	try {
		const request = await provider.buildRequest(ctx);
		finish = request.finish?.bind(request);
		let payload = request.payload;
		const replacement =
			payload === undefined ? undefined : await options.onPayload?.(payload, model, request.metadata);
		if (replacement !== undefined) payload = replacement as TPayload;
		const sent = await sendWithRetry(request, payload, options, describeFailure);
		if (sent.response) await options.onResponse?.(sent.response, model);
		// Parse even after an abort: the provider observes the signal and releases what `send` acquired.
		await provider.parse(sent.body, sink, ctx);
		await runFinish();
		if (signal.aborted) throw new Error(ABORT_MESSAGE);
		const mapping = provider.mapStopReason(stop, ctx);
		ensureStarted();
		if (mapping.stopReason === "error" || mapping.stopReason === "aborted") {
			normalizer.push({ type: "error", reason: mapping.stopReason, error: mapping.error });
		} else {
			normalizer.push({ type: "done", reason: mapping.stopReason });
		}
	} catch (error) {
		try {
			await runFinish();
		} catch {
			// The original failure is the terminal cause.
		}
		ensureStarted();
		if (signal.aborted) {
			normalizer.push({ type: "error", reason: "aborted", error: createProviderError("aborted", ABORT_MESSAGE) });
		} else {
			const failure = describeFailure(error);
			normalizer.push({
				type: "error",
				reason: "error",
				error: failure.error,
				...(failure.diagnostics === undefined ? {} : { diagnostics: failure.diagnostics }),
			});
		}
	} finally {
		normalizer.end();
	}
}

/** A throwing `mapError` must not cost the stream its terminal; fall back to the shared classification. */
function mapProviderError<TApi extends Api, TOptions extends StreamOptions, TPayload, TBody, TStop, TUsage>(
	provider: StreamProvider<TApi, TOptions, TPayload, TBody, TStop, TUsage>,
	error: unknown,
	ctx: ProviderStreamContext<TApi, TOptions>,
): ProviderError {
	if (!provider.mapError) return classifyProviderError(error);
	try {
		return provider.mapError(error, ctx);
	} catch {
		return classifyProviderError(error);
	}
}

async function sendWithRetry<TPayload, TBody>(
	request: ProviderRequest<TPayload, TBody>,
	payload: TPayload,
	options: StreamOptions & { signal: AbortSignal },
	describeFailure: (error: unknown) => ProviderFailure,
): Promise<ProviderSendResult<TBody>> {
	const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 0));
	const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
	for (let attempt = 0; ; attempt++) {
		if (options.signal.aborted) throw new Error(ABORT_MESSAGE);
		try {
			return await request.send(payload, { index: attempt, signal: options.signal });
		} catch (error) {
			if (options.signal.aborted || attempt >= maxRetries) throw error;
			const failure = describeFailure(error);
			if (!failure.error.retryable) throw error;
			const delayMs = retryDelayMs(failure.retryAfterMs, attempt, maxRetryDelayMs);
			if (delayMs === undefined) {
				throw new ProviderStreamError(
					failure.error.kind,
					`${failure.error.message} (server requested a ${Math.ceil(failure.retryAfterMs! / 1000)}s retry delay, above maxRetryDelayMs ${maxRetryDelayMs}ms)`,
					{
						retryable: failure.error.retryable,
						...(failure.error.providerCode === undefined ? {} : { providerCode: failure.error.providerCode }),
						...(failure.diagnostics === undefined ? {} : { diagnostics: failure.diagnostics }),
						cause: error,
					},
				);
			}
			await sleep(delayMs, options.signal);
		}
	}
}

/** Delay before retry `attempt + 1`, or `undefined` when the server asks for longer than the cap. */
function retryDelayMs(retryAfterMs: number | undefined, attempt: number, maxRetryDelayMs: number): number | undefined {
	const cap = maxRetryDelayMs > 0 ? maxRetryDelayMs : Number.POSITIVE_INFINITY;
	if (retryAfterMs !== undefined) return retryAfterMs > cap ? undefined : retryAfterMs;
	return Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, cap);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error(ABORT_MESSAGE));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error(ABORT_MESSAGE));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
