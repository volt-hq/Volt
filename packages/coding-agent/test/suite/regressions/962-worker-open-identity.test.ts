import { afterEach, describe, expect, it } from "vitest";
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

/** Workers that report their conversation is in use by another client, then exit. */
class InUseWorkerLauncher implements WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const exited = Promise.withResolvers<WorkerExit>();
		const client: DaemonClient = createDaemonClient({
			socketPath: request.socketPath,
			version: "test",
			worker: { workerId: request.workerId, workerToken: request.workerToken },
			reconnect: false,
			onEvent: (event) => {
				if (event.type !== "worker_open") return;
				void client
					.request({
						type: "worker_open_failed",
						sessionId: event.spec.session.sessionId,
						message: "conversation is in use by another client",
						outcome: "conversation_in_use",
					})
					.catch(() => undefined)
					.then(() => client.close())
					.then(() => exited.resolve({ reason: "failed" }));
			},
		});
		void client.connect().catch(() => exited.resolve({ reason: "crashed" }));
		return { pid: process.pid, exited: exited.promise, kill: () => exited.resolve({ reason: "crashed" }) };
	}
}

describe.runIf(nativeIrohAvailable || process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1")(
	"regression #962: a worker open failure the phone checks the identity of",
	() => {
		it("names the conversation in a conversation_in_use rejection, without a retry pace", async () => {
			const harness = await createDaemonHarness({
				workerLauncher: new InUseWorkerLauncher(),
				extensions: [createIrohDaemonService({ relayMode: "disabled" })],
			});
			cleanups.push(() => harness.dispose());
			const ref = await harness.createSession();
			const paired = await pairPhone(harness);
			cleanups.push(() => paired.close());

			const { handshake } = await paired.openConversation({ target: "session", sessionId: ref.sessionId });
			expect(handshake).toMatchObject({
				success: false,
				outcome: "conversation_in_use",
				workspace: harness.workspaceName,
				sessionId: ref.sessionId,
				error: "conversation is in use by another client",
			});
			expect(handshake).not.toHaveProperty("retryAfterMs");
		}, 60_000);
	},
);
