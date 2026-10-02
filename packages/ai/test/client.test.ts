import { describe, expect, it, vi } from "vitest";
import {
	type AnthropicOptions,
	type ApiProvider,
	type AssistantImages,
	builtInModels,
	builtInProviders,
	type CredentialRequest,
	type Credentials,
	createAiClient,
	createAssistantMessageEventStream,
	createFauxProvider,
	type FauxProvider,
	fauxAssistantMessage,
	getModels,
	getProviders,
	type ImagesApi,
	type ImagesContext,
	type ImagesModel,
	type ImagesOptions,
	type OAuthProviderInterface,
	ProviderStreamError,
	type StreamOptions,
	streamAnthropic,
	streamSimpleAnthropic,
} from "../src/index.ts";
import { anthropicOAuthProvider, builtInOAuthProviders } from "../src/oauth.ts";
import type { Context } from "../src/types.ts";

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

/** Reply with the API key and headers each request received. */
function echoCredentials(faux: FauxProvider, count: number): void {
	faux.setResponses(
		Array.from(
			{ length: count },
			() => (_context: Context, options: StreamOptions | undefined) =>
				fauxAssistantMessage(JSON.stringify({ apiKey: options?.apiKey, headers: options?.headers })),
		),
	);
}

function replyText(message: { content: { type: string; text?: string }[] }): string {
	return message.content.map((block) => block.text ?? "").join("");
}

describe("createAiClient", () => {
	it("starts empty: built-ins are supplied explicitly", () => {
		const client = createAiClient();
		expect(client.getProviders()).toEqual([]);
		expect(client.getModels()).toEqual([]);
		expect(client.getOAuthProviders()).toEqual([]);

		const builtIn = createAiClient({
			providers: builtInProviders(),
			models: builtInModels(),
			oauthProviders: builtInOAuthProviders(),
		});
		expect(builtIn.getProvider("anthropic-messages")?.refreshPromptCache).toBeDefined();
		expect(builtIn.getModels()).toHaveLength(getProviders().reduce((sum, p) => sum + getModels(p).length, 0));
		expect(builtIn.getModel("anthropic", getModels("anthropic")[0]!.id)).toBe(getModels("anthropic")[0]);
		expect(builtIn.getOAuthProvider("anthropic")).toBe(anthropicOAuthProvider);
	});

	it("keeps registries of separate clients isolated", async () => {
		const first = createFauxProvider({ api: "shared-api" });
		const second = createFauxProvider({ api: "shared-api" });
		const a = createAiClient({ providers: [first], models: first.models });
		const b = createAiClient({ providers: [second] });
		first.setResponses([fauxAssistantMessage("from a")]);
		second.setResponses([fauxAssistantMessage("from b")]);

		expect(replyText(await a.complete(first.getModel(), context))).toBe("from a");
		expect(replyText(await b.complete(first.getModel(), context))).toBe("from b");
		expect(first.state.callCount).toBe(1);
		expect(second.state.callCount).toBe(1);

		const oauth: OAuthProviderInterface = { ...anthropicOAuthProvider, id: "custom-oauth", name: "Custom" };
		a.registerOAuthProvider(oauth);
		expect(a.getOAuthProvider("custom-oauth")).toBe(oauth);
		expect(b.getOAuthProvider("custom-oauth")).toBeUndefined();
		expect(a.getModels()).toEqual(first.models);
		expect(b.getModels()).toEqual([]);
	});

	it("unregisters providers, OAuth providers, and models on its own instance", async () => {
		const faux = createFauxProvider();
		const client = createAiClient({ providers: [faux], models: faux.models });
		client.registerOAuthProvider({ ...anthropicOAuthProvider, id: "x" });

		client.unregisterProvider(faux.api);
		client.unregisterOAuthProvider("x");
		client.setModels([]);

		expect(() => client.streamSimple(faux.getModel(), context)).toThrow(
			`No API provider registered for api: ${faux.api}`,
		);
		await expect(client.complete(faux.getModel(), context)).rejects.toThrow("No API provider registered");
		expect(client.getOAuthProvider("x")).toBeUndefined();
		expect(client.getModel(faux.getModel().provider, faux.getModel().id)).toBeUndefined();
	});

	it("replaces a registration for the same api", async () => {
		const first = createFauxProvider({ api: "same" });
		const second = createFauxProvider({ api: "same" });
		const client = createAiClient({ providers: [first] });
		client.registerProvider(second);
		second.setResponses([fauxAssistantMessage("second")]);

		expect(replyText(await client.complete(first.getModel(), context))).toBe("second");
		expect(client.getProviders()).toEqual([second]);
	});

	it("consults its credential source before each request", async () => {
		const faux = createFauxProvider();
		const requests: CredentialRequest[] = [];
		let next = 0;
		const client = createAiClient({
			providers: [faux],
			credentials: {
				resolve: async (request) => {
					requests.push(request);
					return { apiKey: `key-${++next}`, headers: { authorization: "Bearer resolved", "x-source": "1" } };
				},
			},
		});
		echoCredentials(faux, 2);
		const controller = new AbortController();

		const first = await client.complete(faux.getModel(), context, { signal: controller.signal });
		const second = await client.complete(faux.getModel(), context, {
			apiKey: "caller-key",
			headers: { authorization: "caller", "x-trace": "1" },
		});

		expect(JSON.parse(replyText(first))).toEqual({
			apiKey: "key-1",
			headers: { authorization: "Bearer resolved", "x-source": "1" },
		});
		// Request options take precedence over resolved credentials.
		expect(JSON.parse(replyText(second))).toEqual({
			apiKey: "caller-key",
			headers: { authorization: "caller", "x-source": "1", "x-trace": "1" },
		});
		expect(requests).toHaveLength(2);
		expect(requests[0]!.model).toBe(faux.getModel());
		expect(requests[0]!.signal).toBe(controller.signal);
		expect(requests[1]!.signal).toBeUndefined();
	});

	it("keeps request options a source leaves unresolved", async () => {
		const faux = createFauxProvider();
		const client = createAiClient({ providers: [faux], credentials: { resolve: async () => undefined } });
		echoCredentials(faux, 1);

		const reply = await client.completeSimple(faux.getModel(), { ...context, tools: [] }, { apiKey: "caller-key" });

		expect(JSON.parse(replyText(reply)).apiKey).toBe("caller-key");
	});

	it("isolates the credential sources of separate clients", async () => {
		const faux = createFauxProvider();
		const source = (apiKey: string) => ({ resolve: async (): Promise<Credentials> => ({ apiKey }) });
		const a = createAiClient({ providers: [faux], credentials: source("key-a") });
		const b = createAiClient({ providers: [faux], credentials: source("key-b") });
		echoCredentials(faux, 2);

		expect(JSON.parse(replyText(await a.complete(faux.getModel(), context))).apiKey).toBe("key-a");
		expect(JSON.parse(replyText(await b.complete(faux.getModel(), context))).apiKey).toBe("key-b");
	});

	it("reports a credential source failure as a typed auth error without calling the provider", async () => {
		const faux = createFauxProvider();
		const client = createAiClient({
			providers: [faux],
			credentials: {
				resolve: async () => {
					throw new Error("token refresh failed");
				},
			},
		});
		faux.setResponses([fauxAssistantMessage("unused")]);

		const events: string[] = [];
		const stream = client.stream(faux.getModel(), context);
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		expect(events).toEqual(["start", "error"]);
		expect(result.stopReason).toBe("error");
		expect(result.error).toEqual({ kind: "auth", retryable: false, message: "token refresh failed" });
		expect(result).toMatchObject({ api: faux.api, provider: "faux", model: faux.getModel().id });
		expect(faux.state.callCount).toBe(0);
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("reports an abort during credential resolution as aborted", async () => {
		const faux = createFauxProvider();
		const controller = new AbortController();
		const client = createAiClient({
			providers: [faux],
			credentials: {
				resolve: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
			},
		});

		const pending = client.complete(faux.getModel(), context, { signal: controller.signal });
		controller.abort();
		const result = await pending;

		expect(result.stopReason).toBe("aborted");
		expect(result.error?.kind).toBe("aborted");
		expect(faux.state.callCount).toBe(0);
	});

	it("resolves prompt-cache refresh credentials and reports failures as auth errors", async () => {
		const faux = createFauxProvider({
			models: [{ id: "c", promptCache: { modes: ["explicit"], retention: { short: {} }, refreshesOnHit: true } }],
			refreshPromptCache: (_context, options) => ({ status: "unsupported", reason: `key ${options?.apiKey}` }),
		});
		let fail = false;
		const client = createAiClient({
			providers: [faux],
			credentials: {
				resolve: async () => {
					if (fail) throw new Error("no credentials");
					return { apiKey: "resolved" };
				},
			},
		});

		expect(client.supportsPromptCacheRefresh(faux.getModel())).toBe(true);
		expect(await client.refreshPromptCache(faux.getModel(), context)).toEqual({
			status: "unsupported",
			reason: "key resolved",
		});
		fail = true;
		const failure = await client.refreshPromptCache(faux.getModel(), context).catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ProviderStreamError);
		expect((failure as ProviderStreamError).providerError.kind).toBe("auth");
	});

	it("resolves image generation credentials", async () => {
		const generateImages = vi.fn(
			async (
				_model: ImagesModel<ImagesApi>,
				_context: ImagesContext,
				options?: ImagesOptions,
			): Promise<AssistantImages> => ({
				api: "test-images",
				provider: "test",
				model: "image-model",
				output: [{ type: "text", text: options?.apiKey ?? "" }],
				stopReason: "stop",
				timestamp: 1,
			}),
		);
		let fail = false;
		const client = createAiClient({
			imagesProviders: [{ api: "test-images", generateImages }],
			credentials: {
				resolve: async () => {
					if (fail) throw new Error("no image key");
					return { apiKey: "image-key" };
				},
			},
		});
		const model: ImagesModel<ImagesApi> = {
			id: "image-model",
			name: "Image Model",
			api: "test-images",
			provider: "test",
			baseUrl: "http://localhost:0",
			input: ["text"],
			output: ["image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const imagesContext = { input: [{ type: "text" as const, text: "draw" }] };

		expect((await client.generateImages(model, imagesContext)).output).toEqual([{ type: "text", text: "image-key" }]);
		fail = true;
		expect(await client.generateImages(model, imagesContext)).toMatchObject({
			stopReason: "error",
			errorMessage: "no image key",
		});
		expect(generateImages).toHaveBeenCalledTimes(1);
	});

	it("forwards the final message of a provider stream that ends without a terminal event", async () => {
		const message = fauxAssistantMessage("ended without events");
		const endOnly = () => {
			const stream = createAssistantMessageEventStream();
			stream.end(message);
			return stream;
		};
		const client = createAiClient({
			providers: [{ api: "end-only", stream: endOnly, streamSimple: endOnly }],
			credentials: { resolve: async () => ({ apiKey: "key" }) },
		});

		expect(await client.complete({ ...createFauxProvider().getModel(), api: "end-only" }, context)).toBe(message);
	});

	it("accepts providers typed for a specific api and options", () => {
		const anthropic: ApiProvider<"anthropic-messages", AnthropicOptions> = {
			api: "anthropic-messages",
			stream: streamAnthropic,
			streamSimple: streamSimpleAnthropic,
		};
		const client = createAiClient({ providers: [anthropic] });
		expect(client.getProvider("anthropic-messages")).toBe(anthropic);
	});
});
