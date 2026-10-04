import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteCapability, RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { remoteProfile } from "../src/core/protocol/profiles.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
	IROH_REMOTE_RPC_CAPABILITIES,
	parseIrohRemoteRpcGrant,
} from "../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { DEFAULT_IROH_REMOTE_ALLOW_TOOLS } from "../src/core/remote/iroh/protocol.ts";
import {
	createEmptyIrohRemoteHostState,
	parseIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { admitControlRequest } from "../src/daemon/control-protocol.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import {
	connectRemotePhone,
	type IntentOutcome,
	type QueryOutcome,
	type RemotePhone,
} from "./utilities/remote-phone.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Iroh remote RPC grants", () => {
	it("strictly parses versioned grants and accepts an empty capability set", () => {
		expect(parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 1, capabilities: [] })).toEqual({
			schemaVersion: 1,
			revision: 1,
			capabilities: [],
		});
		expect(() => parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 1, capabilities: ["unknown.v1"] })).toThrow(
			"unknown capability",
		);
		expect(() =>
			parseIrohRemoteRpcGrant({
				schemaVersion: 1,
				revision: 1,
				capabilities: ["conversation.observe.v1", "conversation.observe.v1"],
			}),
		).toThrow("duplicates");
		expect(() => parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: 0, capabilities: [] })).toThrow(
			"greater than or equal to 1",
		);
		expect(() =>
			parseIrohRemoteRpcGrant({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER + 1, capabilities: [] }),
		).toThrow("safe integer");
	});

	it("defines immutable coding, review, chat, and full presets", () => {
		const coding = createIrohRemotePresetAccess("coding");
		const review = createIrohRemotePresetAccess("review");
		const chat = createIrohRemotePresetAccess("chat");
		const full = createIrohRemotePresetAccess("full");
		expect(coding.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(full.allowedTools).toBe(DEFAULT_IROH_REMOTE_ALLOW_TOOLS);
		expect(coding.allowedTools.split(",")).toContain("image_gen");
		expect(full.allowedTools.split(",")).toContain("image_gen");
		expect(review.allowedTools).toBe("read,grep,find,ls");
		expect(chat.allowedTools).toBe("");
		expect(coding.rpcGrant.capabilities).toEqual([
			"conversation.observe.v1",
			"conversation.control.v1",
			"model.select.v1",
			"host.manage.v1",
		]);
		expect(review.rpcGrant.capabilities).toEqual(coding.rpcGrant.capabilities);
		expect(chat.rpcGrant.capabilities).toEqual(coding.rpcGrant.capabilities);
		expect(full.rpcGrant.capabilities).toEqual(IROH_REMOTE_RPC_CAPABILITIES);
	});

	it("requires grants on every persisted active, revoked, and pending record", () => {
		const base = { workspaces: [], worktrees: [], pendingPairingTickets: [], clients: [], revokedClients: [] };
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				clients: [
					{ nodeId: "n", label: "phone", allowedWorkspaces: [], allowedTools: "", pairedAt: 1, lastSeenAt: 1 },
				],
			}),
		).toThrow("client rpcGrant");
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				revokedClients: [
					{
						nodeId: "n",
						label: "phone",
						allowedWorkspaces: [],
						allowedTools: "",
						pairedAt: 1,
						lastSeenAt: 1,
						revokedAt: 2,
					},
				],
			}),
		).toThrow("revoked client rpcGrant");
		expect(() =>
			parseIrohRemoteHostState({
				...base,
				pendingPairingTickets: [{ secretHash: "h", workspace: "ws", allowedTools: "", expiresAt: 2, createdAt: 1 }],
			}),
		).toThrow("pending pairing ticket rpcGrant");
	});

	it("snapshots each pairing ticket's selected grant", async () => {
		const manager = new IrohRemoteHostStateManager();
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "ws", path: "/tmp/ws" },
		});
		const review = createIrohRemotePresetAccess("review");
		const chat = createIrohRemotePresetAccess("chat");
		await engine.pair({
			irohTicket: "endpoint",
			secret: "review-secret",
			allowTools: review.allowedTools,
			rpcGrant: review.rpcGrant,
		});
		await engine.pair({
			irohTicket: "endpoint",
			secret: "chat-secret",
			allowTools: chat.allowedTools,
			rpcGrant: chat.rpcGrant,
		});
		const tickets = (await manager.getState()).pendingPairingTickets ?? [];
		expect(tickets).toHaveLength(2);
		expect(tickets.map((ticket) => ticket.allowedTools)).toEqual(["read,grep,find,ls", ""]);
		expect(tickets.map((ticket) => ticket.rpcGrant?.capabilities)).toEqual([
			review.rpcGrant.capabilities,
			chat.rpcGrant.capabilities,
		]);
	});

	it("atomically persists both access planes and rejects stale revisions", async () => {
		const path = mkdtempSync(join(tmpdir(), "volt-rpc-grant-"));
		temporaryDirectories.push(path);
		const statePath = join(path, "state.json");
		const coding = createIrohRemotePresetAccess("coding");
		await writeIrohRemoteHostState(statePath, {
			workspaces: [],
			clients: [
				{
					nodeId: "n",
					label: "phone",
					allowedWorkspaces: [],
					allowedTools: coding.allowedTools,
					rpcGrant: coding.rpcGrant,
					pairedAt: 1,
					lastSeenAt: 1,
				},
			],
		});
		const manager = new IrohRemoteHostStateManager({ statePath });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "voltd", path },
		});
		const review = createIrohRemotePresetAccess("review", 2);
		const updated = await engine.updateClientAccess("n", 1, review);
		expect(updated).toMatchObject({
			ok: true,
			client: { allowedTools: "read,grep,find,ls", rpcGrant: { revision: 2 } },
		});
		expect(await engine.updateClientAccess("n", 1, createIrohRemotePresetAccess("chat", 2))).toEqual({
			ok: false,
			reason: "revision_conflict",
			currentRevision: 2,
		});
		const reloaded = new IrohRemoteHostStateManager({ statePath });
		expect(await reloaded.getClient("n")).toMatchObject({
			allowedTools: "read,grep,find,ls",
			rpcGrant: { revision: 2, capabilities: review.rpcGrant.capabilities },
		});
	});

	it("fails safely before incrementing an exhausted revision", async () => {
		const full = createIrohRemotePresetAccess("full", Number.MAX_SAFE_INTEGER);
		const manager = new IrohRemoteHostStateManager({
			initialState: {
				workspaces: [],
				clients: [
					{
						nodeId: "n",
						label: "phone",
						allowedWorkspaces: [],
						allowedTools: full.allowedTools,
						rpcGrant: full.rpcGrant,
						pairedAt: 1,
						lastSeenAt: 1,
					},
				],
			},
		});

		await expect(
			manager.updateClientAccess("n", Number.MAX_SAFE_INTEGER, createIrohRemotePresetAccess("chat")),
		).resolves.toEqual({
			ok: false,
			reason: "revision_exhausted",
			currentRevision: Number.MAX_SAFE_INTEGER,
		});
		expect(await manager.getClient("n")).toMatchObject({
			allowedTools: full.allowedTools,
			rpcGrant: { revision: Number.MAX_SAFE_INTEGER, capabilities: full.rpcGrant.capabilities },
		});
		await expect(
			manager.updateClientAccess("n", Number.MAX_SAFE_INTEGER + 1, createIrohRemotePresetAccess("chat")),
		).rejects.toThrow("safe integer");
	});

	it("does not acknowledge ticket creation, pairing consumption, or revocation before durable writes", async () => {
		let persisted = createEmptyIrohRemoteHostState();
		let failNextWrite = false;
		const store = {
			read: () => parseIrohRemoteHostState(structuredClone(persisted)),
			write: async (state: typeof persisted) => {
				if (failNextWrite) {
					failNextWrite = false;
					throw new Error("injected flush failure");
				}
				persisted = parseIrohRemoteHostState(structuredClone(state));
			},
		};
		const createEngine = () =>
			new IrohRemoteHostEngine({
				stateManager: new IrohRemoteHostStateManager({ store }),
				workspace: { name: "ws", path: "/tmp/ws" },
				now: () => 100,
			});
		const pairOptions = { irohTicket: "endpoint", secret: "durable-secret", ttlMs: 1000 };

		failNextWrite = true;
		await expect(createEngine().pair(pairOptions)).rejects.toThrow("injected flush failure");
		expect(persisted.pendingPairingTickets).toEqual([]);

		await createEngine().pair(pairOptions);
		expect(persisted.pendingPairingTickets).toHaveLength(1);
		const hello = {
			type: "volt_iroh_hello" as const,
			protocol: "volt/1" as const,
			workspace: "ws",
			secret: "durable-secret",
			clientLabel: "phone",
			mode: "conversation" as const,
			conversation: { target: "new" as const, sessionId: "new-session" },
		};

		failNextWrite = true;
		await expect(createEngine().authorizeHello(hello, "client-node")).rejects.toThrow("injected flush failure");
		expect(persisted.clients).toEqual([]);
		expect(persisted.pendingPairingTickets).toHaveLength(1);

		const paired = await createEngine().authorizeHello(hello, "client-node");
		expect(paired.ok).toBe(true);
		expect(persisted.clients).toHaveLength(1);
		expect(persisted.pendingPairingTickets).toEqual([]);

		failNextWrite = true;
		await expect(createEngine().revokeClient("client-node")).rejects.toThrow("injected flush failure");
		expect(persisted.clients).toHaveLength(1);
		expect(persisted.revokedClients).toEqual([]);

		await expect(createEngine().revokeClient("client-node")).resolves.toMatchObject({ revoked: true });
		const restarted = new IrohRemoteHostStateManager({ store });
		expect(await restarted.getClient("client-node")).toBeUndefined();
		expect(await restarted.listRevokedClients()).toEqual([
			expect.objectContaining({ nodeId: "client-node", revokedAt: 100 }),
		]);
	});

	it("parses preset and explicit control requests and rejects mixed access", () => {
		expect(admitControlRequest({ type: "pair_request", id: "1", access: "coding" })).toBe(true);
		expect(
			admitControlRequest({
				type: "pair_request",
				id: "2",
				allowedTools: [],
				rpcCapabilities: [],
			}),
		).toBe(true);
		expect(
			admitControlRequest({
				type: "client_access_update",
				id: "3",
				clientNodeId: "n",
				expectedRevision: 1,
				access: "full",
			}),
		).toBe(true);
		expect(
			admitControlRequest({
				type: "pair_request",
				id: "4",
				access: "coding",
				allowedTools: [],
				rpcCapabilities: [],
			}),
		).toBe(false);
		expect(
			admitControlRequest({
				type: "client_access_update",
				id: "unsafe",
				clientNodeId: "n",
				expectedRevision: Number.MAX_SAFE_INTEGER + 1,
				access: "full",
			}),
		).toBe(false);
		expect(createIrohRemoteExplicitAccess([], []).rpcGrant.capabilities).toEqual([]);
	});
});

/** An intent or query and the capabilities its admission requires of a remote grant. */
interface GrantCase {
	readonly kind: "intent" | "query";
	readonly name: string;
	readonly requires: readonly RemoteCapability[];
}

const control = "conversation.control.v1";
const observe = "conversation.observe.v1";

const GRANT_CASES: readonly GrantCase[] = [
	{ kind: "intent", name: "prompt", requires: [control] },
	{ kind: "intent", name: "abort", requires: [control] },
	{ kind: "intent", name: "cancel_job", requires: [control] },
	{ kind: "intent", name: "set_agent_mode", requires: [control] },
	{ kind: "intent", name: "plan_execute", requires: [control] },
	{ kind: "intent", name: "plan_change", requires: [control] },
	{ kind: "intent", name: "plan_discard", requires: [control] },
	{ kind: "intent", name: "new_session", requires: [control] },
	{ kind: "intent", name: "review_acknowledge", requires: [control] },
	{ kind: "intent", name: "review_record_finding_outcome", requires: [control] },
	{ kind: "intent", name: "review_rerun", requires: [control] },
	{ kind: "intent", name: "review_publish", requires: [control] },
	{ kind: "intent", name: "set_model", requires: ["model.select.v1"] },
	{ kind: "intent", name: "set_thinking_level", requires: ["model.select.v1"] },
	{ kind: "intent", name: "set_default_model", requires: ["model.select.v1", "host.manage.v1"] },
	{ kind: "intent", name: "set_default_thinking_level", requires: ["model.select.v1", "host.manage.v1"] },
	{ kind: "intent", name: "set_keep_awake", requires: ["host.manage.v1"] },
	{ kind: "intent", name: "set_web_search_key", requires: ["integrations.manage.v1"] },
	{ kind: "intent", name: "mcp.connect", requires: ["integrations.manage.v1"] },
	{ kind: "intent", name: "create_worktree", requires: ["worktrees.manage.v1"] },
	{ kind: "intent", name: "remove_worktree", requires: ["worktrees.manage.v1"] },
	{ kind: "intent", name: "prepare_pr_review", requires: [control, "worktrees.manage.v1"] },
	{ kind: "intent", name: "unregister_workspace", requires: ["workspace.manage.v1"] },
	{ kind: "intent", name: "upload_device_logs", requires: ["diagnostics.upload.v1"] },
	{ kind: "intent", name: "register_push_target", requires: [] },
	{ kind: "query", name: "history", requires: [observe] },
	{ kind: "query", name: "content", requires: [observe] },
	{ kind: "query", name: "intents", requires: [observe] },
	{ kind: "query", name: "intent_completions", requires: [observe] },
	{ kind: "query", name: "job_output", requires: [observe] },
	{ kind: "query", name: "sessions", requires: [observe] },
	{ kind: "query", name: "worktrees", requires: [observe] },
	{ kind: "query", name: "models", requires: ["model.select.v1"] },
	{ kind: "query", name: "agent_options", requires: ["model.select.v1"] },
	{ kind: "query", name: "subscription_usage", requires: ["host.manage.v1"] },
	{ kind: "query", name: "web_search_status", requires: ["integrations.manage.v1"] },
	{ kind: "query", name: "mcp.servers", requires: ["integrations.manage.v1"] },
];

function grantWithout(...missing: RemoteCapability[]): RemoteGrant {
	return {
		schemaVersion: 1,
		revision: 1,
		capabilities: IROH_REMOTE_RPC_CAPABILITIES.filter((capability) => !missing.includes(capability)),
	};
}

describe("remote grant admission on a paired device's stream", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function phone(
		harness: HostHarness,
		conversation: HostedConversation,
		grant: RemoteGrant,
	): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		await device.hello();
		await device.subscribe(conversation.id);
		return device;
	}

	/** Send a case with input its schema refuses: admission checks the grant first, then the input. */
	function send(device: RemotePhone, entry: GrantCase): Promise<IntentOutcome | QueryOutcome> {
		return entry.kind === "intent"
			? device.intent(entry.name, { unexpectedField: true })
			: device.query(entry.name, { unexpectedField: true });
	}

	it("rejects each intent and query without every capability it requires, naming the missing one", async () => {
		const { harness, conversation } = await setup();
		for (const capability of IROH_REMOTE_RPC_CAPABILITIES) {
			const device = await phone(harness, conversation, grantWithout(capability));
			for (const entry of GRANT_CASES.filter((candidate) => candidate.requires.includes(capability))) {
				const outcome = await send(device, entry);
				const reason = outcome.type === "rejected" || outcome.type === "query_error" ? outcome.reason : undefined;
				expect(reason, `${entry.name} without ${capability}`).toMatchObject({
					code: "not_allowed",
					requiredCapability: capability,
				});
			}
		}
	});

	it("admits each intent and query past the grant when every capability it requires is granted", async () => {
		const { harness, conversation } = await setup();
		const full = await phone(harness, conversation, grantWithout());
		const minimal = new Map<string, RemotePhone>();
		for (const entry of GRANT_CASES) {
			const exact = [...entry.requires].sort().join(",");
			let device = minimal.get(exact);
			if (!device) {
				device = await phone(harness, conversation, {
					schemaVersion: 1,
					revision: 1,
					capabilities: [...new Set<RemoteCapability>([observe, ...entry.requires])],
				});
				minimal.set(exact, device);
			}
			for (const [label, client] of [
				["full", full],
				["minimal", device],
			] as const) {
				const outcome = await send(client, entry);
				const reason = outcome.type === "rejected" || outcome.type === "query_error" ? outcome.reason : undefined;
				expect(reason, `${entry.name} with the ${label} grant`).toMatchObject({ code: "invalid_input" });
			}
		}
	});

	it("keeps local-only intents and queries off the remote profile whatever the grant", async () => {
		const { harness, conversation } = await setup();
		const device = await phone(harness, conversation, createIrohRemotePresetAccess("full").rpcGrant);
		for (const name of ["review_export_feedback", "bash", "set_steering_mode", "mcp.auth_start_browser"]) {
			expect(await device.intent(name, {}), name).toMatchObject({
				type: "rejected",
				reason: { code: "not_allowed", message: `Intent not available over remote host: ${name}` },
			});
		}
		const rejected = await device.intent("review_export_feedback", {});
		expect(rejected.type === "rejected" ? rejected.reason : undefined).not.toHaveProperty("requiredCapability");
		expect(await device.query("subagent_definitions")).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", message: "Query not available over remote host: subagent_definitions" },
		});
		expect(await device.intent("local_only_command", {})).toMatchObject({
			type: "rejected",
			reason: { code: "unknown_intent" },
		});
	});

	it("asks a device only the host requests its grant allows", () => {
		const accepts = ["select", "confirm", "approval", "mcp_auth"] as const;
		const asked = (grant: RemoteGrant) =>
			[...remoteProfile({ grant, redaction: { workspacePath: "/tmp/ws" } }).hostRequests(accepts)].sort();
		expect(asked(createIrohRemotePresetAccess("full").rpcGrant)).toEqual([
			"approval",
			"confirm",
			"mcp_auth",
			"select",
		]);
		// Approvals of host actions need host management; MCP sign-in needs integrations.
		expect(asked(createIrohRemotePresetAccess("coding").rpcGrant)).toEqual(["approval", "confirm", "select"]);
		expect(asked(createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant)).toEqual([]);
	});
});
