import { afterEach, describe, expect, test, vi } from "vitest";
import { attachCompletionNotifications } from "../src/core/remote/iroh/completion-notifications.ts";
import type { IrohRemotePushNotificationIntent } from "../src/core/remote/iroh/push.ts";
import { createHostHarness } from "./suite/host-harness.ts";

/**
 * P3 (leak): a device's notification delivery history must stay bounded. The
 * history of delivered event ids is kept per conversation and device for as
 * long as the conversation runs, so it accumulates one entry per completed
 * run. This test drives many distinct completions for one device and checks
 * that the oldest event id is eventually evicted: re-driving the oldest
 * completion pushes it again instead of being suppressed as a duplicate.
 */

describe("P3: iroh remote notification dedupe set growth", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	test("bounds the per-device notification delivery history so old eventIds are eventually evicted", async () => {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const session = conversation.session;
		// Each run settles on its own leaf, so every completion has a distinct
		// event id (conversation:<sessionId>:<runId>:completed).
		let leafId = "before-run";
		vi.spyOn(session.sessionManager, "getLeafId").mockImplementation(() => leafId);
		const delivered: IrohRemotePushNotificationIntent[] = [];
		const notifications = attachCompletionNotifications(conversation, {
			hostNodeId: "a".repeat(64),
			clientNodeId: "paired-client",
			delivery: {
				deliverNotification: async (notification) => {
					delivered.push(notification);
					return "sent";
				},
			},
		});
		cleanups.push(async () => notifications.detach());

		/** One accepted prompt whose run settles on leaf `runId`. */
		const complete = async (runId: string, count: number): Promise<void> => {
			leafId = "before-run";
			notifications.inputAccepted();
			// The run's start state was read; the idle conversation settles it on its new leaf.
			leafId = runId;
			await vi.waitFor(() => expect(delivered).toHaveLength(count), { interval: 1 });
		};

		// Far exceeds any plausible delivery history cap (e.g. 128/256/512).
		const TOTAL = 600;
		for (let index = 0; index < TOTAL; index++) {
			await complete(`run-${index}`, index + 1);
		}
		expect(new Set(delivered.map((notification) => notification.eventId)).size).toBe(TOTAL);

		// Re-drive the oldest completion (run-0) for the same device.
		await complete("run-0", TOTAL + 1);
		const oldest = `conversation:${session.sessionId}:run-0:completed`;
		expect(delivered.filter((notification) => notification.eventId === oldest)).toHaveLength(2);
	}, 120_000);
});
