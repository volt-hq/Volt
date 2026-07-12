import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "volt-iroh-audit-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("IrohRemoteAuditLogger security bounds", () => {
	it("burst-samples rejected handshakes and emits a bounded aggregate", async () => {
		let now = 1_000;
		const events: IrohRemoteAuditEvent[] = [];
		const logger = new IrohRemoteAuditLogger({
			now: () => now,
			sink: { write: (event) => void events.push(event) },
			securityEventRateLimit: { maxEventsPerWindow: 2, windowMs: 100 },
		});

		for (let index = 0; index < 5; index++) {
			await logger.log({
				type: "handshake_rejected",
				clientNodeId: `node-${index}`,
				success: false,
				error: "invalid hello",
			});
		}
		expect(events).toHaveLength(2);

		await logger.flush();
		expect(events).toHaveLength(3);
		expect(events[2]).toMatchObject({
			type: "security_events_rate_limited",
			success: false,
			details: {
				eventType: "handshake_rejected",
				suppressedCount: 3,
				windowStartedAt: 1_000,
				firstSuppressedAt: 1_000,
				lastSuppressedAt: 1_000,
			},
		});
		expect(events[2]?.clientNodeId).toBeUndefined();

		now = 2_000;
		await logger.log({ type: "handshake_rejected", success: false, error: "next window" });
		expect(events.at(-1)).toMatchObject({ type: "handshake_rejected", error: "next window" });
		await logger.flush();
	});

	it("emits a suppression aggregate when the rate-limit window expires", async () => {
		vi.useFakeTimers();
		let now = 5_000;
		const events: IrohRemoteAuditEvent[] = [];
		const logger = new IrohRemoteAuditLogger({
			now: () => now,
			sink: { write: (event) => void events.push(event) },
			securityEventRateLimit: { maxEventsPerWindow: 1, windowMs: 50 },
		});
		await logger.log({ type: "client_rejected", success: false, error: "revoked" });
		await logger.log({ type: "client_rejected", success: false, error: "revoked" });
		expect(events).toHaveLength(1);

		now = 5_050;
		await vi.advanceTimersByTimeAsync(50);
		expect(events.at(-1)).toMatchObject({
			type: "security_events_rate_limited",
			details: { eventType: "client_rejected", suppressedCount: 1 },
		});
		await logger.flush();
	});

	it("rotates to a fixed backup count, caps entries, and enforces owner-only modes", async () => {
		const directory = createTempDirectory();
		const auditPath = join(directory, "daemon", "audit.jsonl");
		const logger = new IrohRemoteAuditLogger({
			path: auditPath,
			maxFileBytes: 1024,
			maxEntryBytes: 1024,
			maxBackupFiles: 2,
			securityEventRateLimit: false,
		});

		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				logger.log({ type: "bounded_event", details: { index, payload: "x".repeat(300) } }),
			),
		);
		await logger.log({ type: "oversized_event", error: "y".repeat(4_096) });
		await logger.flush();

		const files = readdirSync(join(directory, "daemon"))
			.filter((name) => name.startsWith("audit.jsonl"))
			.sort();
		expect(files).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
		for (const file of files) {
			const filePath = join(directory, "daemon", file);
			expect(statSync(filePath).size).toBeLessThanOrEqual(1024);
			expect(statSync(filePath).mode & 0o777).toBe(0o600);
			for (const line of readFileSync(filePath, "utf8").trim().split("\n")) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		}
		expect(statSync(join(directory, "daemon")).mode & 0o777).toBe(0o700);
		expect(readFileSync(auditPath, "utf8")).toContain('"type":"audit_event_truncated"');
	});

	it("refuses to append through an audit-file symlink", async () => {
		const directory = createTempDirectory();
		const targetPath = join(directory, "target.txt");
		const auditPath = join(directory, "audit.jsonl");
		writeFileSync(targetPath, "unchanged", { mode: 0o600 });
		symlinkSync(targetPath, auditPath);
		const logger = new IrohRemoteAuditLogger({ path: auditPath, securityEventRateLimit: false });

		await expect(logger.log({ type: "daemon_started", success: true })).rejects.toThrow(
			"Refusing to use non-regular audit file",
		);
		expect(readFileSync(targetPath, "utf8")).toBe("unchanged");
	});
});
