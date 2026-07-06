import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { McpResolvedServerConfig, McpSourceScope } from "./types.ts";

export interface McpConfigWriterOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

export interface McpConfigWriteResult {
	path: string;
	scope: McpSourceScope;
}

type MutableJsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is MutableJsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): MutableJsonRecord {
	if (!existsSync(path)) {
		return {};
	}
	const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!isRecord(parsed)) {
		throw new Error(`MCP config is not a JSON object: ${path}`);
	}
	return parsed;
}

function ensureObjectField(parent: MutableJsonRecord, field: string): MutableJsonRecord {
	const current = parent[field];
	if (isRecord(current)) {
		return current;
	}
	const next: MutableJsonRecord = {};
	parent[field] = next;
	return next;
}

function writeJsonObject(path: string, value: MutableJsonRecord): void {
	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export class McpConfigWriter {
	private cwd: string;
	private agentDir: string;
	private projectTrusted: boolean;

	constructor(options: McpConfigWriterOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.projectTrusted = options.projectTrusted;
	}

	setServerEnabled(server: McpResolvedServerConfig, enabled: boolean): McpConfigWriteResult {
		return this.updateServerOverlay(server, (overlay) => {
			overlay.enabled = enabled;
		});
	}

	setServerDirectTools(server: McpResolvedServerConfig, directTools: boolean | string[]): McpConfigWriteResult {
		return this.updateServerOverlay(server, (overlay) => {
			overlay.directTools = Array.isArray(directTools) ? [...directTools] : directTools;
		});
	}

	private getVoltOwnedPath(scope: McpSourceScope): string {
		if (scope === "project") {
			if (!this.projectTrusted) {
				throw new Error("Cannot persist project MCP config because project trust is not granted");
			}
			return join(this.cwd, CONFIG_DIR_NAME, "mcp.json");
		}
		if (scope === "temporary") {
			throw new Error("Cannot persist temporary MCP server config");
		}
		return join(this.agentDir, "mcp.json");
	}

	private updateServerOverlay(
		server: McpResolvedServerConfig,
		update: (overlay: MutableJsonRecord) => void,
	): McpConfigWriteResult {
		const path = this.getVoltOwnedPath(server.source.scope);
		const config = readJsonObject(path);
		if (typeof config.version !== "number") {
			config.version = 1;
		}
		const servers = ensureObjectField(config, "servers");
		const current = servers[server.id];
		const overlay = isRecord(current) ? current : {};
		servers[server.id] = overlay;
		update(overlay);
		writeJsonObject(path, config);
		return { path, scope: server.source.scope };
	}
}
