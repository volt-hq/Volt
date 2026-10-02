/**
 * Test helper for resolving API keys from ~/.volt/agent/auth.json
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to auth.json.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { builtInOAuthProviders } from "../src/utils/oauth/index.ts";
import type { OAuthCredentials } from "../src/utils/oauth/types.ts";

const AUTH_PATH = join(homedir(), ".volt", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

function loadAuthStorage(): AuthStorage {
	if (!existsSync(AUTH_PATH)) {
		return {};
	}
	try {
		const content = readFileSync(AUTH_PATH, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

function saveAuthStorage(storage: AuthStorage): void {
	const configDir = dirname(AUTH_PATH);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(AUTH_PATH, JSON.stringify(storage, null, 2), "utf-8");
	chmodSync(AUTH_PATH, 0o600);
}

/**
 * Resolve API key for a provider from ~/.volt/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const storage = loadAuthStorage();
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		const oauthProvider = builtInOAuthProviders().find((candidate) => candidate.id === provider);
		if (!oauthProvider) return undefined;
		const { type: _, ...stored } = entry;
		let credentials: OAuthCredentials = stored;
		if (Date.now() >= credentials.expires) {
			try {
				credentials = await oauthProvider.refreshToken(credentials);
			} catch (e) {
				console.log(JSON.stringify(e));
				return undefined;
			}
			// Save refreshed credentials back to auth.json
			storage[provider] = { type: "oauth", ...credentials };
			saveAuthStorage(storage);
		}
		return oauthProvider.getApiKey(credentials);
	}

	return undefined;
}
