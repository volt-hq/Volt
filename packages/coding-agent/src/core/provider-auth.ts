/**
 * Provider credentials as clients see and change them (`auth.providers`,
 * `auth.login`, `auth.logout`): which providers take a subscription login or
 * an API key, how each authenticates now, and the host's login flows.
 *
 * A login runs on the host and asks only the client that started it: a
 * `provider_auth` request while a sign-in page or device code waits, `input`
 * and `select` requests for what the provider asks, and a `secret` input for
 * an API key. Credentials go to the credential store, never to settings, and
 * are never part of a request, a notice, or an intent's result.
 */

import { type Api, getProviders, type Model, type OAuthSelectPrompt } from "@hansjm10/volt-ai";
import type { AuthProvider, HostRequest, HostResponse, ProviderAuthMethod } from "@hansjm10/volt-protocol";
import type { AgentSession } from "./agent-session.ts";
import type { LiveState } from "./host/live-state.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { defaultModelPerProvider } from "./model-resolver.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";

const BUILT_IN_MODEL_PROVIDERS = new Set<string>(getProviders());

/** Amazon Bedrock signs requests with AWS credentials, not one API key. */
export const BEDROCK_PROVIDER_ID = "amazon-bedrock";

/** How long a login prompt waits for its client, in milliseconds. */
const LOGIN_PROMPT_TIMEOUT_MS = 10 * 60_000;

/** How long a subscription login may wait for the user, in milliseconds. */
const LOGIN_TIMEOUT_MS = 15 * 60_000;

/** Whether `providerId` takes an API key at login: built-in key providers and custom providers without OAuth. */
export function isApiKeyLoginProvider(
	providerId: string,
	oauthProviderIds: ReadonlySet<string>,
	builtInProviderIds: ReadonlySet<string> = BUILT_IN_MODEL_PROVIDERS,
): boolean {
	if (BUILT_IN_PROVIDER_DISPLAY_NAMES[providerId]) {
		return true;
	}
	if (builtInProviderIds.has(providerId)) {
		return false;
	}
	return !oauthProviderIds.has(providerId);
}

/** The providers a client may sign in to or out of, by display name, with how each authenticates now. */
export function listAuthProviders(registry: ModelRegistry): AuthProvider[] {
	const oauthIds = new Set(registry.client.getOAuthProviders().map((provider) => provider.id));
	const ids = new Set([
		...oauthIds,
		...registry.getAll().map((model) => model.provider),
		...registry.authStorage.list(),
	]);
	return [...ids]
		.map((id): AuthProvider => {
			const status = registry.getProviderAuthStatus(id);
			const stored = registry.authStorage.get(id);
			return {
				id,
				name: registry.getProviderDisplayName(id),
				oauth: oauthIds.has(id),
				apiKey: id !== BEDROCK_PROVIDER_ID && isApiKeyLoginProvider(id, oauthIds),
				configured: status.configured || registry.authStorage.hasAuth(id),
				...(status.source === undefined ? {} : { source: status.source }),
				...(status.label === undefined ? {} : { label: status.label }),
				...(stored === undefined ? {} : { stored: stored.type }),
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

/** The client a login asks, in the live state of the conversation it runs for. */
export interface ProviderLoginClient {
	readonly liveState: LiveState;
	readonly clientId: string;
}

/** A login that cannot start or failed, with the protocol code it is refused with. */
export class ProviderLoginError extends Error {
	readonly code: "invalid_input" | "unavailable" | "failed";

	constructor(code: "invalid_input" | "unavailable" | "failed", message: string) {
		super(message);
		this.name = "ProviderLoginError";
		this.code = code;
	}
}

export type ProviderLoginOutcome =
	| { readonly cancelled: true }
	| { readonly cancelled: false; readonly model?: Model<Api>; readonly warning?: string };

function isUnknownModel(model: Model<Api> | undefined): boolean {
	return model !== undefined && model.provider === "unknown" && model.id === "unknown" && model.api === "unknown";
}

/**
 * Sign `session`'s host in to `provider` with `method`, asking `client`. A
 * conversation without a usable model then selects the provider's default
 * model. Resolves cancelled when the user cancelled or the client left.
 */
export async function loginProvider(
	session: AgentSession,
	client: ProviderLoginClient,
	provider: string,
	method: ProviderAuthMethod,
): Promise<ProviderLoginOutcome> {
	const registry = session.modelRegistry;
	const previousModel = session.model;
	const cancelled =
		method === "api_key" ? await saveApiKey(registry, client, provider) : await signIn(registry, client, provider);
	if (cancelled) return { cancelled: true };
	registry.refresh();
	if (previousModel !== undefined && !isUnknownModel(previousModel)) return { cancelled: false };
	return { cancelled: false, ...(await selectProviderModel(session, provider)) };
}

/** Ask for a provider's API key and store it; resolves whether the user cancelled. */
async function saveApiKey(registry: ModelRegistry, client: ProviderLoginClient, provider: string): Promise<boolean> {
	const oauthIds = new Set(registry.client.getOAuthProviders().map((oauth) => oauth.id));
	const known = registry.getAll().some((model) => model.provider === provider);
	if (provider === BEDROCK_PROVIDER_ID) {
		throw new ProviderLoginError(
			"invalid_input",
			"Amazon Bedrock uses AWS credentials (a profile, IAM keys, a bearer token, or a role) instead of an API key",
		);
	}
	if (!known || !isApiKeyLoginProvider(provider, oauthIds)) {
		throw new ProviderLoginError("invalid_input", `Provider ${provider} does not take an API key`);
	}
	if (!client.liveState.accepts("input", client.clientId)) {
		throw new ProviderLoginError("unavailable", "Entering an API key needs a client that answers input requests");
	}
	const outcome = await client.liveState.request(
		{
			kind: "input",
			title: `API key for ${registry.getProviderDisplayName(provider)}`,
			secret: true,
			timeoutMs: LOGIN_PROMPT_TIMEOUT_MS,
		},
		{ client: client.clientId },
	);
	if (outcome.status !== "answered" || !("value" in outcome.response)) return true;
	const key = outcome.response.value.trim();
	if (key.length === 0) throw new ProviderLoginError("invalid_input", "The API key is empty");
	registry.authStorage.set(provider, { type: "api_key", key });
	return false;
}

/**
 * Run a provider's subscription login, its prompts asked of `client`.
 * Resolves whether the user cancelled; the login fails with its own error.
 */
async function signIn(registry: ModelRegistry, client: ProviderLoginClient, provider: string): Promise<boolean> {
	const oauth = registry.client.getOAuthProvider(provider);
	if (!oauth) throw new ProviderLoginError("invalid_input", `Provider ${provider} has no subscription login`);
	if (!client.liveState.accepts("provider_auth", client.clientId)) {
		throw new ProviderLoginError("unavailable", "Signing in needs a client that answers provider_auth requests");
	}
	const ended = new AbortController();
	let cancelled = false;
	const cancel = (): void => {
		cancelled = true;
		ended.abort(new Error("Login cancelled"));
	};
	const signal = AbortSignal.any([ended.signal, AbortSignal.timeout(LOGIN_TIMEOUT_MS)]);
	// A pasted redirect URL or code, for providers whose sign-in page redirects to a local callback.
	const manualCode = oauth.usesCallbackServer === true ? Promise.withResolvers<string>() : undefined;
	void manualCode?.promise.catch(() => undefined);
	/** The sign-in shown now: a new one (a device code after a page) replaces it. */
	let shown: AbortController | undefined;

	const show = (request: Extract<HostRequest, { kind: "provider_auth" }>): void => {
		shown?.abort();
		const own = new AbortController();
		shown = own;
		void client.liveState
			.request(request, { client: client.clientId, signal: AbortSignal.any([own.signal, signal]) })
			.then(
				(outcome) => {
					if (outcome.status === "answered") {
						if ("value" in outcome.response) manualCode?.resolve(outcome.response.value);
						else cancel();
					} else if (outcome.reason !== "aborted") {
						// The client left, or the conversation closed: nobody can finish the sign-in.
						cancel();
					}
				},
				() => cancel(),
			);
	};
	/** Ask the client what the provider asks; a cancelled or unanswered prompt cancels the login. */
	const ask = async (request: HostRequest): Promise<HostResponse> => {
		const outcome = await client.liveState.request(request, { client: client.clientId, signal });
		if (outcome.status !== "answered" || "cancelled" in outcome.response) {
			cancel();
			throw new Error("Login cancelled");
		}
		return outcome.response;
	};
	const select = async (prompt: OAuthSelectPrompt): Promise<string | undefined> => {
		if (prompt.options.length === 0) return undefined;
		const response = await ask({
			kind: "select",
			title: prompt.message,
			options: prompt.options.map((option) => option.label),
			timeoutMs: LOGIN_PROMPT_TIMEOUT_MS,
		});
		return "value" in response ? prompt.options.find((option) => option.label === response.value)?.id : undefined;
	};
	const stopped = new Promise<never>((_resolve, reject) => {
		const stop = (): void => reject(signal.reason instanceof Error ? signal.reason : new Error("Login timed out"));
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
	});
	void stopped.catch(() => undefined);
	try {
		await Promise.race([
			registry.login(provider, {
				onAuth: (info) =>
					show({
						kind: "provider_auth",
						provider,
						flow: manualCode ? "manual" : "browser",
						url: signInUrl(info.url),
						...(info.instructions === undefined ? {} : { instructions: info.instructions }),
					}),
				onDeviceCode: (info) =>
					show({
						kind: "provider_auth",
						provider,
						flow: "device",
						url: signInUrl(info.verificationUri),
						userCode: info.userCode,
					}),
				onPrompt: async (prompt) => {
					const response = await ask({
						kind: "input",
						title: prompt.message,
						...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
						timeoutMs: LOGIN_PROMPT_TIMEOUT_MS,
					});
					return "value" in response ? response.value : "";
				},
				onSelect: select,
				...(manualCode === undefined ? {} : { onManualCodeInput: () => manualCode.promise }),
				signal,
			}),
			stopped,
		]);
	} catch (error) {
		if (cancelled) return true;
		throw error;
	} finally {
		// The sign-in shown and any prompt end with the login.
		ended.abort(new Error("Login ended"));
		manualCode?.reject(new Error("Login ended"));
	}
	return false;
}

/** A sign-in URL a client may open: http or https only. */
function signInUrl(url: string): string {
	let protocol: string;
	try {
		protocol = new URL(url).protocol;
	} catch {
		protocol = "";
	}
	if (protocol !== "https:" && protocol !== "http:") {
		throw new ProviderLoginError("failed", "The provider's sign-in address is not an http or https URL");
	}
	return url;
}

/** The provider's default model, selected for a conversation that has none to use. */
async function selectProviderModel(
	session: AgentSession,
	provider: string,
): Promise<{ model?: Model<Api>; warning?: string }> {
	const defaultModelId = (defaultModelPerProvider as Readonly<Record<string, string | undefined>>)[provider];
	if (defaultModelId === undefined) {
		return { warning: `No default model is configured for provider "${provider}"; select a model` };
	}
	const model = session.modelRegistry
		.getAvailable()
		.find((candidate) => candidate.provider === provider && candidate.id === defaultModelId);
	if (!model) return { warning: `The default model "${defaultModelId}" is not available; select a model` };
	try {
		await session.setModel(model);
		return { model };
	} catch (error) {
		return {
			warning: `Selecting the default model failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/** Remove a provider's stored credentials: how they signed in. Environment variables and `models.json` stay. */
export function logoutProvider(registry: ModelRegistry, provider: string): ProviderAuthMethod {
	const stored = Object.hasOwn(registry.authStorage.getAll(), provider)
		? registry.authStorage.get(provider)
		: undefined;
	if (!stored) throw new ProviderLoginError("invalid_input", `No stored credentials for provider ${provider}`);
	registry.authStorage.logout(provider);
	registry.refresh();
	return stored.type;
}
