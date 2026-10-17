import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { createEmptyIrohRemoteHostState, type IrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import {
	createEmptyVoltdState,
	findRecoverableVoltdStateBackup,
	inspectVoltdStateFiles,
	parseVoltdState,
	recoverVoltdStateFromBackup,
	regenerateInvalidVoltdState,
	VoltdStateStore,
} from "../src/daemon/state.ts";

const SECRET_KEY_BYTES = Array.from({ length: 32 }, (_, index) => index + 1);

function createGrantedHostState(): IrohRemoteHostState {
	const rpcGrant = createIrohRemotePresetAccess("coding").rpcGrant;
	return {
		...createEmptyIrohRemoteHostState(),
		hostSecretKey: [...SECRET_KEY_BYTES],
		workspaceGenerationCounter: 7,
		workspaceGenerations: [{ workspaceName: "volt", generation: 7 }],
		workspaces: [{ name: "volt", path: "/tmp/volt", allowedTools: undefined }],
		clients: [
			{
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["volt"],
				allowedTools: "read,bash",
				rpcGrant,
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
				rpcGrant,
				pairedAt: 1,
				lastSeenAt: 2,
				revokedAt: 3,
			},
		],
		pendingPairingTickets: [
			{
				secretHash: "pre-grant-ticket",
				workspace: "volt",
				allowedTools: "read",
				rpcGrant,
				expiresAt: 3000,
				createdAt: 2000,
			},
		],
	};
}

function withoutGrant<T extends { rpcGrant: unknown }>({ rpcGrant: _rpcGrant, ...entry }: T): Omit<T, "rpcGrant"> {
	return entry;
}

/** The granted state as it was written before RPC grants existed: no access record carries one. */
function createPreGrantState() {
	const state = createGrantedHostState();
	return {
		...state,
		clients: state.clients.map(withoutGrant),
		revokedClients: state.revokedClients.map(withoutGrant),
		pendingPairingTickets: state.pendingPairingTickets.map(withoutGrant),
	};
}

describe("voltd state", () => {
	let agentDir: string;
	let statePath: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-state-"));
		statePath = getDaemonPaths(agentDir).statePath;
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("round-trips through parseVoltdState including settings", async () => {
		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await store.load();
		store.updateSettings({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.settings).toEqual({ detachedRuntimeTtlMs: 60_000, allowTools: ["read", "grep"] });
	});

	it("round-trips managed relay authority and rejects malformed persisted credentials", async () => {
		const managedCredential = {
			schemaVersion: 2 as const,
			serviceUrl: "http://127.0.0.1:8085",
			relayUrls: ["https://iroh-relay-us-central-canary.volt-cli.dev"],
			endpointNodeId: "a".repeat(64),
			endpointId: "abcdefghijklmnopqrstuvwx",
			grantId: "zyxwvutsrqponmlkjihgfedc",
			accessToken: "aaaaaa.bbbbbb.cccccc",
			accessTokenExpiresAt: Date.now() + 15 * 60_000,
			refreshToken: `vrr_${"d".repeat(43)}`,
		};
		const managedClaim = {
			schemaVersion: 1 as const,
			serviceUrl: managedCredential.serviceUrl,
			relayUrls: managedCredential.relayUrls,
			hostNodeId: managedCredential.endpointNodeId,
			claimSecret: `vpc_${"c".repeat(43)}`,
			claimId: "abcdefghijklmnopqrstuvwx",
			expiresAt: Date.now() + 10 * 60_000,
		};
		const state = createEmptyVoltdState();
		const appEndpoint = {
			schemaVersion: 1 as const,
			claimId: managedClaim.claimId,
			nodeId: "b".repeat(64),
			endpointId: "appendpointabcdefghijklm",
			revocationPending: false,
		};
		state.settings.relayCredential = managedCredential;
		state.settings.relayCredentialClaim = managedClaim;
		state.settings.relayCredentialAppEndpoints = [appEndpoint];
		const parsed = parseVoltdState(JSON.parse(JSON.stringify(state))).settings;
		expect(parsed.relayCredential).toEqual(managedCredential);
		expect(parsed.relayCredentialClaim).toEqual(managedClaim);
		expect(parsed.relayCredentialAppEndpoints).toEqual([appEndpoint]);
		state.settings.relayCredential = undefined;
		state.settings.relayCredentialClaim = undefined;
		state.settings.relayCredentialAppEndpoints = undefined;
		state.settings.relayCredentialRevocation = managedCredential;
		expect(parseVoltdState(JSON.parse(JSON.stringify(state))).settings.relayCredentialRevocation).toEqual(
			managedCredential,
		);

		state.settings.relayCredentialRevocation = undefined;
		state.settings.relayCredential = { ...managedCredential, serviceUrl: "http://attacker.example" };
		expect(() => parseVoltdState(JSON.parse(JSON.stringify(state)))).toThrow(/HTTPS origin or the local canary/);
	});

	it("round-trips a valid Iroh bind port across host-state writes and drops invalid ones", async () => {
		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await store.load();
		store.updateSettings({ irohBindPort: 47_000 });
		store.setHostState(createGrantedHostState());
		await store.close();
		expect(parseVoltdState(JSON.parse(readFileSync(statePath, "utf8"))).settings.irohBindPort).toBe(47_000);

		for (const invalid of [0, 70_000, 1.5, "47000"]) {
			const state = JSON.parse(JSON.stringify(createEmptyVoltdState())) as Record<string, unknown> & {
				settings: Record<string, unknown>;
			};
			state.settings.irohBindPort = invalid;
			expect(parseVoltdState(state).settings).not.toHaveProperty("irohBindPort");
		}
	});

	it("setHostState updates the persisted host portion", async () => {
		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await store.load();
		store.setHostState(createGrantedHostState());
		await store.close();
		const parsed = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(parsed.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(parsed.workspaceGenerationCounter).toBe(7);
		expect(parsed.workspaceGenerations).toEqual([{ workspaceName: "volt", generation: 7 }]);
		expect(store.getHostState()).toMatchObject({
			hostSecretKey: SECRET_KEY_BYTES,
			workspaceGenerationCounter: 7,
			workspaceGenerations: [{ workspaceName: "volt", generation: 7 }],
		});
	});

	it("rejects an unparseable state file without modifying it", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const invalidState = "{ this is : not valid json";
		writeFileSync(statePath, invalidState);

		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await expect(store.load()).rejects.toThrow("Confirm regeneration from /remote");
		expect(readFileSync(statePath, "utf8")).toBe(invalidState);
	});

	it("backs up invalid state only after the caller explicitly requests regeneration", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const invalidState = "{ invalid";
		writeFileSync(statePath, invalidState);

		expect(inspectVoltdStateFiles(agentDir)).toMatchObject({ path: statePath });
		expect(readFileSync(statePath, "utf8")).toBe(invalidState);
		const { backupPath } = await regenerateInvalidVoltdState(agentDir);
		expect(existsSync(statePath)).toBe(false);
		expect(readFileSync(backupPath, "utf8")).toBe(invalidState);

		const replacementStore = new VoltdStateStore({ statePath, debounceMs: 1 });
		const replacement = await replacementStore.load();
		expect(replacement).toEqual(createEmptyVoltdState());
		await replacementStore.close();
	});

	it("rejects pre-grant daemon state, and regeneration starts empty state", async () => {
		mkdirSync(join(agentDir, "daemon"), { recursive: true });
		const incompatibleState = JSON.stringify({
			...createEmptyVoltdState(),
			irohSecretKey: SECRET_KEY_BYTES,
			clients: createPreGrantState().clients,
			workspaces: createPreGrantState().workspaces,
		});
		writeFileSync(statePath, incompatibleState);

		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await expect(store.load()).rejects.toThrow("client rpcGrant must be an object");
		expect(readFileSync(statePath, "utf8")).toBe(incompatibleState);

		const { backupPath } = await regenerateInvalidVoltdState(agentDir);
		expect(readFileSync(backupPath, "utf8")).toBe(incompatibleState);
		expect(existsSync(statePath)).toBe(false);
		expect(findRecoverableVoltdStateBackup(agentDir)).toBeUndefined();

		const replacementStore = new VoltdStateStore({ statePath, debounceMs: 1 });
		expect(await replacementStore.load()).toEqual(createEmptyVoltdState());
		await replacementStore.close();
	});

	it("recovers a backup that parses as current state, pairings included", async () => {
		const store = new VoltdStateStore({ statePath, debounceMs: 1 });
		await store.load();
		store.setHostState(createGrantedHostState());
		store.updateSettings({ relayAuthToken: "persisted-relay-token" });
		await store.close();
		const backupPath = `${statePath}.invalid-1`;
		writeFileSync(backupPath, readFileSync(statePath, "utf8"));
		writeFileSync(`${statePath}.invalid-2`, "{ not state");
		writeFileSync(statePath, JSON.stringify(createEmptyVoltdState()));

		expect(findRecoverableVoltdStateBackup(agentDir)).toEqual({ path: backupPath, preservedIdentity: true });
		const recovered = await recoverVoltdStateFromBackup(agentDir, backupPath);
		expect(recovered.preservedIdentity).toBe(true);
		expect(recovered.previousStateBackupPath).toBeDefined();
		const restored = parseVoltdState(JSON.parse(readFileSync(statePath, "utf8")));
		expect(restored.irohSecretKey).toEqual(SECRET_KEY_BYTES);
		expect(restored.clients.map((client) => client.nodeId)).toEqual(["n-phone"]);
		expect(restored.settings.relayAuthToken).toBe("persisted-relay-token");
	});
});
