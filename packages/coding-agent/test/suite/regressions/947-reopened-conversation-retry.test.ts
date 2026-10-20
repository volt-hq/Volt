import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient, type DaemonClient } from "../../../src/daemon/control-client.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import type {
	LaunchedWorker,
	WorkerExit,
	WorkerLauncher,
	WorkerLaunchRequest,
} from "../../../src/daemon/worker-launcher.ts";
import { nativeIrohAvailable, pairPhone } from "../../utilities/daemon-phone.ts";
import { createDaemonHarness } from "../daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/** Workers that open their conversation and never redeem a relay offer, so every phone open stays in its handshake. */
class OfferHoldingWorkerLauncher implements WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const exited = Promise.withResolvers<WorkerExit>();
		const client: DaemonClient = createDaemonClient({
			socketPath: request.socketPath,
			version: "test",
			worker: { workerId: request.workerId, workerToken: request.workerToken },
			reconnect: false,
			onEvent: (event) => {
				if (event.type === "worker_open") {
					void client
						.request({ type: "worker_ready", sessionId: event.spec.session.sessionId })
						.catch(() => undefined);
				}
				if (event.type === "worker_stop") {
					void client
						.request({ type: "worker_stop_result", stopId: event.stopId, outcome: "stopped" })
						.catch(() => undefined)
						.then(() => client.close())
						.then(() => exited.resolve({ reason: "stopped" }));
				}
			},
		});
		void client.connect().catch(() => exited.resolve({ reason: "crashed" }));
		return { pid: process.pid, exited: exited.promise, kill: () => exited.resolve({ reason: "crashed" }) };
	}
}

describe.runIf(nativeIrohAvailable || process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1")(
	"regression #947: an open replaced by the same phone's newer connection",
	() => {
		it("is rejected as a retryable duplicate that names the conversation", async () => {
			const harness = await createDaemonHarness({
				workerLauncher: new OfferHoldingWorkerLauncher(),
				extensions: [createIrohDaemonService({ relayMode: "disabled" })],
			});
			cleanups.push(() => harness.dispose());
			const ref = await harness.createSession();
			const paired = await pairPhone(harness);
			cleanups.push(() => paired.close());
			const target = { target: "session", sessionId: ref.sessionId };

			const older = paired.openConversation(target);
			// Its relay is offered to the worker, which holds the offer.
			await vi.waitFor(
				() =>
					expect(harness.audit()).toContainEqual(
						expect.objectContaining({
							type: "relay_opened",
							details: expect.objectContaining({ sessionId: ref.sessionId }),
						}),
					),
				{ timeout: 10_000 },
			);
			// The same phone opens the conversation again on a new connection; that open stays offered until cleanup.
			const newer = paired.openConversation(target);
			void newer.catch(() => undefined);

			expect((await older).handshake).toMatchObject({
				success: false,
				outcome: "duplicate_conversation_connection",
				workspace: harness.workspaceName,
				sessionId: ref.sessionId,
				retryAfterMs: 1000,
				error: "conversation reopened; retry",
			});
		}, 60_000);
	},
);
