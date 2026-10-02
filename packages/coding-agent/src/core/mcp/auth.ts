import type { McpOAuthStore } from "./oauth-store.ts";
import type { McpAuthState, McpResolvedServerConfig } from "./types.ts";

const ENV_TEMPLATE = /^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function resolveMcpSecretTemplate(value: string, env: NodeJS.ProcessEnv = process.env): string {
	const match = ENV_TEMPLATE.exec(value.trim());
	if (!match) {
		return value;
	}
	const resolved = env[match[1]];
	if (resolved === undefined || resolved.length === 0) {
		throw new Error(`MCP environment variable is not set: ${match[1]}`);
	}
	return resolved;
}

export function resolveMcpStringRecordTemplates(
	values: Record<string, string>,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		resolved[key] = resolveMcpSecretTemplate(value, env);
	}
	return resolved;
}

export function getMcpServerAuthState(
	server: McpResolvedServerConfig,
	env: NodeJS.ProcessEnv = process.env,
	oauthStore?: McpOAuthStore,
): McpAuthState {
	if (server.auth?.type === "oauth") {
		return oauthStore?.hasUsableTokens(server) ? "authenticated" : "required";
	}
	try {
		if (server.auth?.type === "bearer" && server.auth.token) {
			resolveMcpSecretTemplate(server.auth.token, env);
		}
		if (server.auth?.type === "env" && server.auth.env) {
			const value = env[server.auth.env];
			if (!value) {
				return "required";
			}
		}
		resolveMcpStringRecordTemplates(server.headers, env);
		resolveMcpStringRecordTemplates(server.env, env);
	} catch {
		return "required";
	}
	return server.auth?.type && server.auth.type !== "none" ? "authenticated" : "none";
}

export function buildMcpAuthorizationHeaders(
	server: McpResolvedServerConfig,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const headers = resolveMcpStringRecordTemplates(server.headers, env);
	if (server.auth?.type === "bearer" && server.auth.token) {
		headers.authorization = `Bearer ${resolveMcpSecretTemplate(server.auth.token, env)}`;
	}
	if (server.auth?.type === "env" && server.auth.env) {
		const token = env[server.auth.env];
		if (!token) {
			throw new Error(`MCP auth environment variable is not set: ${server.auth.env}`);
		}
		headers.authorization = `Bearer ${token}`;
	}
	return headers;
}
