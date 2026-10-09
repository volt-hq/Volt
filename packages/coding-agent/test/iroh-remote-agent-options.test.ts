/**
 * The `agent_options` query on an `agent_options` workspace discovery stream:
 * the daemon's services answer it for the stream's own workspace, backend
 * failures stay correlated to the query, and the grant must allow model
 * selection.
 */

import { REMOTE_CAPABILITIES, type RemoteCapability } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test } from "vitest";
import type { IrohRemoteAgentOptionsRpcBackend } from "../src/core/remote/iroh/agent-options.ts";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	IrohRemoteAuditLogger,
	type IrohRemoteClientAuthorizationSuccess,
	IrohRemoteHostStateManager,
	serveIrohRemoteConnection,
} from "../src/core/remote/iroh/index.ts";
import { type RemoteIntentHost, remoteIntentServices, remoteStreamAllows } from "../src/daemon/remote-intents.ts";
import { WorkspaceSessions } from "../src/daemon/workspace-sessions.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

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

function backend(): IrohRemoteAgentOptionsRpcBackend {
	return {
		getAgentOptions: async (workspaceName) => ({
			workspaceName,
			models: [],
			defaultConfig: {
				model: { provider: "test", modelId: "model" },
				thinkingLevel: "off",
				fastModeEnabled: false,
				agentMode: "build",
			},
		}),
	};
}

/** The daemon's backends a discovery stream reaches; only agent options are used here. */
function remoteHost(agentOptions: IrohRemoteAgentOptionsRpcBackend, requested: string[]): RemoteIntentHost {
	const unused = (): never => {
		throw new Error("Not used by an agent_options stream");
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
		agentOptions: (granted) => {
			requested.push(granted.workspace.name);
			return agentOptions;
		},
		sessionContexts: unused,
		prReviews: unused,
		unregisterWorkspace: unused,
	};
}

describe("agent_options workspace discovery", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function phone(
		agentOptions: IrohRemoteAgentOptionsRpcBackend,
		capabilities: readonly RemoteCapability[] = REMOTE_CAPABILITIES,
	): Promise<{ device: RemotePhone; requested: string[] }> {
		const requested: string[] = [];
		const scope = { kind: "discovery", purpose: "agent_options" } as const;
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities: [...capabilities] },
			redaction: { workspacePath: authorization.workspace.path, remoteWorkspacePath: "/workspace" },
			services: () => remoteIntentServices(remoteHost(agentOptions, requested), authorization, scope, { keep: {} }),
			...(remoteStreamAllows(scope) === undefined ? {} : { allows: remoteStreamAllows(scope) }),
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		await device.hello();
		return { device, requested };
	}

	test("answers for the stream's own workspace and validates its parameters strictly", async () => {
		const { device, requested } = await phone(backend());
		expect(await device.query("agent_options")).toMatchObject({
			type: "result",
			data: { workspaceName: "volt", defaultConfig: { agentMode: "build" } },
		});
		expect(requested).toEqual(["volt"]);

		for (const params of [{ extra: true }, { workspaceName: "other" }]) {
			expect(await device.query("agent_options", params)).toMatchObject({
				type: "query_error",
				reason: { code: "invalid_input" },
			});
		}
		expect(requested).toEqual(["volt"]);
	});

	test("answers backend failures as correlated query errors", async () => {
		const { device } = await phone({ getAgentOptions: async () => Promise.reject(new Error("failed")) });
		expect(await device.query("agent_options")).toMatchObject({
			type: "query_error",
			reason: { code: "failed", message: "failed" },
		});
	});

	test("requires model selection authority", async () => {
		const { device, requested } = await phone(
			backend(),
			REMOTE_CAPABILITIES.filter((capability) => capability !== "model.select.v1"),
		);
		expect(await device.query("agent_options")).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "model.select.v1" },
		});
		expect(requested).toEqual([]);
	});

	test("serves nothing but agent options", async () => {
		const { device } = await phone(backend());
		expect(await device.query("sessions")).toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
		expect(await device.intent("create_worktree", {})).toMatchObject({
			type: "rejected",
			reason: { code: "unavailable" },
		});
	});
});
