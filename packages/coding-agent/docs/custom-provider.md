# Custom Providers

Extensions can register custom model providers via `volt.registerProvider()`. This enables:

- **Proxies** - Route requests through corporate proxies or API gateways
- **Custom endpoints** - Use self-hosted or private model deployments
- **OAuth/SSO** - Add authentication flows for enterprise providers
- **Custom APIs** - Implement streaming for non-standard LLM APIs

## Example Extensions

See these complete provider examples:

- [`examples/extensions/custom-provider-anthropic/`](../examples/extensions/custom-provider-anthropic/)
- [`examples/extensions/custom-provider-gitlab-duo/`](../examples/extensions/custom-provider-gitlab-duo/)

## Table of Contents

- [Example Extensions](#example-extensions)
- [Quick Reference](#quick-reference)
- [Override Existing Provider](#override-existing-provider)
- [Register New Provider](#register-new-provider)
- [Unregister Provider](#unregister-provider)
- [OAuth Support](#oauth-support)
- [Custom Streaming API](#custom-streaming-api)
- [Context Overflow Errors](#context-overflow-errors)
- [Testing Your Implementation](#testing-your-implementation)
- [Config Reference](#config-reference)
- [Model Definition Reference](#model-definition-reference)

## Quick Reference

```typescript
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";

export default function (volt: ExtensionAPI) {
  // Override baseUrl for existing provider
  volt.registerProvider("anthropic", {
    baseUrl: "https://proxy.example.com"
  });

  // Register new provider with models
  volt.registerProvider("my-provider", {
    name: "My Provider",
    baseUrl: "https://api.example.com",
    apiKey: "$MY_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "my-model",
        name: "My Model",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096
      }
    ]
  });
}
```

The extension factory can also be `async`. For dynamic model discovery, fetch and register models in the factory instead of `session_start`. volt waits for the factory before startup continues, so the provider is available during interactive startup and to `volt --list-models`.

## Override Existing Provider

The simplest use case: redirect an existing provider through a proxy.

```typescript
// All Anthropic requests now go through your proxy
volt.registerProvider("anthropic", {
  baseUrl: "https://proxy.example.com"
});

// Add custom headers to OpenAI requests
volt.registerProvider("openai", {
  headers: {
    "X-Custom-Header": "value"
  }
});

// Both baseUrl and headers
volt.registerProvider("google", {
  baseUrl: "https://ai-gateway.corp.com/google",
  headers: {
    "X-Corp-Auth": "$CORP_AUTH_TOKEN"  // env var or literal
  }
});
```

When only `baseUrl` and/or `headers` are provided (no `models`), all existing models for that provider are preserved with the new endpoint.

## Register New Provider

To add a completely new provider, specify `models` along with the required configuration.

If the model list comes from a remote endpoint, use an async extension factory:

```typescript
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";

export default async function (volt: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_window?: number;
      max_tokens?: number;
    }>;
  };

  volt.registerProvider("local-openai", {
    baseUrl: "http://localhost:1234/v1",
    apiKey: "$LOCAL_OPENAI_API_KEY",
    api: "openai-completions",
    models: payload.data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.context_window ?? 128000,
      maxTokens: model.max_tokens ?? 4096,
    })),
  });
}
```

This registers the fetched models before startup finishes.

```typescript
volt.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",  // env var reference
  api: "openai-completions",  // which streaming API to use
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,        // supports extended thinking
      input: ["text", "image"],
      cost: {
        input: 3.0,           // $/million tokens
        output: 15.0,
        cacheRead: 0.3,
        cacheWrite: 3.75
      },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});
```

When `models` is provided, it **replaces** all existing models for that provider.

`apiKey` and custom header values use the same config value syntax as `models.json`: `!command` at the start executes a command for the whole value, `$ENV_VAR` and `${ENV_VAR}` interpolate environment variables, `$$` emits a literal `$`, and `$!` emits a literal `!`.

## Unregister Provider

Use `volt.unregisterProvider(name)` to remove a provider that was previously registered via `volt.registerProvider(name, ...)`:

```typescript
// Register
volt.registerProvider("my-llm", {
  baseUrl: "https://api.my-llm.com/v1",
  apiKey: "$MY_LLM_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "my-llm-large",
      name: "My LLM Large",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 3.75 },
      contextWindow: 200000,
      maxTokens: 16384
    }
  ]
});

// Later, remove it
volt.unregisterProvider("my-llm");
```

Unregistering removes that provider's dynamic models, API key fallback, OAuth provider registration, and custom stream handler registrations. Any built-in models or provider behavior that were overridden are restored.

Calls made after the initial extension load phase are applied immediately, so no `/reload` is required.

### API Types

The `api` field determines which streaming implementation is used:

| API | Use for |
|-----|---------|
| `anthropic-messages` | Anthropic Claude API and compatibles |
| `openai-completions` | OpenAI Chat Completions API and compatibles |
| `openai-responses` | OpenAI Responses API |
| `azure-openai-responses` | Azure OpenAI Responses API |
| `openai-codex-responses` | OpenAI Codex Responses API |
| `mistral-conversations` | Mistral SDK Conversations/Chat streaming |
| `google-generative-ai` | Google Generative AI API |
| `google-vertex` | Google Vertex AI API |
| `bedrock-converse-stream` | Amazon Bedrock Converse API |

Most OpenAI-compatible providers work with `openai-completions`. Use model-level `thinkingLevelMap` for model-specific thinking levels, and `compat` for provider quirks:

```typescript
models: [{
  id: "custom-model",
  // ...
  reasoning: true,
  thinkingLevelMap: {              // map volt levels to provider values; null hides unsupported levels
    minimal: null,
    low: null,
    medium: null,
    high: "default",
    xhigh: null,
    max: "max"
  },
  compat: {
    supportsDeveloperRole: false,   // use "system" instead of "developer"
    supportsReasoningEffort: true,
    maxTokensField: "max_tokens",   // instead of "max_completion_tokens"
    requiresToolResultName: true,   // tool results need name field
    thinkingFormat: "qwen",        // top-level enable_thinking: true
    cacheControlFormat: "anthropic" // Anthropic-style cache_control markers
  }
}]
```

Use `openrouter` for OpenRouter-style `reasoning: { effort }` controls. Use `together` for Together-style `reasoning: { enabled }` controls; with `supportsReasoningEffort`, it also sends `reasoning_effort`. Use `qwen-chat-template` instead for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking`.
Use `cacheControlFormat: "anthropic"` for OpenAI-compatible providers that expose Anthropic-style prompt caching via `cache_control` on the system prompt, last tool definition, and last user/assistant text content.

For Anthropic-compatible providers using `api: "anthropic-messages"`, set `compat.forceAdaptiveThinking: true` on models or providers whose upstream model requires adaptive thinking (`thinking.type: "adaptive"` plus `output_config.effort`). Built-in adaptive Claude models set this automatically. Set `compat.allowEmptySignature: true` only for providers that emit empty thinking signatures and expect `signature: ""` on replay.

> Migration note: Mistral moved from `openai-completions` to `mistral-conversations`.
> Use `mistral-conversations` for native Mistral models.
> If you intentionally route Mistral-compatible/custom endpoints through `openai-completions`, set `compat` flags explicitly as needed.

### Auth Header

If your provider expects `Authorization: Bearer <key>` but doesn't use a standard API, set `authHeader: true`:

```typescript
volt.registerProvider("custom-api", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  authHeader: true,  // adds Authorization: Bearer header
  api: "openai-completions",
  models: [...]
});
```

## OAuth Support

Add OAuth/SSO authentication that integrates with `/login`:

```typescript
import type { OAuthCredentials, OAuthLoginCallbacks } from "@hansjm10/volt-ai";

volt.registerProvider("corporate-ai", {
  baseUrl: "https://ai.corp.com/v1",
  api: "openai-responses",
  models: [...],
  oauth: {
    name: "Corporate AI (SSO)",

    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const method = await callbacks.onSelect({
        message: "Select login method:",
        options: [
          { id: "browser", label: "Browser OAuth" },
          { id: "device", label: "Device code" }
        ]
      });
      if (!method) throw new Error("Login cancelled");

      let code: string;
      if (method === "device") {
        callbacks.onDeviceCode({
          userCode: "ABCD-1234",
          verificationUri: "https://sso.corp.com/device",
          intervalSeconds: 5,
          expiresInSeconds: 900
        });
        code = await pollDeviceCodeUntilComplete();
      } else {
        callbacks.onAuth({ url: "https://sso.corp.com/authorize?..." });
        code = await callbacks.onPrompt({ message: "Enter SSO code:" });
      }

      // Exchange for tokens (your implementation)
      const tokens = await exchangeCodeForTokens(code);

      return {
        refresh: tokens.refreshToken,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
      const tokens = await refreshAccessToken(credentials.refresh);
      return {
        refresh: tokens.refreshToken ?? credentials.refresh,
        access: tokens.accessToken,
        expires: Date.now() + tokens.expiresIn * 1000
      };
    },

    getApiKey(credentials: OAuthCredentials): string {
      return credentials.access;
    },

    // Optional: expose normalized quota windows through /usage
    async fetchSubscriptionUsage(credentials, options) {
      return fetchCorporateUsage(credentials.access, options?.signal);
    },

    // Optional: modify models based on user's subscription
    modifyModels(models, credentials) {
      const region = decodeRegionFromToken(credentials.access);
      return models.map(m => ({
        ...m,
        baseUrl: `https://${region}.ai.corp.com/v1`
      }));
    }
  }
});
```

After registration, users can authenticate via `/login corporate-ai`. If `fetchSubscriptionUsage` is provided, stored OAuth credentials for the provider also appear in `/usage`. The callback must return `SubscriptionUsageResult`: either a provider-neutral snapshot or a safe categorized error. Snapshot percentages are used percentages clamped to 0–100, timestamps are epoch milliseconds, and raw provider payloads or identity fields must not be returned.

### OAuthLoginCallbacks

The `callbacks` object provides three ways to authenticate:

```typescript
interface OAuthLoginCallbacks {
  // Open URL in browser (for OAuth redirects)
  onAuth(params: { url: string }): void;

  // Show device code (for device authorization flow)
  onDeviceCode(params: {
    userCode: string;
    verificationUri: string;
    intervalSeconds?: number;
    expiresInSeconds?: number;
  }): void;

  // Prompt user for input (for manual token entry)
  onPrompt(params: { message: string }): Promise<string>;

  // Show an interactive selector, e.g. to choose browser OAuth vs device code
  onSelect(params: {
    message: string;
    options: { id: string; label: string }[];
  }): Promise<string | undefined>;
}
```

### OAuthCredentials

Credentials are persisted in `~/.volt/agent/auth.json`:

```typescript
interface OAuthCredentials {
  refresh: string;   // Refresh token (for refreshToken())
  access: string;    // Access token (returned by getApiKey())
  expires: number;   // Expiration timestamp in milliseconds
}
```

## Custom Streaming API

For providers with non-standard APIs, implement `streamSimple`. Study the existing provider implementations before writing your own:

**Reference implementations:**
- [anthropic.ts](../../ai/src/providers/anthropic.ts) - Anthropic Messages API
- [mistral.ts](../../ai/src/providers/mistral.ts) - Mistral Conversations API
- [openai-completions.ts](../../ai/src/providers/openai-completions.ts) - OpenAI Chat Completions
- [openai-responses.ts](../../ai/src/providers/openai-responses.ts) - OpenAI Responses API
- [google.ts](../../ai/src/providers/google.ts) - Google Generative AI
- [amazon-bedrock.ts](../../ai/src/providers/amazon-bedrock.ts) - AWS Bedrock

### Stream Pattern

Custom providers implement only request building and fragment parsing. Pass a `StreamProvider` definition to `createProviderStream`; the shared runner owns the event stream and `AssistantStreamNormalizer` (the only component that builds an `AssistantMessage`), the `onPayload` and `onResponse` hooks, abort mapping, the retry policy, and the terminal `done` or `error` event.

```typescript
import {
  type Api,
  type SimpleStreamOptions,
  type Usage,
  calculateCost,
  createProviderError,
  createProviderStream,
} from "@hansjm10/volt-ai";

interface MyEvent { type: string; text?: string; finish?: string; usage?: { input: number; output: number } }

const streamMyProvider = createProviderStream<
  Api,
  SimpleStreamOptions,
  MyRequestBody,                 // wire payload
  AsyncIterable<MyEvent>,        // accepted response body
  string,                        // raw stop reason
  { input: number; output: number } // raw usage
>({
  buildRequest({ model, context, options }) {
    const payload = toMyRequestBody(model, context, options);
    return {
      payload,
      // One attempt. Throw on a rejected request; the runner retries retryable failures.
      async send(body, { signal }) {
        const response = await fetch(`${model.baseUrl}/v1/stream`, {
          method: "POST",
          headers: { Authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          // Status and headers drive the typed error and `retry-after` handling.
          throw Object.assign(new Error(await response.text()), { status: response.status, headers: response.headers });
        }
        return { response: { status: response.status, headers: {} }, body: parseMyEvents(response) };
      },
    };
  },

  async parse(events, sink) {
    for await (const event of events) {
      if (event.text) {
        // Push text/thinking/tool-call fragments as they arrive (see below).
      }
      if (event.usage) sink.usage(event.usage);
      if (event.finish) sink.stop(event.finish);
    }
  },

  mapStopReason: (finish) =>
    finish === "stop" || finish === undefined
      ? { stopReason: "stop" }
      : finish === "length"
        ? { stopReason: "length" }
        : { stopReason: "error", error: createProviderError("refusal", `Provider finish reason: ${finish}`) },

  mapUsage: (counts, { model }): Usage => ({
    ...counts,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: counts.input + counts.output,
    cost: calculateCost(model, { ...counts, cacheRead: 0, cacheWrite: 0 }),
  }),
});
```

The runner starts the message on the first fragment, maps any failure under an aborted signal to `stopReason: "aborted"`, and turns every other failure into a typed `error` on the assistant message: `{ kind, retryable, providerCode?, message }`. Failures carrying an HTTP `status` (and an optional provider `code` or `type`) are classified by `classifyProviderError`; supply `mapError` for provider-specific failures, or throw `new ProviderStreamError(kind, message)` where the provider already knows the classification. Only a failed `send` with a retryable error retries, up to `maxRetries`.

### Replayed context and payload delivery

The `context` a provider receives is already replayed: Volt applies `applyReplayPolicy` from `@hansjm10/volt-ai` before each request, so errored and aborted turns are gone, rejected tool calls are explained, and every tool call has a result. Apply only model-dependent normalization, such as tool call ID formats, and serialize every message, including every tool result, into the payload.

Return the serialized payload from `buildRequest`; the runner calls `options.onPayload(payload, model)` once before the first attempt. Volt treats the tool results of the replayed context as delivered, and clears background-job notices, only after the payload hook left the payload unchanged and the response completed successfully. A provider without a wire payload gets no `onPayload` call, which leaves notices visible; it does not fail inference. See [Background jobs](usage.md#background-jobs).

### Fragment Types

Push fragments via `sink.push()` in `parse`:

1. Optional `{ type: "meta", patch }` fragments - Fold response ID/model or diagnostics into subsequent snapshots. Report usage with `sink.usage()` instead.

2. Content fragments (repeatable; `contentIndex` must be dense: `0`, `1`, `2`, ...):
   - `{ type: "text_start", contentIndex }`
   - `{ type: "text_delta", contentIndex, delta }`
   - `{ type: "text_end", contentIndex, content?, textSignature? }`
   - `{ type: "thinking_start", contentIndex, content?, thinkingSignature?, redacted? }`
   - `{ type: "thinking_delta", contentIndex, delta, signatureDelta? }`
   - `{ type: "thinking_end", contentIndex, content?, thinkingSignature?, redacted? }`
   - `{ type: "toolcall_start", contentIndex, id?, name? }`
   - `{ type: "toolcall_delta", contentIndex, argsTextDelta, id?, name? }`
   - `{ type: "toolcall_end", contentIndex, toolCall?, thoughtSignature? }`

3. `sink.stop(raw)` records the provider's stop reason; the runner maps the last one with `mapStopReason` and emits the terminal event.

The runner emits `start` before the first fragment; a provider that needs a different `init` (timestamp, response ID) may push its own `{ type: "start", init }` first. If a `sink.check*` method returns `false`, a local tool-argument limit already failed the stream; return from `parse`.

Provider code should retain only protocol bookkeeping such as raw-index-to-dense-index maps and late tool identity. Do not build an `AssistantMessage`, retain content strings, or add private `partialJson` / `partialArgs` fields; the normalizer owns that state.

### Content Blocks

Allocate a dense index when the provider announces a block, then forward its deltas:

```typescript
let nextContentIndex = 0;
const contentIndex = nextContentIndex++;

sink.push({ type: "text_start", contentIndex });
sink.push({ type: "text_delta", contentIndex, delta });
sink.push({ type: "text_end", contentIndex });
```

If the upstream API has sparse or out-of-order block indexes, map them to dense indexes locally:

```typescript
const blocksByRawIndex = new Map<number, number>();

function registerBlock(rawIndex: number): number {
  const contentIndex = nextContentIndex++;
  blocksByRawIndex.set(rawIndex, contentIndex);
  return contentIndex;
}
```

An optional `content` on `text_end` / `thinking_end` is authoritative. Use it when the provider's final value can replace rather than append to streamed deltas.

### Tool Calls

The normalizer accumulates and incrementally parses tool argument JSON. Providers only forward raw argument text:

```typescript
const contentIndex = nextContentIndex++;

sink.push({
  type: "toolcall_start",
  contentIndex,
  id: toolCallId,
  name: toolName,
});

sink.push({
  type: "toolcall_delta",
  contentIndex,
  argsTextDelta: jsonDelta,
});

sink.push({
  type: "toolcall_end",
  contentIndex,
});
```

If a tool call starts with pre-seeded arguments, serialize them and emit that string as the immediate first `toolcall_delta`. If the provider supplies a final argument object that is not guaranteed to be an append of prior deltas, pass a complete authoritative `toolCall` on `toolcall_end`:

```typescript
sink.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: {
    type: "toolCall",
    id: toolCallId,
    name: toolName,
    arguments: finalArguments,
  },
});
```

When identity arrives late, include the newly known `id` / `name` on the next `toolcall_delta`; the normalizer patches the block without provider-side mutation.

### Usage and Cost

Report raw usage with `sink.usage(raw)` whenever the provider sends it. The runner maps it with your `mapUsage` hook and folds the result into subsequent snapshots. `calculateCost` derives a new cost from the token counts and the model's price table, records the table's `priceVersion`, and never modifies its input:

```typescript
mapUsage: (raw, { model }) => {
  const counts = {
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_tokens ?? 0,
    cacheWrite: raw.cache_write_tokens ?? 0,
  };
  return {
    ...counts,
    totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
    cost: calculateCost(model, counts),
  };
},
```

### Context Overflow Errors

When a request exceeds the model's context window, volt can recover automatically by compacting the conversation and retrying. This recovery only kicks in when the failed assistant message's error has `kind: "context_overflow"`.

The shared classification sets that kind for HTTP 413, for provider codes such as `context_length_exceeded` and `request_too_large`, and for the overflow messages of known OpenAI-compatible backends (see [`packages/ai/src/utils/overflow.ts`](../../ai/src/utils/overflow.ts)). If your provider reports overflow differently, classify it in the provider itself:

```typescript
mapError(error, ctx) {
  const classified = classifyProviderError(error);
  return MY_PROVIDER_OVERFLOW_CODE === (error as { code?: string }).code
    ? createProviderError("context_overflow", classified.message, { providerCode: MY_PROVIDER_OVERFLOW_CODE })
    : classified;
},
```

or throw `new ProviderStreamError("context_overflow", message)` from `send` or `parse`. With this in place, volt will:

1. Detect the overflow from `error.kind`.
2. Drop the failed assistant message from live context.
3. Run compaction.
4. Retry the request once.

Classify only your provider's own overflow signal. Rate-limit and throttling failures must stay `rate_limit` so volt retries them with backoff instead of compacting.

### Registration

Register your stream function:

```typescript
volt.registerProvider("my-provider", {
  baseUrl: "https://api.example.com",
  apiKey: "$MY_API_KEY",
  api: "my-custom-api",
  models: [...],
  streamSimple: streamMyProvider
});
```

## Testing Your Implementation

Test your provider against the same test suites used by built-in providers. Copy and adapt these test files from [packages/ai/test/](../../ai/test):

| Test | Purpose |
|------|---------|
| `stream.test.ts` | Basic streaming, text output |
| `tokens.test.ts` | Token counting and usage |
| `abort.test.ts` | AbortSignal handling |
| `empty.test.ts` | Empty/minimal responses |
| `context-overflow.test.ts` | Context window limits |
| `image-limits.test.ts` | Image input handling |
| `unicode-surrogate.test.ts` | Unicode edge cases |
| `tool-call-without-result.test.ts` | Tool call edge cases |
| `image-tool-result.test.ts` | Images in tool results |
| `total-tokens.test.ts` | Total token calculation |
| `cross-provider-handoff.test.ts` | Context handoff between providers |

Run tests with your provider/model pairs to verify compatibility.

## Config Reference

```typescript
interface ProviderConfig {
  /** Display name for the provider in UI such as /login. */
  name?: string;

  /** API endpoint URL. Required when defining models. */
  baseUrl?: string;

  /** API key literal, env interpolation ($ENV_VAR or ${ENV_VAR}), or !command. Required when defining models (unless oauth). */
  apiKey?: string;

  /** API type for streaming. Required at provider or model level when defining models. */
  api?: Api;

  /** Custom streaming implementation for non-standard APIs. */
  streamSimple?: (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions
  ) => AssistantMessageEventStream;

  /** Custom headers to include in requests. Values use the same resolution syntax as apiKey. */
  headers?: Record<string, string>;

  /** If true, adds Authorization: Bearer header with the resolved API key. */
  authHeader?: boolean;

  /** Models to register. If provided, replaces all existing models for this provider. */
  models?: ProviderModelConfig[];

  /** OAuth provider for /login support. */
  oauth?: {
    name: string;
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    getApiKey(credentials: OAuthCredentials): string;
    fetchSubscriptionUsage?(
      credentials: OAuthCredentials,
      options?: SubscriptionUsageFetchOptions
    ): Promise<SubscriptionUsageResult>;
    modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
  };
}
```

## Model Definition Reference

```typescript
interface ProviderModelConfig {
  /** Model ID (e.g., "claude-sonnet-4-20250514"). */
  id: string;

  /** Display name (e.g., "Claude 4 Sonnet"). */
  name: string;

  /** API type override for this specific model. */
  api?: Api;

  /** API endpoint URL override for this specific model. */
  baseUrl?: string;

  /** Whether the model supports extended thinking. */
  reasoning: boolean;

  /** Maps volt thinking levels to provider/model-specific values; null marks a level unsupported. */
  thinkingLevelMap?: Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;

  /** Supported input types. */
  input: ("text" | "image")[];

  /** Cost per million tokens (for usage tracking). */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };

  /** Maximum context window size in tokens. */
  contextWindow: number;

  /** Maximum output tokens. */
  maxTokens: number;

  /** Prompt-cache capabilities for this exact provider/API/model route. */
  promptCache?: {
    modes: ("implicit" | "explicit")[];
    retention: {
      short: { ttlSeconds?: number };
      long?: { ttlSeconds?: number };
    };
    refreshesOnHit?: boolean;
  };

  /** Custom headers for this specific model. */
  headers?: Record<string, string>;

  /** Compatibility settings for the selected API. */
  compat?: {
    // openai-completions
    supportsStore?: boolean;
    supportsDeveloperRole?: boolean;
    supportsReasoningEffort?: boolean;
    supportsUsageInStreaming?: boolean;
    maxTokensField?: "max_completion_tokens" | "max_tokens";
    requiresToolResultName?: boolean;
    requiresAssistantAfterToolResult?: boolean;
    requiresThinkingAsText?: boolean;
    requiresReasoningContentOnAssistantMessages?: boolean;
    thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template";
    cacheControlFormat?: "anthropic";

    // anthropic-messages
    supportsEagerToolInputStreaming?: boolean;
    sendSessionAffinityHeaders?: boolean;
    supportsCacheControlOnTools?: boolean;
    forceAdaptiveThinking?: boolean;
    allowEmptySignature?: boolean;
  };
}
```

`openrouter` sends `reasoning: { effort }`. `deepseek` sends `thinking: { type: "enabled" | "disabled" }` and `reasoning_effort` when enabled. `together` sends `reasoning: { enabled }` and also `reasoning_effort` when `supportsReasoningEffort` is enabled. `qwen` is for DashScope-style top-level `enable_thinking`. Use `qwen-chat-template` for local Qwen-compatible servers that read `chat_template_kwargs.enable_thinking`.
`cacheControlFormat: "anthropic"` applies Anthropic-style `cache_control` markers to the system prompt, last tool definition, and last user/assistant text content.

`promptCache` can also be set as a provider default. Model metadata overrides that default; provider and model overrides may use `promptCache: null` to clear inherited built-in cache behavior for an incompatible proxy. The `long` request preference is available only when `retention.long` exists, otherwise Volt falls back to short retention. Missing metadata suppresses controllable cache hints.
