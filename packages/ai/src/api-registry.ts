import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	PromptCacheRefreshCheck,
	PromptCacheRefreshFunction,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.ts";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
	/** Optional no-output replay of a `streamSimple` request that renews the provider's prompt cache. */
	refreshPromptCache?: PromptCacheRefreshFunction<TApi>;
	/** Which request options `refreshPromptCache` can refresh; omitted means all of them. */
	canRefreshPromptCache?: PromptCacheRefreshCheck<TApi>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
	refreshPromptCache?: PromptCacheRefreshFunction;
	canRefreshPromptCache?: PromptCacheRefreshCheck;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

function wrapRefreshPromptCache<TApi extends Api>(
	api: TApi,
	refresh: PromptCacheRefreshFunction<TApi>,
): PromptCacheRefreshFunction {
	return async (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return await refresh(model as Model<TApi>, context, options);
	};
}

function wrapCanRefreshPromptCache<TApi extends Api>(
	api: TApi,
	canRefresh: PromptCacheRefreshCheck<TApi>,
): PromptCacheRefreshCheck {
	return (model, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return canRefresh(model as Model<TApi>, options);
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
			...(provider.refreshPromptCache
				? { refreshPromptCache: wrapRefreshPromptCache(provider.api, provider.refreshPromptCache) }
				: {}),
			...(provider.canRefreshPromptCache
				? { canRefreshPromptCache: wrapCanRefreshPromptCache(provider.api, provider.canRefreshPromptCache) }
				: {}),
		},
		sourceId,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}
