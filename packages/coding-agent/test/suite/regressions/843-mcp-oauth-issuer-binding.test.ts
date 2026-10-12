import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMcpServerAuthState } from "../../../src/core/mcp/auth.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import {
	pollMcpOAuthDeviceAuth,
	startMcpOAuthBrowserAuth,
	startMcpOAuthDeviceAuth,
} from "../../../src/core/mcp/oauth-flow.ts";
import { McpOAuthStore } from "../../../src/core/mcp/oauth-store.ts";
import type { McpResolvedServerConfig } from "../../../src/core/mcp/types.ts";

const MCP_URL = "https://api.example/mcp";
const ISSUER_A = "https://auth-a.example";
const ISSUER_B = "https://auth-b.example";
const REDIRECT_URL = "http://127.0.0.1:4321/mcp/oauth/callback";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

interface SeenRequest {
	url: string;
	/** Request body plus decoded Basic credentials: everything a server could read as a secret. */
	sent: string;
}

/**
 * A protected MCP resource whose metadata names `advertised` as its
 * authorization server, plus two authorization servers that register clients,
 * issue device codes, and mint tokens tagged with their own name.
 */
function createOAuthWorld(advertised: string): { requests: SeenRequest[]; fetchFn: typeof fetch } {
	const requests: SeenRequest[] = [];
	const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
		const authorization = new Headers(init?.headers).get("authorization") ?? "";
		const basic = authorization.startsWith("Basic ")
			? Buffer.from(authorization.slice("Basic ".length), "base64").toString("utf8")
			: authorization;
		requests.push({ url: url.href, sent: `${body}\n${basic}` });

		if (url.pathname.includes("oauth-protected-resource")) {
			return Response.json({ resource: MCP_URL, authorization_servers: [advertised] });
		}
		const tag = url.origin === ISSUER_A ? "a" : "b";
		if (url.pathname.includes("oauth-authorization-server")) {
			return Response.json({
				issuer: url.origin,
				authorization_endpoint: `${url.origin}/authorize`,
				token_endpoint: `${url.origin}/token`,
				registration_endpoint: `${url.origin}/register`,
				device_authorization_endpoint: `${url.origin}/device`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token", DEVICE_GRANT],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
			});
		}
		if (url.pathname === "/register") {
			return Response.json(
				{ ...(JSON.parse(body) as object), client_id: `client-${tag}`, client_secret: `secret-${tag}` },
				{ status: 201 },
			);
		}
		if (url.pathname === "/device") {
			return Response.json({
				device_code: `device-code-${tag}`,
				user_code: "ABCD-EFGH",
				verification_uri: `${url.origin}/activate`,
				expires_in: 600,
				interval: 1,
			});
		}
		if (url.pathname === "/token") {
			return Response.json({
				access_token: `access-${tag}`,
				refresh_token: `refresh-${tag}-next`,
				token_type: "Bearer",
				expires_in: 3600,
				// Not part of the wire format; a response must not choose its own binding.
				issuer: "https://elsewhere.example",
			});
		}
		throw new Error(`Unexpected fetch URL: ${url.href}`);
	};
	return { requests, fetchFn };
}

function sentTo(requests: SeenRequest[], origin: string): string {
	return requests
		.filter((request) => new URL(request.url).origin === origin)
		.map((request) => request.sent)
		.join("\n");
}

function credentialRequests(requests: SeenRequest[], origin: string): string[] {
	return requests
		.map((request) => new URL(request.url))
		.filter((url) => url.origin === origin && ["/register", "/device", "/token"].includes(url.pathname))
		.map((url) => url.pathname);
}

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createAgentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-843-"));
	directories.push(directory);
	return directory;
}

function oauthServer(directory: string, auth: Record<string, unknown> = {}): McpResolvedServerConfig {
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{ servers: { remote: { transport: "streamable-http", url: MCP_URL, auth: { type: "oauth", ...auth } } } },
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	return finalizeMcpConfig(merged).servers.remote;
}

function seedCredentialsFromA(store: McpOAuthStore, server: McpResolvedServerConfig): void {
	store.patchRecord(server, {
		clientInformation: {
			client_id: "client-a",
			client_secret: "secret-a",
			redirect_uris: [REDIRECT_URL],
			issuer: ISSUER_A,
		},
		tokens: { access_token: "access-a", refresh_token: "refresh-a", token_type: "Bearer", issuer: ISSUER_A },
	});
}

describe("MCP OAuth credentials are bound to their issuer (#843)", () => {
	it("refreshes stored credentials with the authorization server that issued them, and keeps the binding on reload", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir);
		seedCredentialsFromA(McpOAuthStore.create(agentDir), server);
		const world = createOAuthWorld(ISSUER_A);

		const result = await startMcpOAuthBrowserAuth({
			server,
			store: McpOAuthStore.create(agentDir),
			redirectUrl: REDIRECT_URL,
			fetchFn: world.fetchFn,
		});

		expect(result.status).toBe("authenticated");
		expect(sentTo(world.requests, ISSUER_A)).toContain("refresh_token=refresh-a");
		expect(sentTo(world.requests, ISSUER_A)).toContain("client-a:secret-a");
		const reloaded = McpOAuthStore.create(agentDir).getRecord(server);
		expect(reloaded?.tokens).toMatchObject({ access_token: "access-a", issuer: ISSUER_A });
		expect(reloaded?.clientInformation).toMatchObject({ client_id: "client-a", issuer: ISSUER_A });
	});

	it("does not present stored refresh tokens or client secrets to a different authorization server", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir);
		seedCredentialsFromA(McpOAuthStore.create(agentDir), server);
		const world = createOAuthWorld(ISSUER_B);

		const result = await startMcpOAuthBrowserAuth({
			server,
			store: McpOAuthStore.create(agentDir),
			redirectUrl: REDIRECT_URL,
			fetchFn: world.fetchFn,
		});

		expect(result.status).toBe("pending");
		expect(new URL(result.authorizationUrl ?? "").origin).toBe(ISSUER_B);
		expect(sentTo(world.requests, ISSUER_B)).not.toContain("refresh-a");
		expect(sentTo(world.requests, ISSUER_B)).not.toContain("secret-a");
		expect(credentialRequests(world.requests, ISSUER_B)).toEqual(["/register"]);
		const record = McpOAuthStore.create(agentDir).getRecord(server);
		expect(record?.clientInformation).toMatchObject({ client_id: "client-b", issuer: ISSUER_B });
		expect(record?.tokens).toMatchObject({ refresh_token: "refresh-a", issuer: ISSUER_A });
	});

	it("drops credentials stored without an issuer instead of binding them on first use", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir);
		McpOAuthStore.create(agentDir).patchRecord(server, {
			clientInformation: {
				client_id: "legacy-client",
				client_secret: "legacy-secret",
				redirect_uris: [REDIRECT_URL],
			},
			tokens: { access_token: "legacy-access", refresh_token: "legacy-refresh", token_type: "Bearer" },
		});
		const store = McpOAuthStore.create(agentDir);

		expect(store.getRecord(server)?.tokens).toBeUndefined();
		expect(store.getRecord(server)?.clientInformation).toBeUndefined();
		expect(getMcpServerAuthState(server, {}, store)).toBe("required");

		// Even the authorization server that issued them cannot claim them now.
		const world = createOAuthWorld(ISSUER_A);
		const result = await startMcpOAuthBrowserAuth({
			server,
			store,
			redirectUrl: REDIRECT_URL,
			fetchFn: world.fetchFn,
		});

		expect(result.status).toBe("pending");
		expect(world.requests.map((request) => request.sent).join("\n")).not.toMatch(/legacy-/);
		expect(credentialRequests(world.requests, ISSUER_A)).toEqual(["/register"]);
		expect(readFileSync(join(agentDir, "mcp-auth.json"), "utf8")).not.toMatch(/legacy-/);
	});

	it("presents pre-registered client credentials only to the configured issuer", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir, {
			flow: "device",
			clientId: "pre-client",
			clientSecret: "pre-secret",
			issuer: ISSUER_A,
		});

		const elsewhere = createOAuthWorld(ISSUER_B);
		await expect(
			startMcpOAuthBrowserAuth({
				server,
				store: McpOAuthStore.create(agentDir),
				redirectUrl: REDIRECT_URL,
				fetchFn: elsewhere.fetchFn,
			}),
		).rejects.toThrow(`${ISSUER_A} and is not presented to ${ISSUER_B}`);
		await expect(
			startMcpOAuthDeviceAuth({ server, store: McpOAuthStore.create(agentDir), fetchFn: elsewhere.fetchFn }),
		).rejects.toThrow(`${ISSUER_A} and is not presented to ${ISSUER_B}`);
		expect(sentTo(elsewhere.requests, ISSUER_B)).not.toContain("pre-secret");
		expect(credentialRequests(elsewhere.requests, ISSUER_B)).toEqual([]);

		const trusted = createOAuthWorld(ISSUER_A);
		const started = await startMcpOAuthDeviceAuth({
			server,
			store: McpOAuthStore.create(agentDir),
			fetchFn: trusted.fetchFn,
		});
		expect(started.result.status).toBe("pending");
		expect(sentTo(trusted.requests, ISSUER_A)).toContain("pre-client:pre-secret");
	});

	it("refuses pre-registered client credentials without a configured issuer", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir, { flow: "device", clientId: "pre-client", clientSecret: "pre-secret" });
		const world = createOAuthWorld(ISSUER_A);

		await expect(
			startMcpOAuthBrowserAuth({
				server,
				store: McpOAuthStore.create(agentDir),
				redirectUrl: REDIRECT_URL,
				fetchFn: world.fetchFn,
			}),
		).rejects.toThrow("auth.issuer");
		await expect(
			startMcpOAuthDeviceAuth({ server, store: McpOAuthStore.create(agentDir), fetchFn: world.fetchFn }),
		).rejects.toThrow("auth.issuer");
		expect(world.requests.map((request) => request.sent).join("\n")).not.toContain("pre-secret");
		expect(credentialRequests(world.requests, ISSUER_A)).toEqual([]);
	});

	it("binds device-flow registrations and tokens to the authorization server in use", async () => {
		const agentDir = createAgentDir();
		const server = oauthServer(agentDir, { flow: "device" });
		McpOAuthStore.create(agentDir).patchRecord(server, {
			clientInformation: { client_id: "client-a", client_secret: "secret-a", issuer: ISSUER_A },
		});
		const world = createOAuthWorld(ISSUER_B);
		const store = McpOAuthStore.create(agentDir);

		const started = await startMcpOAuthDeviceAuth({ server, store, fetchFn: world.fetchFn });
		expect(sentTo(world.requests, ISSUER_B)).not.toContain("secret-a");
		expect(sentTo(world.requests, ISSUER_B)).toContain("client_id=client-b");

		started.pending.nextPollAtMs = Date.now();
		const polled = await pollMcpOAuthDeviceAuth({ server, store, pending: started.pending, fetchFn: world.fetchFn });
		expect(polled.result.status).toBe("authenticated");
		const reloaded = McpOAuthStore.create(agentDir).getRecord(server);
		expect(reloaded?.tokens).toMatchObject({ access_token: "access-b", issuer: ISSUER_B });
		expect(reloaded?.clientInformation).toMatchObject({ client_id: "client-b", issuer: ISSUER_B });

		const requestCount = world.requests.length;
		await expect(
			pollMcpOAuthDeviceAuth({
				server,
				store,
				pending: {
					...started.pending,
					nextPollAtMs: Date.now(),
					clientInformation: { client_id: "client-a", client_secret: "secret-a", issuer: ISSUER_A },
				},
				fetchFn: world.fetchFn,
			}),
		).rejects.toThrow(`${ISSUER_A} and is not presented to ${ISSUER_B}`);
		expect(world.requests).toHaveLength(requestCount);
	});
});
