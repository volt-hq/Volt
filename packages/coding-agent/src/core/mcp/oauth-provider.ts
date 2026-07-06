import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { VERSION } from "../../config.ts";
import type { McpOAuthStore } from "./oauth-store.ts";
import type { McpResolvedServerConfig } from "./types.ts";

export interface VoltMcpOAuthProviderOptions {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	redirectUrl?: string | URL;
	clientName?: string;
	clientVersion?: string;
	onAuthorizationUrl?: (url: URL) => void | Promise<void>;
}

function randomState(): string {
	return randomBytes(24).toString("base64url");
}

function assertHttpsEndpoint(value: string | undefined, label: string): void {
	if (!value) {
		throw new Error(`MCP OAuth ${label} is missing`);
	}
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error(`MCP OAuth ${label} must use HTTPS`);
	}
	if (url.username || url.password || url.hash) {
		throw new Error(`MCP OAuth ${label} must not include userinfo or fragments`);
	}
}

function getDeviceAuthorizationEndpoint(metadata: AuthorizationServerMetadata): string | undefined {
	const value = (metadata as { device_authorization_endpoint?: unknown }).device_authorization_endpoint;
	return typeof value === "string" ? value : undefined;
}

function assertSafeDiscoveryState(state: OAuthDiscoveryState): void {
	assertHttpsEndpoint(state.authorizationServerUrl, "authorization server URL");
	if (!state.authorizationServerMetadata) {
		throw new Error("MCP OAuth authorization server metadata is required");
	}
	assertHttpsEndpoint(state.authorizationServerMetadata.authorization_endpoint, "authorization endpoint");
	assertHttpsEndpoint(state.authorizationServerMetadata.token_endpoint, "token endpoint");
	if (state.authorizationServerMetadata.registration_endpoint) {
		assertHttpsEndpoint(state.authorizationServerMetadata.registration_endpoint, "registration endpoint");
	}
	const deviceEndpoint = getDeviceAuthorizationEndpoint(state.authorizationServerMetadata);
	if (deviceEndpoint) {
		assertHttpsEndpoint(deviceEndpoint, "device authorization endpoint");
	}
	if (state.resourceMetadataUrl) {
		assertHttpsEndpoint(state.resourceMetadataUrl, "resource metadata URL");
	}
	for (const authorizationServer of state.resourceMetadata?.authorization_servers ?? []) {
		assertHttpsEndpoint(authorizationServer, "protected-resource authorization server");
	}
}

function staticClientInformation(server: McpResolvedServerConfig): OAuthClientInformationMixed | undefined {
	const clientId = server.auth?.clientId?.trim();
	if (!clientId) {
		return undefined;
	}
	return {
		client_id: clientId,
		...(server.auth?.clientSecret ? { client_secret: server.auth.clientSecret } : {}),
		...(server.auth?.tokenEndpointAuthMethod
			? { token_endpoint_auth_method: server.auth.tokenEndpointAuthMethod }
			: {}),
	};
}

function clientMetadata(options: VoltMcpOAuthProviderOptions): OAuthClientMetadata {
	const redirectUrl = String(options.redirectUrl ?? "http://127.0.0.1/mcp/oauth/callback");
	const auth = options.server.auth;
	return {
		redirect_uris: [redirectUrl],
		token_endpoint_auth_method:
			auth?.tokenEndpointAuthMethod ?? (auth?.clientSecret ? "client_secret_basic" : "none"),
		grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
		response_types: ["code"],
		client_name: options.clientName ?? "Volt",
		software_version: options.clientVersion ?? VERSION,
		...(auth?.scope ? { scope: auth.scope } : {}),
	};
}

export class VoltMcpOAuthProvider implements OAuthClientProvider {
	private server: McpResolvedServerConfig;
	private store: McpOAuthStore;
	private redirectUrlValue: string | URL | undefined;
	private metadata: OAuthClientMetadata;
	private authorizationUrlValue: URL | undefined;
	private stateValue: string;
	private onAuthorizationUrl: ((url: URL) => void | Promise<void>) | undefined;

	constructor(options: VoltMcpOAuthProviderOptions) {
		this.server = options.server;
		this.store = options.store;
		this.redirectUrlValue = options.redirectUrl;
		this.metadata = clientMetadata(options);
		this.stateValue = randomState();
		this.onAuthorizationUrl = options.onAuthorizationUrl;
	}

	get redirectUrl(): string | URL | undefined {
		return this.redirectUrlValue;
	}

	get clientMetadataUrl(): string | undefined {
		return this.server.auth?.clientMetadataUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.metadata;
	}

	get authorizationUrl(): URL | undefined {
		return this.authorizationUrlValue;
	}

	get expectedState(): string {
		return this.stateValue;
	}

	async state(): Promise<string> {
		this.store.patchRecord(this.server, { state: this.stateValue });
		return this.stateValue;
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return (
			staticClientInformation(this.server) ?? this.store.getClientInformation(this.server, this.redirectUrlValue)
		);
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		if (staticClientInformation(this.server)) {
			return;
		}
		this.store.patchRecord(this.server, { clientInformation });
	}

	tokens(): OAuthTokens | undefined {
		return this.store.getRecord(this.server)?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.store.patchRecord(this.server, { tokens });
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		this.authorizationUrlValue = authorizationUrl;
		await this.onAuthorizationUrl?.(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.store.patchRecord(this.server, { codeVerifier });
	}

	codeVerifier(): string {
		const verifier = this.store.getRecord(this.server)?.codeVerifier;
		if (!verifier) {
			throw new Error(`Missing MCP OAuth code verifier for ${this.server.id}`);
		}
		return verifier;
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		this.store.clear(this.server, scope);
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		assertSafeDiscoveryState(state);
		this.store.patchRecord(this.server, { discoveryState: state });
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		const state = this.store.getRecord(this.server)?.discoveryState;
		if (state) {
			assertSafeDiscoveryState(state);
		}
		return state;
	}
}
