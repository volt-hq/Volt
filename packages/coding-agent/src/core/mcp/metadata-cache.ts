import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Prompt, Resource, Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { hashMcpMetadata } from "./config.ts";
import type { McpServerMetadata } from "./types.ts";

interface MetadataCacheFile {
	version: 1;
	servers: Record<string, McpServerMetadata>;
}

export interface McpMetadataCacheOptions {
	agentDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: unknown): McpServerMetadata | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (
		typeof value.server !== "string" ||
		typeof value.metadataHash !== "string" ||
		typeof value.lastSeenAt !== "string"
	) {
		return undefined;
	}
	if (!Array.isArray(value.tools) || !Array.isArray(value.resources) || !Array.isArray(value.prompts)) {
		return undefined;
	}
	return {
		server: value.server,
		metadataHash: value.metadataHash,
		lastSeenAt: value.lastSeenAt,
		...(typeof value.serverVersion === "string" ? { serverVersion: value.serverVersion } : {}),
		...(typeof value.configHash === "string" ? { configHash: value.configHash } : {}),
		tools: value.tools as SdkTool[],
		resources: value.resources as Resource[],
		prompts: value.prompts as Prompt[],
	};
}

function parseCacheFile(value: unknown): MetadataCacheFile {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) {
		return { version: 1, servers: {} };
	}
	const servers: Record<string, McpServerMetadata> = {};
	for (const [server, entry] of Object.entries(value.servers)) {
		const parsed = parseMetadata(entry);
		if (parsed) {
			servers[server] = parsed;
		}
	}
	return { version: 1, servers };
}

export class McpMetadataCache {
	private path: string;
	private servers: Map<string, McpServerMetadata>;

	constructor(options: McpMetadataCacheOptions) {
		this.path = join(options.agentDir, "mcp", "metadata-cache.json");
		this.servers = new Map();
		this.load();
	}

	get(server: string): McpServerMetadata | undefined {
		const metadata = this.servers.get(server);
		return metadata ? structuredClone(metadata) : undefined;
	}

	getAll(): McpServerMetadata[] {
		return Array.from(this.servers.values(), (metadata) => structuredClone(metadata));
	}

	set(server: string, metadata: Omit<McpServerMetadata, "metadataHash" | "lastSeenAt">): McpServerMetadata {
		const next: McpServerMetadata = {
			...metadata,
			server,
			metadataHash: hashMcpMetadata({
				tools: metadata.tools,
				resources: metadata.resources,
				prompts: metadata.prompts,
				serverVersion: metadata.serverVersion,
				configHash: metadata.configHash,
			}),
			lastSeenAt: new Date().toISOString(),
		};
		this.servers.set(server, next);
		this.save();
		return structuredClone(next);
	}

	delete(server: string): void {
		this.servers.delete(server);
		this.save();
	}

	private load(): void {
		if (!existsSync(this.path)) {
			return;
		}
		try {
			const parsed = parseCacheFile(JSON.parse(readFileSync(this.path, "utf-8")) as unknown);
			this.servers = new Map(Object.entries(parsed.servers));
		} catch {
			this.servers = new Map();
		}
	}

	private save(): void {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		const servers: Record<string, McpServerMetadata> = {};
		for (const [server, metadata] of this.servers.entries()) {
			servers[server] = metadata;
		}
		writeFileSync(this.path, `${JSON.stringify({ version: 1, servers }, null, 2)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
	}
}
