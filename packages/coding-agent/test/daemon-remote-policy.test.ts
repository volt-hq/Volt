import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";

describe("voltd remote tool policy settings", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-remote-policy-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function waitForHealthy(): Promise<DaemonProbeResult> {
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		return status;
	}

	it("syncs remote.allowTools into daemon state without collapsing deny-all", async () => {
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ remote: { allowTools: [] } }, null, 2)}\n`);
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		const probe = await waitForHealthy();
		const client = createDaemonClient({
			socketPath: probe.socketPath,
			client: "cli",
			version: "test",
			authToken: probe.authToken,
			reconnect: false,
		});

		const status = await client.request({ type: "status" });
		expect(status).toMatchObject({
			type: "status_result",
			remotePolicy: { allowTools: [] },
		});

		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);

		const persisted = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
			settings?: { allowTools?: string[] | null };
		};
		expect(persisted.settings?.allowTools).toEqual([]);
	}, 30_000);
});
