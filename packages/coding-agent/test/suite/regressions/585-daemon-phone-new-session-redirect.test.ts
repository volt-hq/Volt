import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { handoffRecord } from "../../fixtures/handoff-command-extension.ts";
import {
	nativeIrohAvailable,
	type PairedPhone,
	type PhoneConversation,
	pairPhone,
} from "../../utilities/daemon-phone.ts";
import type { IntentOutcome, RemotePhone } from "../../utilities/remote-phone.ts";
import { createDaemonHarness, type DaemonHarness } from "../daemon-harness.ts";

const HANDOFF_EXTENSION_PATH = realpathSync.native(
	fileURLToPath(new URL("../../fixtures/handoff-command-extension.ts", import.meta.url)),
);

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

/**
 * A daemon whose workers load the `/handoff` extension beside the harness's
 * faux provider, with what the extension records cleared.
 */
async function startDaemon(options: { detachedRuntimeTtlMs?: number } = {}): Promise<DaemonHarness> {
	const harness = await createDaemonHarness({
		...options,
		extensions: [createIrohDaemonService({ relayMode: "disabled" })],
		workerExtensions: [HANDOFF_EXTENSION_PATH],
	});
	cleanups.push(() => harness.dispose());
	const record = handoffRecord();
	record.events.length = 0;
	record.seeds.length = 0;
	record.handoffs.length = 0;
	return harness;
}

async function pair(harness: DaemonHarness, label: string): Promise<PairedPhone> {
	const phone = await pairPhone(harness, { label });
	cleanups.push(() => phone.close());
	return phone;
}

/** Open `conversation` and subscribe to the conversation the handshake names. */
async function attach(
	paired: PairedPhone,
	conversation: Record<string, unknown>,
): Promise<{ stream: PhoneConversation; phone: RemotePhone; sessionId: string }> {
	const stream = await paired.openConversation(conversation);
	expect(stream.handshake).toMatchObject({ success: true });
	const sessionId = stream.handshake.sessionId;
	if (typeof sessionId !== "string" || stream.phone === undefined) {
		throw new Error(`The conversation did not open: ${JSON.stringify(stream.handshake)}`);
	}
	const phone = stream.phone;
	await phone.hello();
	await phone.subscribe(sessionId);
	return { stream, phone, sessionId };
}

/** The conversation a structural intent's acceptance names. */
function targetOf(outcome: IntentOutcome): string {
	if (outcome.type !== "accepted" || outcome.conversation === undefined) {
		throw new Error(`Expected the intent to name its target: ${JSON.stringify(outcome)}`);
	}
	return outcome.conversation;
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

/** The workers hosting the harness workspace, by the sessions they host. */
async function workersBySession(harness: DaemonHarness) {
	return (await harness.status()).workers.map((worker) => ({
		sessionIds: [...worker.sessionIds].sort(),
		remote: worker.clients.remote,
	}));
}

describe.runIf(nativeIrohAvailable)(
	"regression #585: a phone on a worker-hosted conversation changes sessions alone",
	() => {
		it("answers new_session, redirects that phone without opening the target, and keeps a co-attached phone on the source", async () => {
			const harness = await startDaemon();
			const record = handoffRecord();
			harness.faux.setResponses([fauxAssistantMessage("still here")]);
			const [pairedA, pairedB] = [await pair(harness, "phone-a"), await pair(harness, "phone-b")];
			const a = await attach(pairedA, { target: "new", sessionId: "s-source" });
			const b = await attach(pairedB, { target: "session", sessionId: "s-source" });
			expect(await workersBySession(harness)).toEqual([{ sessionIds: ["s-source"], remote: 2 }]);
			record.events.length = 0;

			const outcome = await a.phone.intent("new_session", {});
			const targetId = targetOf(outcome);
			expect(targetId).not.toBe("s-source");
			// The answer comes first; the subscription ends moved, then the stream.
			await a.phone.ended;
			expect(a.phone.frames.indexOf(outcome)).toBeGreaterThan(0);
			expect(a.phone.frames.at(-1)).toEqual({
				type: "ended",
				subscriptionId: "s1",
				reason: "moved",
				target: targetId,
			});

			// A client's own move redirects it (D1): the source's worker does not open the target.
			await expect.poll(() => workersBySession(harness)).toEqual([{ sessionIds: ["s-source"], remote: 1 }]);
			expect(record.events).toEqual([{ type: "session_before_switch", sessionId: "s-source", reason: "new" }]);

			// Phone B stays on the source, which stays open for it.
			expect(b.phone.frames.some((frame) => frame.type === "ended" || frame.type === "fatal")).toBe(false);
			expect(await b.phone.intent("prompt", { message: "still on the source" })).toMatchObject({ type: "accepted" });
			await expect.poll(() => assistantText(b.phone.frames), { timeout: 5000 }).toContain("still here");

			// Only phone A's last session moved: `target:"last"` lands it on the new conversation, which opens
			// beside the source in its worker: the phone's open has the worker's compatibility key (D11).
			const back = await attach(pairedA, { target: "last" });
			expect(back.sessionId).toBe(targetId);
			expect(back.stream.handshake).toMatchObject({
				sessionId: targetId,
				conversation: { target: "last", sessionId: targetId, selection: "resumed" },
			});
			await expect
				.poll(() => workersBySession(harness))
				.toEqual([{ sessionIds: ["s-source", targetId].sort(), remote: 2 }]);
			// Phone B's last session is still the source.
			const stays = await attach(pairedB, { target: "last" });
			expect(stays.sessionId).toBe("s-source");
			expect(record.events).toContainEqual(expect.objectContaining({ type: "session_start", sessionId: targetId }));
			expect(record.events.some((event) => event.type === "session_shutdown")).toBe(false);
		}, 60_000);

		it("opens an extension command's new session in the phone's worker and runs its withSession once the phone reconnected", async () => {
			const harness = await startDaemon();
			const record = handoffRecord();
			const [pairedA, pairedB] = [await pair(harness, "phone-a"), await pair(harness, "phone-b")];
			const source = await attach(pairedA, { target: "new", sessionId: "s-seed" });
			// A second phone keeps the source open.
			await attach(pairedB, { target: "session", sessionId: "s-seed" });

			source.phone.send({
				type: "extension.command.handoff-command.handoff",
				intentId: "i-handoff",
				expectedOrdinal: source.phone.position(),
				input: {},
			});
			await source.phone.ended;
			const moved = source.phone.frames.at(-1);
			if (moved?.type !== "ended" || moved.reason !== "moved") throw new Error("The phone was not redirected");
			// An extension's move opens its target in the worker hosting the source (D1)...
			expect(await workersBySession(harness)).toEqual([{ sessionIds: [moved.target, "s-seed"].sort(), remote: 1 }]);
			// ...whose extensions and seed wait for the phone to come back.
			expect(record.seeds).toEqual([]);

			const back = await attach(pairedA, { target: "session", sessionId: moved.target });
			expect(back.sessionId).toBe(moved.target);
			await expect
				.poll(() => record.handoffs)
				.toEqual([{ cancelled: false, sessionId: moved.target, seeded: true }]);
			expect(record.seeds).toEqual([moved.target]);
			expect(record.events).toContainEqual({ type: "session_start", sessionId: moved.target, reason: "new" });
			// The phone reconnected to the same worker.
			expect(await workersBySession(harness)).toEqual([{ sessionIds: [moved.target, "s-seed"].sort(), remote: 2 }]);
		}, 60_000);

		it("retires the source once idle when the phone that moved away was its last client", async () => {
			const harness = await startDaemon({ detachedRuntimeTtlMs: 200 });
			const record = handoffRecord();
			const paired = await pair(harness, "phone-a");
			const phone = await attach(paired, { target: "new", sessionId: "s-alone" });

			const targetId = targetOf(await phone.phone.intent("new_session", {}));
			await phone.phone.ended;

			// Its worker is detached and idle: retention retires it.
			await expect.poll(() => workersBySession(harness), { timeout: 10_000 }).toEqual([]);
			expect(record.events).toContainEqual({ type: "session_shutdown", sessionId: "s-alone", reason: "quit" });

			// The phone's reconnect opens the new conversation in a worker of its own.
			const back = await attach(paired, { target: "session", sessionId: targetId });
			expect(back.sessionId).toBe(targetId);
			expect(await workersBySession(harness)).toEqual([{ sessionIds: [targetId], remote: 1 }]);
		}, 60_000);
	},
);
