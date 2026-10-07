/**
 * A daemon whose Iroh binding does not load (an `--omit=optional` install,
 * darwin x64, or a standalone binary): it serves its control plane, its
 * TUIs, and conversation workers as a daemon with phone transport
 * does, reports that transport unavailable, refuses pairing with the
 * guidance its status shows, and still revokes paired devices.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { REMOTE_TRANSPORT_REASON_MESSAGES } from "../src/daemon/control-protocol.ts";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** What loading the binding reports when npm omitted the optional platform package. */
function missingBinding() {
	return {
		packageVersion: "1.1.1-volt.2",
		error: Object.assign(new Error("Cannot find module '@hansjm10/volt-iroh-linux-x64-gnu'"), {
			code: "MODULE_NOT_FOUND",
		}),
	};
}

async function startHarness(): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({
		extensions: [createIrohDaemonService({ relayMode: "disabled" }, { loadIrohModule: missingBinding })],
	});
	cleanups.push(() => harness.dispose());
	return harness;
}

const UNAVAILABLE = {
	state: "unavailable",
	reasonCode: "native_binding_missing",
	message: REMOTE_TRANSPORT_REASON_MESSAGES.native_binding_missing,
	wrapperVersion: "1.1.1-volt.2",
};

describe("a daemon without the Iroh binding", () => {
	it("reports phone transport unavailable and refuses pairing with the same guidance", async () => {
		const harness = await startHarness();
		expect((await harness.status()).remoteTransport).toEqual(UNAVAILABLE);
		for (const request of [{ type: "pair_request", access: "coding" }, { type: "relay_credential_check" }] as const) {
			expect(await harness.control.request(request)).toMatchObject({
				type: "error",
				code: "iroh_unavailable",
				message: UNAVAILABLE.message,
			});
		}
	});

	it("runs conversation workers and serves TUIs", async () => {
		const harness = await startHarness();
		const hosted = await harness.createSession();
		const { release } = await harness.openWorker(hosted, { attach: "local" });
		expect((await harness.status()).workers).toMatchObject([{ state: "live", sessionIds: [hosted.sessionId] }]);
		release();

		const tui = await harness.connect("tui");
		expect(await tui.request({ type: "worktree_list", workspaceName: harness.workspaceName })).toMatchObject({
			type: "worktrees_result",
			worktrees: [],
		});
	});

	it("retires a workspace's workers when the workspace is unregistered", async () => {
		const harness = await startHarness();
		await harness.openWorker(await harness.createSession());
		expect((await harness.status()).workers).toHaveLength(1);

		expect(await harness.control.request({ type: "workspace_unregister", name: harness.workspaceName })).toEqual(
			expect.objectContaining({ type: "ok" }),
		);
		expect((await harness.status()).workers).toEqual([]);
	});

	it("revokes a paired device", async () => {
		const harness = await startHarness();
		const clientNodeId = "a".repeat(64);
		const host = harness.services.state.getHostState();
		harness.services.state.setHostState({
			...host,
			clients: [
				...host.clients,
				{
					nodeId: clientNodeId,
					label: "phone",
					allowedWorkspaces: [],
					rpcGrant: createIrohRemotePresetAccess("coding").rpcGrant,
					pairedAt: 1,
					lastSeenAt: 1,
				},
			],
		});

		expect(await harness.control.request({ type: "client_revoke", clientNodeId })).toMatchObject({ type: "ok" });
		const status = await harness.status();
		expect(status.clients).toEqual([]);
		expect(status.revokedClients).toMatchObject([{ clientNodeId }]);
		expect(harness.audit()).toContainEqual(
			expect.objectContaining({ type: "client_revoked", clientNodeId, success: true }),
		);
	});
});
