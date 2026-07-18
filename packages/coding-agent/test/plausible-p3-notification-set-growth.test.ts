import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createTestSession, parseWrittenObjects, startIrohRpcMode } from "./iroh-stream-doubles.ts";

/**
 * P3 (leak): `sentNotificationEventIds` in runIrohRemoteRpcMode is a per-stream
 * Set that accumulates one entry per completed conversation turn with NO cap or
 * eviction. This test drives many DISTINCT prompt completions within a SINGLE
 * relay stream and checks whether the dedupe memory is bounded.
 *
 * CORRECT behavior (if the leak were fixed with a bounded LRU cap): after driving
 * far more completions than any reasonable cap, the OLDEST eventId would have been
 * evicted from the dedupe set. Re-driving the oldest completion would therefore
 * emit a *fresh* notification (the set no longer remembers it) — proving the set
 * is bounded.
 *
 * BUGGY behavior (current code, unbounded Set): every eventId is remembered for
 * the entire stream lifetime, so re-driving the oldest completion is suppressed as
 * a duplicate and the dedupe set is proven to retain ALL N entries → unbounded.
 */

function getNotifications(send: { writtenText(): string; writes: number[][] }): Array<Record<string, unknown>> {
	return parseWrittenObjects(send as never).filter((record) => record.type === "notification_request");
}

function createStableSessionRunner<TSession>(getSession: () => TSession) {
	return {
		async runWithStableSession<TResult>(
			operation: (session: TSession) => Promise<TResult> | TResult,
		): Promise<TResult> {
			const session = getSession();
			return operation(session);
		},
	};
}

describe("P3: iroh remote notification dedupe set growth", () => {
	test("bounds the per-stream notification dedupe set so old eventIds are eventually evicted", async () => {
		// The loop drives hundreds of prompts through the async transport queue.
		const session = createTestSession("session-one", "before-run");

		// Each prompt advances the leaf id to a brand-new run, so every completion
		// produces a DISTINCT conversation eventId
		// (conversation:session-one:<runId>:completed).
		let runCounter = 0;
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = `run-${runCounter}`;
			},
		);

		const runtimeHost = {
			...createStableSessionRunner(() => session),
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;

		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		// Far exceeds any plausible per-stream dedupe cap (e.g. 128/256/512), while
		// staying fast enough to run deterministically. The inbound transport queue
		// serializes these prompts in order, and `prompt.mockImplementation` sets a
		// distinct leaf id per run, so each completion yields a distinct eventId.
		const TOTAL = 600;

		// run-0 is the OLDEST completion. Its notification is emitted immediately.
		for (let index = 0; index < TOTAL; index++) {
			runCounter = index;
			session.leafId = "before-run";
			recv.pushLine(
				JSON.stringify({
					id: `prompt-${index}`,
					type: "prompt",
					clientMessageId: `client-prompt-${index}`,
					message: `hello ${index}`,
				}),
			);
			// runCounter is captured by the async prompt mock; wait for this prompt to
			// be consumed before mutating runCounter for the next one.
			await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(index + 1));
		}

		await vi.waitFor(() =>
			expect(
				getNotifications(send).some((n) => n.eventId === `conversation:session-one:run-${TOTAL - 1}:completed`),
			).toBe(true),
		);

		const notificationsBeforeReplay = getNotifications(send).length;

		// Re-drive the OLDEST completion (run-0) again in the same stream.
		runCounter = 0;
		session.leafId = "before-run";
		recv.pushLine(
			JSON.stringify({
				id: "prompt-replay",
				type: "prompt",
				clientMessageId: "client-prompt-replay",
				message: "hello replay",
			}),
		);
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(TOTAL + 1));
		// Give any async notification delivery a chance to flush.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		const run0Notifications = getNotifications(send).filter(
			(n) => n.eventId === "conversation:session-one:run-0:completed",
		).length;

		// CORRECT behavior: a bounded dedupe set (cap << 2000) would have evicted
		// run-0 long ago, so replaying it emits a second run-0 notification.
		// BUGGY (unbounded) behavior: run-0 is remembered forever, so it stays
		// deduped and only ONE run-0 notification is ever emitted.
		expect(run0Notifications).toBeGreaterThanOrEqual(2);

		// Sanity: the replay should have produced a new notification overall under a
		// bounded set.
		expect(getNotifications(send).length).toBeGreaterThan(notificationsBeforeReplay);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	}, 120000);
});
