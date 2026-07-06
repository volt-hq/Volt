import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../tools/truncate.ts";
import type { McpCacheReference, McpOutputTruncation } from "./types.ts";

export interface McpOutputStoreOptions {
	agentDir: string;
	maxOutputBytes?: number;
	maxOutputLines?: number;
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
	let end = Math.max(start, Math.min(buffer.length, start + maxBytes));
	while (end > start && (buffer[end] & 0xc0) === 0x80) {
		end--;
	}
	const content = buffer.slice(start, end).toString("utf-8");
	return end < buffer.length ? { content, nextCursor: String(end) } : { content };
}

export class McpOutputStore {
	private dir: string;
	private maxOutputBytes: number;
	private maxOutputLines: number;
	private sessionId: string | undefined;
	private workspaceId: string | undefined;

	constructor(options: McpOutputStoreOptions) {
		this.dir = join(options.agentDir, "mcp", "output");
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
		this.maxOutputLines = options.maxOutputLines ?? DEFAULT_MAX_LINES;
		this.sessionId = options.sessionId;
		this.workspaceId = options.workspaceId;
	}

	shapeOutput(text: string): McpStoredOutputResult {
		const truncation = truncateHead(text, { maxBytes: this.maxOutputBytes, maxLines: this.maxOutputLines });
		if (!truncation.truncated) {
			return { content: text };
		}
		const cacheId = this.write(text);
		return {
			content: truncation.content,
			truncation: {
				truncated: true,
				returnedBytes: truncation.outputBytes,
				totalBytes: truncation.totalBytes,
				returnedLines: truncation.outputLines,
				totalLines: truncation.totalLines,
			},
			cache: {
				id: cacheId,
				read: `mcp({"action":"read_cache","cacheId":"${cacheId}"})`,
			},
		};
	}

	write(text: string): string {
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		}
		const id = createCacheId();
		const record: McpStoredOutput = {
			id,
			createdAt: new Date().toISOString(),
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(this.workspaceId ? { workspaceId: this.workspaceId } : {}),
			text,
			bytes: byteLength(text),
			lines: lineCount(text),
		};
		const filePath = join(this.dir, `${id}.json`);
		writeFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
		return id;
	}

	read(cacheId: string, options?: { cursor?: string; limit?: number }): McpStoredOutputChunk {
		const id = safeCacheId(cacheId);
		const filePath = join(this.dir, `${id}.json`);
		if (!existsSync(filePath)) {
			throw new Error(`MCP cache entry not found: ${cacheId}`);
		}
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			throw new Error(`Invalid MCP cache entry: ${cacheId}`);
		}
		const record = parsed as Partial<McpStoredOutput>;
		if (record.id !== id || typeof record.text !== "string" || typeof record.bytes !== "number") {
			throw new Error(`Invalid MCP cache entry: ${cacheId}`);
		}
		if (this.sessionId && record.sessionId && record.sessionId !== this.sessionId) {
			throw new Error(`MCP cache entry is not available in this session: ${cacheId}`);
		}
		if (this.workspaceId && record.workspaceId && record.workspaceId !== this.workspaceId) {
			throw new Error(`MCP cache entry is not available in this workspace: ${cacheId}`);
		}
		const startByte = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
		const maxBytes = Math.max(1, Math.min(options?.limit ?? this.maxOutputBytes, this.maxOutputBytes));
		const chunk = sliceByUtf8Bytes(record.text, Number.isFinite(startByte) ? startByte : 0, maxBytes);
		return {
			cacheId,
			content: chunk.content,
			startByte: Number.isFinite(startByte) ? startByte : 0,
			...(chunk.nextCursor ? { nextCursor: chunk.nextCursor } : {}),
			totalBytes: record.bytes,
		};
	}
}
