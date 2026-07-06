import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_MCP_SERVER_PERMISSIONS } from "./config.ts";
import type { McpGatewayExecutionContext, McpResolvedServerConfig, McpRisk } from "./types.ts";

const TOKEN_START = "(?:^|[^a-z0-9])";
const TOKEN_END = "(?:$|[^a-z0-9])";
const DESTRUCTIVE_NAME_PATTERN = new RegExp(
	`${TOKEN_START}(delete|remove|rm|destroy|drop|truncate|erase|reset|revoke|terminate|kill|purge)${TOKEN_END}`,
	"i",
);
const WRITE_NAME_PATTERN = new RegExp(
	`${TOKEN_START}(create|update|write|edit|patch|post|put|send|submit|comment|merge|commit|push|publish|upload|insert|set|add|assign)${TOKEN_END}`,
	"i",
);
const READ_NAME_PATTERN = new RegExp(
	`${TOKEN_START}(read|get|list|search|find|query|fetch|lookup|inspect|describe|show|view|download)${TOKEN_END}`,
	"i",
);
const SECRET_KEY_PATTERN = /token|secret|password|passwd|api[-_]?key|authorization|credential|private/i;
const SECRET_VALUE_PATTERN =
	/(bearer\s+)[A-Za-z0-9._~+/=-]+|((?:token|secret|password|passwd|api[-_]?key|authorization|credential|private)[\s:=]+)[^\s,;]+/gi;

export function classifyMcpToolRisk(
	server: McpResolvedServerConfig,
	tool: Pick<SdkTool, "name" | "description" | "annotations">,
): McpRisk {
	const override = server.permissions.unknown;
	if (tool.annotations?.destructiveHint === true) {
		return "destructive";
	}
	const haystack = `${tool.name} ${tool.description ?? ""}`;
	if (DESTRUCTIVE_NAME_PATTERN.test(haystack)) {
		return "destructive";
	}
	if (WRITE_NAME_PATTERN.test(haystack)) {
		return "write";
	}
	if (READ_NAME_PATTERN.test(haystack)) {
		return "read";
	}
	if (tool.annotations?.readOnlyHint === true) {
		return "read";
	}
	return override === "allow" ? "read" : "unknown";
}

export function redactMcpText(value: string): string {
	return value.replace(
		SECRET_VALUE_PATTERN,
		(_match, bearerPrefix: string | undefined, keyPrefix: string | undefined) => {
			if (bearerPrefix) {
				return `${bearerPrefix}[redacted]`;
			}
			if (keyPrefix) {
				return `${keyPrefix}[redacted]`;
			}
			return "[redacted]";
		},
	);
}

export function sanitizeMcpArguments(value: unknown, depth = 0): unknown {
	if (depth > 4) {
		return "[redacted: nested]";
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return redactMcpText(value);
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((entry) => sanitizeMcpArguments(entry, depth + 1));
	}
	if (typeof value !== "object") {
		return String(value);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			result[key] = "[redacted]";
		} else {
			result[key] = sanitizeMcpArguments(entry, depth + 1);
		}
	}
	return result;
}

export async function assertMcpToolAllowed(options: {
	server: McpResolvedServerConfig;
	tool: Pick<SdkTool, "name" | "description" | "annotations">;
	risk: McpRisk;
	arguments: Record<string, unknown>;
	context: McpGatewayExecutionContext;
	signal?: AbortSignal;
}): Promise<void> {
	const policy = options.server.permissions[options.risk] ?? DEFAULT_MCP_SERVER_PERMISSIONS[options.risk];
	if (policy === "allow") {
		return;
	}
	if (policy === "deny") {
		throw new Error(`MCP tool denied by policy: ${options.server.id}.${options.tool.name} (${options.risk})`);
	}
	if (!options.context.hasUI || options.context.mode === "print" || options.context.mode === "json") {
		throw new Error(
			`MCP tool requires approval but this mode cannot prompt: ${options.server.id}.${options.tool.name} (${options.risk})`,
		);
	}
	const approved = await options.context.confirm(
		`Approve MCP ${options.risk} tool?`,
		[
			`Server: ${options.server.displayName} (${options.server.id})`,
			`Tool: ${options.tool.name}`,
			`Risk: ${options.risk}`,
			`Arguments: ${JSON.stringify(sanitizeMcpArguments(options.arguments))}`,
		].join("\n"),
		{ signal: options.signal, timeout: 5 * 60 * 1000 },
	);
	if (!approved) {
		throw new Error(`MCP tool approval denied: ${options.server.id}.${options.tool.name}`);
	}
}
