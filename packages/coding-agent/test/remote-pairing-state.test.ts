import { describe, expect, it } from "vitest";
import { hashIrohRemotePairingSecret } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostEngine } from "../src/core/remote/iroh/engine.ts";
import { createEmptyIrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";

describe("remote pairing ticket cancellation", () => {
	it("removes only the cancelled pending ticket", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.addPendingPairingTicket({
			secretHash: "cancelled-hash",
			workspace: "volt",
			allowedTools: "read",
			createdAt: 1,
			expiresAt: 100,
		});
		await manager.addPendingPairingTicket({
			secretHash: "kept-hash",
			workspace: "volt",
			allowedTools: "read",
			createdAt: 2,
			expiresAt: 100,
		});

		await expect(manager.removePendingPairingTicket("cancelled-hash")).resolves.toBe(true);
		await expect(manager.removePendingPairingTicket("missing-hash")).resolves.toBe(false);
		expect((await manager.getState()).pendingPairingTickets).toEqual([
			{
				secretHash: "kept-hash",
				workspace: "volt",
				allowedTools: "read",
				createdAt: 2,
				expiresAt: 100,
			},
		]);
	});

	it("clears the engine's live pairing secret as well as persisted state", async () => {
		const manager = new IrohRemoteHostStateManager({ initialState: createEmptyIrohRemoteHostState() });
		await manager.upsertWorkspace({ name: "volt", path: "/workspace" });
		const engine = new IrohRemoteHostEngine({
			stateManager: manager,
			workspace: { name: "volt", path: "/workspace" },
			now: () => 1,
		});
		const pairing = await engine.pair({
			workspace: "volt",
			irohTicket: "endpoint-ticket",
			secret: "one-time-secret",
			expiresAt: 100,
		});
		const secretHash = hashIrohRemotePairingSecret(pairing.secret);

		await expect(engine.cancelPairingSecretByHash(secretHash)).resolves.toBe(true);
		await expect(engine.cancelPairingSecretByHash(secretHash)).resolves.toBe(false);
		await expect(manager.removePendingPairingTicket(secretHash)).resolves.toBe(false);
		expect((await manager.getState()).pendingPairingTickets).toEqual([]);
	});
});
