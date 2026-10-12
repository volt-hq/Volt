import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../../../src/core/auth-storage.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import { startMcpOAuthBrowserAuth } from "../../../src/core/mcp/oauth-flow.ts";
import { McpOAuthStore } from "../../../src/core/mcp/oauth-store.ts";
import { redactMcpText } from "../../../src/core/mcp/safety.ts";
import type { McpResolvedServerConfig } from "../../../src/core/mcp/types.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createOAuthServer(): McpResolvedServerConfig {
	const directory = mkdtempSync(join(tmpdir(), "volt-873-"));
	directories.push(directory);
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: {
				remote: {
					transport: "streamable-http",
					url: "https://api.example/mcp",
					auth: { type: "oauth", clientId: "volt-test" },
				},
			},
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	const server = finalizeMcpConfig(merged).servers.remote;
	expect(server).toBeDefined();
	return server!;
}

describe("issue #873: MCP redaction keeps authorization prose readable", () => {
	it("leaves prose that mentions authorization unchanged", () => {
		for (const message of [
			"MCP OAuth authorization server must support PKCE S256",
			"MCP OAuth authorization server URL must use HTTPS",
			"MCP OAuth device authorization response must be an object",
			"MCP OAuth device authorization failed: invalid_client",
			"Client is bound to authorization server https://issuer.example",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts authorization header and key-value credentials including the auth scheme", () => {
		expect(redactMcpText("request failed with Authorization: Bearer abc.def")).toBe(
			"request failed with Authorization: [redacted]",
		);
		expect(redactMcpText("Authorization: Basic dXNlcjpwYXNz, status 401")).toBe(
			"Authorization: [redacted], status 401",
		);
		expect(redactMcpText("Proxy-Authorization:token ghp_abc")).toBe("Proxy-Authorization:[redacted]");
		expect(redactMcpText("https://api.example/mcp?authorization=abc123&x=1")).toBe(
			"https://api.example/mcp?authorization=[redacted]",
		);
		expect(redactMcpText('{"authorization":"Bearer abc"}')).toBe('{"authorization":"Bearer [redacted]"}');
	});

	it("reports the failed authorization server check from the browser flow", async () => {
		const server = createOAuthServer();
		const fetchFn = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.includes("oauth-protected-resource")) {
				return Response.json({
					resource: "https://api.example/mcp",
					authorization_servers: ["https://auth.example"],
				});
			}
			if (url.includes("oauth-authorization-server")) {
				return Response.json({
					issuer: "https://auth.example",
					authorization_endpoint: "https://auth.example/authorize",
					token_endpoint: "https://auth.example/token",
					response_types_supported: ["code"],
					code_challenge_methods_supported: ["plain"],
				});
			}
			throw new Error(`Unexpected fetch URL: ${url}`);
		};

		await expect(
			startMcpOAuthBrowserAuth({
				server,
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				redirectUrl: "http://127.0.0.1:4321/mcp/oauth/callback",
				fetchFn,
			}),
		).rejects.toThrow("MCP OAuth authorization server must support PKCE S256");
	});
});
