import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Prompt, Resource, Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { ensurePrivateDirectorySync, hardenPrivateRegularFileSync } from "../../utils/private-files.ts";
import { hashMcpMetadata } from "./config.ts";
import type { McpMetadataCategory, McpServerMetadata } from "./types.ts";

const DEFAULT_METADATA_CACHE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const DEFAULT_METADATA_CACHE_MAX_SERVERS = 64;
const DEFAULT_METADATA_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const RESET_METADATA_FRESHNESS = new Date(0).toISOString();
/** A persisted entry's file name: the SHA-256 hex digest of its server id. */
const METADATA_FILE_PATTERN = /^[0-9a-f]{64}\.json$/;

/** The content of one server's persisted metadata file. */
interface MetadataCacheFile {
	version: 3;
	metadata: McpServerMetadata;
}

export interface McpMetadataCacheOptions {
	agentDir: string;
	/** Largest persisted entry, in bytes of its file. A larger entry stays usable in memory but is not persisted. */
	maxEntryBytes?: number;
	/** Most persisted entries; the least recently refreshed beyond it are removed from disk, never from memory. */
	maxServers?: number;
	/** Persisted entries not refreshed for longer are removed from disk and not loaded. */
	maxAgeMs?: number;
	now?: () => number;
}

export type McpDiscoveryTool = Pick<SdkTool, "name" | "title" | "description"> & {
	annotations?: Pick<NonNullable<SdkTool["annotations"]>, "readOnlyHint" | "destructiveHint">;
};

/** Searchable metadata without schemas, resource bodies, or arbitrary server extensions. */
export interface McpDiscoveryMetadata
	extends Pick<
		McpServerMetadata,
		| "server"
		| "metadataHash"
		| "serverVersion"
		| "configHash"
		| "toolsLastSeenAt"
		| "resourcesLastSeenAt"
		| "promptsLastSeenAt"
	> {
	tools: McpDiscoveryTool[];
}

export function toMcpDiscoveryMetadata(metadata: McpServerMetadata): McpDiscoveryMetadata {
	return {
		server: metadata.server,
		metadataHash: metadata.metadataHash,
		serverVersion: metadata.serverVersion,
		configHash: metadata.configHash,
		toolsLastSeenAt: metadata.toolsLastSeenAt,
		resourcesLastSeenAt: metadata.resourcesLastSeenAt,
		promptsLastSeenAt: metadata.promptsLastSeenAt,
		tools: metadata.tools.map((tool) => ({
			name: tool.name,
			...(tool.title !== undefined ? { title: tool.title } : {}),
			...(tool.description !== undefined ? { description: tool.description } : {}),
			...(tool.annotations
				? {
						annotations: {
							...(tool.annotations.readOnlyHint !== undefined
								? { readOnlyHint: tool.annotations.readOnlyHint }
								: {}),
							...(tool.annotations.destructiveHint !== undefined
								? { destructiveHint: tool.annotations.destructiveHint }
								: {}),
						},
					}
				: {}),
		})),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMetadata(value: unknown): McpServerMetadata | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (typeof value.server !== "string" || typeof value.metadataHash !== "string") {
		return undefined;
	}
	if (!Array.isArray(value.tools) || !Array.isArray(value.resources) || !Array.isArray(value.prompts)) {
		return undefined;
	}
	if (
		typeof value.toolsLastSeenAt !== "string" ||
		typeof value.resourcesLastSeenAt !== "string" ||
		typeof value.promptsLastSeenAt !== "string"
	) {
		return undefined;
	}
	return {
		server: value.server,
		metadataHash: value.metadataHash,
		...(typeof value.serverVersion === "string" ? { serverVersion: value.serverVersion } : {}),
		...(typeof value.configHash === "string" ? { configHash: value.configHash } : {}),
		tools: value.tools as SdkTool[],
		resources: value.resources as Resource[],
		prompts: value.prompts as Prompt[],
		toolsLastSeenAt: value.toolsLastSeenAt,
		resourcesLastSeenAt: value.resourcesLastSeenAt,
		promptsLastSeenAt: value.promptsLastSeenAt,
	};
}

function parseCacheFile(value: unknown): McpServerMetadata | undefined {
	if (!isRecord(value) || value.version !== 3) {
		return undefined;
	}
	return parseMetadata(value.metadata);
}

/**
 * Tool, resource, and prompt metadata per MCP server.
 *
 * Memory is authoritative for the running session: an entry stays usable once stored or loaded, whatever its
 * size, until it is deleted. Each server persists to its own owner-only file under `<agentDir>/mcp/metadata/`,
 * read the first time the server is asked for, so one server's size or a damaged file never affects another
 * server. Persistence is best effort: an entry larger than `maxEntryBytes` is not persisted, and a failed write
 * leaves the entry usable in memory. A file's modification time is its last refresh on this cache's clock;
 * files older than `maxAgeMs`, and the least recently refreshed beyond `maxServers`, are removed from disk.
 */
export class McpMetadataCache {
	private dir: string;
	/** Stored or loaded entries. `undefined` marks a server with no usable persisted entry or a deleted one. */
	private servers = new Map<string, McpServerMetadata | undefined>();
	private discovery = new Map<string, McpDiscoveryMetadata>();
	private maxEntryBytes: number;
	private maxServers: number;
	private maxAgeMs: number;
	private now: () => number;

	constructor(options: McpMetadataCacheOptions) {
		this.dir = join(options.agentDir, "mcp", "metadata");
		this.maxEntryBytes = Math.max(1, options.maxEntryBytes ?? DEFAULT_METADATA_CACHE_MAX_ENTRY_BYTES);
		this.maxServers = Math.max(1, options.maxServers ?? DEFAULT_METADATA_CACHE_MAX_SERVERS);
		this.maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_METADATA_CACHE_MAX_AGE_MS);
		this.now = options.now ?? Date.now;
	}

	get(server: string): McpServerMetadata | undefined {
		const metadata = this.entry(server);
		return metadata ? structuredClone(metadata) : undefined;
	}

	/** The entries this cache has stored or loaded; persisted entries of servers never asked for are not read. */
	getAll(): McpServerMetadata[] {
		return Array.from(this.servers.values()).flatMap((metadata) => (metadata ? [structuredClone(metadata)] : []));
	}

	getTool(server: string, toolName: string): SdkTool | undefined {
		const tool = this.entry(server)?.tools.find((candidate) => candidate.name === toolName);
		return tool ? structuredClone(tool) : undefined;
	}

	/**
	 * Whether any requested category is older than `refreshMs` on this cache's clock, the same clock that
	 * stamps refreshes. Missing metadata and reset or unparseable timestamps are stale.
	 */
	isStale(
		metadata: Pick<McpServerMetadata, "toolsLastSeenAt" | "resourcesLastSeenAt" | "promptsLastSeenAt"> | undefined,
		refreshMs: number,
		categories: readonly McpMetadataCategory[],
	): boolean {
		if (!metadata) {
			return true;
		}
		const now = this.now();
		return categories.some((category) => {
			const value =
				category === "tools"
					? metadata.toolsLastSeenAt
					: category === "resources"
						? metadata.resourcesLastSeenAt
						: metadata.promptsLastSeenAt;
			const seenAt = Date.parse(value);
			return !Number.isFinite(seenAt) || now - seenAt > refreshMs;
		});
	}

	getDiscovery(server: string): McpDiscoveryMetadata | undefined {
		const metadata = this.entry(server);
		if (!metadata) return undefined;
		let discovery = this.discovery.get(server);
		if (!discovery) {
			discovery = toMcpDiscoveryMetadata(metadata);
			this.discovery.set(server, discovery);
		}
		return structuredClone(discovery);
	}

	set(
		server: string,
		metadata: Omit<
			McpServerMetadata,
			"metadataHash" | "toolsLastSeenAt" | "resourcesLastSeenAt" | "promptsLastSeenAt"
		>,
		refreshedCategories: readonly McpMetadataCategory[],
	): McpServerMetadata {
		if (refreshedCategories.length === 0) {
			throw new Error("MCP metadata writes require at least one refreshed category");
		}
		const refreshed = new Set(refreshedCategories);
		const current = this.entry(server);
		const identityMatches =
			current !== undefined &&
			current.serverVersion === metadata.serverVersion &&
			current.configHash === metadata.configHash;
		const refreshedAtMs = this.now();
		const refreshedAt = new Date(refreshedAtMs).toISOString();
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
			toolsLastSeenAt: refreshed.has("tools")
				? refreshedAt
				: identityMatches
					? current.toolsLastSeenAt
					: RESET_METADATA_FRESHNESS,
			resourcesLastSeenAt: refreshed.has("resources")
				? refreshedAt
				: identityMatches
					? current.resourcesLastSeenAt
					: RESET_METADATA_FRESHNESS,
			promptsLastSeenAt: refreshed.has("prompts")
				? refreshedAt
				: identityMatches
					? current.promptsLastSeenAt
					: RESET_METADATA_FRESHNESS,
		};
		this.servers.set(server, next);
		this.discovery.delete(server);
		this.persist(server, next, refreshedAtMs);
		return structuredClone(next);
	}

	delete(server: string): void {
		this.servers.set(server, undefined);
		this.discovery.delete(server);
		try {
			rmSync(this.pathFor(server), { force: true });
		} catch {
			// Persistence is best effort; the entry is already gone from memory.
		}
	}

	private pathFor(server: string): string {
		return join(this.dir, `${createHash("sha256").update(server).digest("hex")}.json`);
	}

	/** The server's entry, read from its persisted file the first time the server is asked for. */
	private entry(server: string): McpServerMetadata | undefined {
		if (this.servers.has(server)) {
			return this.servers.get(server);
		}
		const metadata = this.read(server);
		this.servers.set(server, metadata);
		return metadata;
	}

	private read(server: string): McpServerMetadata | undefined {
		const path = this.pathFor(server);
		try {
			const stat = hardenPrivateRegularFileSync(path);
			if (stat.size > this.maxEntryBytes || stat.mtimeMs < this.now() - this.maxAgeMs) {
				rmSync(path, { force: true });
				return undefined;
			}
			const metadata = parseCacheFile(JSON.parse(readFileSync(path, "utf-8")) as unknown);
			return metadata?.server === server ? metadata : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Writes the server's file, or removes it when the entry is too large to persist so an older entry cannot
	 * outlive it, then prunes the other files. Failures leave the entry usable in memory.
	 */
	private persist(server: string, metadata: McpServerMetadata, refreshedAtMs: number): void {
		const path = this.pathFor(server);
		try {
			const serialized = JSON.stringify({ version: 3, metadata } satisfies MetadataCacheFile);
			if (Buffer.byteLength(serialized, "utf8") > this.maxEntryBytes) {
				rmSync(path, { force: true });
				return;
			}
			ensurePrivateDirectorySync(dirname(this.dir));
			ensurePrivateDirectorySync(this.dir);
			writeDurableAtomicFileSync(path, serialized);
			const refreshedAt = new Date(refreshedAtMs);
			utimesSync(path, refreshedAt, refreshedAt);
			this.prune(path);
		} catch {
			// Persistence is best effort; the entry stays usable in memory.
		}
	}

	/** Removes files older than `maxAgeMs`, then the least recently refreshed beyond `maxServers`, never `keep`. */
	private prune(keep: string): void {
		const cutoff = this.now() - this.maxAgeMs;
		const files: { path: string; mtimeMs: number }[] = [];
		for (const name of readdirSync(this.dir)) {
			if (!METADATA_FILE_PATTERN.test(name)) continue;
			const path = join(this.dir, name);
			try {
				const { mtimeMs } = lstatSync(path);
				if (path !== keep && mtimeMs < cutoff) {
					rmSync(path, { force: true });
				} else {
					files.push({ path, mtimeMs });
				}
			} catch {
				// Another process removed the file.
			}
		}
		const evictable = files.filter((file) => file.path !== keep).sort((left, right) => left.mtimeMs - right.mtimeMs);
		const excess = files.length - this.maxServers;
		for (const file of evictable.slice(0, Math.max(0, excess))) {
			rmSync(file.path, { force: true });
		}
	}
}
