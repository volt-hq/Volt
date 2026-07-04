import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import {
	createEmptyVoltdState,
	getLegacyRemoteStatePath,
	migrateLegacyRemoteState,
	parseVoltdState,
	VoltdStateStore,
} from "../src/daemon/state.ts";

const SECRET_KEY_BYTES = Array.from({ length: 32 }, (_, index) => index + 1);

function createLegacyState(): IrohRemoteHostState {
	return {
		hostSecretKey: [...SECRET_KEY_BYTES],
		workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: undefined }],
		clients: [
			{
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["volt"],
				allowedTools: "read,bash",
				pairedAt: 1000,
				lastSeenAt: 2000,
				lastSessionIdByWorkspace: { volt: "s-abc" },
				pushTargets: [
					{
						id: "pt-1",
						provider: "fcm",
						platform: "ios",
						pushTargetAuthToken: "tok",
						enabled: true,
						createdAt: 1000,
						updatedAt: 1000,
					},
				],
			},
		],
		revokedClients: [
			{
				nodeId: "n-old",
				label: "old",
				allowedWorkspaces: [],
				allowedTools: "read",
				pairedAt: 1,
				lastSeenAt: 2,
				revokedAt: 3,
			},
		],
		pendingPairingTickets: [],
		pairingSecretTombstones: [],
	};
}

describe("voltd state migration", () => {
	let agentDir: string;
	let statePath: string;
	let legacyPath: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-state-"));
		statePath = getDaemonPaths(agentDir).statePath;
		legacyPath = getLegacyRemoteStatePath(agentDir);
		mkdirSync(join(agentDir, "remote"), { recursive: true });
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("maps legacy fields and preserves the secret key byte-identically", () => {
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const migrated = migrateLegacyRemoteState(agentDir, statePath);
		expect(migrated).not.toBeNull();
		expect(migrated?.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(migrated?.clients).toHaveLength(1);
		expect(migrated?.clients[0]?.nodeId).toBe("n-phone");
		expect(migrated?.clients[0]?.pushTargets?.[0]?.pushTargetAuthToken).toBe("tok");
		expect(migrated?.revokedClients).toHaveLength(1);
		expect(migrated?.workspaces[0]?.name).toBe("volt");
		expect(migrated?.settings.detachedRuntimeTtlMs).toBe(30 * 60 * 1000);
	});

	it("defaults missing legacy sections to empty", () => {
		writeFileSync(legacyPath, JSON.stringify({ workspaces: [], clients: [] }));
		const migrated = migrateLegacyRemoteState(agentDir, statePath);
		expect(migrated).not.toBeNull();
		expect(migrated?.irohSecretKey).toBeUndefined();
		expect(migrated?.revokedClients).toEqual([]);
		expect(migrated?.pendingPairingTickets).toEqual([]);
	});

	it("does nothing when state.json already exists", () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		writeFileSync(statePath, JSON.stringify(createEmptyVoltdState()));
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		expect(migrateLegacyRemoteState(agentDir, statePath)).toBeNull();
	});

	it("store.load migrates once, renames legacy to .migrated, and is idempotent", async () => {
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const first = await store.load();
		expect(first.migratedFromLegacyState).toBe(true);
		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(legacyPath)).toBe(false);
		expect(existsSync(`${legacyPath}.migrated`)).toBe(true);
		await store.close();

		// Reload from disk: secret key survives byte-identically.
		const secondStore = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const second = await secondStore.load();
		expect(second.migratedFromLegacyState).toBe(false);
		expect(second.state.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(second.state.clients[0]?.nodeId).toBe("n-phone");
		await secondStore.close();

		// Legacy file restored alongside state.json: still nothing happens.
		writeFileSync(legacyPath, JSON.stringify(createLegacyState()));
		const thirdStore = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		expect((await thirdStore.load()).migratedFromLegacyState).toBe(false);
		await thirdStore.close();
	});

	it("round-trips through parseVoltdState including settings", async () => {
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await store.load();
		store.updateSettings({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.settings).toEqual({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
	});

	it("setHostState updates the persisted host portion", async () => {
		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		await store.load();
		store.setHostState(createLegacyState());
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(store.getHostState().hostSecretKey).toEqual(SECRET_KEY_BYTES);
	});

	it("recovers from an unparseable state file instead of failing to load", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		writeFileSync(statePath, "{ this is : not valid json");

		const store = new VoltdStateStore({ agentDir, statePath, debounceMs: 1 });
		const result = await store.load();

		// The daemon starts from empty state rather than throwing (which would brick it).
		expect(result.migratedFromLegacyState).toBe(false);
		expect(result.recoveredFromCorruptStatePath).toBeDefined();
		expect(result.state.clients).toEqual([]);
		expect(result.state.workspaces).toEqual([]);
		// The bad file was quarantined, and state.json now holds valid, reparseable state.
		expect(existsSync(result.recoveredFromCorruptStatePath as string)).toBe(true);
		expect(() => parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")))).not.toThrow();
		await store.close();
	});
});
