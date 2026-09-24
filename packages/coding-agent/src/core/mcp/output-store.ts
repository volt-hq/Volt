import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	writePrivateNewFileSync,
} from "../../utils/private-files.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../tools/truncate.ts";
import type { McpCacheReference, McpGatewayInput, McpOutputTruncation } from "./types.ts";

const DEFAULT_MAX_CACHE_ENTRY_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const DEFAULT_MAX_CACHE_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_FILE_PATTERN = /^mcpout_[a-f0-9]{32}\.json$/;

export interface McpOutputStoreOptions {
	agentDir: string;
	maxOutputBytes?: number;
	maxOutputLines?: number;
	maxCacheEntryBytes?: number;
	maxCacheEntries?: number;
	maxCacheTotalBytes?: number;
	maxCacheAgeMs?: number;
	now?: () => number;
	sessionId?: string;
	workspaceId?: string;
}

export interface McpStoredOutput {
	id: string;
	createdAt: string;
	sessionId?: string;
	workspaceId?: string;
	text: string;
	bytes: number;
	lines: number;
	structuredContent?: Record<string, unknown>;
}

export interface McpStoredOutputChunk {
	cacheId: string;
	content: string;
	startByte: number;
	nextCursor?: string;
	totalBytes: number;
}

export interface McpStoredOutputResult {
	content: string;
	truncation?: McpOutputTruncation;
	cache?: McpCacheReference;
	cacheUnavailable?: boolean;
}

export interface McpStoredStructuredOutput {
	cacheId: string;
	pointer: string;
	value?: unknown;
	startOffset?: number;
	nextOffset?: number;
	totalItems?: number;
	selectionRequired?: boolean;
	message?: string;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf-8");
}

function lineCount(value: string): number {
	if (value.length === 0) {
		return 0;
	}
	const lines = value.split("\n");
	if (value.endsWith("\n")) {
		lines.pop();
	}
	return lines.length;
}

function createCacheId(): string {
	return `mcpout_${randomUUID().replace(/-/g, "")}`;
}

function safeCacheId(cacheId: string): string {
	if (!/^mcpout_[a-f0-9]{32}$/.test(cacheId)) {
		throw new Error("Invalid MCP cache id");
	}
	return cacheId;
}

function sliceByUtf8Bytes(text: string, startByte: number, maxBytes: number): { content: string; nextCursor?: string } {
	const buffer = Buffer.from(text, "utf-8");
	const start = Math.max(0, Math.min(startByte, buffer.length));
	if ((buffer[start] & 0xc0) === 0x80) {
		throw new Error("MCP cache cursor must be on a UTF-8 character boundary");
	}
	let end = Math.max(start, Math.min(buffer.length, start + maxBytes));
	while (end > start && (buffer[end] & 0xc0) === 0x80) {
		end--;
	}
	if (end === start && start < buffer.length) {
		throw new Error("MCP cache limit is too small for the next UTF-8 character; increase limit");
	}
	const content = buffer.slice(start, end).toString("utf-8");
	return end < buffer.length ? { content, nextCursor: String(end) } : { content };
}

export class McpOutputStore {
	private dir: string;
	private maxOutputBytes: number;
	private maxOutputLines: number;
	private maxCacheEntryBytes: number;
	private maxCacheEntries: number;
	private maxCacheTotalBytes: number;
	private maxCacheAgeMs: number;
	private now: () => number;
	private sessionId: string | undefined;
	private workspaceId: string | undefined;

	constructor(options: McpOutputStoreOptions) {
		this.dir = join(options.agentDir, "mcp", "output");
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
		this.maxOutputLines = options.maxOutputLines ?? DEFAULT_MAX_LINES;
		this.maxCacheEntryBytes = Math.max(1, options.maxCacheEntryBytes ?? DEFAULT_MAX_CACHE_ENTRY_BYTES);
		this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
		this.maxCacheTotalBytes = Math.max(1, options.maxCacheTotalBytes ?? DEFAULT_MAX_CACHE_TOTAL_BYTES);
		this.maxCacheAgeMs = Math.max(1, options.maxCacheAgeMs ?? DEFAULT_MAX_CACHE_AGE_MS);
		this.now = options.now ?? Date.now;
		this.sessionId = options.sessionId;
		this.workspaceId = options.workspaceId;
	}

	getMaxOutputBytes(): number {
		return this.maxOutputBytes;
	}

	shapeOutput(text: string, structuredContent?: Record<string, unknown>): McpStoredOutputResult {
		const truncation = truncateHead(text, { maxBytes: this.maxOutputBytes, maxLines: this.maxOutputLines });
		if (!truncation.truncated && structuredContent === undefined) {
			return { content: text };
		}
		let cacheId: string | undefined;
		try {
			cacheId = this.write(text, structuredContent);
		} catch {
			// Cache storage failure must not discard an otherwise successful tool result.
		}
		let content = truncation.content;
		let returnedLines = truncation.outputLines;
		// Whole-line truncation drops an oversized line, such as compact structured JSON, entirely.
		// Keep its UTF-8 prefix instead; a 4-byte budget always fits the first character.
		if (truncation.truncatedBy === "bytes" && this.maxOutputBytes >= 4) {
			content = sliceByUtf8Bytes(text, 0, this.maxOutputBytes).content;
			returnedLines = lineCount(content);
		}
		return {
			content,
			...(truncation.truncated
				? {
						truncation: {
							truncated: true as const,
							returnedBytes: byteLength(content),
							totalBytes: truncation.totalBytes,
							returnedLines,
							totalLines: truncation.totalLines,
						},
					}
				: {}),
			...(cacheId
				? {
						cache: {
							id: cacheId,
							read: `mcp({"action":"read_cache","cacheId":"${cacheId}"})`,
						},
					}
				: { cacheUnavailable: true }),
		};
	}

	/** Bound the final JSON sent to a model, including escaping and retrieval metadata. */
	formatResult(action: McpGatewayInput["action"], result: unknown): { text: string; result: unknown } {
		const record = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
		const previousTruncation =
			typeof record.truncation === "object" && record.truncation !== null
				? (record.truncation as Partial<McpOutputTruncation>)
				: undefined;
		const previousCache =
			typeof record.cache === "object" && record.cache !== null
				? (record.cache as Partial<McpCacheReference>)
				: undefined;
		if (previousTruncation?.truncated && !previousCache) {
			result = { ...record, cacheUnavailable: true };
		}
		// Compact JSON occupies one physical line, including when strings contain newlines.
		const text = JSON.stringify(result) ?? "null";
		if (byteLength(text) <= this.maxOutputBytes) {
			return { text, result };
		}
		if (
			action === "read_cache" &&
			typeof record.content === "string" &&
			typeof record.startByte === "number" &&
			typeof record.totalBytes === "number"
		) {
			const { startByte, totalBytes } = record;
			return this.fitResult(record.content, (content) => ({
				...record,
				content,
				nextCursor:
					startByte + byteLength(content) < totalBytes ? String(startByte + byteLength(content)) : undefined,
			}));
		}

		const hasContent = typeof record.content === "string";
		const content = hasContent ? (record.content as string) : text;
		let cache: McpCacheReference | undefined;
		if (hasContent && typeof previousCache?.id === "string" && typeof previousCache.read === "string") {
			cache = { id: previousCache.id, read: previousCache.read };
		} else if (!previousTruncation?.truncated && record.cacheUnavailable !== true) {
			try {
				const id = this.write(content);
				if (id) cache = { id, read: `mcp({"action":"read_cache","cacheId":"${id}"})` };
			} catch {
				// A full or unavailable cache must never force unbounded model output.
			}
		}
		const totalBytes = previousTruncation?.totalBytes ?? byteLength(content);
		const totalLines = previousTruncation?.totalLines ?? lineCount(content);
		const identity: Record<string, string> = {};
		for (const key of ["risk", "server", "tool", "resourceUri", "prompt"]) {
			const value = record[key];
			// Reserve most of the envelope for the preview and retrieval metadata.
			if (
				typeof value === "string" &&
				byteLength(JSON.stringify({ ...identity, [key]: value })) <= this.maxOutputBytes / 4
			) {
				identity[key] = value;
			}
		}
		return this.fitResult(content, (preview) => ({
			action,
			...identity,
			...(record.status === "failed" || record.status === "completed" ? { status: record.status } : {}),
			...(record.isError === true ? { isError: true } : {}),
			content: preview,
			truncation: {
				truncated: true,
				returnedBytes: byteLength(preview),
				totalBytes,
				returnedLines: lineCount(preview),
				totalLines,
			},
			...(cache ? { cache } : { cacheUnavailable: true }),
		}));
	}

	private fitResult(content: string, wrap: (preview: string) => unknown): { text: string; result: unknown } {
		let low = 0;
		let high = Math.min(content.length, this.maxOutputBytes);
		let fitted = wrap("");
		let text = JSON.stringify(fitted);
		let returnedCharacters = 0;
		if (byteLength(text) > this.maxOutputBytes) {
			throw new Error("MCP output limit is too small for retrieval metadata");
		}
		// Search UTF-16 offsets, retreating from split surrogate pairs before encoding.
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			let end = middle;
			if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end] ?? "")) end--;
			const candidate = wrap(content.slice(0, end));
			const serialized = JSON.stringify(candidate);
			if (byteLength(serialized) <= this.maxOutputBytes) {
				fitted = candidate;
				text = serialized;
				returnedCharacters = end;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		if (content.length > 0 && returnedCharacters === 0) {
			throw new Error("MCP output limit is too small for the next character and retrieval metadata");
		}
		return { text, result: fitted };
	}

	write(text: string, structuredContent?: Record<string, unknown>): string | undefined {
		const id = createCacheId();
		const record: McpStoredOutput = {
			id,
			createdAt: new Date(this.now()).toISOString(),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
			text,
			bytes: byteLength(text),
			lines: lineCount(text),
			...(structuredContent !== undefined ? { structuredContent } : {}),
		};
		const serialized = `${JSON.stringify(record)}\n`;
		const serializedBytes = byteLength(serialized);
		if (serializedBytes > this.maxCacheEntryBytes || serializedBytes > this.maxCacheTotalBytes) {
			return undefined;
		}
		ensurePrivateDirectorySync(this.dir);
		if (!this.prune(serializedBytes, 1)) {
			return undefined;
		}
		const filePath = join(this.dir, `${id}.json`);
		writePrivateNewFileSync(filePath, serialized);
		const timestamp = new Date(this.now());
		utimesSync(filePath, timestamp, timestamp);
		return id;
	}

	read(cacheId: string, options?: { cursor?: string; limit?: number }): McpStoredOutputChunk {
		const record = this.readRecord(cacheId);
		if (options?.cursor !== undefined && !/^\d+$/.test(options.cursor)) {
			throw new Error("Invalid MCP cache cursor");
		}
		const startByte = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
		if (!Number.isSafeInteger(startByte) || startByte < 0 || startByte > record.bytes) {
			throw new Error("Invalid MCP cache cursor");
		}
		if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit <= 0)) {
			throw new Error("MCP cache limit must be a positive safe integer");
		}
		const maxBytes = Math.min(options?.limit ?? this.maxOutputBytes, this.maxOutputBytes);
		const chunk = sliceByUtf8Bytes(record.text, startByte, maxBytes);
		return {
			cacheId,
			content: chunk.content,
			startByte,
			...(chunk.nextCursor ? { nextCursor: chunk.nextCursor } : {}),
			totalBytes: record.bytes,
		};
	}

	readStructured(
		cacheId: string,
		options: { pointer?: string; offset?: number; limit?: number } = {},
	): McpStoredStructuredOutput {
		const record = this.readRecord(cacheId);
		if (record.structuredContent === undefined) {
			throw new Error("MCP cache entry has no structured content; omit pointer to read its text");
		}
		const pointer = options.pointer ?? "";
		if ((pointer !== "" && !pointer.startsWith("/")) || /~(?:[^01]|$)/.test(pointer)) {
			throw new Error("Invalid MCP JSON Pointer; use an empty string or slash-separated fields with ~0/~1 escapes");
		}
		let value: unknown = record.structuredContent;
		for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
			const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
			if (
				typeof value !== "object" ||
				value === null ||
				(Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(key)) ||
				!Object.hasOwn(value, key)
			) {
				throw new Error("MCP JSON Pointer does not identify a stored value");
			}
			value = (value as Record<string, unknown>)[key];
		}
		const fits = (result: McpStoredStructuredOutput): boolean =>
			byteLength(JSON.stringify({ action: "read_cache", ...result })) <= this.maxOutputBytes;
		const result: McpStoredStructuredOutput = { cacheId, pointer };
		if (Array.isArray(value)) {
			const offset = options.offset ?? 0;
			const limit = options.limit ?? 20;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset > value.length) {
				throw new Error("MCP structured cache offset must be a safe integer within the selected array");
			}
			if (!Number.isSafeInteger(limit) || limit <= 0) {
				throw new Error("MCP structured cache limit must be a positive safe integer");
			}
			result.startOffset = offset;
			result.totalItems = value.length;
			const rows: unknown[] = [];
			const end = Math.min(value.length, offset + Math.min(limit, 100));
			for (let index = offset; index < end; index++) {
				const candidate = {
					...result,
					value: [...rows, value[index]],
					...(index + 1 < value.length ? { nextOffset: index + 1 } : {}),
				};
				if (!fits(candidate)) break;
				rows.push(value[index]);
			}
			if (rows.length > 0 || offset === value.length) {
				const page = {
					...result,
					value: rows,
					...(offset + rows.length < value.length ? { nextOffset: offset + rows.length } : {}),
				};
				if (fits(page)) return page;
			}
		} else {
			if (options.offset !== undefined || options.limit !== undefined) {
				throw new Error("MCP structured cache offset and limit require an array selection");
			}
			const selected = { ...result, value };
			if (fits(selected)) return selected;
		}
		const selection = {
			...result,
			selectionRequired: true,
			message:
				"Selection exceeds the output limit. Choose a more specific JSON Pointer, or omit pointer to read the original text.",
		};
		if (!fits(selection)) throw new Error("MCP JSON Pointer is too large for the output limit");
		return selection;
	}

	private readRecord(cacheId: string): McpStoredOutput {
		const id = safeCacheId(cacheId);
		const filePath = join(this.dir, `${id}.json`);
		if (!existsSync(filePath)) {
			throw new Error(`MCP cache entry not found: ${cacheId}`);
		}
		hardenPrivateRegularFileSync(filePath);
		const stat = lstatSync(filePath);
		if (stat.size > this.maxCacheEntryBytes || stat.mtimeMs < this.now() - this.maxCacheAgeMs) {
			throw new Error(`MCP cache entry is expired or exceeds the configured size limit: ${cacheId}`);
		}
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Invalid MCP cache entry: ${cacheId}`);
		}
		const record = parsed as Partial<McpStoredOutput>;
		if (
			record.id !== id ||
			typeof record.text !== "string" ||
			typeof record.bytes !== "number" ||
			record.bytes !== byteLength(record.text) ||
			typeof record.lines !== "number" ||
			typeof record.createdAt !== "string" ||
			(record.structuredContent !== undefined &&
				(typeof record.structuredContent !== "object" ||
					record.structuredContent === null ||
					Array.isArray(record.structuredContent)))
		) {
			throw new Error(`Invalid MCP cache entry: ${cacheId}`);
		}
		if (record.sessionId !== this.sessionId) {
			throw new Error(`MCP cache entry is not available in this session: ${cacheId}`);
		}
		if (record.workspaceId !== this.workspaceId) {
			throw new Error(`MCP cache entry is not available in this workspace: ${cacheId}`);
		}
		return record as McpStoredOutput;
	}

	private prune(reservedBytes = 0, reservedEntries = 0): boolean {
		if (!existsSync(this.dir)) return true;
		const cutoff = this.now() - this.maxCacheAgeMs;
		const entries = readdirSync(this.dir)
			.filter((name) => CACHE_FILE_PATTERN.test(name))
			.flatMap((name) => {
				const path = join(this.dir, name);
				try {
					const stat = lstatSync(path);
					if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
						unlinkSync(path);
						return [];
					}
					if (stat.mtimeMs < cutoff || stat.size > this.maxCacheEntryBytes) {
						unlinkSync(path);
						return [];
					}
					return [{ path, size: stat.size, mtimeMs: stat.mtimeMs }];
				} catch {
					return [];
				}
			})
			.sort((left, right) => left.mtimeMs - right.mtimeMs);
		let totalBytes = entries.reduce((total, entry) => total + entry.size, 0);
		let totalEntries = entries.length;
		for (const entry of entries) {
			if (
				totalBytes + reservedBytes <= this.maxCacheTotalBytes &&
				totalEntries + reservedEntries <= this.maxCacheEntries
			) {
				break;
			}
			try {
				unlinkSync(entry.path);
				totalBytes -= entry.size;
				totalEntries--;
			} catch {
				// Capacity is checked below; a failed eviction prevents the new write.
			}
		}
		return (
			totalBytes + reservedBytes <= this.maxCacheTotalBytes && totalEntries + reservedEntries <= this.maxCacheEntries
		);
	}
}
