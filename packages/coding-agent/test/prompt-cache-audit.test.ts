import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROMPT_CACHE_AUDIT_DIRECTORY, PromptCacheAudit } from "../src/core/prompt-cache-audit.ts";

const common = {
	provider: "anthropic",
	model: "claude-opus-5-5",
	ttlSeconds: 300,
	keepAlive: { enabled: true, idleWindowMinutes: 15, refreshBudget: 24 },
};
const usage = { input: 4, output: 0, cacheRead: 6000, cacheWrite: 0, cacheWrite1h: 0, costTotal: 0.0012 };

const directories: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function agentDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-cache-audit-"));
	directories.push(directory);
	return directory;
}

function readRecords(directory: string): Array<Record<string, unknown>> {
	const auditDirectory = join(directory, PROMPT_CACHE_AUDIT_DIRECTORY);
	return readdirSync(auditDirectory).flatMap((name) =>
		readFileSync(join(auditDirectory, name), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>),
	);
}

describe("PromptCacheAudit", () => {
	it("writes metadata records as a JSONL batch on close", async () => {
		const directory = agentDir();
		const audit = new PromptCacheAudit({ agentDir: directory, sessionId: () => "session-1", enabled: true });

		audit.record({
			kind: "request",
			...common,
			stopReason: "toolUse",
			precededBy: "refresh",
			gapMs: 420_000,
			prefixTokens: 6000,
			usage,
		});
		audit.record({
			kind: "refresh",
			...common,
			reason: "in_flight",
			outcome: "refreshed",
			durationMs: 800,
			sinceLastRequestMs: 240_000,
			usage,
		});
		audit.record({ kind: "keepalive_stop", ...common, reason: "idle_window_elapsed", expiresInMs: 60_000 });
		await audit.close();

		const records = readRecords(directory);
		expect(records.map((record) => record.kind)).toEqual(["request", "refresh", "keepalive_stop"]);
		expect(records[0]).toMatchObject({
			schemaVersion: 1,
			sessionId: "session-1",
			runtimeId: audit.runtimeId,
			sequence: 1,
			provider: "anthropic",
			model: "claude-opus-5-5",
			precededBy: "refresh",
			gapMs: 420_000,
			usage,
		});
		expect(records[1]).toMatchObject({ sequence: 2, reason: "in_flight", outcome: "refreshed" });
	});

	it("is disabled by VOLT_PROMPT_CACHE_AUDIT=0 unless explicitly enabled", async () => {
		vi.stubEnv("VOLT_PROMPT_CACHE_AUDIT", "0");
		const directory = agentDir();
		const audit = new PromptCacheAudit({ agentDir: directory, sessionId: () => "session-1" });

		audit.record({ kind: "keepalive_stop", ...common, reason: "idle_window_elapsed" });
		await audit.close();

		expect(audit.enabled).toBe(false);
		expect(existsSync(join(directory, PROMPT_CACHE_AUDIT_DIRECTORY))).toBe(false);
	});

	it("never creates a missing agent directory", async () => {
		const directory = join(agentDir(), "removed");
		const audit = new PromptCacheAudit({ agentDir: directory, sessionId: () => "session-1", enabled: true });

		audit.record({ kind: "keepalive_stop", ...common, reason: "idle_window_elapsed" });
		await audit.close();

		expect(existsSync(directory)).toBe(false);
	});
});
