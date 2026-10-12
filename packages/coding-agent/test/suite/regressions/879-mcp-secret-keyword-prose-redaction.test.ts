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
import { redactMcpText } from "../../../src/core/mcp/safety.ts";
import type { McpResolvedServerConfig } from "../../../src/core/mcp/types.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createOAuthServer(flow: "browser" | "device"): McpResolvedServerConfig {
	const directory = mkdtempSync(join(tmpdir(), "volt-879-"));
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

// Discovery succeeds, but the advertised token endpoint is plain HTTP.
const plaintextTokenEndpointFetch = async (input: string | URL | Request): Promise<Response> => {
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
};

describe("issue #879: MCP redaction keeps secret-keyword prose readable", () => {
	it("leaves prose that mentions secret keywords unchanged", () => {
		for (const message of [
			"MCP OAuth token endpoint must use HTTPS",
			"MCP OAuth token endpoint is missing",
			"private key file is unreadable",
			"secret store is locked",
			"password prompt was cancelled",
			"passwd file not found",
			"api key rotation is pending",
			"credential helper exited with code 1",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("still redacts key-value and bearer credentials", () => {
		expect(redactMcpText("token=abc123")).toBe("token=[redacted]");
		expect(redactMcpText("refresh failed: token: abc123, status 401")).toBe(
			"refresh failed: token: [redacted], status 401",
		);
		expect(redactMcpText("client_secret = s3cr3t; retry")).toBe("client_secret = [redacted]; retry");
		expect(redactMcpText("password := hunter2")).toBe("password := [redacted]");
		expect(redactMcpText("api_key:abc private=xyz credential: c1")).toBe(
			"api_key:[redacted] private=[redacted] credential: [redacted]",
		);
		expect(redactMcpText("https://api.example/mcp?access_token=abc123&x=1")).toBe(
			"https://api.example/mcp?access_token=[redacted]",
		);
		expect(redactMcpText("sent Bearer abc.def to the token endpoint")).toBe(
			"sent Bearer [redacted] to the token endpoint",
		);
	});

	it("reports the failed token endpoint check from the browser flow", async () => {
		await expect(
			startMcpOAuthBrowserAuth({
				server: createOAuthServer("browser"),
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				redirectUrl: "http://127.0.0.1:4321/mcp/oauth/callback",
				fetchFn: plaintextTokenEndpointFetch,
			}),
		).rejects.toThrow("MCP OAuth token endpoint must use HTTPS");
	});

	it("reports the failed token endpoint check from the device flow", async () => {
		await expect(
			startMcpOAuthDeviceAuth({
				server: createOAuthServer("device"),
				store: McpOAuthStore.fromStorage(new InMemoryAuthStorageBackend()),
				fetchFn: plaintextTokenEndpointFetch,
			}),
		).rejects.toThrow("MCP OAuth token endpoint must use HTTPS");
	});
});
