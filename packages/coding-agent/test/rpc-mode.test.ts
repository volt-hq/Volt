/**
 * RPC mode: one protocol connection on stdio, on the local profile.
 */

import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isStdoutTakenOver } from "../src/core/output-guard.ts";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/index.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./suite/host-harness.ts";

const HELLO = { type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } };

describe("runRpcMode", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function harness(options: HostHarnessOptions = {}): Promise<HostHarness> {
		const created = await createHostHarness(options);
		cleanups.push(() => created.cleanup());
		return created;
	}

	it("takes over stdout on stdio and restores it when stdin ends without exiting the process", async () => {
		const host = await harness();
		const conversation = await host.openStartup();
		const initialEndListeners = process.stdin.listenerCount("end");

		const mode = runRpcMode(host.host, conversation, { exitProcess: false });
		expect(isStdoutTakenOver()).toBe(true);
		expect(process.stdin.listenerCount("end")).toBeGreaterThan(initialEndListeners);

		process.stdin.emit("end");
		await expect(mode).resolves.toBeUndefined();
		expect(isStdoutTakenOver()).toBe(false);
		// The client anchored its conversation: it closed with the connection.
		expect(conversation.closed).toBe(true);
	});

	it("ends the subscription and the connection when an extension shuts the host down", async () => {
		const host = await harness({
			extension: (volt) => {
				volt.registerCommand("leave", { handler: async (_args, ctx) => ctx.shutdown() });
			},
		});
		const conversation = await host.openStartup();
		const pair = createLoopbackRpcTransportPair();
		const frames: HostFrame[] = [];
		pair.client.onValue?.((value) => {
			frames.push(value as HostFrame);
		});
		const ready = Promise.withResolvers<void>();
		const mode = runRpcMode(host.host, conversation, { transport: pair.server, onReady: ready.resolve });
		void pair.client.write(HELLO);
		await ready.promise;
		void pair.client.write({
			type: "subscribe",
			subscriptionId: "s",
			conversation: conversation.id,
			after: "snapshot",
		});
		void pair.client.write({ type: "prompt", intentId: "leave-1", input: { message: "/leave" } });

		await expect(mode).resolves.toBeUndefined();
		const ended = frames.findIndex((frame) => frame.type === "ended");
		expect(frames[ended]).toEqual({ type: "ended", subscriptionId: "s", reason: "shutdown" });
		expect(frames.at(-1)).toMatchObject({ type: "fatal", code: "host_shutdown" });
		expect(conversation.closed).toBe(true);
	});

	it("rejects when the client cannot attach to its conversation", async () => {
		const host = await harness();
		const conversation = await host.openStartup();
		const attach = vi.spyOn(host.host, "attach").mockRejectedValueOnce(new Error("bind failed"));
		const pair = createLoopbackRpcTransportPair();
		const mode = runRpcMode(host.host, conversation, { transport: pair.server });
		void pair.client.write(HELLO);
		await expect(mode).rejects.toThrow("bind failed");
		expect(attach).toHaveBeenCalledOnce();
	});
});
