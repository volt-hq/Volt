import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefaultMcpClientFactory } from "../../../src/core/mcp/client-factory.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import { completeMcpOAuthBrowserAuth, startMcpOAuthBrowserAuth } from "../../../src/core/mcp/oauth-flow.ts";
import { McpOAuthStore } from "../../../src/core/mcp/oauth-store.ts";
import type { McpResolvedServerConfig } from "../../../src/core/mcp/types.ts";

const MCP_URL = "https://api.example/mcp";
const ISSUER = "https://auth.example";
/** Browser sign-in listens on an ephemeral loopback port, so its redirect URL carries one. */
const REDIRECT_URL = "http://127.0.0.1:4321/mcp/oauth/callback";

interface OAuthWorld {
	fetchFn: typeof fetch;
	/** `redirect_uris` of every dynamic client registration. */
	registrations: string[][];
	/** `client_id` presented with every refresh-token grant. */
	refreshClients: string[];
	/** Makes the MCP server reject every access token issued so far. */
	expireAccessTokens(): void;
}

/**
 * A protected MCP resource and its authorization server. Refresh tokens only
 * work for the client they were issued to, as real authorization servers enforce.
 */
function createOAuthWorld(): OAuthWorld {
	const registrations: string[][] = [];
	const refreshClients: string[] = [];
	const refreshTokenClients = new Map<string, string>();
	const liveAccessTokens = new Set<string>();
	let issued = 0;

	const issueTokens = (clientId: string): Response => {
		issued += 1;
		const tokens = { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` };
		liveAccessTokens.add(tokens.access_token);
		refreshTokenClients.set(tokens.refresh_token, clientId);
		return Response.json({ ...tokens, token_type: "Bearer", expires_in: 3600 });
	};

	const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.pathname.includes("oauth-protected-resource")) {
			return Response.json({ resource: MCP_URL, authorization_servers: [ISSUER] });
		}
		if (url.pathname.includes("oauth-authorization-server")) {
			return Response.json({
				issuer: ISSUER,
				authorization_endpoint: `${ISSUER}/authorize`,
				token_endpoint: `${ISSUER}/token`,
				registration_endpoint: `${ISSUER}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		}
		if (url.href === `${ISSUER}/register`) {
			const metadata = JSON.parse(String(init?.body)) as { redirect_uris: string[] };
			registrations.push(metadata.redirect_uris);
			return Response.json({ ...metadata, client_id: `client-${registrations.length}` }, { status: 201 });
		}
		if (url.href === `${ISSUER}/token`) {
			const params = new URLSearchParams(String(init?.body));
			const clientId = params.get("client_id") ?? "";
			if (params.get("grant_type") === "authorization_code") {
				return issueTokens(clientId);
			}
			refreshClients.push(clientId);
			if (refreshTokenClients.get(params.get("refresh_token") ?? "") !== clientId) {
				return Response.json({ error: "invalid_grant" }, { status: 400 });
			}
			return issueTokens(clientId);
		}
		if (url.href === MCP_URL) {
			const accessToken = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
			if (!liveAccessTokens.has(accessToken)) {
				return new Response(null, {
					status: 401,
					headers: {
						"www-authenticate": `Bearer resource_metadata="https://api.example/.well-known/oauth-protected-resource/mcp"`,
					},
				});
			}
			if (init?.method !== "POST") {
				return new Response(null, { status: 405 });
			}
			const message = JSON.parse(String(init.body)) as {
				id?: number;
				method: string;
				params?: { protocolVersion?: string };
			};
			if (message.id === undefined) {
				return new Response(null, { status: 202 });
			}
			return Response.json({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion,
					capabilities: {},
					serverInfo: { name: "remote", version: "1.0.0" },
				},
			});
		}
		throw new Error(`Unexpected fetch URL: ${url.href}`);
	};

	return {
		fetchFn,
		registrations,
		refreshClients,
		expireAccessTokens: () => liveAccessTokens.clear(),
	};
}

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-878-"));
	directories.push(directory);
	return directory;
}

function oauthServer(directory: string): McpResolvedServerConfig {
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{ servers: { remote: { transport: "streamable-http", url: MCP_URL, auth: { type: "oauth" } } } },
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	return finalizeMcpConfig(merged).servers.remote;
}

describe("MCP connections use the OAuth client registered by browser sign-in (#878)", () => {
	it("refreshes an expired access token with the browser sign-in client and keeps that client stored", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir);
		const world = createOAuthWorld();

		const started = await startMcpOAuthBrowserAuth({
			server,
			store: McpOAuthStore.create(agentDir),
			redirectUrl: REDIRECT_URL,
			fetchFn: world.fetchFn,
		});
		expect(started.status).toBe("pending");
		await completeMcpOAuthBrowserAuth({
			server,
			store: McpOAuthStore.create(agentDir),
			redirectUrl: REDIRECT_URL,
			code: "authorization-code",
			state: started.state,
			fetchFn: world.fetchFn,
		});
		expect(world.registrations).toEqual([[REDIRECT_URL]]);

		world.expireAccessTokens();
		vi.stubGlobal("fetch", world.fetchFn);
		const factory = new DefaultMcpClientFactory({ cwd: agentDir, oauthStore: McpOAuthStore.create(agentDir) });
		const connection = await factory.connect(server, {});
		try {
			expect(connection.getServerVersion()).toEqual({ name: "remote", version: "1.0.0" });
		} finally {
			await connection.close();
		}

		expect(world.registrations).toEqual([[REDIRECT_URL]]);
		expect(world.refreshClients).toEqual(["client-1"]);
		const record = McpOAuthStore.create(agentDir).getRecord(server);
		expect(record?.clientInformation).toMatchObject({ client_id: "client-1", redirect_uris: [REDIRECT_URL] });
		expect(record?.tokens?.access_token).toBe("access-2");
	});
});
