import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProtocolClient } from "../src/client/protocol-client.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { localProfile } from "../src/core/protocol/profiles.ts";
import { serveConnection } from "../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../src/core/protocol/transport/index.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";

/** The pending host requests the client's live state shows, by request id. */
function shownRequests(client: ProtocolClient): string[] {
	return [...client.live.values.values()].flatMap((value) => (value.kind === "host_request" ? [value.requestId] : []));
}

describe("host requests across branch cuts and moves", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	test("keeps dialogs and approvals pending across a branch switch and with their conversation on a move", async () => {
		const harness: HostHarness = await createHostHarness({ whenUnattached: "keep", responses: ["one", "two"] });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		// Other clients keep the conversation open: this one does not anchor it.
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, {
			host: harness.host,
			conversation,
			anchor: false,
		});
		const frames: HostFrame[] = [];
		const client = new ProtocolClient({
			hostRequests: ["confirm", "approval"],
			onFrame: (frame) => frames.push(frame),
		});
		cleanups.push(async () => {
			await client.stop();
			await connection.closed.catch(() => undefined);
		});
		await client.connect(pair.client);
		await connection.ready;
		/** Wait until the host handled every answer sent so far: answers and unsubscribes share one ordered lane. */
		const answersHandled = async (barrier: string) => {
			pair.client.write({ type: "unsubscribe", subscriptionId: barrier });
			await vi.waitFor(() =>
				expect(frames).toContainEqual({ type: "ended", subscriptionId: barrier, reason: "unsubscribed" }),
			);
		};
		await client.promptAndWait("first", { timeoutMs: 10_000 });
		await client.promptAndWait("second", { timeoutMs: 10_000 });

		/** An extension dialog and an approval in `asker`, as the client sees them. */
		const startControls = async (asker: HostedConversation, suffix: string) => {
			const confirm = asker.liveState.request({ kind: "confirm", title: `Confirm ${suffix}`, message: "Proceed?" });
			const approval = asker.liveState.hostInteraction.requestAction({
				id: `host-${suffix}`,
				action: "test.action",
				title: `Host ${suffix}`,
			});
			const confirmId = asker.liveState
				.pendingRequests()
				.find(
					(pending) => pending.request.kind === "confirm" && pending.request.title === `Confirm ${suffix}`,
				)?.requestId;
			if (confirmId === undefined) throw new Error("Missing the confirm request");
			await vi.waitFor(() =>
				expect(shownRequests(client)).toEqual(expect.arrayContaining([confirmId, `host-${suffix}`])),
			);
			return { confirmId, confirm, approval };
		};

		// A branch switch commits entries; it never drops a pending dialog or approval (RFC §6.1).
		const branch = await startControls(conversation, "branch");
		const firstAnswer = client.state.entries.find((entry) => entry.type === "message" && entry.view?.text === "one");
		if (!firstAnswer) throw new Error("Missing the first answer");
		await conversation.session.navigateTree(firstAnswer.id);
		const switched = conversation.session.conversationGenerationRevision;
		await vi.waitFor(() => expect(client.state.ordinal).toBeGreaterThanOrEqual(switched));
		expect(shownRequests(client)).toEqual(expect.arrayContaining([branch.confirmId, "host-branch"]));
		client.answer(branch.confirmId, { confirmed: true });
		client.answer("host-branch", { decision: "approved" });
		await expect(branch.confirm).resolves.toMatchObject({ status: "answered", response: { confirmed: true } });
		await expect(branch.approval).resolves.toEqual({ decision: "approved" });

		// The client moves to another conversation, as its structural intents do. The requests
		// stay with the conversation that asked them, which stays open.
		const moved = await startControls(conversation, "move");
		const accepted = await client.intent("new_session", {});
		if (accepted.conversation === undefined) throw new Error("Expected the client to move");
		await vi.waitFor(() => expect(client.conversation).toBe(accepted.conversation));
		await client.caughtUp();
		expect(shownRequests(client)).toEqual([]);
		// Its answers now go to the conversation it is on, which asked nothing.
		client.answer(moved.confirmId, { confirmed: true });
		client.answer("host-move", { decision: "approved" });
		await answersHandled("after-move");
		expect(conversation.closed).toBe(false);
		expect(conversation.liveState.pendingRequests().map((pending) => pending.requestId)).toEqual([
			moved.confirmId,
			"host-move",
		]);

		// They end when their conversation closes.
		await harness.host.close(conversation);
		await expect(moved.confirm).resolves.toEqual({ status: "cancelled", reason: "closed" });
		await expect(moved.approval).resolves.toMatchObject({ decision: "dismissed" });
	});
});
