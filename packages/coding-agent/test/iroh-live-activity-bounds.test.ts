import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import {
	createEmptyIrohRemoteHostState,
	type IrohRemoteClient,
	type IrohRemoteLiveActivityRegistration,
	MAX_IROH_REMOTE_LIVE_ACTIVITIES_PER_CLIENT,
	parseIrohRemoteLiveActivityRegistration,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { createEmptyVoltdState, VoltdStateStore } from "../src/daemon/state.ts";

const temporaryDirectories: string[] = [];
const TOKEN_HASH = "a".repeat(64);

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function createRegistration(
	index: number,
	overrides: Partial<IrohRemoteLiveActivityRegistration> = {},
): IrohRemoteLiveActivityRegistration {
	return {
		workspaceName: "volt-app",
		sessionId: `session-${index}`,
		activityId: `activity-${index}`,
		tokenHash: TOKEN_HASH,
		tokenEnvironment: "production",
		platform: "ios",
		pushTargetId: "relay-target",
		createdAt: index,
		updatedAt: index,
		...overrides,
	};
}

function createClient(liveActivities: IrohRemoteLiveActivityRegistration[] = []): IrohRemoteClient {
	return {
		nodeId: "paired-client",
		label: "phone",
		allowedWorkspaces: ["volt-app"],
		allowedTools: "read",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		pairedAt: 1,
		lastSeenAt: 2,
		...(liveActivities.length === 0 ? {} : { liveActivities }),
	};
}

function createStateManager(liveActivities: IrohRemoteLiveActivityRegistration[] = []): IrohRemoteHostStateManager {
	return new IrohRemoteHostStateManager({
		initialState: {
			...createEmptyIrohRemoteHostState(),
			clients: [createClient(liveActivities)],
		},
	});
}

describe("Iroh Live Activity registration bounds", () => {
	test("replaces the single registration for a workspace/session", async () => {
		const manager = createStateManager([createRegistration(1, { createdAt: 10, updatedAt: 10 })]);

		const result = await manager.registerClientLiveActivity(
			"paired-client",
			createRegistration(1, { activityId: "replacement", createdAt: 20, updatedAt: 20 }),
		);

		expect(result.replacedRegistration?.activityId).toBe("activity-1");
		expect(result.registration).toMatchObject({ activityId: "replacement", createdAt: 10, updatedAt: 20 });
		await expect(manager.getClient("paired-client")).resolves.toMatchObject({
			liveActivities: [{ sessionId: "session-1", activityId: "replacement" }],
		});
	});

	test("deterministically evicts the oldest registration above 32 per client", async () => {
		const manager = createStateManager([createRegistration(0)]);
		for (let index = 1; index <= MAX_IROH_REMOTE_LIVE_ACTIVITIES_PER_CLIENT; index++) {
			await manager.registerClientLiveActivity("paired-client", createRegistration(index));
		}

		const client = await manager.getClient("paired-client");
		expect(client?.liveActivities).toHaveLength(MAX_IROH_REMOTE_LIVE_ACTIVITIES_PER_CLIENT);
		expect(client?.liveActivities?.map((registration) => registration.sessionId)).toEqual(
			Array.from({ length: MAX_IROH_REMOTE_LIVE_ACTIVITIES_PER_CLIENT }, (_, index) => `session-${index + 1}`),
		);
	});

	test("prunes duplicate and excess legacy registrations during daemon-state startup and persistence", async () => {
		const directory = await mkdtemp(join(tmpdir(), "volt-live-activity-bounds-"));
		temporaryDirectories.push(directory);
		const statePath = join(directory, "state.json");
		const state = createEmptyVoltdState();
		state.clients = [
			createClient([
				...Array.from({ length: 35 }, (_, index) => createRegistration(index)),
				createRegistration(34, { activityId: "replacement", updatedAt: 100 }),
			]),
		];
		await writeFile(statePath, `${JSON.stringify(state)}\n`);

		const store = new VoltdStateStore({ agentDir: directory, statePath, debounceMs: 1 });
		const loaded = await store.load();
		expect(loaded.state.clients[0].liveActivities).toHaveLength(MAX_IROH_REMOTE_LIVE_ACTIVITIES_PER_CLIENT);
		expect(loaded.state.clients[0].liveActivities?.[0].sessionId).toBe("session-3");
		expect(loaded.state.clients[0].liveActivities?.at(-1)).toMatchObject({
			sessionId: "session-34",
			activityId: "replacement",
		});

		await store.flush();
		const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
			clients: Array<{ liveActivities?: IrohRemoteLiveActivityRegistration[] }>;
		};
		expect(persisted.clients[0].liveActivities).toEqual(loaded.state.clients[0].liveActivities);
	});

	test("rejects oversized or malformed registration fields", () => {
		expect(() =>
			parseIrohRemoteLiveActivityRegistration(createRegistration(1, { activityId: "a".repeat(513) })),
		).toThrow("live activity activityId must be at most 512 UTF-8 bytes");
		expect(() => parseIrohRemoteLiveActivityRegistration(createRegistration(1, { tokenHash: "not-a-hash" }))).toThrow(
			"live activity tokenHash must be a lowercase SHA-256 hex digest",
		);
	});
});
