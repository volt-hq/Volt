import { resolvePromptCacheRetention } from "./providers/prompt-cache.ts";
import { AssistantStreamNormalizer } from "./stream/normalizer.ts";
import { classifyProviderError, createProviderError, ProviderStreamError } from "./stream/provider-errors.ts";
import type {
	Api,
	AssistantImages,
	AssistantMessage,
	Context,
	ImagesApi,
	ImagesContext,
	ImagesModel,
	ImagesOptions,
	Model,
	PromptCacheRefreshResult,
	ProviderEnv,
	ProviderError,
	ProviderImagesOptions,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";
import { AssistantMessageEventStream, drainEventStream, EventStreamOverflowError } from "./utils/event-stream.ts";
import type { OAuthProviderInterface } from "./utils/oauth/types.ts";

/**
 * Streams requests for models whose `api` equals `api`.
 *
 * Contract: once invoked, request, model, and runtime failures are encoded in the returned stream,
 * terminating with an `error` event whose message carries a typed `error`.
 */
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	readonly api: TApi;
	stream(model: Model<TApi>, context: Context, options?: TOptions): AssistantMessageEventStream;
	streamSimple(model: Model<TApi>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
	/**
	 * No-output replay of a `streamSimple` request that renews the provider's prompt cache. Builds the
	 * same payload as `streamSimple`, returns "unsupported" instead of sending a normal inference request,
	 * and throws on transport, authentication, or provider errors.
	 */
	refreshPromptCache?(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<PromptCacheRefreshResult>;
	/** Which request options `refreshPromptCache` can refresh, decided without sending anything; omitted means all. */
	canRefreshPromptCache?(model: Model<TApi>, options?: SimpleStreamOptions): boolean;
}

/** Generates images for models whose `api` equals `api`. */
export interface ImagesApiProvider<TApi extends ImagesApi = ImagesApi, TOptions extends ImagesOptions = ImagesOptions> {
	readonly api: TApi;
	generateImages(model: ImagesModel<TApi>, context: ImagesContext, options?: TOptions): Promise<AssistantImages>;
}

/** Credentials for one request. Request options take precedence: `apiKey` fills a request without one, and `headers` and `env` merge under the request's own per key. */
export interface Credentials {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: ProviderEnv;
}

export interface CredentialRequest {
	/** The requested model; `model.provider` names the provider whose credentials are needed. */
	readonly model: Model<Api> | ImagesModel<ImagesApi>;
	/** Aborts with the request. */
	readonly signal?: AbortSignal;
}

/**
 * Resolves an API key, request headers, or OAuth access for a provider and model. A client consults
 * its source before each request. Resolve `undefined` when nothing is configured; reject to fail the
 * request, which is reported as an `auth` error (or `aborted` when the request's signal aborted).
 */
export interface CredentialSource {
	resolve(request: CredentialRequest): Promise<Credentials | undefined>;
}

/** Prompt-cache refresh of `streamSimple` requests. `AiClient` implements it. */
export interface PromptCacheRefresher {
	/**
	 * Whether `refreshPromptCache` can renew the prompt cache of `streamSimple(model, context, options)`:
	 * the provider implements a no-output refresh for these options, the model documents a cache that
	 * renews on hit, and caching is enabled. Sends nothing.
	 */
	supportsPromptCacheRefresh(model: Model<Api>, options?: SimpleStreamOptions): boolean;
	/**
	 * Replay the request `streamSimple(model, context, options)` would send, without generating output,
	 * so the provider renews its cached prefix. Returns "unsupported" instead of sending anything when the
	 * model, provider, or cache settings cannot refresh that request.
	 */
	refreshPromptCache(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<PromptCacheRefreshResult>;
}

export interface AiClientOptions {
	/** API implementations. `builtInProviders()` supplies the built-in APIs. */
	providers?: readonly ApiProvider[];
	/** Model catalog. `builtInModels()` supplies the generated catalog. */
	models?: readonly Model<Api>[];
	/** OAuth login and refresh implementations. `builtInOAuthProviders()` from `@hansjm10/volt-ai/oauth` supplies the built-ins. */
	oauthProviders?: readonly OAuthProviderInterface[];
	/** Image generation implementations. `builtInImagesProviders()` supplies the built-ins. */
	imagesProviders?: readonly ImagesApiProvider[];
	/** Consulted before each request. Without one, requests use only the credentials in their options. */
	credentials?: CredentialSource;
}

/**
 * An LLM client that owns its API-provider registry, model catalog, OAuth-provider registry, and
 * image-provider registry. Clients share no state. Methods are bound and safe to pass as functions.
 */
export interface AiClient extends PromptCacheRefresher {
	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ProviderStreamOptions,
	): AssistantMessageEventStream;
	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ProviderStreamOptions,
	): Promise<AssistantMessage>;
	streamSimple<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream;
	completeSimple<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: SimpleStreamOptions,
	): Promise<AssistantMessage>;
	generateImages<TApi extends ImagesApi>(
		model: ImagesModel<TApi>,
		context: ImagesContext,
		options?: ProviderImagesOptions,
	): Promise<AssistantImages>;

	/** Register an API implementation, replacing any registered for the same `api`. */
	registerProvider(provider: ApiProvider): void;
	unregisterProvider(api: Api): void;
	getProvider(api: Api): ApiProvider | undefined;
	getProviders(): ApiProvider[];

	/** Register an image generation implementation, replacing any registered for the same `api`. */
	registerImagesProvider(provider: ImagesApiProvider): void;
	unregisterImagesProvider(api: ImagesApi): void;

	getModel(provider: string, modelId: string): Model<Api> | undefined;
	/** Catalog models in catalog order, or only those of `provider`. */
	getModels(provider?: string): Model<Api>[];
	/** Replace the model catalog. */
	setModels(models: readonly Model<Api>[]): void;

	/** Register an OAuth implementation, replacing any registered with the same `id`. */
	registerOAuthProvider(provider: OAuthProviderInterface): void;
	unregisterOAuthProvider(id: string): void;
	getOAuthProvider(id: string): OAuthProviderInterface | undefined;
	getOAuthProviders(): OAuthProviderInterface[];
}

const ABORT_MESSAGE = "Request was aborted";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A stream holding only a failed terminal for a request that never reached its provider. */
function failedStream(
	model: Model<Api>,
	reason: "error" | "aborted",
	error: ProviderError,
): AssistantMessageEventStream {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({
		type: "start",
		init: { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() },
	});
	normalizer.push({ type: "error", reason, error });
	return normalizer.stream;
}

/** Forward every event, and the final message of a source that ended without a terminal event. */
async function forwardStream(target: AssistantMessageEventStream, source: AssistantMessageEventStream) {
	for await (const event of source) {
		target.push(event);
	}
	target.end(await source.result());
}

/** Fill the request options with resolved credentials; options the request sets take precedence. */
function withCredentials<TOptions extends { apiKey?: string; headers?: Record<string, string>; env?: ProviderEnv }>(
	options: TOptions | undefined,
	credentials: Credentials | undefined,
): TOptions | undefined {
	if (!credentials) return options;
	return {
		...options,
		...(options?.apiKey !== undefined || credentials.apiKey === undefined ? {} : { apiKey: credentials.apiKey }),
		...(credentials.headers === undefined ? {} : { headers: { ...credentials.headers, ...options?.headers } }),
		...(credentials.env === undefined ? {} : { env: { ...credentials.env, ...options?.env } }),
	} as TOptions;
}

export function createAiClient(options: AiClientOptions = {}): AiClient {
	const providers = new Map<string, ApiProvider>();
	const imagesProviders = new Map<string, ImagesApiProvider>();
	const oauthProviders = new Map<string, OAuthProviderInterface>();
	let models: Model<Api>[] = [...(options.models ?? [])];
	const credentials = options.credentials;

	for (const provider of options.providers ?? []) providers.set(provider.api, provider);
	for (const provider of options.imagesProviders ?? []) imagesProviders.set(provider.api, provider);
	for (const provider of options.oauthProviders ?? []) oauthProviders.set(provider.id, provider);

	const requireProvider = (api: Api): ApiProvider => {
		const provider = providers.get(api);
		if (!provider) throw new Error(`No API provider registered for api: ${api}`);
		return provider;
	};

	/**
	 * Start a provider stream after consulting the credential source. Without a source the provider is
	 * called directly; otherwise its events are forwarded once credentials resolve.
	 */
	const streamWithCredentials = <TOptions extends StreamOptions>(
		model: Model<Api>,
		requestOptions: TOptions | undefined,
		start: (options: TOptions | undefined) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		if (!credentials) return start(requestOptions);
		const signal = requestOptions?.signal;
		const outer = new AssistantMessageEventStream();
		const controller = new AbortController();
		const aborted = () => failedStream(model, "aborted", createProviderError("aborted", ABORT_MESSAGE));
		const open = async (): Promise<AssistantMessageEventStream> => {
			let resolved: Credentials | undefined;
			try {
				resolved = await credentials.resolve({ model, ...(signal === undefined ? {} : { signal }) });
			} catch (error) {
				return signal?.aborted
					? aborted()
					: failedStream(model, "error", createProviderError("auth", errorMessage(error)));
			}
			if (signal?.aborted) return aborted();
			const providerSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			try {
				return start(withCredentials({ ...requestOptions, signal: providerSignal } as TOptions, resolved));
			} catch (error) {
				return failedStream(model, "error", classifyProviderError(error));
			}
		};
		void (async () => {
			const inner = await open();
			try {
				await forwardStream(outer, inner);
			} catch (error) {
				// The consumer stopped keeping up, or the provider broke its stream contract.
				controller.abort(error);
				if (error instanceof EventStreamOverflowError) return;
				try {
					await forwardStream(outer, failedStream(model, "error", classifyProviderError(error)));
				} catch (overflow) {
					if (!(overflow instanceof EventStreamOverflowError)) throw overflow;
				}
			}
		})();
		return outer;
	};

	const resolveCredentials = async (
		model: Model<Api> | ImagesModel<ImagesApi>,
		signal: AbortSignal | undefined,
	): Promise<Credentials | undefined> =>
		credentials ? await credentials.resolve({ model, ...(signal === undefined ? {} : { signal }) }) : undefined;

	const client: AiClient = {
		stream(model, context, requestOptions) {
			const provider = requireProvider(model.api);
			return streamWithCredentials(model, requestOptions, (resolved) => provider.stream(model, context, resolved));
		},
		async complete(model, context, requestOptions) {
			return drainEventStream(client.stream(model, context, requestOptions));
		},
		streamSimple(model, context, requestOptions) {
			const provider = requireProvider(model.api);
			return streamWithCredentials(model, requestOptions, (resolved) =>
				provider.streamSimple(model, context, resolved),
			);
		},
		async completeSimple(model, context, requestOptions) {
			return drainEventStream(client.streamSimple(model, context, requestOptions));
		},
		supportsPromptCacheRefresh(model, requestOptions) {
			const provider = providers.get(model.api);
			if (!provider?.refreshPromptCache || model.promptCache?.refreshesOnHit !== true) return false;
			if (resolvePromptCacheRetention(model, requestOptions?.cacheRetention, requestOptions?.env) === "none") {
				return false;
			}
			return provider.canRefreshPromptCache?.(model, requestOptions) ?? true;
		},
		async refreshPromptCache(model, context, requestOptions) {
			const provider = requireProvider(model.api);
			if (!provider.refreshPromptCache || model.promptCache?.refreshesOnHit !== true) {
				return { status: "unsupported", reason: "model does not support prompt-cache refresh" };
			}
			if (resolvePromptCacheRetention(model, requestOptions?.cacheRetention, requestOptions?.env) === "none") {
				return { status: "unsupported", reason: "prompt caching is disabled" };
			}
			let resolved: Credentials | undefined;
			try {
				resolved = await resolveCredentials(model, requestOptions?.signal);
			} catch (error) {
				requestOptions?.signal?.throwIfAborted();
				throw new ProviderStreamError("auth", errorMessage(error), { cause: error });
			}
			return await provider.refreshPromptCache(model, context, withCredentials(requestOptions, resolved));
		},
		async generateImages(model, context, requestOptions) {
			const provider = imagesProviders.get(model.api);
			if (!provider) throw new Error(`No API provider registered for api: ${model.api}`);
			let resolved: Credentials | undefined;
			try {
				resolved = await resolveCredentials(model, requestOptions?.signal);
			} catch (error) {
				return {
					api: model.api,
					provider: model.provider,
					model: model.id,
					output: [],
					stopReason: requestOptions?.signal?.aborted ? "aborted" : "error",
					errorMessage: requestOptions?.signal?.aborted ? ABORT_MESSAGE : errorMessage(error),
					timestamp: Date.now(),
				};
			}
			return await provider.generateImages(model, context, withCredentials(requestOptions, resolved));
		},

		registerProvider(provider) {
			providers.set(provider.api, provider);
		},
		unregisterProvider(api) {
			providers.delete(api);
		},
		getProvider(api) {
			return providers.get(api);
		},
		getProviders() {
			return [...providers.values()];
		},

		registerImagesProvider(provider) {
			imagesProviders.set(provider.api, provider);
		},
		unregisterImagesProvider(api) {
			imagesProviders.delete(api);
		},

		getModel(provider, modelId) {
			return models.find((model) => model.provider === provider && model.id === modelId);
		},
		getModels(provider) {
			return provider === undefined ? [...models] : models.filter((model) => model.provider === provider);
		},
		setModels(next) {
			models = [...next];
		},

		registerOAuthProvider(provider) {
			oauthProviders.set(provider.id, provider);
		},
		unregisterOAuthProvider(id) {
			oauthProviders.delete(id);
		},
		getOAuthProvider(id) {
			return oauthProviders.get(id);
		},
		getOAuthProviders() {
			return [...oauthProviders.values()];
		},
	};
	return client;
}
