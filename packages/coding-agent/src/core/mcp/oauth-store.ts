import { createHash } from "node:crypto";
import { join } from "node:path";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { getAgentDir } from "../../config.ts";
import { type AuthStorageBackend, FileAuthStorageBackend } from "../auth-storage.ts";
import type { McpResolvedServerConfig } from "./types.ts";

export interface McpOAuthStoredRecord {
	serverId: string;
	serverUrl: string;
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
	state?: string;
	discoveryState?: OAuthDiscoveryState;
	updatedAt: string;
}

interface McpOAuthStorageData {
	version: 1;
	servers: Record<string, McpOAuthStoredRecord>;
}

function emptyStorage(): McpOAuthStorageData {
	return { version: 1, servers: {} };
}

function parseStorage(content: string | undefined): McpOAuthStorageData {
	if (!content?.trim()) {
		return emptyStorage();
	}
	const parsed = JSON.parse(content) as Partial<McpOAuthStorageData>;
	return {
		version: 1,
		servers: typeof parsed.servers === "object" && parsed.servers !== null ? parsed.servers : {},
	};
}

function serializeStorage(data: McpOAuthStorageData): string {
	return `${JSON.stringify(data, null, 2)}\n`;
}

function canonicalServerUrl(server: McpResolvedServerConfig): string {
	if (!server.url) {
		return server.id;
	}
	const url = new URL(server.url);
	url.hash = "";
	return url.toString();
}

function recordKey(server: McpResolvedServerConfig): string {
	return createHash("sha256")
		.update(`${server.id}\0${canonicalServerUrl(server)}`)
		.digest("base64url");
}

function clientInformationMatchesRedirect(
	clientInformation: OAuthClientInformationMixed | undefined,
	redirectUrl: string | URL | undefined,
): boolean {
	if (!clientInformation || !redirectUrl || !("redirect_uris" in clientInformation)) {
		return true;
	}
	const redirect = String(redirectUrl);
	return clientInformation.redirect_uris.includes(redirect);
}

export class McpOAuthStore {
	private storage: AuthStorageBackend;

	constructor(storage: AuthStorageBackend = new FileAuthStorageBackend(join(getAgentDir(), "mcp-auth.json"))) {
		this.storage = storage;
	}

	static create(agentDir: string = getAgentDir()): McpOAuthStore {
		return new McpOAuthStore(new FileAuthStorageBackend(join(agentDir, "mcp-auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): McpOAuthStore {
		return new McpOAuthStore(storage);
	}

	getRecord(server: McpResolvedServerConfig): McpOAuthStoredRecord | undefined {
		return this.storage.withLock((current) => {
			const data = parseStorage(current);
			return { result: data.servers[recordKey(server)] };
		});
	}

	hasUsableTokens(server: McpResolvedServerConfig): boolean {
		const tokens = this.getRecord(server)?.tokens;
		return typeof tokens?.access_token === "string" && tokens.access_token.length > 0;
	}

	getClientInformation(
		server: McpResolvedServerConfig,
		redirectUrl?: string | URL,
	): OAuthClientInformationMixed | undefined {
		const clientInformation = this.getRecord(server)?.clientInformation;
		return clientInformationMatchesRedirect(clientInformation, redirectUrl) ? clientInformation : undefined;
	}

	updateRecord(
		server: McpResolvedServerConfig,
		update: (record: McpOAuthStoredRecord | undefined) => McpOAuthStoredRecord | undefined,
	): McpOAuthStoredRecord | undefined {
		return this.storage.withLock((current) => {
			const data = parseStorage(current);
			const key = recordKey(server);
			const nextRecord = update(data.servers[key]);
			if (nextRecord) {
				data.servers[key] = { ...nextRecord, updatedAt: new Date().toISOString() };
			} else {
				delete data.servers[key];
			}
			return { result: nextRecord, next: serializeStorage(data) };
		});
	}

	patchRecord(
		server: McpResolvedServerConfig,
		patch: Partial<Omit<McpOAuthStoredRecord, "serverId" | "serverUrl" | "updatedAt">>,
	): McpOAuthStoredRecord {
		const base = (): McpOAuthStoredRecord => ({
			serverId: server.id,
			serverUrl: canonicalServerUrl(server),
			updatedAt: new Date().toISOString(),
		});
		return this.updateRecord(server, (record) => ({ ...base(), ...record, ...patch })) ?? base();
	}

	clear(server: McpResolvedServerConfig, scope: "all" | "client" | "tokens" | "verifier" | "discovery" = "all"): void {
		this.updateRecord(server, (record) => {
			if (!record || scope === "all") {
				return undefined;
			}
			const next: McpOAuthStoredRecord = { ...record };
			if (scope === "client") {
				delete next.clientInformation;
			}
			if (scope === "tokens") {
				delete next.tokens;
			}
			if (scope === "verifier") {
				delete next.codeVerifier;
				delete next.state;
			}
			if (scope === "discovery") {
				delete next.discoveryState;
			}
			return next;
		});
	}
}
