import { serverMatchesToolFilters, serverTrustsToolRead } from "./config.ts";
import type { McpDiscoveryMetadata, McpDiscoveryTool } from "./metadata-cache.ts";
import { classifyMcpToolRisk, isMcpToolTrustedReadCandidate } from "./safety.ts";
import type { McpResolvedServerConfig, McpSearchMatch } from "./types.ts";

const DEFAULT_MCP_SEARCH_LIMIT = 8;
const MAX_MCP_SEARCH_LIMIT = 20;
const MAX_INDEXED_CATALOGS = 64;
const QUERY_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"could",
	"for",
	"from",
	"how",
	"i",
	"in",
	"is",
	"it",
	"me",
	"my",
	"of",
	"on",
	"or",
	"please",
	"that",
	"the",
	"this",
	"to",
	"with",
	"would",
	"you",
	"your",
]);

function tokenize(value: string): string[] {
	return (
		value
			.normalize("NFKC")
			.replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
			.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
			.toLowerCase()
			.match(/[\p{L}\p{N}\p{M}]+/gu) ?? []
	);
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) {
		return DEFAULT_MCP_SEARCH_LIMIT;
	}
	return Math.max(1, Math.min(MAX_MCP_SEARCH_LIMIT, Math.floor(limit)));
}

function boundedSummary(value: string | undefined): string {
	const normalized = (value ?? "").replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "No description.";
	}
	return normalized.length <= 180 ? normalized : `${normalized.slice(0, 177)}...`;
}

interface PreparedTool {
	tool: McpDiscoveryTool;
	normalizedName: string;
	nameTokens: string[];
	namePhrase: string;
	titleTokens: Set<string>;
	descriptionTokens: Set<string>;
}

function prepareTool(tool: McpDiscoveryTool): PreparedTool {
	const nameTokens = tokenize(tool.name);
	return {
		tool: {
			name: tool.name,
			title: tool.title,
			description: tool.description,
			...(tool.annotations
				? {
						annotations: {
							readOnlyHint: tool.annotations.readOnlyHint,
							destructiveHint: tool.annotations.destructiveHint,
						},
					}
				: {}),
		},
		normalizedName: tool.name.normalize("NFKC").toLowerCase(),
		nameTokens,
		namePhrase: nameTokens.join(" "),
		titleTokens: new Set(tokenize(tool.title ?? tool.name)),
		descriptionTokens: new Set(tokenize(tool.description ?? "")),
	};
}

function scoreTool(queryTokens: string[], query: string, queryPhrase: string, prepared: PreparedTool): number {
	let relevance = 0;
	let matched = 0;
	for (const token of queryTokens) {
		let score = 0;
		if (prepared.nameTokens.includes(token)) score += 24;
		else if (token.length >= 3 && prepared.nameTokens.some((part) => part.startsWith(token))) score += 4;
		if (prepared.titleTokens.has(token)) score += 12;
		if (prepared.descriptionTokens.has(token)) score += 6;
		if (score > 0) matched++;
		relevance += score;
	}
	if (matched === 0) return 0;
	// Coverage dominates field weights: broad partial matches must not bury a tool matching the whole request.
	return (
		(1_000 * matched + relevance) / queryTokens.length +
		(prepared.normalizedName === query ? 10_000 : 0) +
		(prepared.namePhrase === queryPhrase ? 500 : 0)
	);
}

export interface McpSearchOptions {
	query: string;
	limit?: number;
	server?: string;
	servers: Record<string, McpResolvedServerConfig>;
	metadata: readonly McpDiscoveryMetadata[];
}

function searchPreparedMetadata(
	options: McpSearchOptions,
	prepare: (metadata: McpDiscoveryMetadata) => readonly PreparedTool[],
): McpSearchMatch[] {
	const tokens = [...new Set(tokenize(options.query))];
	const meaningfulTokens = tokens.filter((token) => !QUERY_STOP_WORDS.has(token));
	const queryTokens = meaningfulTokens.length > 0 ? meaningfulTokens : tokens;
	if (queryTokens.length === 0) {
		return [];
	}
	const query = options.query.normalize("NFKC").trim().toLowerCase();
	const queryPhrase = queryTokens.join(" ");
	const serverScope = options.server?.trim().toLowerCase();
	const matches: Array<{
		server: McpResolvedServerConfig;
		metadataHash: string;
		tool: McpDiscoveryTool;
		score: number;
	}> = [];
	for (const metadata of options.metadata) {
		if (serverScope !== undefined && metadata.server.toLowerCase() !== serverScope) continue;
		const server = options.servers[metadata.server];
		if (!server || !server.enabled) {
			continue;
		}
		for (const prepared of prepare(metadata)) {
			const tool = prepared.tool;
			if (!serverMatchesToolFilters(server, tool.name)) {
				continue;
			}
			const score = scoreTool(queryTokens, query, queryPhrase, prepared);
			if (score <= 0) {
				continue;
			}
			matches.push({ server, metadataHash: metadata.metadataHash, tool, score });
		}
	}
	return matches
		.sort(
			(a, b) =>
				b.score - a.score || a.server.id.localeCompare(b.server.id) || a.tool.name.localeCompare(b.tool.name),
		)
		.slice(0, normalizeLimit(options.limit))
		.map(({ server, metadataHash, tool, score }) => ({
			server: server.id,
			tool: tool.name,
			title: tool.title ?? tool.name,
			summary: boundedSummary(tool.description),
			risk: classifyMcpToolRisk(tool),
			trustedRead: serverTrustsToolRead(server, tool.name) && isMcpToolTrustedReadCandidate(tool),
			metadataHash,
			call: `mcp({"action":"call","server":${JSON.stringify(server.id)},"tool":${JSON.stringify(tool.name)},"arguments":{...}})`,
			describe: `mcp(${JSON.stringify({ action: "describe", server: server.id, tool: tool.name })})`,
			score,
		}));
}

export function searchMcpMetadata(options: McpSearchOptions): McpSearchMatch[] {
	return searchPreparedMetadata(options, (metadata) => metadata.tools.map(prepareTool));
}

/** Session-owned text features; callers supply only currently fresh catalog snapshots. */
export class McpSearchIndex {
	private catalogs = new Map<string, { metadataHash: string; tools: PreparedTool[] }>();

	search(options: McpSearchOptions): McpSearchMatch[] {
		const current = new Map(options.metadata.map((metadata) => [metadata.server, metadata.metadataHash]));
		const scope = options.server?.trim().toLowerCase();
		for (const [server, catalog] of this.catalogs) {
			const absentFromScope = !current.has(server) && (scope === undefined || server.toLowerCase() === scope);
			if (
				absentFromScope ||
				(current.has(server) && current.get(server) !== catalog.metadataHash) ||
				!options.servers[server]?.enabled
			) {
				this.catalogs.delete(server);
			}
		}
		return searchPreparedMetadata(options, (metadata) => {
			let catalog = this.catalogs.get(metadata.server);
			if (!catalog || catalog.metadataHash !== metadata.metadataHash) {
				catalog = { metadataHash: metadata.metadataHash, tools: metadata.tools.map(prepareTool) };
			}
			this.catalogs.delete(metadata.server);
			this.catalogs.set(metadata.server, catalog);
			while (this.catalogs.size > MAX_INDEXED_CATALOGS) {
				const oldest = this.catalogs.keys().next().value;
				if (oldest === undefined) break;
				this.catalogs.delete(oldest);
			}
			return catalog.tools;
		});
	}
}
