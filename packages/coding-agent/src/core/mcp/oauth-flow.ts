import {
	auth,
	discoverOAuthServerInfo,
	isHttpsUrl,
	type OAuthServerInfo,
	registerClient,
	selectClientAuthMethod,
	selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
	type AuthorizationServerMetadata,
	type OAuthClientInformationMixed,
	type OAuthTokens,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { VERSION } from "../../config.ts";
import { VoltMcpOAuthProvider } from "./oauth-provider.ts";
import type { McpOAuthStore } from "./oauth-store.ts";
import { redactMcpText } from "./safety.ts";
import type { McpResolvedServerConfig } from "./types.ts";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_DEVICE_INTERVAL_MS = 5000;
const SLOW_DOWN_INCREMENT_MS = 5000;

export interface McpOAuthBrowserStartResult {
	action: "auth";
	server: string;
	flow: "browser";
	status: "pending" | "authenticated";
	authorizationUrl?: string;
	redirectUrl: string;
	state?: string;
	message: string;
}

export interface McpOAuthBrowserCompleteResult {
	action: "auth";
	server: string;
	flow: "browser";
	status: "authenticated";
	message: string;
}

export interface McpOAuthDeviceStartResult {
	action: "auth";
	server: string;
	flow: "device";
	status: "pending";
	verificationUri: string;
	verificationUriComplete?: string;
	userCode: string;
	expiresAt: string;
	intervalMs: number;
	message: string;
}

export interface McpOAuthDevicePollResult {
	action: "auth";
	server: string;
	flow: "device";
	status: "pending" | "authenticated" | "failed";
	nextPollMs?: number;
	message: string;
}

export interface McpOAuthPendingDeviceFlow {
	serverId: string;
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresAtMs: number;
	intervalMs: number;
	nextPollAtMs: number;
	authorizationServerUrl: string;
	metadata: AuthorizationServerMetadata;
	clientInformation: OAuthClientInformationMixed;
	resource?: URL;
}

interface DeviceAuthorizationResponse {
	device_code: string;
	user_code: string;
	verification_uri?: string;
	verification_url?: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
	message?: string;
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function assertLoopbackRedirectUrl(value: string | URL): void {
	const url = new URL(String(value));
	if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname) || url.hostname === "localhost") {
		throw new Error("MCP OAuth redirect URL must use HTTP on a numeric loopback address");
	}
	if (url.username || url.password || url.hash) {
		throw new Error("MCP OAuth redirect URL must not include userinfo or fragments");
	}
}

function assertBrowserTargetUrl(value: string, label: string): void {
	assertHttpsEndpoint(value, label);
}

function getOAuthFetchUrl(input: Parameters<typeof fetch>[0]): URL {
	if (typeof input === "string") {
		return new URL(input);
	}
	if (input instanceof URL) {
		return input;
	}
	return new URL(input.url);
}

/**
 * OAuth requests never follow redirects. Endpoint metadata is validated before
 * credential-bearing requests, and rejecting redirects prevents an HTTPS token
 * endpoint from forwarding codes, verifiers, or client secrets to plaintext or
 * a different origin. Loopback HTTP remains available for MCP resource
 * discovery; OAuth authorization-server endpoints themselves must be HTTPS.
 */
export function createSafeMcpOAuthFetch(fetchFn: typeof fetch = fetch): typeof fetch {
	return async (input, init) => {
		const requestUrl = getOAuthFetchUrl(input);
		if (
			requestUrl.protocol !== "https:" &&
			!(requestUrl.protocol === "http:" && isLoopbackHostname(requestUrl.hostname))
		) {
			throw new Error("MCP OAuth network requests must use HTTPS unless the MCP resource is loopback HTTP");
		}
		const response = await fetchFn(input, { ...init, redirect: "error" });
		if (response.redirected || (response.status >= 300 && response.status < 400)) {
			throw new Error("MCP OAuth network redirects are not allowed");
		}
		if (response.url) {
			const responseUrl = new URL(response.url);
			if (
				responseUrl.protocol !== "https:" &&
				!(responseUrl.protocol === "http:" && isLoopbackHostname(responseUrl.hostname))
			) {
				throw new Error("MCP OAuth response URL must use HTTPS unless the MCP resource is loopback HTTP");
			}
		}
		return response;
	};
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

function assertOAuthServerUrlAllowed(server: McpResolvedServerConfig): void {
	if (!server.url) {
		throw new Error(`MCP OAuth server ${server.id} is missing URL`);
	}
	const url = new URL(server.url);
	if (url.protocol === "https:") {
		return;
	}
	if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
		return;
	}
	throw new Error(`MCP OAuth server ${server.id} must use HTTPS unless it is loopback HTTP`);
}

function getDeviceAuthorizationEndpoint(metadata: AuthorizationServerMetadata): string | undefined {
	const value = (metadata as { device_authorization_endpoint?: unknown }).device_authorization_endpoint;
	return typeof value === "string" ? value : undefined;
}

function validateBrowserServerInfo(serverInfo: OAuthServerInfo): void {
	assertHttpsEndpoint(serverInfo.authorizationServerUrl, "authorization server URL");
	const metadata = serverInfo.authorizationServerMetadata;
	if (!metadata) {
		throw new Error("MCP OAuth browser flow requires authorization server metadata");
	}
	assertHttpsEndpoint(metadata.authorization_endpoint, "authorization endpoint");
	assertHttpsEndpoint(metadata.token_endpoint, "token endpoint");
	if (metadata.registration_endpoint) {
		assertHttpsEndpoint(metadata.registration_endpoint, "registration endpoint");
	}
	if (!metadata.code_challenge_methods_supported?.includes("S256")) {
		throw new Error("MCP OAuth authorization server must support PKCE S256");
	}
}

function validateDeviceServerInfo(serverInfo: OAuthServerInfo): AuthorizationServerMetadata {
	assertHttpsEndpoint(serverInfo.authorizationServerUrl, "authorization server URL");
	const metadata = serverInfo.authorizationServerMetadata;
	if (!metadata) {
		throw new Error("MCP OAuth device flow requires authorization server metadata");
	}
	assertHttpsEndpoint(metadata.token_endpoint, "token endpoint");
	assertHttpsEndpoint(getDeviceAuthorizationEndpoint(metadata), "device authorization endpoint");
	if (metadata.registration_endpoint) {
		assertHttpsEndpoint(metadata.registration_endpoint, "registration endpoint");
	}
	const grants = metadata.grant_types_supported;
	if (grants && !grants.includes(DEVICE_CODE_GRANT)) {
		throw new Error("MCP OAuth authorization server does not advertise device-code grant support");
	}
	return metadata;
}

function providerFor(
	server: McpResolvedServerConfig,
	store: McpOAuthStore,
	redirectUrl?: string | URL,
): VoltMcpOAuthProvider {
	return new VoltMcpOAuthProvider({
		server,
		store,
		redirectUrl,
		clientName: "Volt",
		clientVersion: VERSION,
	});
}

async function discoverOAuthForServer(
	server: McpResolvedServerConfig,
	fetchFn: typeof fetch = fetch,
): Promise<OAuthServerInfo> {
	assertOAuthServerUrlAllowed(server);
	if (!server.url) {
		throw new Error(`MCP OAuth server ${server.id} is missing URL`);
	}
	const resourceMetadataUrl = server.auth?.resourceMetadataUrl ? new URL(server.auth.resourceMetadataUrl) : undefined;
	if (resourceMetadataUrl) {
		assertHttpsEndpoint(resourceMetadataUrl.toString(), "resource metadata URL");
	}
	return discoverOAuthServerInfo(server.url, {
		resourceMetadataUrl,
		fetchFn,
	});
}

function saveDiscoveryState(
	server: McpResolvedServerConfig,
	provider: VoltMcpOAuthProvider,
	serverInfo: OAuthServerInfo,
): void {
	provider.saveDiscoveryState({
		authorizationServerUrl: serverInfo.authorizationServerUrl,
		resourceMetadata: serverInfo.resourceMetadata,
		authorizationServerMetadata: serverInfo.authorizationServerMetadata,
		...(server.auth?.resourceMetadataUrl ? { resourceMetadataUrl: server.auth.resourceMetadataUrl } : {}),
	});
}

async function ensureClientInformation(
	_server: McpResolvedServerConfig,
	provider: VoltMcpOAuthProvider,
	authorizationServerUrl: string,
	metadata: AuthorizationServerMetadata | undefined,
	scope: string | undefined,
	fetchFn: typeof fetch = fetch,
): Promise<OAuthClientInformationMixed> {
	const existing = provider.clientInformation();
	if (existing) {
		return existing;
	}
	if (metadata?.client_id_metadata_document_supported && provider.clientMetadataUrl) {
		if (!isHttpsUrl(provider.clientMetadataUrl)) {
			throw new Error("MCP OAuth client metadata URL must be an HTTPS URL with a path");
		}
		const clientInformation: OAuthClientInformationMixed = { client_id: provider.clientMetadataUrl };
		provider.saveClientInformation(clientInformation);
		return clientInformation;
	}
	if (!metadata?.registration_endpoint) {
		throw new Error("MCP OAuth dynamic client registration is not available; configure auth.clientId");
	}
	const registered = await registerClient(authorizationServerUrl, {
		metadata,
		clientMetadata: provider.clientMetadata,
		scope,
		fetchFn,
	});
	provider.saveClientInformation(registered);
	return registered;
}

function addClientAuthentication(
	params: URLSearchParams,
	headers: Headers,
	clientInformation: OAuthClientInformationMixed,
	metadata: AuthorizationServerMetadata,
): void {
	const supported = metadata.token_endpoint_auth_methods_supported ?? [];
	const method = selectClientAuthMethod(clientInformation, supported);
	if (method === "client_secret_basic") {
		if (!clientInformation.client_secret) {
			params.set("client_id", clientInformation.client_id);
			return;
		}
		const credentials = Buffer.from(`${clientInformation.client_id}:${clientInformation.client_secret}`).toString(
			"base64",
		);
		headers.set("authorization", `Basic ${credentials}`);
		return;
	}
	params.set("client_id", clientInformation.client_id);
	if (method === "client_secret_post" && clientInformation.client_secret) {
		params.set("client_secret", clientInformation.client_secret);
	}
}

function parseDeviceAuthorizationResponse(value: unknown): DeviceAuthorizationResponse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("MCP OAuth device authorization response must be an object");
	}
	const record = value as Record<string, unknown>;
	const verificationUri = record.verification_uri ?? record.verification_url;
	if (
		typeof record.device_code !== "string" ||
		typeof record.user_code !== "string" ||
		typeof verificationUri !== "string" ||
		typeof record.expires_in !== "number"
	) {
		throw new Error("MCP OAuth device authorization response is missing required fields");
	}
	return {
		device_code: record.device_code,
		user_code: record.user_code,
		verification_uri: verificationUri,
		verification_url: typeof record.verification_url === "string" ? record.verification_url : undefined,
		verification_uri_complete:
			typeof record.verification_uri_complete === "string" ? record.verification_uri_complete : undefined,
		expires_in: record.expires_in,
		interval: typeof record.interval === "number" ? record.interval : undefined,
		message: typeof record.message === "string" ? record.message : undefined,
	};
}

async function parseOAuthTokenResponse(response: Response): Promise<OAuthTokens> {
	const parsed = (await response.json()) as unknown;
	return OAuthTokensSchema.parse(parsed);
}

async function parseOAuthErrorCode(response: Response): Promise<string> {
	try {
		const parsed = (await response.json()) as unknown;
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const error = (parsed as { error?: unknown }).error;
			return typeof error === "string" ? error : `http_${response.status}`;
		}
	} catch {
		// Fall through to status-based error.
	}
	return `http_${response.status}`;
}

export async function startMcpOAuthBrowserAuth(options: {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	redirectUrl: string | URL;
	fetchFn?: typeof fetch;
}): Promise<McpOAuthBrowserStartResult> {
	assertLoopbackRedirectUrl(options.redirectUrl);
	const fetchFn = createSafeMcpOAuthFetch(options.fetchFn);
	const provider = providerFor(options.server, options.store, options.redirectUrl);
	try {
		const serverInfo = await discoverOAuthForServer(options.server, fetchFn);
		validateBrowserServerInfo(serverInfo);
		saveDiscoveryState(options.server, provider, serverInfo);
		const result = await auth(provider, {
			serverUrl: options.server.url ?? "",
			scope: options.server.auth?.scope,
			resourceMetadataUrl: options.server.auth?.resourceMetadataUrl
				? new URL(options.server.auth.resourceMetadataUrl)
				: undefined,
			fetchFn,
		});
		if (result === "AUTHORIZED") {
			return {
				action: "auth",
				server: options.server.id,
				flow: "browser",
				status: "authenticated",
				redirectUrl: String(options.redirectUrl),
				message: "MCP server is already authenticated.",
			};
		}
		if (!provider.authorizationUrl) {
			throw new Error("MCP OAuth authorization URL was not produced");
		}
		return {
			action: "auth",
			server: options.server.id,
			flow: "browser",
			status: "pending",
			authorizationUrl: provider.authorizationUrl.toString(),
			redirectUrl: String(options.redirectUrl),
			state: provider.expectedState,
			message: "Open the authorization URL and complete the browser flow.",
		};
	} catch (error) {
		throw new Error(redactMcpText(error instanceof Error ? error.message : String(error)));
	}
}

export async function completeMcpOAuthBrowserAuth(options: {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	redirectUrl: string | URL;
	code: string;
	state?: string;
	fetchFn?: typeof fetch;
}): Promise<McpOAuthBrowserCompleteResult> {
	assertLoopbackRedirectUrl(options.redirectUrl);
	const record = options.store.getRecord(options.server);
	if (typeof record?.state !== "string" || record.state.length === 0 || options.state !== record.state) {
		throw new Error("MCP OAuth state mismatch");
	}
	const fetchFn = createSafeMcpOAuthFetch(options.fetchFn);
	const provider = providerFor(options.server, options.store, options.redirectUrl);
	try {
		await auth(provider, {
			serverUrl: options.server.url ?? "",
			authorizationCode: options.code,
			scope: options.server.auth?.scope,
			resourceMetadataUrl: options.server.auth?.resourceMetadataUrl
				? new URL(options.server.auth.resourceMetadataUrl)
				: undefined,
			fetchFn,
		});
		options.store.clear(options.server, "verifier");
		return {
			action: "auth",
			server: options.server.id,
			flow: "browser",
			status: "authenticated",
			message: "MCP server authenticated.",
		};
	} catch (error) {
		throw new Error(redactMcpText(error instanceof Error ? error.message : String(error)));
	}
}

export async function startMcpOAuthDeviceAuth(options: {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	fetchFn?: typeof fetch;
}): Promise<{ result: McpOAuthDeviceStartResult; pending: McpOAuthPendingDeviceFlow }> {
	const fetchFn = createSafeMcpOAuthFetch(options.fetchFn);
	const provider = providerFor(options.server, options.store);
	try {
		const serverInfo = await discoverOAuthForServer(options.server, fetchFn);
		const metadata = validateDeviceServerInfo(serverInfo);
		saveDiscoveryState(options.server, provider, serverInfo);
		const resource = options.server.url
			? await selectResourceURL(options.server.url, provider, serverInfo.resourceMetadata)
			: undefined;
		const scope = options.server.auth?.scope ?? serverInfo.resourceMetadata?.scopes_supported?.join(" ");
		const clientInformation = await ensureClientInformation(
			options.server,
			provider,
			serverInfo.authorizationServerUrl,
			metadata,
			scope,
			fetchFn,
		);
		const endpoint = getDeviceAuthorizationEndpoint(metadata);
		if (!endpoint) {
			throw new Error("MCP OAuth device authorization endpoint is missing");
		}
		assertHttpsEndpoint(endpoint, "device authorization endpoint");
		const params = new URLSearchParams();
		const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
		addClientAuthentication(params, headers, clientInformation, metadata);
		if (scope) {
			params.set("scope", scope);
		}
		if (resource) {
			params.set("resource", resource.toString());
		}
		const response = await fetchFn(endpoint, { method: "POST", headers, body: params });
		if (!response.ok) {
			throw new Error(`MCP OAuth device authorization failed: ${await parseOAuthErrorCode(response)}`);
		}
		const device = parseDeviceAuthorizationResponse((await response.json()) as unknown);
		assertBrowserTargetUrl(device.verification_uri ?? device.verification_url ?? "", "verification URL");
		if (device.verification_uri_complete) {
			assertBrowserTargetUrl(device.verification_uri_complete, "complete verification URL");
		}
		const intervalMs = Math.max(1, device.interval ?? DEFAULT_DEVICE_INTERVAL_MS / 1000) * 1000;
		const expiresAtMs = Date.now() + Math.max(1, device.expires_in) * 1000;
		const pending: McpOAuthPendingDeviceFlow = {
			serverId: options.server.id,
			deviceCode: device.device_code,
			userCode: device.user_code,
			verificationUri: device.verification_uri ?? device.verification_url ?? "",
			...(device.verification_uri_complete ? { verificationUriComplete: device.verification_uri_complete } : {}),
			expiresAtMs,
			intervalMs,
			nextPollAtMs: Date.now() + intervalMs,
			authorizationServerUrl: serverInfo.authorizationServerUrl,
			metadata,
			clientInformation,
			resource,
		};
		return {
			pending,
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "pending",
				verificationUri: pending.verificationUri,
				...(pending.verificationUriComplete ? { verificationUriComplete: pending.verificationUriComplete } : {}),
				userCode: pending.userCode,
				expiresAt: new Date(expiresAtMs).toISOString(),
				intervalMs,
				message: device.message ?? "Open the verification URL and enter the user code.",
			},
		};
	} catch (error) {
		throw new Error(redactMcpText(error instanceof Error ? error.message : String(error)));
	}
}

export async function pollMcpOAuthDeviceAuth(options: {
	server: McpResolvedServerConfig;
	store: McpOAuthStore;
	pending: McpOAuthPendingDeviceFlow;
	fetchFn?: typeof fetch;
}): Promise<{ result: McpOAuthDevicePollResult; pending?: McpOAuthPendingDeviceFlow }> {
	if (Date.now() >= options.pending.expiresAtMs) {
		return {
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "failed",
				message: "MCP OAuth device code expired.",
			},
		};
	}
	const waitMs = options.pending.nextPollAtMs - Date.now();
	if (waitMs > 0) {
		return {
			pending: options.pending,
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "pending",
				nextPollMs: waitMs,
				message: "MCP OAuth device authorization is still pending.",
			},
		};
	}
	const params = new URLSearchParams({ grant_type: DEVICE_CODE_GRANT, device_code: options.pending.deviceCode });
	const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
	addClientAuthentication(params, headers, options.pending.clientInformation, options.pending.metadata);
	if (options.pending.resource) {
		params.set("resource", options.pending.resource.toString());
	}
	assertHttpsEndpoint(options.pending.metadata.token_endpoint, "token endpoint");
	const fetchFn = createSafeMcpOAuthFetch(options.fetchFn);
	const response = await fetchFn(options.pending.metadata.token_endpoint, {
		method: "POST",
		headers,
		body: params,
	});
	if (response.ok) {
		const tokens = await parseOAuthTokenResponse(response);
		options.store.patchRecord(options.server, { tokens });
		return {
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "authenticated",
				message: "MCP server authenticated.",
			},
		};
	}
	const error = await parseOAuthErrorCode(response);
	if (error === "authorization_pending") {
		const next = { ...options.pending, nextPollAtMs: Date.now() + options.pending.intervalMs };
		return {
			pending: next,
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "pending",
				nextPollMs: options.pending.intervalMs,
				message: "MCP OAuth device authorization is still pending.",
			},
		};
	}
	if (error === "slow_down") {
		const intervalMs = options.pending.intervalMs + SLOW_DOWN_INCREMENT_MS;
		const next = { ...options.pending, intervalMs, nextPollAtMs: Date.now() + intervalMs };
		return {
			pending: next,
			result: {
				action: "auth",
				server: options.server.id,
				flow: "device",
				status: "pending",
				nextPollMs: intervalMs,
				message: "MCP OAuth authorization server asked Volt to slow down polling.",
			},
		};
	}
	return {
		result: {
			action: "auth",
			server: options.server.id,
			flow: "device",
			status: "failed",
			message: `MCP OAuth device authorization failed: ${redactMcpText(error)}`,
		},
	};
}
