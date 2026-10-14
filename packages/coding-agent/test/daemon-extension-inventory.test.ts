/**
 * The daemon's extension inventories: evaluations are shared, kept for a minute as a prediction, bounded in time
 * and number, and answered on an `extensions` workspace discovery stream in their remote view, with the stream's
 * roots (the managed worktrees root among them) redacted.
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
import {
	type RemoteIntentHost,
	remoteIntentServices,
	remoteStreamAllows,
	workspaceStreamRedaction,
} from "../src/daemon/remote-intents.ts";
import type { ExtensionInventoryLaunchRequest } from "../src/daemon/worker-launcher.ts";
import { WorkspaceSessions } from "../src/daemon/workspace-sessions.ts";
import { getWorktreesRoot } from "../src/daemon/worktree-manager.ts";
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

/** 128 engines only a client at the host may start: more than a remote answer may carry, were they all sent. */
const hostOnlyEngines: RpcReviewEngine[] = Array.from({ length: 128 }, (_, index) => ({
	...deskEngine,
	id: `ext:engines/desk-${index}`,
	name: `desk-${index}`,
}));

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

	/** Settle the `index`th launch with a successful evaluation. */
	succeed(index: number, reviewEngines: RpcReviewEngine[] = [phoneEngine, deskEngine]): void {
		const output: ExtensionInventoryProbeOutput = {
			ok: true,
			projectTrusted: true,
			extensions: [summary],
			reviewEngines,
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
			...options,
		});
		return created;
	}

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-daemon-extension-inventory-")));
		root = join(tempDir, "workspace");
		mkdirSync(join(root, ".volt"), { recursive: true });
		settings = join(root, ".volt", "settings.json");
		writeFileSync(settings, "{}");
		launcher = new FakeLauncher();
		clock = 1_000;
		target = { workspaceName: "volt", workspaceGeneration: 1, root, projectTrusted: true };
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("shares one evaluation between concurrent requests and keeps it", async () => {
		const inventories = service();
		const first = inventories.get(target);
		const second = inventories.get(target);
		await settle();
		expect(launcher.launches).toHaveLength(1);
		expect(launcher.launches[0]?.request).toMatchObject({ root, projectTrusted: true });
		launcher.succeed(0);
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

	test("answers with a kept evaluation for a minute, whatever changed meanwhile, then evaluates again", async () => {
		const inventories = service();
		const first = inventories.get(target);
		await settle();
		launcher.succeed(0);
		const kept = await first;

		// A prediction: what changed is not tracked, so the kept answer stands until it is a minute old.
		writeFileSync(settings, JSON.stringify({ extensions: { engines: { enabled: false } } }));
		mkdirSync(join(root, ".volt", "extensions"));
		clock += 59_999;
		expect(await inventories.get(target)).toBe(kept);
		expect(launcher.launches).toHaveLength(1);

		clock += 1;
		pending(inventories.get(target));
		await settle();
		expect(launcher.launches).toHaveLength(2);
		inventories.dispose();
	});

	test("accepts every engine an evaluation lists, however many are host-only", async () => {
		const inventories = service();
		const evaluated = inventories.get(target);
		await settle();
		launcher.succeed(0, [...hostOnlyEngines, phoneEngine]);
		expect((await evaluated).reviewEngines).toHaveLength(129);
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
		launcher.succeed(0);
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
		launcher.succeed(0);
		await first;
		await settle();
		expect(launcher.launches).toHaveLength(2);
		expect(launcher.launches[1]?.request.root).toBe(other);
		launcher.succeed(1);
		await second;
		inventories.dispose();
	});

	test("keeps at most its limit of evaluations, dropping the least recently used", async () => {
		const inventories = service({ maxEntries: 1 });
		const other = join(tempDir, "other");
		mkdirSync(other);
		const first = inventories.get(target);
		await settle();
		launcher.succeed(0);
		await first;
		const second = inventories.get({ ...target, root: other });
		await settle();
		launcher.succeed(1);
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

const AGENT_DIR = "/tmp/volt-agent";

/** The daemon's backends an `extensions` stream reaches; only the inventory is used. */
function remoteHost(extensionInventory: InventoryOf | undefined): RemoteIntentHost {
	const unused = (): never => {
		throw new Error("Not used by an extensions stream");
	};
	return {
		agentDir: AGENT_DIR,
		workspaceSessions: new WorkspaceSessions({
			agentDir: AGENT_DIR,
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
			// What the daemon serves an `extensions` stream with.
			redaction: workspaceStreamRedaction(scope.purpose, authorization.workspace.path, AGENT_DIR),
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

	test("lists only the engines a paired device may start, however many host-only ones there are", async () => {
		const device = await phone(async () => ({ ...inventory, reviewEngines: [...hostOnlyEngines, phoneEngine] }));
		const answer = await device.query("extension_inventory");
		expect(answer).toMatchObject({ type: "result" });
		const engines = (answer as { data: { reviewEngines: RpcReviewEngine[] } }).data.reviewEngines;
		expect(engines.map((engine) => engine.id)).toEqual(["ext:engines/phone"]);
	});

	test("redacts a worktree checkout's path from an extension's load error", async () => {
		const checkout = join(getWorktreesRoot(AGENT_DIR), "volt-1234", "fix-login");
		const broken: ExtensionSummary = {
			...summary,
			id: "broken",
			state: "failed",
			error: `Extension does not export a valid factory function: ${checkout}/.volt/extensions/broken.ts`,
		};
		const device = await phone(async () => ({ ...inventory, extensions: [broken] }));
		const answer = await device.query("extension_inventory", { worktreeId: "fix-login" });
		expect(answer).toMatchObject({ type: "result" });
		const text = JSON.stringify(answer);
		expect(text).not.toContain(getWorktreesRoot(AGENT_DIR));
		expect(text).not.toContain(AGENT_DIR);
		expect(text).toContain("Extension does not export a valid factory function: /workspace");
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
