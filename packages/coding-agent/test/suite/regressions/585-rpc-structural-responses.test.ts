import { RPC_RESPONSE_SCHEMAS } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createLoopbackRpcTransportPair, type RpcTransport } from "../../../src/core/rpc/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../../../src/modes/rpc/rpc-transport-client.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

type StructuralCommand = "new_session" | "switch_session" | "switch_session_by_id" | "fork" | "clone";

/** The server side of a loopback pair that keeps a copy of every frame it writes. */
function recording(transport: RpcTransport, frames: Array<Record<string, unknown>>): RpcTransport {
	return {
		write: (value) => {
			frames.push(structuredClone(value) as Record<string, unknown>);
			return transport.write(value);
		},
		onLine: (handler) => transport.onLine(handler),
		onClose: (handler) => transport.onClose?.(handler) ?? (() => {}),
		close: () => transport.close(),
	};
}

describe("regression #585: stdio RPC structural commands respond with the session id", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup() {
		let cancel = false;
		const harness: HostHarness = await createHostHarness({
			extension: (volt) => {
				volt.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
				volt.on("session_before_fork", () => (cancel ? { cancel: true } : undefined));
			},
		});
		const source = await harness.openStartup();
		await source.session.prompt("first prompt");
		const runtime = new AgentSessionRuntime(harness.host, source);
		const frames: Array<Record<string, unknown>> = [];
		const pair = createLoopbackRpcTransportPair();
		const client = new RpcTransportClient({ transport: pair.client });
		await client.start();
		const ready = Promise.withResolvers<void>();
		const closed = runRpcMode(runtime, {
			transport: recording(pair.server, frames),
			disposeRuntimeOnClose: false,
			onReady: ready.resolve,
		});
		await Promise.race([ready.promise, closed]);
		cleanups.push(async () => {
			await client.stop();
			await closed.catch(() => undefined);
			await runtime.dispose();
			await harness.cleanup();
		});
		/** Every structural response frame so far, checked against its contract schema. */
		const responses = (command: StructuralCommand) => {
			const matching = frames.filter((frame) => frame.type === "response" && frame.command === command);
			for (const frame of matching) expect(Compile(RPC_RESPONSE_SCHEMAS[command]).Errors(frame)).toEqual([]);
			return matching.map((frame) => frame.data);
		};
		return {
			runtime,
			client,
			responses,
			cancelNext: (value: boolean) => {
				cancel = value;
			},
		};
	}

	it("responds to each structural command with the session the client is on now", async () => {
		const { runtime, client, responses } = await setup();
		const first = runtime.session.sessionId;

		const created = await client.newSession();
		const second = runtime.session.sessionId;
		expect(second).not.toBe(first);
		expect(created).toEqual({ cancelled: false, sessionId: second });
		await expect(client.getState()).resolves.toMatchObject({ sessionId: second });

		await expect(client.switchSession(first)).resolves.toEqual({ cancelled: false, sessionId: first });
		await expect(client.switchSessionById(second)).resolves.toEqual({ cancelled: false, sessionId: second });
		// A switch to the session the client is on moves nothing and names it.
		await expect(client.switchSessionById(second)).resolves.toEqual({ cancelled: false, sessionId: second });
		expect(runtime.session.sessionId).toBe(second);

		await client.switchSessionById(first);
		const [forkFrom] = await client.getForkMessages();
		const forked = await client.fork(forkFrom!.entryId);
		const third = runtime.session.sessionId;
		expect(forked).toEqual({ cancelled: false, sessionId: third, text: "first prompt" });
		expect(new Set([first, second, third]).size).toBe(3);

		await runtime.session.prompt("fork prompt");
		const cloned = await client.clone();
		const fourth = runtime.session.sessionId;
		expect(cloned).toEqual({ cancelled: false, sessionId: fourth });
		expect(fourth).not.toBe(third);
		await expect(client.getState()).resolves.toMatchObject({ sessionId: fourth });

		expect(responses("new_session")).toEqual([{ cancelled: false, sessionId: second }]);
		expect(responses("switch_session")).toEqual([{ cancelled: false, sessionId: first }]);
		expect(responses("switch_session_by_id")).toEqual([
			{ cancelled: false, sessionId: second },
			{ cancelled: false, sessionId: second },
			{ cancelled: false, sessionId: first },
		]);
		expect(responses("fork")).toEqual([{ cancelled: false, sessionId: third, text: "first prompt" }]);
		expect(responses("clone")).toEqual([{ cancelled: false, sessionId: fourth }]);
	});

	it("responds with only cancelled: true when an extension cancels, and keeps the client on its session", async () => {
		const { runtime, client, responses, cancelNext } = await setup();
		const first = runtime.session.sessionId;
		const created = await client.newSession();
		if (created.cancelled) throw new Error("Expected the new session");
		await client.switchSessionById(first);
		const [forkFrom] = await client.getForkMessages();
		cancelNext(true);

		await expect(client.newSession()).resolves.toEqual({ cancelled: true });
		await expect(client.switchSession(created.sessionId)).resolves.toEqual({ cancelled: true });
		await expect(client.switchSessionById(created.sessionId)).resolves.toEqual({ cancelled: true });
		await expect(client.fork(forkFrom!.entryId)).resolves.toEqual({ cancelled: true });
		await expect(client.clone()).resolves.toEqual({ cancelled: true });

		expect(runtime.session.sessionId).toBe(first);
		await expect(client.getState()).resolves.toMatchObject({ sessionId: first });
		expect(responses("new_session").at(-1)).toEqual({ cancelled: true });
		expect(responses("switch_session")).toEqual([{ cancelled: true }]);
		expect(responses("switch_session_by_id").at(-1)).toEqual({ cancelled: true });
		expect(responses("fork")).toEqual([{ cancelled: true }]);
		expect(responses("clone")).toEqual([{ cancelled: true }]);
	});
});
