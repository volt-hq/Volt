import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListToolsResult,
	ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import { buildMcpAuthorizationHeaders, resolveMcpStringRecordTemplates } from "./auth.ts";
import { createSafeMcpOAuthFetch } from "./oauth-flow.ts";
import { VoltMcpOAuthProvider } from "./oauth-provider.ts";
import type { McpOAuthStore } from "./oauth-store.ts";
import type { McpClientConnection, McpClientFactory, McpRequestOptions, McpResolvedServerConfig } from "./types.ts";

type McpSdkTransport = Transport & {
	terminateSession?: () => Promise<void>;
};

export interface DefaultMcpClientFactoryOptions {
	cwd: string;
	clientName?: string;
	clientVersion?: string;
	env?: NodeJS.ProcessEnv;
	oauthStore?: McpOAuthStore;
}

function isCallToolResult(value: unknown): value is CallToolResult {
	return typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content);
}

class SdkMcpClientConnection implements McpClientConnection {
	private client: Client;
	private transport: McpSdkTransport;

	constructor(client: Client, transport: McpSdkTransport) {
		this.client = client;
		this.transport = transport;
	}

	async listTools(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<ListToolsResult> {
		return this.client.listTools(params, options);
	}

	async listResources(
		params: { cursor?: string } | undefined,
		options: McpRequestOptions,
	): Promise<ListResourcesResult> {
		return this.client.listResources(params, options);
	}

	async readResource(params: { uri: string }, options: McpRequestOptions): Promise<ReadResourceResult> {
		return this.client.readResource(params, options);
	}

	async listPrompts(params: { cursor?: string } | undefined, options: McpRequestOptions): Promise<ListPromptsResult> {
		return this.client.listPrompts(params, options);
	}

	async getPrompt(
		params: { name: string; arguments?: Record<string, unknown> },
		options: McpRequestOptions,
	): Promise<GetPromptResult> {
		return this.client.getPrompt(
			{ name: params.name, arguments: stringifyPromptArguments(params.arguments) },
			options,
		);
	}

	async callTool(
		params: { name: string; arguments?: Record<string, unknown> },
		options: McpRequestOptions,
	): Promise<CallToolResult> {
		const { onProgress, ...sdkOptions } = options;
		const result = await this.client.callTool(params, CallToolResultSchema, {
			...sdkOptions,
			...(onProgress
				? {
						onprogress: (progress: { progress: number; total?: number; message?: string }) =>
							onProgress({
								progress: progress.progress,
								...(progress.total !== undefined ? { total: progress.total } : {}),
								...(progress.message !== undefined ? { message: progress.message } : {}),
							}),
					}
				: {}),
		});
		if (isCallToolResult(result)) {
			return result;
		}
		throw new Error("MCP server returned a compatibility tool result without content");
	}

	getServerVersion(): { name: string; version: string } | undefined {
		return this.client.getServerVersion();
	}

	async close(): Promise<void> {
		try {
			await this.transport.terminateSession?.();
		} catch {
			// Some servers reject session termination; close the transport regardless.
		}
		await this.client.close();
	}
}

function stringifyPromptArguments(args: Record<string, unknown> | undefined): Record<string, string> | undefined {
	if (!args) {
		return undefined;
	}
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(args)) {
		result[key] = typeof value === "string" ? value : JSON.stringify(value);
	}
	return result;
}

function buildStdioEnvironment(server: McpResolvedServerConfig, env: NodeJS.ProcessEnv): Record<string, string> {
	const result: Record<string, string> = getDefaultEnvironment();
	for (const key of server.envAllowlist) {
		const value = env[key];
		if (value !== undefined) {
			result[key] = value;
		}
	}
	return { ...result, ...resolveMcpStringRecordTemplates(server.env, env) };
}

function isLoopbackHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function assertSafeAuthenticatedUrl(server: McpResolvedServerConfig, url: URL, headers: Record<string, string>): void {
	if (Object.keys(headers).length === 0 && server.auth?.type !== "oauth") {
		return;
	}
	if (url.protocol === "https:") {
		return;
	}
	if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
		return;
	}
	throw new Error(`MCP server ${server.id} uses authenticated HTTP over an insecure URL`);
}

function createRequestInit(server: McpResolvedServerConfig, env: NodeJS.ProcessEnv, url: URL): RequestInit | undefined {
	const headers = buildMcpAuthorizationHeaders(server, env);
	assertSafeAuthenticatedUrl(server, url, headers);
	if (Object.keys(headers).length === 0) {
		return undefined;
	}
	return { headers };
}

type HeaderInput = ConstructorParameters<typeof Headers>[0];

function mergeHeaders(base: HeaderInput | undefined, extra: HeaderInput | undefined): Headers {
	const headers = new Headers(base);
	const extraHeaders = new Headers(extra);
	for (const [key, value] of extraHeaders.entries()) {
		if (!headers.has(key)) {
			headers.set(key, value);
		}
	}
	return headers;
}

function createExactResourceFetch(serverUrl: URL, requestInit: RequestInit | undefined): typeof fetch {
	const expected = serverUrl.toString();
	const oauthFetch = createSafeMcpOAuthFetch();
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const requestUrl = input instanceof Request ? input.url : String(input);
		if (requestUrl !== expected || !requestInit?.headers) {
			return oauthFetch(input, init);
		}
		return oauthFetch(input, { ...init, headers: mergeHeaders(init?.headers, requestInit.headers) });
	};
}

export class DefaultMcpClientFactory implements McpClientFactory {
	private cwd: string;
	private clientName: string;
	private clientVersion: string;
	private env: NodeJS.ProcessEnv;
	private oauthStore: McpOAuthStore | undefined;

	constructor(options: DefaultMcpClientFactoryOptions) {
		this.cwd = resolvePath(options.cwd);
		this.clientName = options.clientName ?? "volt";
		this.clientVersion = options.clientVersion ?? VERSION;
		this.env = options.env ?? process.env;
		this.oauthStore = options.oauthStore;
	}

	async connect(server: McpResolvedServerConfig, options: McpRequestOptions): Promise<McpClientConnection> {
		const client = new Client({ name: this.clientName, version: this.clientVersion }, { capabilities: {} });
		const transport = this.createTransport(server);
		try {
			await client.connect(transport, options);
			return new SdkMcpClientConnection(client, transport);
		} catch (error) {
			await transport.close().catch(() => undefined);
			throw error;
		}
	}

	private createTransport(server: McpResolvedServerConfig): McpSdkTransport {
		if (server.transport === "stdio") {
			if (!server.command) {
				throw new Error(`MCP stdio server ${server.id} is missing command`);
			}
			return new StdioClientTransport({
				command: server.command,
				args: server.args,
				cwd: resolvePath(server.cwd ?? this.cwd, this.cwd),
				env: buildStdioEnvironment(server, this.env),
				stderr: "ignore",
			});
		}
		if (!server.url) {
			throw new Error(`MCP HTTP server ${server.id} is missing URL`);
		}
		const url = new URL(server.url);
		const requestInit = createRequestInit(server, this.env, url);
		const authProvider =
			server.auth?.type === "oauth" && this.oauthStore
				? new VoltMcpOAuthProvider({
						server,
						store: this.oauthStore,
						redirectUrl: "http://127.0.0.1/mcp/oauth/callback",
						clientName: this.clientName,
						clientVersion: this.clientVersion,
					})
				: undefined;
		const scopedFetch = authProvider ? createExactResourceFetch(url, requestInit) : undefined;
		const transportRequestInit = authProvider ? undefined : requestInit;
		if (server.transport === "sse") {
			return new SSEClientTransport(url, {
				requestInit: transportRequestInit,
				authProvider,
				...(scopedFetch ? { fetch: scopedFetch } : {}),
			});
		}
		return new StreamableHTTPClientTransport(url, {
			requestInit: transportRequestInit,
			authProvider,
			...(scopedFetch ? { fetch: scopedFetch } : {}),
		});
	}
}
