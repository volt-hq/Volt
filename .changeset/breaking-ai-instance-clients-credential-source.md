---
"@hansjm10/volt-ai": minor
"@hansjm10/volt-agent-core": minor
"@hansjm10/volt-coding-agent": minor
---

breaking(ai): The AI library now streams through clients created with `createAiClient`, each with its own providers, models, OAuth providers, and credential source, instead of process-wide registries; it no longer reads API keys from environment variables, and the `volt-ai` login command is removed.

To migrate, create a client with `createAiClient({ providers: builtInProviders(), models: builtInModels(), credentials })` and call `client.stream`, `complete`, `streamSimple`, `completeSimple`, `refreshPromptCache`, and `generateImages` where you called the global functions; register custom APIs with `client.registerProvider` and OAuth implementations with `client.registerOAuthProvider` (the built-ins come from `builtInOAuthProviders()` in `@hansjm10/volt-ai/oauth`). Pass API keys per request or through a `CredentialSource`, whose `resolve({ model, signal })` the client consults before each request; a rejection fails the request with an `auth` error. `registerFauxProvider` is now `createFauxProvider`, which returns a provider to register on a client.

In `@hansjm10/volt-agent-core`, `agentLoop` and `agentLoopContinue` require a stream function (for example `client.streamSimple`), and `AgentLoopConfig.getApiKey` is removed.

In Volt, extensions' `registerProvider` calls are unchanged. Each model registry owns a client (`ctx.modelRegistry.client`) that resolves credentials from auth.json, OAuth refresh, environment variables, and models.json, so extensions make model calls with `ctx.modelRegistry.client.complete(...)` instead of resolving keys themselves. `compact`, `generateSummary`, and `generateBranchSummary` take a required stream function instead of `apiKey`, `headers`, and `env`. Use Volt's `/login` instead of `npx @hansjm10/volt-ai login`.
