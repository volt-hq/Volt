import { Buffer } from "node:buffer";
import { createServer } from "node:http";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDaemonConversation } from "../../../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../../../src/client/protocol-client.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { nativeIrohAvailable, pairPhone } from "../../utilities/daemon-phone.ts";
import { createDaemonHarness } from "../daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

describe.runIf(nativeIrohAvailable || process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1")(
	"regression #627: completion pushes from a phone attached to a TUI-opened conversation",
	() => {
		it("passes daemon control validation and delivers only canonical notification fields to the push relay", async () => {
			const requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
			const relay = createServer((request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					requests.push({
						method: request.method,
						path: request.url,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
					});
					response.writeHead(200, { "content-type": "application/json" });
					response.end("{}");
				});
			});
			cleanups.push(
				() =>
					new Promise<void>((resolve, reject) => {
						relay.closeAllConnections();
						relay.close((error) => (error ? reject(error) : resolve()));
					}),
			);
			await new Promise<void>((resolve, reject) => {
				relay.once("error", reject);
				relay.listen(0, "127.0.0.1", resolve);
			});
			const address = relay.address();
			if (!address || typeof address === "string") throw new Error("The fake push relay did not listen");
			const relayUrl = `http://127.0.0.1:${address.port}`;

			const harness = await createDaemonHarness({
				extensions: [
					createIrohDaemonService({
						relayMode: "disabled",
						pushRelayUrl: relayUrl,
						pushRelayAuthToken: "relay-token-627",
					}),
				],
			});
			cleanups.push(() => harness.dispose());
			harness.faux.setResponses([fauxAssistantMessage("done")]);
			const tui = await harness.connect("tui");
			const { opened, transport } = await openDaemonConversation(tui, {
				target: { kind: "new" },
				spawn: {
					env: {},
					config: { tools: ["read"] },
					cwd: harness.workspacePath,
					persist: true,
					session: {},
				},
				clientKey: "tui-627",
			});
			const client = new ProtocolClient({ followMoves: "reconnect" });
			cleanups.push(() => client.stop());
			await client.connect(transport);

			const paired = await pairPhone(harness);
			cleanups.push(() => paired.close());
			const stream = await paired.openConversation({ target: "session", sessionId: opened.sessionId });
			expect(stream.handshake).toMatchObject({ success: true, sessionId: opened.sessionId });
			const phone = stream.phone;
			if (!phone) throw new Error("The phone did not attach");
			await phone.hello();
			await phone.subscribe(opened.sessionId);
			expect((await harness.status()).workers).toEqual([
				expect.objectContaining({
					origin: "tui",
					sessionIds: [opened.sessionId],
					clients: { local: 1, remote: 1 },
				}),
			]);

			expect(
				await phone.intent("register_push_target", {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "relay-target-627",
					pushTargetAuthToken: "relay-target-token-627",
					relayUrl,
					enabled: true,
				}),
			).toMatchObject({ type: "accepted", result: { status: "registered", pushTargetId: "relay-target-627" } });
			expect(await phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
			await vi.waitFor(() => expect(requests).toHaveLength(1), { timeout: 10_000 });

			// Exact equality excludes the old notification_request `type` envelope and any stream-only fields.
			const eventId = expect.stringMatching(new RegExp(`^conversation:${opened.sessionId}:[^:]+:completed$`));
			expect(requests).toEqual([
				{
					method: "POST",
					path: "/v1/notifications",
					body: {
						pushTargetId: "relay-target-627",
						pushTargetAuthToken: "relay-target-token-627",
						eventId,
						hostNodeId: stream.handshake.hostNodeId,
						kind: "conversation_completed",
						title: `Volt finished in ${harness.workspaceName}`,
						body: "Your conversation is ready.",
						workspaceName: harness.workspaceName,
						data: {
							eventId,
							hostNodeId: stream.handshake.hostNodeId,
							kind: "conversation_completed",
							sessionId: opened.sessionId,
							workspaceName: harness.workspaceName,
						},
					},
				},
			]);
			await vi.waitFor(() =>
				expect(harness.audit()).toContainEqual(
					expect.objectContaining({
						type: "push_notification_delivered",
						clientNodeId: paired.nodeId,
						workspace: harness.workspaceName,
						success: true,
						details: expect.objectContaining({ eventId, kind: "conversation_completed" }),
					}),
				),
			);
		}, 60_000);
	},
);
