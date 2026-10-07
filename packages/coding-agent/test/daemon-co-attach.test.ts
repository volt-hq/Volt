/**
 * Phones co-attached to one conversation (Phase 7): every phone that opens a
 * conversation reaches the one worker hosting it. A daemon in this process
 * (`daemon-harness.ts`) relays real paired phones (relay-disabled Iroh) to
 * its in-process workers.
 */

import type { AssistantMessage } from "@hansjm10/volt-ai";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrohDaemonService } from "../src/daemon/iroh-service.ts";
import { createDaemonHarness, type DaemonHarness } from "./suite/daemon-harness.ts";
import { nativeIrohAvailable, type PairedPhone, type PhoneConversation, pairPhone } from "./utilities/daemon-phone.ts";
import type { IntentOutcome, RemotePhone } from "./utilities/remote-phone.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function startHarness(options: Parameters<typeof createDaemonHarness>[0] = {}): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({
		...options,
		extensions: [createIrohDaemonService({ relayMode: "disabled" }), ...(options.extensions ?? [])],
	});
	cleanups.push(() => harness.dispose());
	return harness;
}

async function pair(harness: DaemonHarness, options: Parameters<typeof pairPhone>[1] = {}): Promise<PairedPhone> {
	const phone = await pairPhone(harness, options);
	cleanups.push(() => phone.close());
	return phone;
}

/** Open `sessionId` on `paired`, say hello, and subscribe to it. */
async function attach(
	paired: PairedPhone,
	sessionId: string,
): Promise<{ stream: PhoneConversation; phone: RemotePhone }> {
	const stream = await paired.openConversation({ target: "session", sessionId });
	expect(stream.handshake).toMatchObject({ success: true, sessionId });
	const phone = stream.phone!;
	await phone.hello();
	await phone.subscribe(sessionId);
	return { stream, phone };
}

/** The latest busy flag the phone's live lane showed. */
function busy(phone: RemotePhone): boolean | undefined {
	return phone.frames
		.flatMap((frame) => (frame.type === "live" ? frame.items : []))
		.flatMap((item) => (item.type === "set" && item.value.kind === "phase" ? [item.value.busy] : []))
		.at(-1);
}

function assistantText(frames: readonly HostFrame[]): string[] {
	return frames.flatMap((frame) =>
		frame.type === "entry" &&
		frame.entry.type === "message" &&
		frame.entry.view !== undefined &&
		"role" in frame.entry.view &&
		frame.entry.view.role === "assistant"
			? [String((frame.entry.view as { text?: unknown }).text ?? "")]
			: [],
	);
}

function terminal(phone: RemotePhone): HostFrame[] {
	return phone.frames.filter((frame) => frame.type === "fatal" || frame.type === "ended");
}

function targetOf(outcome: IntentOutcome): string {
	if (outcome.type !== "accepted" || outcome.conversation === undefined) {
		throw new Error(`Expected the intent to name its target: ${JSON.stringify(outcome)}`);
	}
	return outcome.conversation;
}

/** A turn that runs until its request is aborted. */
function untilAborted(): (context: unknown, options?: { signal?: AbortSignal }) => Promise<AssistantMessage> {
	return (_context, options) =>
		new Promise((resolve) => {
			const stop = () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" }));
			if (options?.signal?.aborted) stop();
			else options?.signal?.addEventListener("abort", stop, { once: true });
		});
}

function lastSessionOf(harness: DaemonHarness, paired: PairedPhone): string | undefined {
	return harness.services.state.getHostState().clients.find((client) => client.nodeId === paired.nodeId)
		?.lastSessionIdByWorkspace?.[harness.workspaceName];
}

describe.runIf(nativeIrohAvailable)("phones co-attached to a conversation worker", () => {
	it("serves two paired phones from one worker: both stream its turn, and an abort keeps both streams open", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		harness.faux.setResponses([untilAborted(), fauxAssistantMessage("after the abort")]);
		const a = await attach(await pair(harness, { label: "phone-a" }), ref.sessionId);
		const b = await attach(await pair(harness, { label: "phone-b" }), ref.sessionId);

		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ sessionIds: [ref.sessionId], clients: { local: 0, remote: 2 } }),
		]);

		// Phone A's turn streams to both phones.
		expect(await a.phone.intent("prompt", { message: "go" })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => {
			expect(busy(a.phone)).toBe(true);
			expect(busy(b.phone)).toBe(true);
		});
		expect(harness.faux.state.callCount).toBe(1);

		// Phone B stops it; both streams stay open on the same worker.
		expect(await b.phone.intent("abort")).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => {
			expect(busy(a.phone)).toBe(false);
			expect(busy(b.phone)).toBe(false);
		});
		expect(await b.phone.intent("prompt", { message: "again" })).toMatchObject({ type: "accepted" });
		for (const { phone } of [a, b]) {
			await vi.waitFor(() => expect(assistantText(phone.frames)).toContain("after the abort"));
			expect(terminal(phone)).toEqual([]);
		}
		const [worker] = (await harness.status()).workers;
		expect(worker).toMatchObject({ state: "live", clients: { local: 0, remote: 2 } });

		// Both leave; the worker stays for its retention TTL.
		await a.stream.close();
		await b.stream.close();
		await vi.waitFor(async () =>
			expect((await harness.status()).workers).toEqual([
				expect.objectContaining({ workerId: worker?.workerId, clients: { local: 0, remote: 0 } }),
			]),
		);
	}, 60_000);

	it("refuses a phone whose grant is narrower than the tools the worker runs with (conversation_in_use)", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const opener = await attach(await pair(harness, { access: "full", label: "broad" }), ref.sessionId);

		const narrow = await (await pair(harness, { access: "chat", label: "narrow" })).openConversation({
			target: "session",
			sessionId: ref.sessionId,
		});
		expect(narrow.handshake).toMatchObject({ success: false, outcome: "conversation_in_use" });

		// A grant with the same tools attaches to the same worker.
		const equal = await attach(await pair(harness, { access: "coding", label: "equal" }), ref.sessionId);
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ sessionIds: [ref.sessionId], clients: { local: 0, remote: 2 } }),
		]);
		expect(terminal(opener.phone)).toEqual([]);
		expect(terminal(equal.phone)).toEqual([]);
	}, 60_000);

	it("moves only the phone that started a new session: it is redirected, and its co-attached phone stays", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		harness.faux.setResponses([fauxAssistantMessage("still on the source")]);
		const pairedA = await pair(harness, { label: "phone-a" });
		const pairedB = await pair(harness, { label: "phone-b" });
		const a = await attach(pairedA, ref.sessionId);
		const b = await attach(pairedB, ref.sessionId);
		const [source] = (await harness.status()).workers;

		const targetId = targetOf(await a.phone.intent("new_session", {}));
		expect(targetId).not.toBe(ref.sessionId);
		// The answer comes first; the subscription ends moved, then the stream.
		await a.phone.ended;
		expect(a.phone.frames.at(-1)).toEqual({ type: "ended", subscriptionId: "s1", reason: "moved", target: targetId });
		await vi.waitFor(() => expect(lastSessionOf(harness, pairedA)).toBe(targetId));

		// Phone B stays on the source, which its worker keeps serving.
		expect(await b.phone.intent("prompt", { message: "hi" })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(assistantText(b.phone.frames)).toContain("still on the source"));
		expect(terminal(b.phone)).toEqual([]);
		expect(lastSessionOf(harness, pairedB)).toBe(ref.sessionId);

		// A client's own move opens nothing in the source's worker until phone A reconnects to the target.
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ workerId: source?.workerId, sessionIds: [ref.sessionId] }),
		]);
		// The target opens beside the source in its worker: the phone's open has its compatibility key (D11).
		const moved = await attach(pairedA, targetId);
		expect(moved.stream.handshake).toMatchObject({ sessionId: targetId });
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({
				workerId: source?.workerId,
				sessionIds: [ref.sessionId, targetId],
				clients: { local: 0, remote: 2 },
			}),
		]);
	}, 60_000);

	it("records a switch to a stored session as the phone's last session without opening it", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const stored = await harness.createSession();
		const paired = await pair(harness);
		const { phone } = await attach(paired, ref.sessionId);

		const outcome = await phone.intent("switch_session", { sessionId: stored.sessionId });
		expect(targetOf(outcome)).toBe(stored.sessionId);
		await phone.ended;
		expect(phone.frames.at(-1)).toMatchObject({ type: "ended", reason: "moved", target: stored.sessionId });
		await vi.waitFor(() => expect(lastSessionOf(harness, paired)).toBe(stored.sessionId));
		// Nothing opened the stored session.
		expect((await harness.status()).workers).toEqual([expect.objectContaining({ sessionIds: [ref.sessionId] })]);

		// `target:"last"` reaches it, in a worker of its own.
		const last = await paired.openConversation({ target: "last" });
		expect(last.handshake).toMatchObject({ success: true, sessionId: stored.sessionId });
	}, 60_000);

	it("retires a conversation its last phone left once its turn ended and the retention TTL passed", async () => {
		const harness = await startHarness({ detachedRuntimeTtlMs: 300 });
		const ref = await harness.createSession();
		const turn = Promise.withResolvers<void>();
		harness.faux.setResponses([
			async () => {
				await turn.promise;
				return fauxAssistantMessage("done");
			},
		]);
		const { stream, phone } = await attach(await pair(harness), ref.sessionId);
		expect(await phone.intent("prompt", { message: "go" })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(busy(phone)).toBe(true));
		await stream.close();

		// Detached while its turn runs: kept well past the TTL.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect((await harness.status()).workers).toEqual([
			expect.objectContaining({ state: "live", sessionIds: [ref.sessionId], clients: { local: 0, remote: 0 } }),
		]);

		// The turn ends: the conversation closes once the TTL passed, and its worker, hosting nothing, exits.
		turn.resolve();
		await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]), { timeout: 10_000 });
		// The audit log is appended after the registry dropped the worker.
		await vi.waitFor(() => {
			const audit = harness.audit();
			expect(audit).toContainEqual(
				expect.objectContaining({
					type: "worker_close",
					success: true,
					details: expect.objectContaining({ sessionId: ref.sessionId, reason: "retention" }),
				}),
			);
			expect(audit).toContainEqual(
				expect.objectContaining({
					type: "worker_exited",
					success: true,
					details: expect.objectContaining({ reason: "stopped", sessionIds: [] }),
				}),
			);
		});
	}, 60_000);

	it("ends every stream of a revoked phone and retires the worker it opened, with its co-attached phone's stream", async () => {
		const harness = await startHarness();
		const ref = await harness.createSession();
		const pairedA = await pair(harness, { label: "phone-a" });
		const pairedB = await pair(harness, { label: "phone-b" });
		const a = await attach(pairedA, ref.sessionId);
		const b = await attach(pairedB, ref.sessionId);

		expect(await harness.control.request({ type: "client_revoke", clientNodeId: pairedA.nodeId })).toMatchObject({
			type: "ok",
		});

		// The worker phone A opened retires: its streams end, phone B's too, and phone B reconnects with resume.
		await a.phone.ended;
		await b.phone.ended;
		await vi.waitFor(async () => expect((await harness.status()).workers).toEqual([]));
		const back = await attach(pairedB, ref.sessionId);
		expect(back.stream.handshake).toMatchObject({ success: true, sessionId: ref.sessionId });
		// The revoked phone opens nothing.
		const refused = await pairedA
			.openConversation({ target: "session", sessionId: ref.sessionId })
			.catch(() => undefined);
		expect(refused?.handshake.success).not.toBe(true);
	}, 60_000);
});
