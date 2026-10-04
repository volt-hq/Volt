/**
 * The run lifecycle a paired device sees on its stream: it may stop runs and
 * background jobs, and nothing else ends a run. A phone that disconnects, or
 * whose stream fails, leaves its accepted prompt running in the conversation
 * the host keeps; an explicit `abort` is accepted once the run settled.
 */

import { type FauxResponseFactory, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import type { ProtocolConnection } from "../src/core/protocol/server/connection.ts";
import { createIrohRemotePresetAccess, serveIrohRemoteConnection } from "../src/core/remote/iroh/index.ts";
import type { IrohBiStreamLike } from "../src/core/rpc/iroh-transport.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

type EntryFrame = Extract<HostFrame, { type: "entry" }>;

/** A faux turn that answers `text` once released, or stops when the run is aborted. */
function gatedTurn(text: string): { step: FauxResponseFactory; release(): void; started: Promise<void> } {
	const release = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const step: FauxResponseFactory = async (_context, options) => {
		started.resolve();
		await new Promise<void>((resolve) => {
			void release.promise.then(resolve);
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage(text);
	};
	return { step, release: release.resolve, started: started.promise };
}

/** The assistant entries a conversation committed, by text and stop reason. */
function assistantEntries(conversation: HostedConversation): Array<{ text: string; stopReason: string }> {
	return conversation.session.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return [];
		const text = entry.message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
		return [{ text, stopReason: entry.message.stopReason }];
	});
}

describe("Iroh remote run lifecycle", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		// The daemon keeps a conversation its phones leave.
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function phone(
		harness: HostHarness,
		conversation: HostedConversation,
		stream?: (pair: { host: IrohBiStreamLike; phone: IrohBiStreamLike }) => IrohBiStreamLike,
	): Promise<{ device: RemotePhone; connection: ProtocolConnection }> {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: stream ? stream(pair) : pair.host,
			grant: createIrohRemotePresetAccess("coding").rpcGrant,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		void connection.closed.catch(() => undefined);
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await device.close();
		});
		await device.hello();
		await device.subscribe(conversation.id);
		return { device, connection };
	}

	test("allows stopping runs and background jobs; other stop-like commands are unknown", async () => {
		const { harness, conversation } = await setup();
		const { device } = await phone(harness, conversation);

		expect(await device.intent("abort")).toMatchObject({ type: "accepted" });
		const cancelJob = await device.intent("cancel_job", { jobId: "missing-job" });
		expect(cancelJob.type === "rejected" ? cancelJob.reason.code : "accepted").not.toMatch(
			/^(not_allowed|unknown_intent)$/,
		);

		for (const name of ["cancel", "cancel_run", "detach", "disconnect", "stop", "get_messages"]) {
			expect(await device.intent(name), name).toMatchObject({
				type: "rejected",
				reason: { code: "unknown_intent" },
			});
		}
	});

	test("an accepted prompt keeps running after the phone disconnects, and the conversation stays open", async () => {
		const { harness, conversation } = await setup();
		const turn = gatedTurn("detached completion");
		harness.faux.setResponses([turn.step]);
		const abort = vi.spyOn(conversation.session, "abort");
		const { device, connection } = await phone(harness, conversation);

		expect(await device.intent("prompt", { message: "keep running" })).toMatchObject({ type: "accepted" });
		await turn.started;

		// A clean close is the phone leaving, not a request to stop.
		await device.close();
		await connection.closed;
		expect(conversation.closed).toBe(false);
		expect(conversation.session.isBusy).toBe(true);

		turn.release();
		await vi.waitFor(() => expect(conversation.session.isBusy).toBe(false));
		expect(abort).not.toHaveBeenCalled();
		expect(conversation.closed).toBe(false);
		expect(assistantEntries(conversation)).toEqual([{ text: "detached completion", stopReason: "stop" }]);
	});

	test("a failed write to the phone ends its connection without stopping the run", async () => {
		const { harness, conversation } = await setup();
		const turn = gatedTurn("write failure detached completion");
		harness.faux.setResponses([turn.step]);
		const abort = vi.spyOn(conversation.session, "abort");
		const writeError = new Error("remote write side closed");
		let failWrites = false;
		const { device, connection } = await phone(harness, conversation, (pair) => ({
			recv: pair.host.recv,
			send: {
				...pair.host.send,
				writeAll: (bytes) => (failWrites ? Promise.reject(writeError) : pair.host.send.writeAll(bytes)),
			},
		}));

		expect(await device.intent("prompt", { message: "keep running" })).toMatchObject({ type: "accepted" });
		await turn.started;

		failWrites = true;
		conversation.liveState.notice("info", "the next frame fails to send");
		await expect(connection.closed).rejects.toBe(writeError);
		expect(conversation.closed).toBe(false);

		turn.release();
		await vi.waitFor(() => expect(conversation.session.isBusy).toBe(false));
		expect(abort).not.toHaveBeenCalled();
		expect(assistantEntries(conversation)).toEqual([
			{ text: "write failure detached completion", stopReason: "stop" },
		]);
	});

	test("an explicit abort stops the active prompt and is accepted once the run settled", async () => {
		const { harness, conversation } = await setup();
		const turn = gatedTurn("never released");
		harness.faux.setResponses([turn.step]);
		const { device } = await phone(harness, conversation);

		expect(await device.intent("prompt", { message: "keep running" })).toMatchObject({ type: "accepted" });
		await turn.started;
		const aborted = await device.intent("abort");
		expect(aborted).toMatchObject({ type: "accepted" });
		expect(conversation.session.isBusy).toBe(false);
		expect(assistantEntries(conversation)).toEqual([expect.objectContaining({ stopReason: "aborted" })]);

		// The aborted turn committed before the abort was answered.
		const committed = device.frames.find(
			(frame): frame is EntryFrame =>
				frame.type === "entry" && frame.entry.type === "message" && frame.entry.view?.stopReason === "aborted",
		);
		expect(committed).toBeDefined();
		expect(device.frames.indexOf(committed!)).toBeLessThan(device.frames.indexOf(aborted));
		expect(conversation.closed).toBe(false);
	});
});
