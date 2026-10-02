/**
 * OAuth credential management for AI providers.
 *
 * This module implements login and token refresh for OAuth-based
 * providers; callers store the credentials:
 * - Anthropic (Claude Pro/Max)
 * - GitHub Copilot
 */

export { anthropicOAuthProvider, loginAnthropic, refreshAnthropicToken } from "./anthropic.ts";
// Anthropic
export { fetchAnthropicSubscriptionUsage } from "./anthropic-usage.ts";
export * from "./device-code.ts";
// GitHub Copilot
export {
	getGitHubCopilotBaseUrl,
	githubCopilotOAuthProvider,
	loginGitHubCopilot,
	normalizeDomain,
	refreshGitHubCopilotToken,
} from "./github-copilot.ts";
export {
	loginOpenAICodex,
	loginOpenAICodexDeviceCode,
	OPENAI_CODEX_BROWSER_LOGIN_METHOD,
	OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
	openaiCodexOAuthProvider,
	refreshOpenAICodexToken,
} from "./openai-codex.ts";
// OpenAI Codex (ChatGPT OAuth)
export { fetchOpenAICodexSubscriptionUsage } from "./openai-codex-usage.ts";

export * from "./types.ts";

import { anthropicOAuthProvider } from "./anthropic.ts";
import { githubCopilotOAuthProvider } from "./github-copilot.ts";
import { openaiCodexOAuthProvider } from "./openai-codex.ts";
import type { OAuthProviderInterface } from "./types.ts";

/** The built-in OAuth implementations, for `createAiClient({ oauthProviders })`. */
export function builtInOAuthProviders(): OAuthProviderInterface[] {
	return [anthropicOAuthProvider, githubCopilotOAuthProvider, openaiCodexOAuthProvider];
}
