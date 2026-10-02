import OpenAI, { APIConnectionError, APIConnectionTimeoutError } from "openai";
import type { ResponseCreateParamsStreaming, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { clampThinkingLevel } from "../models.ts";
import { classifyProviderError, createProviderError, missingApiKeyError } from "../stream/provider-errors.ts";
import { createProviderStream } from "../stream/runner.ts";
import type {
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	Usage,
} from "../types.ts";
import { headersToRecord } from "../utils/headers.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { getFastInferenceServiceTier, getOpenAIPriorityCost } from "./openai-fast-inference.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	mapResponsesStopReason,
	mapResponsesUsage,
	processResponsesStream,
	type ResponsesStop,
	type ResponsesUsageReport,
	scaleCost,
} from "./openai-responses-shared.ts";
import { resolvePromptCacheRetention, supportsPromptCacheMode } from "./prompt-cache.ts";
import { buildBaseOptions } from "./simple-options.ts";
import { ToolResultPayloadTracker } from "./tool-result-payload.ts";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
	};
}

function getPromptCacheRetention(cacheRetention: CacheRetention): "24h" | undefined {
	return cacheRetention === "long" ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `OpenAI API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = createProviderStream<
	"openai-responses",
	OpenAIResponsesOptions,
	ResponseCreateParamsStreaming,
	AsyncIterable<ResponseStreamEvent>,
	ResponsesStop,
	ResponsesUsageReport
>({
	buildRequest({ model, context, options }) {
		const apiKey = options.apiKey;
		if (!apiKey) throw missingApiKeyError(model.provider);
		const cacheRetention = resolvePromptCacheRetention(model, options.cacheRetention, options.env);
		const cacheSessionId = cacheRetention === "none" ? undefined : options.sessionId;
		const client = createClient(model, context, apiKey, options.headers, cacheSessionId, options.env);
		const toolResultPayload = new ToolResultPayloadTracker();
		const payload = buildParams(model, context, options, toolResultPayload);
		return {
			payload,
			metadata: toolResultPayload.metadata,
			async send(params, { signal }) {
				const { data, response } = await client.responses
					.create(params, {
						signal,
						...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
						maxRetries: 0,
					})
					.withResponse();
				return { response: { status: response.status, headers: headersToRecord(response.headers) }, body: data };
			},
		};
	},

	async parse(openaiStream, sink) {
		await processResponsesStream(openaiStream, sink);
	},

	mapStopReason: mapResponsesStopReason,

	mapUsage: (report, { model, options }) =>
		mapResponsesUsage(report, model, {
			serviceTier: options.serviceTier,
			priceServiceTier: (usage, serviceTier) => priceServiceTier(usage, serviceTier, model),
		}),

	mapError(error) {
		const message = formatOpenAIResponsesError(error);
		if (error instanceof APIConnectionTimeoutError) return createProviderError("timeout", message);
		if (error instanceof APIConnectionError) return createProviderError("network", message);
		return classifyProviderError(error, { message });
	},
});

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	const apiKey = options?.apiKey;
	if (!apiKey) throw missingApiKeyError(model.provider);

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
		serviceTier: getFastInferenceServiceTier(model, options?.inferenceSpeed),
	} satisfies OpenAIResponsesOptions);
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
	env?: ProviderEnv,
) {
	const compat = getCompat(model);
	const headers = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${apiKey}`,
				}
			: headers;

	return new OpenAI({
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model, env) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});
}

function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	toolResultPayload: ToolResultPayloadTracker,
) {
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, { toolResultPayload });

	const cacheRetention = resolvePromptCacheRetention(model, options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && supportsPromptCacheMode(model, "explicit");
	const params: ResponseCreateParamsStreaming & { prompt_cache_options?: { mode: "explicit" } } = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(cacheRetention),
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : undefined,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<"openai-responses">, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

function priceServiceTier(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<"openai-responses">, "api" | "provider" | "baseUrl" | "id">,
): Usage["cost"] {
	const priorityCost = serviceTier === "priority" ? getOpenAIPriorityCost(usage, model) : undefined;
	return priorityCost ?? scaleCost(usage.cost, getServiceTierCostMultiplier(model, serviceTier));
}
