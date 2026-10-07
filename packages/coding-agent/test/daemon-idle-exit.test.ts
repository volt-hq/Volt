/**
 * A daemon started on demand exits once nothing has needed it for its grace
 * period (Phase 7 D8; daemon RFC Q3): no conversation workers, no control
 * clients, and no paired devices. A connected control client keeps it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

describe("the daemon's idle exit (D8)", () => {
	it("stays while a control client is connected, and exits once nothing needed it for the grace period", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-idle-exit-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const daemon = runVoltDaemon({ agentDir, foreground: false, idleExitMs: 600 });
		let exited: number | undefined;
		void daemon.then((code) => {
			exited = code;
		});
		await vi.waitFor(async () => expect((await probeDaemon(agentDir)).healthy).toBe(true), { timeout: 20_000 });
		const probe = await probeDaemon(agentDir);
		const client = createDaemonClient({
			socketPath: probe.socketPath,
			client: "tui",
			version: "test",
			...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
			reconnect: false,
		});
		cleanups.push(async () => {
			await client.close();
			if (exited === undefined) {
				await createDaemonClient({
					socketPath: probe.socketPath,
					client: "cli",
					version: "test",
					...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
					reconnect: false,
				})
					.request({ type: "shutdown" })
					.catch(() => undefined);
				await daemon;
			}
		});
		await client.connect();

		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(exited).toBeUndefined();

		await client.close();
		await expect(daemon).resolves.toBe(0);
		const audit = readFileSync(getDaemonPaths(agentDir).auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; details?: { reason?: string } });
		expect(audit).toContainEqual(
			expect.objectContaining({ type: "daemon_shutdown", details: expect.objectContaining({ reason: "idle" }) }),
		);
	}, 30_000);
});
