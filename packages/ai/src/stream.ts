import "./providers/register-builtins.ts";

import { getApiProvider } from "./api-registry.ts";
import { getEnvApiKey } from "./env-api-keys.ts";
import { resolvePromptCacheRetention } from "./providers/prompt-cache.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	PromptCacheRefreshResult,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";
import { drainEventStream } from "./utils/event-stream.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

function hasExplicitApiKey(apiKey: string | undefined): apiKey is string {
	return typeof apiKey === "string" && apiKey.trim().length > 0;
}

function withEnvApiKey<TOptions extends StreamOptions>(
	model: Model<Api>,
	options: TOptions | undefined,
): TOptions | undefined {
	if (hasExplicitApiKey(options?.apiKey)) return options;
	const apiKey = getEnvApiKey(model.provider, options?.env);
	if (!apiKey) return options;
	return { ...options, apiKey } as TOptions;
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, withEnvApiKey(model, options) as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return drainEventStream(s);
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, withEnvApiKey(model, options));
}

/**
 * Whether `refreshPromptCache` can renew the prompt cache of `streamSimple(model, context, options)`:
 * its provider implements a no-output refresh for these options, the model documents a cache that
 * renews on hit, and caching is enabled. Sends nothing.
 */
export function supportsPromptCacheRefresh(model: Model<Api>, options?: SimpleStreamOptions): boolean {
	const provider = getApiProvider(model.api);
	if (!provider?.refreshPromptCache || model.promptCache?.refreshesOnHit !== true) return false;
	if (resolvePromptCacheRetention(model, options?.cacheRetention, options?.env) === "none") return false;
	return provider.canRefreshPromptCache?.(model, options) ?? true;
}

/**
 * Replay the request `streamSimple(model, context, options)` would send, without generating
 * output, so the provider renews its cached prefix. Returns "unsupported" instead of sending
 * anything when the model, provider, or cache settings cannot refresh that request.
 */
export async function refreshPromptCache<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<PromptCacheRefreshResult> {
	const refresh = resolveApiProvider(model.api).refreshPromptCache;
	if (!refresh || model.promptCache?.refreshesOnHit !== true) {
		return { status: "unsupported", reason: "model does not support prompt-cache refresh" };
	}
	if (resolvePromptCacheRetention(model, options?.cacheRetention, options?.env) === "none") {
		return { status: "unsupported", reason: "prompt caching is disabled" };
	}
	return await refresh(model, context, withEnvApiKey(model, options));
}

/**
 * Return the final message from the globally registered provider's simple stream.
 *
 * This does not apply a caller-owned or injected stream policy. Runtimes that own a stream function should invoke it
 * and await the stream's result instead.
 */
export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return drainEventStream(s);
}
