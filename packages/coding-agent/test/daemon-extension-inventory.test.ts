/**
 * The daemon's extension inventories: evaluations are shared, kept while nothing they read changed, bounded in
 * time and number, and answered on an `extensions` workspace discovery stream in their remote view.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionSummary, RemoteCapability, RpcReviewEngine } from "@hansjm10/volt-protocol";
import { REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ExtensionInventory } from "../src/core/extensions/inventory.ts";
import { WorkspaceIntentError } from "../src/core/protocol/intents/types.ts";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	IrohRemoteAuditLogger,
	type IrohRemoteClientAuthorizationSuccess,
	IrohRemoteHostStateManager,
	serveIrohRemoteConnection,
} from "../src/core/remote/iroh/index.ts";
import {
	ExtensionInventoryError,
	type ExtensionInventoryProbeOutput,
	ExtensionInventoryService,
	type ExtensionInventoryServiceOptions,
	type ExtensionInventoryTarget,
} from "../src/daemon/extension-inventory.ts";
import { type RemoteIntentHost, remoteIntentServices, remoteStreamAllows } from "../src/daemon/remote-intents.ts";
import type { ExtensionInventoryLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { WorkspaceSessions } from "../src/daemon/workspace-sessions.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const summary: ExtensionSummary = {
	id: "engines",
	displayName: "Engines",
	version: "local",
	scope: "project",
	enabled: true,
	state: "active",
	permissions: [],
	permissionsAcknowledged: true,
	hasSettings: false,
	fingerprint: "local:0123",
};

const { fingerprint: _fingerprint, ...remoteSummary } = summary;

const phoneEngine: RpcReviewEngine = {
	id: "ext:engines/phone",
	name: "phone",
	extension: "engines",
	label: "Phone",
	description: "A paired device may start it.",
	targets: ["pr"],
	remoteSafe: true,
	parameters: { type: "object", properties: { passes: { type: "integer" }, exec: { type: "boolean" } } },
	localOnly: ["exec"],
};

const deskEngine: RpcReviewEngine = {
	id: "ext:engines/desk",
	name: "desk",
	extension: "engines",
	label: "Desk",
	description: "Only at the host.",
	targets: ["uncommitted"],
	remoteSafe: false,
};

/** A launcher whose evaluations the test settles. */
class FakeLauncher {
	readonly launches: Array<{
		request: ExtensionInventoryLaunchRequest;
		resolve: (output: unknown) => void;
		reject: (error: Error) => void;
		killed: boolean;
	}> = [];

	readonly launch: ExtensionInventoryServiceOptions["launch"] = (request) => {
		const settled = Promise.withResolvers<unknown>();
		const launch = { request, resolve: settled.resolve, reject: settled.reject, killed: false };
		this.launches.push(launch);
		return {
			result: settled.promise,
			kill: () => {
				launch.killed = true;
				settled.reject(new Error("killed"));
			},
		};
	};

	/** Settle the `index`th launch with a successful evaluation reading `inputs`. */
	succeed(index: number, inputs: string[], cacheable = true): void {
		const output: ExtensionInventoryProbeOutput = {
			ok: true,
			projectTrusted: true,
			extensions: [summary],
			reviewEngines: [phoneEngine, deskEngine],
			inputs,
			cacheable,
		};
		this.launches[index]?.resolve(output);
	}
}

/** A request the test does not wait for; its failure (the service disposed) is expected. */
function pending(request: Promise<unknown>): void {
	request.catch(() => undefined);
}

/** Let queued promise callbacks run. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

/** Let the clock move past the files' change times, so an evaluation starting now sees them settled. */
async function pastChanges(ms = 20): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ExtensionInventoryService", () => {
	let tempDir: string;
	let root: string;
	let settings: string;
	let launcher: FakeLauncher;
	let clock: number;
	let target: ExtensionInventoryTarget;

	function service(options: Partial<ExtensionInventoryServiceOptions> = {}): ExtensionInventoryService {
		const created = new ExtensionInventoryService({
			agentDir: join(tempDir, "agent"),
			launch: launcher.launch,
			now: () => clock,
			// A change made before an evaluation is settled at once, unless a test says otherwise.
			settleMs: 0,
			...options,
		});
		return created;
	}

	beforeEach(async () => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-daemon-extension-inventory-")));
		root = join(tempDir, "workspace");
		mkdirSync(join(root, ".volt"), { recursive: true });
		settings = join(root, ".volt", "settings.json");
		writeFileSync(settings, "{}");
		launcher = new FakeLauncher();
		clock = 1_000;
		target = { workspaceName: "volt", workspaceGeneration: 1, root, projectTrusted: true };
		await pastChanges();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("shares one evaluation between concurrent requests and keeps it while nothing it read changed", async () => {
		const inventories = service();
		const first = inventories.get(target);
		const second = inventories.get(target);
		await settle();
		expect(launcher.launches).toHaveLength(1);
		expect(launcher.launches[0]?.request).toMatchObject({ root, projectTrusted: true });
		launcher.succeed(0, [settings, join(root, ".volt", "extensions")]);
		const [one, two] = await Promise.all([first, second]);
		expect(one).toEqual(two);
		expect(one.reviewEngines.map((engine) => engine.id)).toEqual(["ext:engines/phone", "ext:engines/desk"]);

		expect(await inventories.get(target)).toEqual(one);
		expect(launcher.launches).toHaveLength(1);

		// Another trust decision, profile, or workspace generation is another evaluation.
		pending(inventories.get({ ...target, projectTrusted: false }));
		pending(inventories.get({ ...target, workspaceGeneration: 2 }));
		await settle();
		expect(launcher.launches).toHaveLength(3);
		inventories.dispose();
	});

	test("evaluates again once an input changes, appears, or the kept evaluation is too old", async () => {
		const inventories = service({ maxAgeMs: 60_000 });
		const extensions = join(root, ".volt", "extensions");
		const first = inventories.get(target);
		await settle();
		launcher.succeed(0, [settings, extensions]);
		await first;

		writeFileSync(settings, JSON.stringify({ extensions: { engines: { enabled: false } } }));
		await pastChanges();
		const edited = inventories.get(target);
		await settle();
		expect(launcher.launches).toHaveLength(2);
		launcher.succeed(1, [settings, extensions]);
		await edited;

		// The project's extension directory did not exist: adding it is a change.
		mkdirSync(extensions);
		await pastChanges();
		const added = inventories.get(target);
		await settle();
		expect(launcher.launches).toHaveLength(3);
		launcher.succeed(2, [settings, extensions]);
		await added;

		expect(await inventories.get(target)).toBeDefined();
		expect(launcher.launches).toHaveLength(3);
		clock += 60_000;
		pending(inventories.get(target));
		await settle();
		expect(launcher.launches).toHaveLength(4);
		inventories.dispose();
	});

	test("does not keep an evaluation that left out a package", async () => {
		const inventories = service();
		const skipped = inventories.get(target);
		await settle();
		launcher.succeed(0, [settings], false);
		await skipped;
		pending(inventories.get(target));
		await settle();
		expect(launcher.launches).toHaveLength(2);
		inventories.dispose();
	});

	test("does not keep an evaluation an input changed during, even when file times lag the clock", async () => {
		const inventories = service({ settleMs: 300 });
		await pastChanges(400);
		const settled = inventories.get(target);
		await settle();
		launcher.succeed(0, [settings]);
		await settled;
		await inventories.get(target);
		expect(launcher.launches).toHaveLength(1);

		const untrusted = { ...target, projectTrusted: false };
		const during = inventories.get(untrusted);
		await settle();
		writeFileSync(settings, '{"changed":true}');
		launcher.succeed(1, [settings]);
		await during;
		pending(inventories.get(untrusted));
		await settle();
		expect(launcher.launches).toHaveLength(3);
		inventories.dispose();
	});

	test("a caller that leaves stops waiting, and the evaluation it shared still answers and is kept", async () => {
		const inventories = service();
		const leaving = new AbortController();
		const left = inventories.get(target, leaving.signal);
		const staying = inventories.get(target);
		await settle();
		leaving.abort(new Error("stream closed"));
		await expect(left).rejects.toThrow("stream closed");
		expect(launcher.launches[0]?.killed).toBe(false);
		launcher.succeed(0, [settings]);
		expect((await staying).extensions).toEqual([summary]);
		await inventories.get(target);
		expect(launcher.launches).toHaveLength(1);
		inventories.dispose();
	});

	test("kills an evaluation that runs too long, and fails one that wrote an invalid or failed result", async () => {
		const inventories = service({ timeoutMs: 30 });
		await expect(inventories.get(target)).rejects.toThrow(/longer than 30 ms/);
		expect(launcher.launches[0]?.killed).toBe(true);

		const invalid = inventories.get(target);
		await settle();
		launcher.launches[1]?.resolve({ ok: true, extensions: [] });
		await expect(invalid).rejects.toThrow(ExtensionInventoryError);

		const failed = inventories.get(target);
		await settle();
		launcher.launches[2]?.resolve({ ok: false, error: "Failed to load settings" });
		await expect(failed).rejects.toThrow("Failed to load settings");

		await expect(inventories.get({ ...target, root: join(tempDir, "missing") })).rejects.toThrow(/unavailable/);
		inventories.dispose();
	});

	test("runs at most its limit of evaluations at once, the rest in turn", async () => {
		const inventories = service({ maxConcurrent: 1 });
		const other = join(tempDir, "other");
		mkdirSync(other);
		const first = inventories.get(target);
		const second = inventories.get({ ...target, workspaceName: "other", root: other });
		await settle();
		expect(launcher.launches).toHaveLength(1);
		launcher.succeed(0, [settings]);
		await first;
		await settle();
		expect(launcher.launches).toHaveLength(2);
		expect(launcher.launches[1]?.request.root).toBe(other);
		launcher.succeed(1, [settings]);
		await second;
		inventories.dispose();
	});

	test("keeps at most its limit of evaluations, dropping the least recently used", async () => {
		const inventories = service({ maxEntries: 1 });
		const other = join(tempDir, "other");
		mkdirSync(other);
		const first = inventories.get(target);
		await settle();
		launcher.succeed(0, [settings]);
		await first;
		const second = inventories.get({ ...target, root: other });
		await settle();
		launcher.succeed(1, [settings]);
		await second;
		pending(inventories.get(target));
		await settle();
		expect(launcher.launches).toHaveLength(3);
		inventories.dispose();
	});

	test("disposing kills running evaluations, fails waiting ones, and answers nothing more", async () => {
		const inventories = service({ maxConcurrent: 1 });
		const other = join(tempDir, "other");
		mkdirSync(other);
		const running = inventories.get(target);
		const waiting = inventories.get({ ...target, root: other });
		await settle();
		inventories.dispose();
		await expect(running).rejects.toThrow();
		await expect(waiting).rejects.toThrow(/shutting down/);
		expect(launcher.launches[0]?.killed).toBe(true);
		expect(launcher.launches).toHaveLength(1);
		await expect(inventories.get(target)).rejects.toThrow(/shutting down/);
	});
});

const authorization: IrohRemoteClientAuthorizationSuccess = {
	ok: true,
	allowTools: "read",
	client: {
		nodeId: "n-phone",
		label: "phone",
		allowedWorkspaces: ["volt"],
		allowedTools: "read",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		pairedAt: 1,
		lastSeenAt: 2,
	},
	paired: false,
	pairingSecretConsumed: false,
	workspace: { name: "volt", path: "/tmp/volt" },
	workspaceNames: ["volt"],
	workspaces: [{ name: "volt", status: "available" }],
};

type InventoryOf = NonNullable<RemoteIntentHost["extensionInventory"]>;

/** The daemon's backends an `extensions` stream reaches; only the inventory is used. */
function remoteHost(extensionInventory: InventoryOf | undefined): RemoteIntentHost {
	const unused = (): never => {
		throw new Error("Not used by an extensions stream");
	};
	return {
		agentDir: "/tmp/volt-agent",
		workspaceSessions: new WorkspaceSessions({
			agentDir: "/tmp/volt-agent",
			workspaces: () => [],
			worktrees: async () => [],
		}),
		auditLogger: new IrohRemoteAuditLogger(),
		stateManager: new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() }),
		pushTargets: unused,
		worktrees: unused,
		agentOptions: unused,
		sessionContexts: unused,
		prReviews: unused,
		...(extensionInventory === undefined ? {} : { extensionInventory }),
		unregisterWorkspace: unused,
	};
}

describe("extension_inventory on an extensions workspace discovery stream", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function phone(
		extensionInventory: InventoryOf | undefined,
		capabilities: readonly RemoteCapability[] = REMOTE_CAPABILITIES,
	): Promise<RemotePhone> {
		const scope = { kind: "discovery", purpose: "extensions" } as const;
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...capabilities] },
			redaction: { workspacePath: authorization.workspace.path, remoteWorkspacePath: "/workspace" },
			services: () => remoteIntentServices(remoteHost(extensionInventory), authorization, scope, { keep: {} }),
			...(remoteStreamAllows(scope) === undefined ? {} : { allows: remoteStreamAllows(scope) }),
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		await device.hello();
		return device;
	}

	const inventory: ExtensionInventory = {
		projectTrusted: true,
		extensions: [summary],
		reviewEngines: [phoneEngine, deskEngine],
	};

	test("answers the remote view for the stream's workspace or worktree, echoing which", async () => {
		const requested: Array<string | undefined> = [];
		const device = await phone(async (granted, worktreeId) => {
			expect(granted.workspace.name).toBe("volt");
			requested.push(worktreeId);
			return inventory;
		});
		const root = await device.query("extension_inventory");
		expect(root).toMatchObject({ type: "result" });
		const data = (root as { data: Record<string, unknown> }).data;
		expect(data).toEqual({
			workspaceName: "volt",
			projectTrusted: true,
			extensions: [remoteSummary],
			reviewEngines: [
				{
					id: "ext:engines/phone",
					name: "phone",
					extension: "engines",
					label: "Phone",
					description: "A paired device may start it.",
					targets: ["pr"],
					remoteSafe: true,
					parameters: { type: "object", properties: { passes: { type: "integer" } } },
				},
			],
		});
		expect(JSON.stringify(data)).not.toMatch(/fingerprint|exec|desk/);

		expect(await device.query("extension_inventory", { worktreeId: "fix-login" })).toMatchObject({
			type: "result",
			data: { workspaceName: "volt", worktreeId: "fix-login" },
		});
		expect(requested).toEqual([undefined, "fix-login"]);
		expect(await device.query("extension_inventory", { worktreeId: "../escape" })).toMatchObject({
			type: "query_error",
			reason: { code: "invalid_input" },
		});
		expect(requested).toHaveLength(2);
	});

	test("reports an unknown worktree, and any other failure, by a stable code", async () => {
		const unknown = await phone(async () => {
			throw new WorkspaceIntentError("worktree_not_found");
		});
		expect(await unknown.query("extension_inventory", { worktreeId: "gone" })).toMatchObject({
			type: "query_error",
			reason: { code: "failed", message: "worktree_not_found" },
		});
		const broken = await phone(async () => {
			throw new Error("/Users/someone/project: evaluation crashed");
		});
		expect(await broken.query("extension_inventory")).toMatchObject({
			type: "query_error",
			reason: { code: "failed", message: "extension_inventory_failed" },
		});
	});

	test("is unavailable on a daemon that evaluates no inventories, and needs conversation observation", async () => {
		const none = await phone(undefined);
		expect(await none.query("extension_inventory")).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
		const blind = await phone(
			async () => inventory,
			REMOTE_CAPABILITIES.filter((capability) => capability !== "conversation.observe.v1"),
		);
		expect(await blind.query("extension_inventory")).toMatchObject({ type: "query_error" });
	});
});
