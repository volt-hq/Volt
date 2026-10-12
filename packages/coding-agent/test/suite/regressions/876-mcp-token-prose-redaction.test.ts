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
import { startMcpOAuthBrowserAuth, startMcpOAuthDeviceAuth } from "../../../src/core/mcp/oauth-flow.ts";
import { McpOAuthStore } from "../../../src/core/mcp/oauth-store.ts";
import { redactMcpText, sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";
import type { McpResolvedServerConfig } from "../../../src/core/mcp/types.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createOAuthServer(flow: "browser" | "device"): McpResolvedServerConfig {
	const directory = mkdtempSync(join(tmpdir(), "volt-876-"));
	directories.push(directory);
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: {
				remote: {
					transport: "streamable-http",
					url: "https://api.example/mcp",
					auth: { type: "oauth", flow, clientId: "volt-test" },
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

// Serves discovery metadata whose token endpoint is plain HTTP.
async function insecureTokenEndpointFetch(input: string | URL | Request): Promise<Response> {
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
			token_endpoint: "http://auth.example/token",
			device_authorization_endpoint: "https://auth.example/device",
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
			code_challenge_methods_supported: ["S256"],
		});
	}
	throw new Error(`Unexpected fetch URL: ${url}`);
}

describe("issue #876: MCP redaction keeps secret key names in prose readable", () => {
	it("leaves prose that mentions a secret key name unchanged", () => {
		for (const message of [
			"MCP OAuth token endpoint must use HTTPS",
			"MCP OAuth token endpoint is missing",
			"MCP OAuth token endpoint must not include userinfo or fragments",
			"Refresh token expired",
			"Refresh-token expired",
			"Client secret is required",
			"password reset required",
			"credential helper failed",
			"private key is missing",
			"Existing OAuth client information is required when exchanging an authorization code",
			"Retried token 3 times",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts values after a colon or equals separator", () => {
		expect(redactMcpText("token: abc123")).toBe("token: [redacted]");
		expect(redactMcpText("token:abc123 rejected")).toBe("token:[redacted] rejected");
		expect(redactMcpText("password = hunter2")).toBe("password = [redacted]");
		expect(redactMcpText("token := abc123")).toBe("token := [redacted]");
		expect(redactMcpText("https://auth.example/cb?access_token=abc123&x=1")).toBe(
			"https://auth.example/cb?access_token=[redacted]",
		);
		expect(redactMcpText("client_secret=xyz, status 400")).toBe("client_secret=[redacted], status 400");
		expect(redactMcpText("API_KEY: sk-abc; retry")).toBe("API_KEY: [redacted]; retry");
	});

	it("redacts credential-like values separated from their key name by whitespace", () => {
		expect(redactMcpText("401 Unauthorized: invalid token ghp_abc123")).toBe(
			"401 Unauthorized: invalid token [redacted]",
		);
		expect(redactMcpText("x-api-key sk-live-123")).toBe("x-api-key [redacted]");
		expect(redactMcpText("password hunter2 rejected")).toBe("password [redacted] rejected");
		expect(redactMcpText("token abc123")).toBe("token [redacted]");
		expect(redactMcpText("Refresh token eyJhbGciOiJIUzI1NiJ9.e30.sig expired")).toBe(
			"Refresh token [redacted] expired",
		);
		expect(sanitizeMcpArguments({ error: "invalid token ghp_abc123", note: "token endpoint" })).toEqual({
			error: "invalid token [redacted]",
			note: "token endpoint",
		});
	});

	it("redacts values after command-line flags named for a secret", () => {
		expect(redactMcpText("deploy --token abc123 --verbose")).toBe("deploy --token [redacted] --verbose");
		expect(redactMcpText("deploy --github-token ghp_abc")).toBe("deploy --github-token [redacted]");
		expect(redactMcpText("login --api-key sk-abc")).toBe("login --api-key [redacted]");
		expect(redactMcpText("keytool -password hunter2")).toBe("keytool -password [redacted]");
		expect(redactMcpText("deploy --token-file /tmp/token")).toBe("deploy --token-file /tmp/token");
		expect(sanitizeMcpArguments({ command: "db connect --password hunter2", note: "token endpoint" })).toEqual({
			command: "db connect --password [redacted]",
			note: "token endpoint",
		});
	});

	it("reports the failed token endpoint check from the browser and device flows", async () => {
		await expect(
			startMcpOAuthBrowserAuth({
				server: createOAuthServer("browser"),
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				redirectUrl: "http://127.0.0.1:4321/mcp/oauth/callback",
				fetchFn: insecureTokenEndpointFetch,
			}),
		).rejects.toThrowError(/^MCP OAuth token endpoint must use HTTPS$/);
		await expect(
			startMcpOAuthDeviceAuth({
				server: createOAuthServer("device"),
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				fetchFn: insecureTokenEndpointFetch,
			}),
		).rejects.toThrowError(/^MCP OAuth token endpoint must use HTTPS$/);
	});
});
