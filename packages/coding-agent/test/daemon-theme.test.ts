/**
 * M6 daemon theme plumbing: theme_set control request applies the theme to the
 * daemon's instance, persists it in voltd state, and broadcasts a resolved
 * theme_snapshot to all control clients; invalid names are rejected without
 * clobbering the active theme.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentThemeName } from "../src/core/theme/runtime.ts";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";

describe("voltd theme_set + theme_snapshot", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-theme-"));
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

	it("applies, persists, and broadcasts theme changes; rejects unknown themes", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		const status = await waitForHealthy();

		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "tui",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});

		// Unknown theme: rejected, no snapshot broadcast, active theme untouched.
		const themeBefore = getCurrentThemeName();
		const rejected = await client.request({ type: "theme_set", theme: "no-such-theme" });
		expect(rejected.type).toBe("error");
		expect((rejected as { code?: string }).code).toBe("invalid_theme");
		expect(getCurrentThemeName()).toBe(themeBefore);
		expect(events.filter((event) => event.type === "theme_snapshot")).toHaveLength(0);

		// Valid theme: ok + theme_snapshot with resolved hex tokens.
		const accepted = await client.request({ type: "theme_set", theme: "light" });
		expect(accepted.type).toBe("ok");
		await vi.waitFor(() => {
			expect(events.some((event) => event.type === "theme_snapshot")).toBe(true);
		});
		const snapshot = events.find((event) => event.type === "theme_snapshot") as Extract<
			ControlEvent,
			{ type: "theme_snapshot" }
		>;
		expect(snapshot.themeName).toBe("light");
		const tokenValues = Object.values(snapshot.tokens);
		expect(tokenValues.length).toBeGreaterThan(0);
		expect(tokenValues.every((value) => typeof value === "string")).toBe(true);
		expect(tokenValues.some((value) => value.startsWith("#"))).toBe(true);
		expect(getCurrentThemeName()).toBe("light");

		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);

		// Persisted in voltd state...
		expect(existsSync(paths.statePath)).toBe(true);
		const persisted = JSON.parse(readFileSync(paths.statePath, "utf8")) as {
			settings?: { themeName?: string };
		};
		expect(persisted.settings?.themeName).toBe("light");

		// ...and re-applied on the next daemon start.
		const restarted = runVoltDaemon({ agentDir, foreground: false });
		const restartedStatus = await waitForHealthy();
		expect(getCurrentThemeName()).toBe("light");
		const stopClient = createDaemonClient({
			socketPath: restartedStatus.socketPath,
			client: "cli",
			version: "test",
			authToken: restartedStatus.authToken,
			reconnect: false,
		});
		await stopClient.request({ type: "shutdown" });
		await stopClient.close();
		await expect(restarted).resolves.toBe(0);
	}, 30_000);
});
