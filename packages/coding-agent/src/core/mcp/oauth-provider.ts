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

const DEFAULT_REDIRECT_URL = "http://127.0.0.1/mcp/oauth/callback";

export interface VoltMcpOAuthProviderOptions {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	/**
	 * Loopback redirect URL of a browser sign-in. A stored client is presented only
	 * if it was registered for this URL. Without it, the provider presents whichever
	 * client sign-in stored and reports a default redirect URL, which the SDK needs
	 * to refresh tokens but no browser redirect completes against.
	 */
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

/**
 * Pre-registered credentials carry the configured authorization server as
 * `issuer`, so the SDK and the device flow never present them to another one.
 */
function staticClientInformation(server: McpResolvedServerConfig): OAuthClientInformationMixed | undefined {
	const clientId = server.auth?.clientId?.trim();
	if (!clientId) {
		return undefined;
	}
	const issuer = server.auth?.issuer?.trim();
	if (!issuer) {
		throw new Error(
			`MCP OAuth server ${server.id} configures auth.clientId without auth.issuer; set auth.issuer to the authorization server URL the client is registered with`,
		);
	}
	return {
		client_id: clientId,
		issuer,
		...(server.auth?.clientSecret ? { client_secret: server.auth.clientSecret } : {}),
		...(server.auth?.tokenEndpointAuthMethod
			? { token_endpoint_auth_method: server.auth.tokenEndpointAuthMethod }
			: {}),
	};
}

function clientMetadata(options: VoltMcpOAuthProviderOptions): OAuthClientMetadata {
	const redirectUrl = String(options.redirectUrl ?? DEFAULT_REDIRECT_URL);
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
	/**
	 * Defined only for dynamically obtained clients. A pre-registered client cannot
	 * register again, so without this the SDK refuses an authorization server other
	 * than the configured issuer instead of registering a replacement client there.
	 */
	saveClientInformation?: (clientInformation: OAuthClientInformationMixed) => void;

	constructor(options: VoltMcpOAuthProviderOptions) {
		this.server = options.server;
		this.store = options.store;
		this.redirectUrlValue = options.redirectUrl;
		this.metadata = clientMetadata(options);
		this.stateValue = randomState();
		this.onAuthorizationUrl = options.onAuthorizationUrl;
		if (!options.server.auth?.clientId?.trim()) {
			this.saveClientInformation = (clientInformation) => {
				this.store.patchRecord(this.server, { clientInformation });
			};
		}
	}

	get redirectUrl(): string | URL {
		return this.redirectUrlValue ?? DEFAULT_REDIRECT_URL;
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

	tokens(): OAuthTokens | undefined {
		return this.store.getRecord(this.server)?.tokens;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.store.patchRecord(this.server, { tokens });
	}

	async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		assertHttpsEndpoint(authorizationUrl.toString(), "authorization URL");
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
