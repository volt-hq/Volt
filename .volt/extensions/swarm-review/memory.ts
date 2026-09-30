import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@hansjm10/volt-coding-agent";
import type { Cluster, ReviewTarget } from "./types.ts";

const MAX_ENTRIES_PER_REPOSITORY = 300;
const MAX_PROMPT_ENTRIES = 100;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_SNIPPET_LINES = 20;

interface StoredDismissal {
	key: string;
	title: string;
	file: string;
	line: number;
	endLine?: number;
	snippetHash: string;
	snippetLines: number;
	reason: string;
	dismissedAt: string;
}

interface MemoryStore {
	version: 1;
	repositories: Record<string, StoredDismissal[]>;
}

/** A remembered dismissal whose anchored code still exists in the reviewed checkout. */
export interface Dismissal extends StoredDismissal {
	/** Prompt-local id (D1, D2, ...). */
	id: string;
}

function isStoredDismissal(value: unknown): value is StoredDismissal {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.key === "string" &&
		typeof entry.title === "string" &&
		typeof entry.file === "string" &&
		typeof entry.line === "number" &&
		(entry.endLine === undefined || typeof entry.endLine === "number") &&
		typeof entry.snippetHash === "string" &&
		typeof entry.snippetLines === "number" &&
		entry.snippetLines > 0 &&
		typeof entry.reason === "string" &&
		typeof entry.dismissedAt === "string"
	);
}

function memoryPath(): string {
	return join(getAgentDir(), "swarm-review", "memory.json");
}

function readStore(): MemoryStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(memoryPath(), "utf8"));
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"version" in parsed &&
			parsed.version === 1 &&
			"repositories" in parsed &&
			typeof parsed.repositories === "object" &&
			parsed.repositories !== null
		) {
			return parsed as MemoryStore;
		}
	} catch {
		// Missing or unreadable memory starts empty.
	}
	return { version: 1, repositories: {} };
}

function fileLines(checkout: string, file: string): string[] | undefined {
	const path = join(checkout, file);
	return existsSync(path) ? readFileSync(path, "utf8").split("\n") : undefined;
}

function hashLines(lines: string[]): string {
	return createHash("sha256")
		.update(lines.map((line) => line.trim()).join("\n"))
		.digest("hex");
}

/** The anchored lines, whitespace-trimmed, so a dismissal survives the code moving but not the code changing. */
function snippet(
	checkout: string,
	file: string,
	line: number,
	endLine: number | undefined,
): { hash: string; lines: number } | undefined {
	const lines = fileLines(checkout, file);
	if (!lines) return undefined;
	const start = line - 1;
	const end = Math.min(Math.max(endLine ?? line, line), line - 1 + MAX_SNIPPET_LINES, lines.length);
	const selected = lines.slice(start, end);
	if (selected.length === 0 || selected.every((text) => !text.trim())) return undefined;
	return { hash: hashLines(selected), lines: selected.length };
}

function snippetPresent(checkout: string, entry: StoredDismissal): boolean {
	const lines = fileLines(checkout, entry.file);
	if (!lines) return false;
	for (let start = 0; start + entry.snippetLines <= lines.length; start++) {
		if (hashLines(lines.slice(start, start + entry.snippetLines)) === entry.snippetHash) return true;
	}
	return false;
}

/** Recent dismissals for this repository whose anchored code is still present, newest first. */
export function loadDismissals(target: ReviewTarget): Dismissal[] {
	const cutoff = Date.now() - MAX_AGE_MS;
	const entries: unknown[] = readStore().repositories[target.commonDir] ?? [];
	return entries
		.filter(isStoredDismissal)
		.filter((entry) => Date.parse(entry.dismissedAt) >= cutoff && snippetPresent(target.checkout, entry))
		.slice(-MAX_PROMPT_ENTRIES)
		.reverse()
		.map((entry, index) => ({ ...entry, id: `D${index + 1}` }));
}

/** Remembers clusters both verifiers rejected, anchored at each cluster's first claim. */
export async function recordDismissals(target: ReviewTarget, clusters: Cluster[]): Promise<number> {
	const additions: StoredDismissal[] = [];
	for (const cluster of clusters) {
		const anchor = cluster.candidates[0];
		const reason = cluster.verdicts[0]?.reason ?? cluster.verdicts[1]?.reason;
		if (!anchor || !reason) continue;
		const anchored = snippet(target.checkout, anchor.file, anchor.line, anchor.endLine);
		if (!anchored) continue;
		additions.push({
			key: randomUUID(),
			title: cluster.title,
			file: anchor.file,
			line: anchor.line,
			...(anchor.endLine !== undefined ? { endLine: anchor.endLine } : {}),
			snippetHash: anchored.hash,
			snippetLines: anchored.lines,
			reason,
			dismissedAt: new Date().toISOString(),
		});
	}
	if (additions.length === 0) return 0;
	const store = readStore();
	const cutoff = Date.now() - MAX_AGE_MS;
	const existing: unknown[] = store.repositories[target.commonDir] ?? [];
	store.repositories[target.commonDir] = [...existing.filter(isStoredDismissal), ...additions]
		.filter((entry) => Date.parse(entry.dismissedAt) >= cutoff)
		.slice(-MAX_ENTRIES_PER_REPOSITORY);
	const path = memoryPath();
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`);
	await rename(temporary, path);
	return additions.length;
}
