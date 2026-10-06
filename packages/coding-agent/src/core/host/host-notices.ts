/**
 * What the host tells a conversation's users on its own: an Anthropic
 * subscription login billing extra usage, and a `models.json` it could not
 * read. The live feed raises the first as a notice when the conversation
 * changes to such a model; the `resources` query lists both as they hold when
 * a local client asks. A `models.json` error names the agent directory, so it
 * never reaches the live lane, which paired devices read.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import type { AgentSession } from "../agent-session.ts";

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage.";

/** Whether `apiKey` is an Anthropic subscription (OAuth) token. */
export function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

/**
 * Whether requests with `model` draw from an Anthropic subscription's extra
 * usage, and the user did not turn the warning off: a stored OAuth login, or
 * a subscription token as the provider's key.
 */
export async function usesAnthropicSubscription(
	session: Pick<AgentSession, "settingsManager" | "modelRegistry">,
	model: Model<Api> | undefined,
): Promise<boolean> {
	if (!model || model.provider !== "anthropic") return false;
	if (session.settingsManager.getWarnings().anthropicExtraUsage === false) return false;
	if (session.modelRegistry.authStorage.get("anthropic")?.type === "oauth") return true;
	try {
		return isAnthropicSubscriptionAuthKey(await session.modelRegistry.getApiKeyForProvider(model.provider));
	} catch {
		// A credential that cannot be read now warns about nothing.
		return false;
	}
}

/** The notice for a `models.json` the model registry could not read. */
export function modelsJsonErrorText(error: string): string {
	return `models.json error: ${error}`;
}
