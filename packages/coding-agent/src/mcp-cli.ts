import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import chalk from "chalk";
import { getAgentDir } from "./config.ts";
import { DefaultMcpClientFactory } from "./core/mcp/client-factory.ts";
import { loadMcpConfig } from "./core/mcp/config-loader.ts";
import { McpConfigWriter } from "./core/mcp/config-writer.ts";
import { McpManager } from "./core/mcp/manager.ts";
import { McpMetadataCache } from "./core/mcp/metadata-cache.ts";
import { McpOAuthStore } from "./core/mcp/oauth-store.ts";
import { McpOutputStore } from "./core/mcp/output-store.ts";
import type { McpGatewayExecutionContext, McpGatewayInput } from "./core/mcp/types.ts";
import { type DefaultProjectTrust, SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { openBrowser } from "./utils/open-browser.ts";
import { resolvePath } from "./utils/paths.ts";

interface McpCliOptions {
	profile?: string;
}

interface ParsedMcpCommand {
	command: string;
	args: string[];
	json: boolean;
	projectTrustOverride?: boolean;
}

function printMcpHelp(): void {
	console.log(`${chalk.bold("Usage:")} volt mcp <command> [options]

${chalk.bold("Commands:")}
  status                         Show MCP status and diagnostics
  list                           List configured MCP servers
  get <server>                   Show one server summary
  connect <server>               Connect and refresh metadata
  refresh <server>               Alias for connect
  disconnect <server>            Disconnect a server
  auth <server>                  Complete browser OAuth for a server
  auth-device <server>           Complete OAuth device-code auth for a server
  logout <server>                Clear stored OAuth credentials for a server
  enable <server>                Persist an enabled overlay
  disable <server>               Persist a disabled overlay
  tools <server>                 List cached/refreshed tools
  resources <server>             List resources
  read-resource <server> <uri>   Read one resource
  prompts <server>               List prompts
  get-prompt <server> <prompt> [jsonArgs]

${chalk.bold("Options:")}
  --json                         Print JSON
  --approve, -a                  Trust project MCP config for this command
  --no-approve, -na              Ignore project MCP config for this command
`);
}

function parseMcpCommand(args: string[]): ParsedMcpCommand {
	const rest: string[] = [];
	let json = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of args) {
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}
		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}
		rest.push(arg);
	}
	return { command: rest[0] ?? "help", args: rest.slice(1), json, projectTrustOverride };
}

function resolveMcpProjectTrusted(
	cwd: string,
	agentDir: string,
	defaultProjectTrust: DefaultProjectTrust,
	override: boolean | undefined,
): boolean {
	if (override !== undefined) {
		return override;
	}
	if (!hasTrustRequiringProjectResources(cwd)) {
		return true;
	}
	const saved = new ProjectTrustStore(agentDir).get(cwd);
	if (saved !== undefined && saved !== null) {
		return saved;
	}
	return defaultProjectTrust === "always";
}

async function createMcpCliManager(
	projectTrustOverride: boolean | undefined,
	profile: string | undefined,
): Promise<McpManager> {
	const cwd = resolvePath(process.cwd());
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false, profile });
	const projectTrusted = resolveMcpProjectTrusted(
		cwd,
		agentDir,
		settingsManager.getDefaultProjectTrust(),
		projectTrustOverride,
	);
	const config = loadMcpConfig({ cwd, agentDir, projectTrusted });
	const oauthStore = McpOAuthStore.create(agentDir);
	return new McpManager({
		config,
		clientFactory: new DefaultMcpClientFactory({ cwd, oauthStore }),
		metadataCache: new McpMetadataCache({ agentDir }),
		outputStore: new McpOutputStore({
			agentDir,
			maxOutputBytes: config.settings.maxOutputBytes,
			maxOutputLines: config.settings.maxOutputLines,
			workspaceId: cwd,
		}),
		configWriter: new McpConfigWriter({ cwd, agentDir, projectTrusted }),
		oauthStore,
		workspaceId: cwd,
	});
}

function outputResult(result: unknown, json: boolean): void {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}
	if (typeof result === "string") {
		console.log(result);
		return;
	}
	console.log(JSON.stringify(result, null, 2));
}

function requireArg(args: string[], index: number, label: string): string {
	const value = args[index]?.trim();
	if (!value) {
		throw new Error(`${label} is required`);
	}
	return value;
}

function cliMcpContext(): McpGatewayExecutionContext {
	return { mode: "print", caller: "user" };
}

function parseOptionalJsonArgs(value: string | undefined): Record<string, unknown> | undefined {
	if (value === undefined) {
		return undefined;
	}
	const parsed = JSON.parse(value) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("prompt arguments must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

interface OAuthCallbackResult {
	code: string;
	state?: string;
}

async function createOAuthLoopbackReceiver(): Promise<{
	redirectUrl: string;
	waitForCallback: () => Promise<OAuthCallbackResult>;
	close: () => Promise<void>;
}> {
	const callbackPath = `/mcp/oauth/callback/${randomBytes(16).toString("base64url")}`;
	let resolveCallback: ((value: OAuthCallbackResult) => void) | undefined;
	let rejectCallback: ((error: Error) => void) | undefined;
	const callback = new Promise<OAuthCallbackResult>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});
	const server = createServer((request: IncomingMessage, response: ServerResponse) => {
		try {
			const remote = request.socket.remoteAddress ?? "";
			const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
			if (!isLoopback) {
				response.writeHead(403).end("Forbidden");
				return;
			}
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== callbackPath) {
				response.writeHead(404).end("Not found");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				response
					.writeHead(400, {
						"content-type": "text/html; charset=utf-8",
						"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
						"referrer-policy": "no-referrer",
					})
					.end("<h1>Volt MCP authorization failed</h1><p>You can close this tab.</p>");
				rejectCallback?.(new Error(`OAuth error: ${error}`));
				return;
			}
			const code = url.searchParams.get("code");
			if (!code) {
				response.writeHead(400).end("Missing code");
				rejectCallback?.(new Error("OAuth callback did not include a code"));
				return;
			}
			response
				.writeHead(200, {
					"content-type": "text/html; charset=utf-8",
					"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
					"referrer-policy": "no-referrer",
				})
				.end("<h1>Volt MCP authorization complete</h1><p>You can close this tab and return to Volt.</p>");
			resolveCallback?.({ code, state: url.searchParams.get("state") ?? undefined });
		} catch (error) {
			rejectCallback?.(error instanceof Error ? error : new Error(String(error)));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (typeof address !== "object" || address === null) {
		throw new Error("Failed to start MCP OAuth loopback receiver");
	}
	const timeout = setTimeout(
		() => {
			rejectCallback?.(new Error("Timed out waiting for MCP OAuth callback"));
		},
		5 * 60 * 1000,
	);
	return {
		redirectUrl: `http://127.0.0.1:${address.port}${callbackPath}`,
		waitForCallback: async () => {
			try {
				return await callback;
			} finally {
				clearTimeout(timeout);
			}
		},
		close: async () => {
			clearTimeout(timeout);
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

async function runBrowserAuth(manager: McpManager, serverId: string, json: boolean): Promise<unknown> {
	const receiver = await createOAuthLoopbackReceiver();
	try {
		const started = (await manager.startServerAuth(serverId, {
			flow: "browser",
			redirectUrl: receiver.redirectUrl,
		})) as { status?: string; authorizationUrl?: string; redirectUrl?: string };
		if (started.status === "authenticated") {
			return started;
		}
		if (!started.authorizationUrl) {
			throw new Error("MCP OAuth did not return an authorization URL");
		}
		if (!json) {
			console.log(chalk.cyan("Open this URL to authenticate MCP:"));
			console.log(started.authorizationUrl);
		}
		openBrowser(started.authorizationUrl);
		const callback = await receiver.waitForCallback();
		return manager.completeServerBrowserAuth(serverId, {
			redirectUrl: started.redirectUrl ?? receiver.redirectUrl,
			code: callback.code,
			state: callback.state,
		});
	} finally {
		await receiver.close();
	}
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDeviceAuth(manager: McpManager, serverId: string, json: boolean): Promise<unknown> {
	const started = (await manager.startServerAuth(serverId, { flow: "device" })) as {
		verificationUri?: string;
		verificationUriComplete?: string;
		userCode?: string;
		intervalMs?: number;
		message?: string;
	};
	if (!json) {
		console.log(chalk.cyan("MCP device authorization"));
		console.log(`URL: ${started.verificationUriComplete ?? started.verificationUri}`);
		console.log(`Code: ${started.userCode}`);
		if (started.message) {
			console.log(started.message);
		}
	}
	if (started.verificationUriComplete ?? started.verificationUri) {
		openBrowser(started.verificationUriComplete ?? started.verificationUri ?? "");
	}
	let waitMs = started.intervalMs ?? 5000;
	for (;;) {
		await sleep(waitMs);
		const polled = (await manager.pollServerAuth(serverId)) as {
			status?: string;
			nextPollMs?: number;
			message?: string;
		};
		if (polled.status === "authenticated" || polled.status === "failed") {
			return polled;
		}
		waitMs = polled.nextPollMs ?? waitMs;
	}
}

export async function handleMcpCommand(args: string[], options: McpCliOptions = {}): Promise<boolean> {
	if (args[0] !== "mcp") {
		return false;
	}
	const parsed = parseMcpCommand(args.slice(1));
	if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
		printMcpHelp();
		return true;
	}

	let manager: McpManager | undefined;
	try {
		manager = await createMcpCliManager(parsed.projectTrustOverride, options.profile);
		let result: unknown;
		switch (parsed.command) {
			case "status":
				result = await manager.handleGatewayInput({ action: "status" }, cliMcpContext());
				break;
			case "list":
				result = { servers: manager.listServers() };
				break;
			case "get":
				result = { server: manager.getServer(requireArg(parsed.args, 0, "server")) };
				break;
			case "connect":
			case "refresh":
				result = await manager.connectServer(requireArg(parsed.args, 0, "server"));
				break;
			case "disconnect":
				result = await manager.disconnectServer(requireArg(parsed.args, 0, "server"));
				break;
			case "auth":
				result = await runBrowserAuth(manager, requireArg(parsed.args, 0, "server"), parsed.json);
				break;
			case "auth-device":
				result = await runDeviceAuth(manager, requireArg(parsed.args, 0, "server"), parsed.json);
				break;
			case "logout":
				result = await manager.logoutServer(requireArg(parsed.args, 0, "server"));
				break;
			case "enable":
				result = await manager.setServerEnabled(requireArg(parsed.args, 0, "server"), true);
				break;
			case "disable":
				result = await manager.setServerEnabled(requireArg(parsed.args, 0, "server"), false);
				break;
			case "tools":
				result = await manager.listTools(requireArg(parsed.args, 0, "server"));
				break;
			case "resources":
				result = await manager.listResources(requireArg(parsed.args, 0, "server"), undefined);
				break;
			case "read-resource":
				result = await manager.readResource(
					requireArg(parsed.args, 0, "server"),
					requireArg(parsed.args, 1, "resource URI"),
					cliMcpContext(),
				);
				break;
			case "prompts":
				result = await manager.listPrompts(requireArg(parsed.args, 0, "server"), undefined);
				break;
			case "get-prompt": {
				const input: McpGatewayInput = {
					action: "get_prompt",
					arguments: parseOptionalJsonArgs(parsed.args[2]),
				};
				result = await manager.getPrompt(
					requireArg(parsed.args, 0, "server"),
					requireArg(parsed.args, 1, "prompt"),
					input,
					cliMcpContext(),
				);
				break;
			}
			default:
				throw new Error(`Unknown mcp command: ${parsed.command}`);
		}
		outputResult(result, parsed.json);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
	} finally {
		await manager?.dispose();
	}
	return true;
}
