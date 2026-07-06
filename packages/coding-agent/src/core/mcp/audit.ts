import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactMcpText, sanitizeMcpArguments } from "./permissions.ts";
import type { McpCallerSurface, McpRecentCallStatus, McpRisk } from "./types.ts";

export interface McpAuditEventInput {
	workspaceId?: string;
	sessionId?: string;
	callerSurface: McpCallerSurface;
	server: string;
	item: string;
	kind: "tool" | "resource" | "prompt" | "cache";
	risk: McpRisk;
	status: McpRecentCallStatus;
	durationMs?: number;
	resultSize?: number;
	cacheId?: string;
	arguments?: Record<string, unknown>;
	error?: string;
}

export interface McpAuditEntry {
	timestamp: string;
	workspaceId?: string;
	sessionId?: string;
	callerSurface: McpCallerSurface;
	server: string;
	item: string;
	kind: "tool" | "resource" | "prompt" | "cache";
	risk: McpRisk;
	status: McpRecentCallStatus;
	durationMs?: number;
	resultSize?: number;
	resultHash?: string;
	cacheId?: string;
	arguments?: unknown;
	error?: string;
}

function hashResultSize(value: number | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export class McpAuditLogger {
	private path: string;

	constructor(agentDir: string) {
		this.path = join(agentDir, "mcp", "audit.jsonl");
	}

	async write(input: McpAuditEventInput): Promise<void> {
		const dir = dirname(this.path);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
		if (!existsSync(this.path)) {
			writeFileSync(this.path, "", { mode: 0o600 });
		}
		const entry: McpAuditEntry = {
			...input,
			timestamp: new Date().toISOString(),
			...(input.error ? { error: redactMcpText(input.error) } : {}),
			...(input.resultSize !== undefined ? { resultHash: hashResultSize(input.resultSize) } : {}),
			...(input.arguments ? { arguments: sanitizeMcpArguments(input.arguments) } : {}),
		};
		await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf-8");
	}
}
