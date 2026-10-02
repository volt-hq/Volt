/**
 * A client with the built-in providers and catalog, for provider tests.
 *
 * Its credential source resolves the provider's environment variable, as end-to-end suites gate on
 * those variables; an `apiKey` in the request options takes precedence. The lookup is coding-agent's,
 * the only environment credential fallback.
 */

import { getEnvApiKey } from "../../coding-agent/src/core/env-api-keys.ts";
import { builtInImagesProviders, builtInModels, builtInProviders, createAiClient } from "../src/index.ts";

export { getEnvApiKey };

export const testClient = createAiClient({
	providers: builtInProviders(),
	models: builtInModels(),
	imagesProviders: builtInImagesProviders(),
	credentials: {
		resolve: async ({ model }) => {
			const apiKey = getEnvApiKey(model.provider);
			return apiKey === undefined ? undefined : { apiKey };
		},
	},
});

export const { stream, complete, streamSimple, completeSimple, generateImages } = testClient;
