import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLspAudit, handleLspAuditCommand, parseLspAuditArgs } from "../src/cli/lsp-audit.ts";
import type { LspOperationMetadata } from "../src/core/lsp/outcome.ts";
import { getDefaultSessionDirPath } from "../src/core/session-manager.ts";
import { auditLsp } from "../src/core/session-store/lsp-audit.ts";
import { initializeSessionStoreSchema } from "../src/core/session-store/schema-migration.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
const createdAt = "2026-09-01T00:00:00.000Z";
const completedAt = "2026-09-10T12:00:00.000Z";
const now = new Date("2026-09-14T12:00:00.000Z");
const secret = "TRANSCRIPT_SECRET /home/private/project/file.ts sk-secret-token";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-lsp-audit-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "custom");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	const db = new DatabaseSync(join(sessionDir, "sessions.sqlite"));
	databases.push(db);
	initializeSessionStoreSchema(db);
	return { root, cwd, sessionDir, db };
}

function session(db: DatabaseSync, id: string, cwd: string, origin: "subagent" | null = null, created = createdAt) {
	db.prepare(
		"INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at, origin) VALUES (?, ?, 5, ?, ?, ?, ?)",
	).run(id, `${id}-generation`, cwd, created, completedAt, origin);
}

function operation(id: string, overrides: Partial<LspOperationMetadata> = {}): LspOperationMetadata {
	return {
		operationId: id,
		trigger: "explicit",
		action: "references",
		completedAt,
		outcome: "success",
		reason: "success",
		language: "typescript",
		server: "typescript",
		durationMs: 100,
		coldStartMs: 0,
		diagnosticCount: 0,
		resultCount: 3,
		freshness: "fresh",
		source: "pull",
		...overrides,
	};
}

function result(
	db: DatabaseSync,
	sessionId: string,
	ordinal: number,
	toolName: string,
	lsp?: LspOperationMetadata,
	timestamp = completedAt,
	toolCallId = `${sessionId}-${ordinal}`,
) {
	const entry = {
		type: "message",
		id: `${sessionId}-${ordinal}`,
		parentId: null,
		timestamp,
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text: secret }],
			details: { ...(lsp ? { lsp } : {}), secret },
			timestamp: Date.parse(timestamp),
		},
	};
	db.prepare(
		"INSERT INTO entries (session_id, entry_id, ordinal, entry_type, timestamp, is_host_only, payload_json) VALUES (?, ?, ?, 'message', ?, 0, ?)",
	).run(sessionId, entry.id, ordinal, timestamp, JSON.stringify(entry));
}

function files(directory: string) {
	return readdirSync(directory)
		.sort()
		.map((name) => {
			const path = join(directory, name);
			const info = statSync(path);
			return {
				name,
				mode: info.mode,
				size: info.size,
				hash: createHash("sha256").update(readFileSync(path)).digest("hex"),
			};
		});
}

afterEach(() => {
	for (const db of databases.splice(0)) if (db.isOpen) db.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.exitCode = 0;
});

describe("offline LSP audit", () => {
	it("counts known outcomes across branches once, excludes empty/copied sessions, separates child and historical evidence", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		session(db, "child", cwd, "subagent");
		session(db, "clone", cwd, null, "2026-09-11T00:00:00.000Z");
		session(db, "empty", cwd);
		session(db, "chat", cwd);
		session(db, "historical", cwd);
		const first = operation("one", { durationMs: 500, coldStartMs: 300 });
		result(db, "root", 1, "lsp", first);
		// Alternate branch: no leaf traversal should exclude this operation.
		result(
			db,
			"root",
			2,
			"edit",
			operation("two", {
				trigger: "edit",
				action: "diagnostics",
				outcome: "empty",
				reason: "no-diagnostics",
				durationMs: 20,
				resultCount: 0,
			}),
		);
		result(db, "clone", 1, "lsp", first);
		result(
			db,
			"child",
			1,
			"write",
			operation("three", {
				trigger: "write",
				action: "diagnostics",
				outcome: "skipped",
				reason: "disabled",
				language: "unknown",
				freshness: "unknown",
				source: "none",
				durationMs: 0,
				resultCount: 0,
			}),
		);
		result(
			db,
			"child",
			2,
			"edit",
			operation("four", {
				trigger: "edit",
				action: "diagnostics",
				outcome: "skipped",
				reason: "no-server",
				language: "unknown",
				freshness: "unknown",
				source: "none",
				durationMs: 0,
				resultCount: 0,
			}),
		);
		result(
			db,
			"child",
			3,
			"lsp",
			operation("five", {
				outcome: "unavailable",
				reason: "startup-failed",
				durationMs: 1000,
				coldStartMs: 900,
				freshness: "unknown",
				source: "none",
				resultCount: 0,
			}),
		);
		result(db, "historical", 1, "lsp");
		result(db, "historical", 2, "edit");
		result(db, "historical", 3, "grep");
		result(db, "historical", 4, "bash");
		db.close();
		const before = files(sessionDir);
		const report = await auditLsp({ cwd, sessionDir, now });
		expect(report.coverage).toMatchObject({ partial: false, storesRead: 1, sessionsScanned: 6, entriesScanned: 10 });
		expect(report.totals).toMatchObject({
			operations: 5,
			explicit: 2,
			automatic: 3,
			startupFailures: 1,
			reasons: { disabled: 1, "no-server": 1 },
		});
		expect(report.deduplication).toMatchObject({ copiesRemoved: 1, originalContextUnavailable: 0 });
		expect(report.utilization).toMatchObject({
			toolActiveConversations: 3,
			withExplicitLsp: 2,
			withAutomaticLsp: 2,
			withAnyLsp: 2,
			cohorts: { root: { toolActive: 2, withLsp: 1 }, subagent: { toolActive: 1, withLsp: 1 } },
		});
		expect(report.byCohort.root.operations).toBe(2);
		expect(report.byCohort.subagent.operations).toBe(3);
		expect(report.byAction.diagnostics.operations).toBe(3);
		expect(report.byLanguage.typescript.operations).toBe(3);
		expect(report.byDay["2026-09-10"].operations).toBe(5);
		expect(report.latencyMs).toEqual({
			all: { samples: 5, p50: 20, p95: 1000 },
			cold: { samples: 2, p50: 500, p95: 1000 },
			warm: { samples: 1, p50: 20, p95: 20 },
			startup: { samples: 2, p50: 300, p95: 900 },
			notStartedOrUnknown: { samples: 2, p50: 0, p95: 0 },
		});
		expect(report.uninstrumented).toEqual({ explicit: 1, automaticChecksUnknown: 1, outcome: "unknown" });
		expect(report.contextOnly).toMatchObject({ grepResults: 1, bashResults: 1 });
		for (const text of [JSON.stringify(report), formatLspAudit(report)]) {
			expect(text).not.toContain(secret);
			expect(text).not.toContain(cwd);
			expect(text).not.toContain(sessionDir);
			expect(text).not.toContain('"operationId"');
		}
		expect(files(sessionDir)).toEqual(before);
	});

	it("reads active WAL without checkpointing, modifying durable data, or changing permissions", async () => {
		const { db, cwd, sessionDir } = fixture();
		db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("wal"));
		const before = files(sessionDir);
		const report = await auditLsp({ cwd, sessionDir, now });
		expect(report.coverage.skippedStores).toEqual({});
		expect(report.totals.operations).toBe(1);
		expect(files(sessionDir).filter((file) => !file.name.endsWith("-shm"))).toEqual(
			before.filter((file) => !file.name.endsWith("-shm")),
		);
		expect(files(sessionDir).map(({ name, mode }) => ({ name, mode }))).toEqual(
			before.map(({ name, mode }) => ({ name, mode })),
		);
	});

	it("does not create sidecars when reading a closed WAL store", async () => {
		const { db, cwd, sessionDir } = fixture();
		db.exec("PRAGMA journal_mode = WAL");
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("closed-wal"));
		db.close();
		const before = files(sessionDir);
		expect(before.map((file) => file.name)).toEqual(["sessions.sqlite"]);
		const report = await auditLsp({ cwd, sessionDir, now });
		expect(report.totals.operations).toBe(1);
		expect(files(sessionDir)).toEqual(before);
	});

	it("uses completedAt for the window and attributes a clone to its original workspace when available", async () => {
		const { db, root, cwd, sessionDir } = fixture();
		const other = join(root, "other");
		mkdirSync(other);
		session(db, "a-clone", cwd, null, "2026-09-12T00:00:00.000Z");
		session(db, "z-original", other);
		const data = operation("shared");
		result(db, "a-clone", 1, "lsp", data, "2026-09-12T00:00:01.000Z");
		result(db, "z-original", 1, "lsp", data);
		result(
			db,
			"a-clone",
			2,
			"lsp",
			operation("old", { completedAt: "2026-08-01T00:00:00.000Z" }),
			"2026-09-12T00:00:02.000Z",
		);
		expect((await auditLsp({ cwd, sessionDir, now })).totals.operations).toBe(0);
		expect((await auditLsp({ cwd, sessionDir, now, allWorkspaces: true })).totals.operations).toBe(1);
		expect(
			(await auditLsp({ cwd, sessionDir, now, allWorkspaces: true, until: completedAt })).totals.operations,
		).toBe(0);
	});

	it("deduplicates forked operations across stores and retains useful totals beside a corrupt store", async () => {
		const source = fixture();
		const fork = fixture();
		const broken = fixture();
		session(source.db, "original", source.cwd, "subagent");
		session(fork.db, "fork", fork.cwd, null, "2026-09-11T00:00:00.000Z");
		result(source.db, "original", 1, "lsp", operation("cross-store"));
		result(fork.db, "fork", 1, "lsp", operation("cross-store"));
		broken.db.close();
		writeFileSync(join(broken.sessionDir, "sessions.sqlite"), "corrupt");
		mkdirSync(join(source.root, "sessions"));
		symlinkSync(source.sessionDir, join(source.root, "sessions", "source"));
		symlinkSync(fork.sessionDir, join(source.root, "sessions", "fork"));
		symlinkSync(broken.sessionDir, join(source.root, "sessions", "broken"));
		vi.stubEnv("VOLT_CODING_AGENT_DIR", source.root);
		vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", "");
		const report = await auditLsp({ cwd: fork.cwd, now, allWorkspaces: true });
		expect(report.coverage).toMatchObject({ partial: true, storesRead: 2, skippedStores: { corrupt: 1 } });
		expect(report.totals.operations).toBe(1);
		expect(report.byCohort.subagent.operations).toBe(1);
		expect(report.utilization.toolActiveConversations).toBe(1);
		expect(report.deduplication.copiesRemoved).toBe(1);
	});

	it("does not read an uncommitted rollback-journal store as an immutable snapshot", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		db.exec("BEGIN IMMEDIATE");
		result(db, "root", 1, "lsp", operation("uncommitted"));
		const before = files(sessionDir);
		try {
			const report = await auditLsp({ cwd, sessionDir, now });
			expect(report.coverage.skippedStores).toEqual({ busy: 1 });
			expect(report.totals.operations).toBe(0);
			expect(files(sessionDir)).toEqual(before);
		} finally {
			db.exec("ROLLBACK");
		}
	});

	it("canonicalizes custom-store cwd filters and defaults to fourteen days", async () => {
		const { db, root, cwd, sessionDir } = fixture();
		const alias = join(root, "alias");
		symlinkSync(cwd, alias);
		session(db, "root", alias);
		result(db, "root", 1, "lsp", operation("alias"));
		const report = await auditLsp({ cwd, sessionDir, now });
		expect(report.totals.operations).toBe(1);
		expect(report.window.since).toBe("2026-08-31T12:00:00.000Z");
	});

	it.each(["absolute", "relative"])(
		"discovers the writer's default store for a symlink cwd (%s path)",
		async (spelling) => {
			const { db, root, cwd, sessionDir } = fixture();
			const alias = join(root, "Alias");
			symlinkSync(cwd, alias, process.platform === "win32" ? "junction" : "dir");
			vi.stubEnv("VOLT_CODING_AGENT_DIR", root);
			vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", "");
			session(db, "alias", alias);
			session(db, "real", cwd);
			session(db, "other", root);
			result(db, "alias", 1, "lsp", operation("alias"));
			result(db, "real", 1, "lsp", operation("real"));
			result(db, "other", 1, "lsp", operation("other"));
			db.close();
			const defaultDir = getDefaultSessionDirPath(alias);
			mkdirSync(join(root, "sessions"));
			renameSync(sessionDir, defaultDir);
			const before = files(defaultDir);
			const report = await auditLsp({
				cwd: spelling === "relative" ? relative(process.cwd(), alias) : alias,
				now,
			});
			expect(report.coverage).toMatchObject({
				partial: false,
				storesDiscovered: 1,
				storesRead: 1,
			});
			expect(report.coverage.skippedStores).toEqual({});
			expect(report.totals.operations).toBe(2);
			expect(report.utilization.toolActiveConversations).toBe(2);
			expect(files(defaultDir)).toEqual(before);
			expect(existsSync(getDefaultSessionDirPath(cwd))).toBe(false);
		},
	);

	it("does not create a missing default session directory during discovery", async () => {
		const { root, cwd } = fixture();
		vi.stubEnv("VOLT_CODING_AGENT_DIR", root);
		vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", "");
		const report = await auditLsp({ cwd, now });
		expect(report.coverage).toMatchObject({ partial: true, storesRead: 0, skippedStores: { missing: 1 } });
		expect(existsSync(join(root, "sessions"))).toBe(false);
	});

	it("reports corrupt, unsupported, missing, and busy stores without repairs", async () => {
		const { db, cwd, sessionDir } = fixture();
		db.close();
		writeFileSync(join(sessionDir, "sessions.sqlite"), "not sqlite");
		const before = files(sessionDir);
		expect((await auditLsp({ cwd, sessionDir, now })).coverage.skippedStores).toEqual({ corrupt: 1 });
		expect(files(sessionDir)).toEqual(before);
		const missing = join(sessionDir, "absent");
		expect((await auditLsp({ cwd, sessionDir: missing, now })).coverage.skippedStores).toEqual({ missing: 1 });
		expect(readdirSync(sessionDir)).toEqual(["sessions.sqlite"]);
		const next = fixture();
		next.db.exec("PRAGMA user_version = 99");
		next.db.close();
		const unsupportedBefore = files(next.sessionDir);
		expect((await auditLsp({ cwd: next.cwd, sessionDir: next.sessionDir, now })).coverage.skippedStores).toEqual({
			unsupported: 1,
		});
		expect(files(next.sessionDir)).toEqual(unsupportedBefore);
		writeFileSync(join(next.sessionDir, "sessions.sqlite-wal"), "busy");
		expect((await auditLsp({ cwd: next.cwd, sessionDir: next.sessionDir, now })).coverage.skippedStores).toEqual({
			busy: 1,
		});
	});

	it("bounds scans and supports cancellation without starting a store", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("one"));
		result(db, "root", 2, "lsp", operation("two"));
		const report = await auditLsp({ cwd, sessionDir, now, limits: { maxEntries: 1 } });
		expect(report.totals.operations).toBe(1);
		expect(report.coverage).toMatchObject({ partial: true, entriesScanned: 1, limitsReached: ["scan"] });
		const controller = new AbortController();
		controller.abort();
		const cancelled = await auditLsp({ cwd, sessionDir, now, signal: controller.signal });
		expect(cancelled.coverage).toMatchObject({ cancelled: true, partial: true, storesRead: 0 });
		const timed = await auditLsp({ cwd, sessionDir, now, limits: { maxStoreMs: 1 } });
		expect(timed.coverage).toMatchObject({ partial: true, skippedStores: { timeout: 1 } });
	});

	it("discovers only bounded default stores and honors an explicit directory over environment", async () => {
		const { db, root, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("one"));
		vi.stubEnv("VOLT_CODING_AGENT_DIR", root);
		vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", join(root, "wrong"));
		expect((await auditLsp({ cwd, sessionDir, now })).totals.operations).toBe(1);
		vi.stubEnv("VOLT_CODING_AGENT_SESSION_DIR", "");
		mkdirSync(join(root, "sessions"));
		symlinkSync(sessionDir, join(root, "sessions", "one"));
		symlinkSync(sessionDir, join(root, "sessions", "two"));
		const all = await auditLsp({ cwd, now, allWorkspaces: true });
		expect(all.coverage.storesRead).toBe(1);
		expect(all.totals.operations).toBe(1);
		const bounded = await auditLsp({ cwd, now, allWorkspaces: true, limits: { maxStores: 1 } });
		expect(bounded.coverage).toMatchObject({ partial: true, limitsReached: ["stores"] });
	});

	it("redacts untrusted metadata, reports oversized entries, and marks orphaned copies uncertain", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "clone", cwd, null, "2026-09-12T00:00:00.000Z");
		result(
			db,
			"clone",
			1,
			"lsp",
			operation("copy", { reason: secret, language: secret, server: secret }),
			"2026-09-12T00:00:01.000Z",
		);
		const report = await auditLsp({ cwd, sessionDir, now });
		expect(report.deduplication.originalContextUnavailable).toBe(1);
		expect(report.totals.reasons).toEqual({ unknown: 1 });
		expect(JSON.stringify(report)).not.toContain(secret);
		const oversized = await auditLsp({ cwd, sessionDir, now, limits: { maxEntryBytes: 64 } });
		expect(oversized.coverage).toMatchObject({ partial: true, oversizedEntries: 1, limitsReached: ["entry-bytes"] });
		expect(oversized.totals.operations).toBe(0);
	});

	it("cancels an in-flight reader and leaves its store unchanged", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		for (let i = 1; i <= 100; i++) result(db, "root", i, "lsp", operation(`operation-${i}`));
		db.close();
		const before = files(sessionDir);
		const controller = new AbortController();
		const pending = auditLsp({ cwd, sessionDir, now, signal: controller.signal });
		const timer = setTimeout(() => controller.abort(), 10);
		try {
			const report = await pending;
			expect(report.coverage).toMatchObject({ partial: true, cancelled: true });
			expect(files(sessionDir)).toEqual(before);
		} finally {
			clearTimeout(timer);
		}
	});

	it("dispatches the actual CLI before reading auth or settings and creates no agent files", () => {
		const { db, root, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("cli"));
		db.close();
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "auth.json"), "invalid auth sentinel");
		writeFileSync(join(agentDir, "settings.json"), "invalid settings sentinel");
		const before = files(agentDir);
		const output = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../../../scripts/run-coding-agent-source.mjs", import.meta.url)),
				"lsp",
				"audit",
				"--json",
				"--session-dir",
				sessionDir,
				"--until",
				now.toISOString(),
			],
			{
				cwd,
				encoding: "utf8",
				timeout: 30_000,
				env: {
					...process.env,
					VOLT_CODING_AGENT_DIR: agentDir,
					VOLT_CODING_AGENT_SESSION_DIR: "",
					VOLT_OFFLINE: "1",
				},
			},
		);
		expect(output.error).toBeUndefined();
		expect(output.status, output.stderr).toBe(0);
		expect(JSON.parse(output.stdout).totals.operations).toBe(1);
		expect(files(agentDir)).toEqual(before);
	}, 35_000);

	it("parses standalone CLI options and prints JSON without normal startup", async () => {
		const { db, cwd, sessionDir } = fixture();
		session(db, "root", cwd);
		result(db, "root", 1, "lsp", operation("one"));
		expect(
			parseLspAuditArgs([
				"--json",
				"--since",
				createdAt,
				"--until",
				now.toISOString(),
				"--session-dir",
				sessionDir,
				"--all-workspaces",
			]),
		).toMatchObject({ json: true, options: { sessionDir, allWorkspaces: true } });
		expect(() => parseLspAuditArgs(["--since"])).toThrow("requires a value");
		expect(() => parseLspAuditArgs(["--format", "csv"])).toThrow("text or json");
		await expect(auditLsp({ cwd, sessionDir, since: "invalid" })).rejects.toThrow("valid dates");
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await handleLspAuditCommand(["other"])).toBe(false);
		expect(
			await handleLspAuditCommand([
				"lsp",
				"audit",
				"--json",
				"--session-dir",
				sessionDir,
				"--all-workspaces",
				"--until",
				now.toISOString(),
			]),
		).toBe(true);
		expect(JSON.parse(log.mock.calls[0][0] as string).totals.operations).toBe(1);
		expect(process.exitCode).toBe(0);
	});
});
