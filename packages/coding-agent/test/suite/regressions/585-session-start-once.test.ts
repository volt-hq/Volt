import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionMode, SessionStartEvent } from "../../../src/core/extensions/types.ts";
import { ClientScope } from "../../../src/core/host/client-scope.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/index.ts";
import type { RpcClientEvent } from "../../../src/modes/rpc/rpc-client-base.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { RpcTransportClient } from "../../../src/modes/rpc/rpc-transport-client.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";
import { createHarness } from "../harness.ts";

interface ConnectedClient {
	client: RpcTransportClient;
	events: RpcClientEvent[];
	ready: Promise<void>;
	closed: Promise<void>;
}

/** An RPC client sharing the conversation with others; the fixture's host keeps it open. */
async function open(fixture: ExtensionRuntime): Promise<ConnectedClient> {
	const pair = createLoopbackRpcTransportPair();
	const client = new RpcTransportClient({ transport: pair.client });
	const events: RpcClientEvent[] = [];
	client.onEvent((event) => events.push(event));
	await client.start();
	const ready = Promise.withResolvers<void>();
	const closed = runRpcMode(fixture.host, fixture.conversation, {
		transport: pair.server,
		anchor: false,
		onReady: ready.resolve,
	});
	const readyOrClosed = Promise.race([ready.promise, closed]);
	// A client that closes during startup rejects both; tests await the one they assert on.
	readyOrClosed.catch(() => undefined);
	return { client, events, ready: readyOrClosed, closed };
}

async function connect(fixture: ExtensionRuntime): Promise<ConnectedClient> {
	const connected = await open(fixture);
	await connected.ready;
	return connected;
}

function uiRequests(events: RpcClientEvent[], method: string): RpcClientEvent[] {
	return events.filter((event) => event.type === "extension_ui_request" && event.method === method);
}

function extensionErrors(events: RpcClientEvent[]): RpcClientEvent[] {
	return events.filter((event) => event.type === "extension_error");
}

describe("regression #585: a session's extensions are bound once", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{
		fixture: ExtensionRuntime;
		starts: SessionStartEvent[];
		modes: ExtensionMode[];
		leaves: string[];
	}> {
		const starts: SessionStartEvent[] = [];
		const modes: ExtensionMode[] = [];
		const leaves: string[] = [];
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (event, ctx) => {
					starts.push(event);
					modes.push(ctx.mode);
					ctx.ui.setStatus("ext", `ready:${event.reason}`);
				});
				volt.registerCommand("ping", { handler: async (_args, ctx) => ctx.ui.notify("pong", "info") });
				volt.registerCommand("fail", {
					handler: async () => {
						throw new Error("command failed");
					},
				});
				volt.registerCommand("leave", {
					handler: async (_args, ctx) => {
						ctx.shutdown();
						leaves.push("leave");
					},
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());
		return { fixture, starts, modes, leaves };
	}

	it("emits session_start once for two RPC clients and once for the session a client opens", async () => {
		const { fixture, starts, modes } = await setup();
		const first = await connect(fixture);
		const second = await connect(fixture);
		cleanups.push(async () => {
			await first.client.stop();
			await second.client.stop();
		});

		expect(starts.map((event) => event.reason)).toEqual(["startup"]);
		expect(modes).toEqual(["rpc"]);

		const opened = await first.client.newSession();
		if (opened.cancelled) throw new Error("Expected the first client to move");
		await expect(first.client.getState()).resolves.toMatchObject({ sessionId: opened.sessionId });
		expect(starts.map((event) => event.reason)).toEqual(["startup", "new"]);
		expect(modes).toEqual(["rpc", "rpc"]);
		// The first client moved alone; the second stays, and neither conversation binds twice.
		await expect(second.client.getState()).resolves.toMatchObject({ sessionId: fixture.conversation.id });
		expect(starts).toHaveLength(2);
	});

	it("routes UI to the last attached client, replays status, and fans errors out to every client", async () => {
		const { fixture, leaves } = await setup();
		const first = await connect(fixture);
		const second = await connect(fixture);
		cleanups.push(async () => {
			await first.client.stop();
			await second.client.stop();
		});

		// session_start ran while only the first client was attached; the second one received the status on attach.
		expect(uiRequests(first.events, "setStatus")).toEqual([
			expect.objectContaining({ statusKey: "ext", statusText: "ready:startup" }),
		]);
		expect(uiRequests(second.events, "setStatus")).toEqual([
			expect.objectContaining({ statusKey: "ext", statusText: "ready:startup" }),
		]);

		await first.client.prompt("/ping");
		await vi.waitFor(() =>
			expect(uiRequests(second.events, "notify")).toEqual([expect.objectContaining({ message: "pong" })]),
		);
		expect(uiRequests(first.events, "notify")).toEqual([]);

		await first.client.prompt("/fail");
		for (const events of [first.events, second.events]) {
			await vi.waitFor(() =>
				expect(extensionErrors(events)).toEqual([
					expect.objectContaining({ extensionPath: "command:fail", error: "command failed" }),
				]),
			);
		}

		// The client whose command asked for shutdown leaves at its next command boundary; the other stays.
		await second.client.prompt("/leave");
		await vi.waitFor(() => expect(leaves).toEqual(["leave"]));
		await second.client.getState().catch(() => undefined);
		await second.closed;
		await expect(first.client.getState()).resolves.toMatchObject({ sessionId: fixture.conversation.id });

		// The remaining client shows UI again and is brought up to date.
		expect(uiRequests(first.events, "setStatus")).toHaveLength(2);
		await first.client.prompt("/ping");
		await vi.waitFor(() =>
			expect(uiRequests(first.events, "notify")).toEqual([expect.objectContaining({ message: "pong" })]),
		);
	});

	it("routes session actions to the invoking client and drops them once it leaves", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.registerCommand("leave-now", { handler: async (_args, ctx) => ctx.shutdown() });
					volt.registerCommand("leave-later", {
						handler: async (_args, ctx) => {
							await gate.promise;
							ctx.shutdown();
						},
					});
				},
			],
		});
		cleanups.push(async () => harness.cleanup());
		const anchorShutdown = vi.fn();
		const phoneShutdown = vi.fn();
		await harness.session.attachExtensionClient({ id: "anchor", mode: "rpc", shutdownHandler: anchorShutdown }).ready;
		const phone = harness.session.attachExtensionClient({
			id: "phone",
			mode: "rpc",
			shutdownHandler: phoneShutdown,
		});
		await phone.ready;

		// Outside any client scope the anchor acts; inside the phone's scope the phone does.
		await harness.session.prompt("/leave-now");
		await ClientScope.run("phone", () => harness.session.prompt("/leave-now"));
		expect(anchorShutdown).toHaveBeenCalledOnce();
		expect(phoneShutdown).toHaveBeenCalledOnce();

		// Work the phone started outlives it, but its actions never fall through to the anchor.
		const running = ClientScope.run("phone", () => harness.session.prompt("/leave-later"));
		phone.detach();
		gate.resolve();
		await running;
		expect(anchorShutdown).toHaveBeenCalledOnce();
		expect(phoneShutdown).toHaveBeenCalledOnce();
	});

	it("lets a client leave while the first client's bind is still running", async () => {
		const gate = Promise.withResolvers<void>();
		const fixture = await createExtensionRuntime((volt) => {
			volt.on("session_start", async () => {
				await gate.promise;
			});
		});
		cleanups.push(() => fixture.dispose());
		const first = await open(fixture);
		const second = await open(fixture);
		cleanups.push(async () => {
			gate.resolve();
			await first.client.stop();
			await second.client.stop();
		});

		// The second client gives up during startup without waiting for the first client's session_start.
		await second.client.stop();
		await expect(second.closed).rejects.toThrow("RPC transport closed during startup");

		gate.resolve();
		await first.ready;
		await expect(first.client.getState()).resolves.toMatchObject({ sessionId: fixture.conversation.id });
	});
});
