import { Buffer } from "node:buffer";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { resolvePath } from "../../utils/paths.ts";
import { ensurePrivateDirectorySync, hardenPrivateRegularFileSync } from "../../utils/private-files.ts";
import type { McpResolvedServerConfig, McpSourceScope } from "./types.ts";

const MAX_MCP_CONFIG_BYTES = 4 * 1024 * 1024;

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
	hardenPrivateRegularFileSync(path);
	if (lstatSync(path).size > MAX_MCP_CONFIG_BYTES) {
		throw new Error(`MCP config exceeds ${MAX_MCP_CONFIG_BYTES} bytes: ${path}`);
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
	const serialized = `${JSON.stringify(value, null, 2)}\n`;
	if (Buffer.byteLength(serialized, "utf8") > MAX_MCP_CONFIG_BYTES) {
		throw new Error(`Refusing to write MCP config larger than ${MAX_MCP_CONFIG_BYTES} bytes`);
	}
	ensurePrivateDirectorySync(dirname(path));
	writeDurableAtomicFileSync(path, serialized);
}

function withConfigLock<T>(path: string, operation: () => T): T {
	const directoryPath = dirname(path);
	ensurePrivateDirectorySync(directoryPath);
	let release: (() => void) | undefined;
	let lastError: unknown;
	for (let attempt = 1; attempt <= 10; attempt++) {
		try {
			release = lockfile.lockSync(directoryPath, { realpath: false, lockfilePath: `${path}.lock` });
			break;
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === 10) throw error;
			lastError = error;
			const startedAt = Date.now();
			while (Date.now() - startedAt < 20) {
				// Preserve the synchronous writer contract while waiting briefly.
			}
		}
	}
	if (!release) throw lastError instanceof Error ? lastError : new Error("Failed to lock MCP config");
	try {
		return operation();
	} finally {
		release();
	}
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
		withConfigLock(path, () => {
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
		});
		return { path, scope: server.source.scope };
	}
}
