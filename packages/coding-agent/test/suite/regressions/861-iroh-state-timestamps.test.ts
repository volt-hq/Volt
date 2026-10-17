import { describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { parseIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";

const RPC_GRANT = createIrohRemotePresetAccess("coding").rpcGrant;

const STATE = {
	pairingSecretTombstones: [],
	pendingPairingTickets: [],
	workspaceGenerationCounter: 1,
	workspaceGenerations: [{ workspaceName: "volt", generation: 1 }],
	workspaces: [{ name: "volt", path: "/workspace" }],
	worktrees: [
		{
			id: "fix-login",
			workspaceName: "volt",
			path: "/workspace/.worktrees/fix-login",
			branch: "volt/fix-login",
			createdAt: 5,
			sessionIds: ["session-one"],
		},
	],
	clients: [
		{
			nodeId: "client-node",
			label: "phone",
			allowedWorkspaces: ["volt"],
			rpcGrant: RPC_GRANT,
			pairedAt: 10,
			lastSeenAt: 20,
		},
	],
	revokedClients: [
		{
			nodeId: "revoked-node",
			label: "revoked phone",
			allowedWorkspaces: ["volt"],
			rpcGrant: RPC_GRANT,
			pairedAt: 11,
			lastSeenAt: 21,
			revokedAt: 31,
			rePairApprovedAt: 41,
		},
	],
};

const TIMESTAMP_FIELDS = [
	["worktrees", "createdAt", "worktree createdAt"],
	["clients", "pairedAt", "client pairedAt"],
	["clients", "lastSeenAt", "client lastSeenAt"],
	["revokedClients", "pairedAt", "revoked client pairedAt"],
	["revokedClients", "lastSeenAt", "revoked client lastSeenAt"],
	["revokedClients", "revokedAt", "revoked client revokedAt"],
	["revokedClients", "rePairApprovedAt", "revoked client rePairApprovedAt"],
] as const;

describe("#861 Iroh remote state timestamps", () => {
	it("loads non-negative safe integer pairing and worktree timestamps", () => {
		for (const [collection, field] of TIMESTAMP_FIELDS) {
			for (const value of [0, Number.MAX_SAFE_INTEGER]) {
				const parsed = parseIrohRemoteHostState({
					...STATE,
					[collection]: [{ ...STATE[collection][0], [field]: value }],
				});
				expect(parsed[collection]?.[0]).toHaveProperty(field, value);
			}
		}
	});

	it.each(
		TIMESTAMP_FIELDS.flatMap(([collection, field, label]) =>
			[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ collection, field, label, value })),
		),
	)("rejects $label = $value", ({ collection, field, label, value }) => {
		expect(() =>
			parseIrohRemoteHostState({
				...STATE,
				[collection]: [{ ...STATE[collection][0], [field]: value }],
			}),
		).toThrow(`${label} must be a non-negative safe integer`);
	});
});
