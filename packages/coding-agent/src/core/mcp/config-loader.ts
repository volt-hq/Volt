import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	getMcpProjectConfigPaths,
	type McpRawConfigFile,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "./config.ts";
import type { McpConfigDiagnostic, McpConfigSource, McpResolvedConfig } from "./types.ts";

export interface LoadMcpConfigOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpConfigFile(path: string): { config?: McpRawConfigFile; diagnostic?: McpConfigDiagnostic } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (error) {
		return {
			diagnostic: {
				severity: "error",
				message: `Failed to read MCP config: ${error instanceof Error ? error.message : String(error)}`,
				path,
			},
		};
	}
	if (!isRecord(parsed)) {
		return {
			diagnostic: {
				severity: "error",
				message: "Invalid MCP config: expected a JSON object",
				path,
			},
		};
	}
	const config: McpRawConfigFile = {};
	if (typeof parsed.version === "number") {
		config.version = parsed.version;
	}
	if (isRecord(parsed.settings)) {
		config.settings = parsed.settings;
	}
	if (isRecord(parsed.servers)) {
		config.servers = parsed.servers;
	}
	return { config };
}

function mcpConfigSources(cwd: string, agentDir: string): McpConfigSource[] {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	return [
		sourceForMcpConfigPath(join(homedir(), ".config", "mcp", "mcp.json"), {
			scope: "user",
			label: "user shared",
			precedence: 1,
			shared: true,
		}),
		sourceForMcpConfigPath(join(resolvedAgentDir, "mcp.json"), {
			scope: "user",
			label: "user Volt",
			precedence: 2,
			shared: false,
		}),
		sourceForMcpConfigPath(join(resolvedCwd, ".mcp.json"), {
			scope: "project",
			label: "project shared",
			precedence: 3,
			shared: true,
		}),
		sourceForMcpConfigPath(join(resolvedCwd, CONFIG_DIR_NAME, "mcp.json"), {
			scope: "project",
			label: "project Volt",
			precedence: 4,
			shared: false,
		}),
	];
}

export function loadMcpConfig(options: LoadMcpConfigOptions): McpResolvedConfig {
	const sources = mcpConfigSources(options.cwd, options.agentDir);
	const merged = createEmptyMcpMergedConfig();
	for (const source of sources) {
		if (!existsSync(source.path)) {
			continue;
		}
		if (source.scope === "project" && !options.projectTrusted) {
			merged.diagnostics.push({
				severity: "warning",
				message: `Ignored project MCP config because project trust is not granted: ${source.path}`,
				path: source.path,
			});
			continue;
		}
		const parsed = parseMcpConfigFile(source.path);
		if (parsed.diagnostic) {
			merged.diagnostics.push(parsed.diagnostic);
			continue;
		}
		if (parsed.config) {
			mergeMcpConfigFile(merged, parsed.config, source);
		}
	}
	return finalizeMcpConfig(merged);
}

export function hasProjectMcpConfig(cwd: string): boolean {
	return getMcpProjectConfigPaths(cwd).some((path) => existsSync(path));
}
