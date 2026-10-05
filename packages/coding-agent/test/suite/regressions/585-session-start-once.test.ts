import type { HostFrame, HostRequestKind, LiveItem, LiveValue } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtocolClient } from "../../../src/client/protocol-client.ts";
import type { ExtensionMode, SessionStartEvent } from "../../../src/core/extensions/types.ts";
import { ClientScope } from "../../../src/core/host/client-scope.ts";
import { localProfile } from "../../../src/core/protocol/profiles.ts";
import { type ProtocolConnection, serveConnection } from "../../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/protocol/transport/index.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";
import { createHarness } from "../harness.ts";

interface ConnectedClient {
	client: ProtocolClient;
	frames: HostFrame[];
	connection: ProtocolConnection;
	/** Resolves once the client caught up and the conversation's extensions are bound for it. */
	ready: Promise<void>;
	closed: Promise<void>;
}

/**
 * A protocol client sharing the conversation with others, as stdio RPC serves
 * one: an extension's shutdown request ends its connection. The fixture's host
 * keeps the conversation open.
 */
function open(fixture: ExtensionRuntime, hostRequests: readonly HostRequestKind[] = []): ConnectedClient {
	const pair = createLoopbackRpcTransportPair();
	const frames: HostFrame[] = [];
	const client = new ProtocolClient({ hostRequests, onFrame: (frame) => frames.push(frame) });
	const connection: ProtocolConnection = serveConnection(pair.server, localProfile, {
		host: fixture.host,
		conversation: fixture.conversation,
		anchor: false,
		onShutdownRequested: () => void connection.shutdown(),
	});
	const ready = Promise.all([client.connect(pair.client), connection.ready]).then(() => undefined);
	// A client that closes during startup rejects; tests await what they assert on.
	ready.catch(() => undefined);
	return { client, frames, connection, ready, closed: connection.closed };
}

async function connect(fixture: ExtensionRuntime, hostRequests: readonly HostRequestKind[] = []) {
	const connected = open(fixture, hostRequests);
	await connected.ready;
	return connected;
}

function liveItems(frames: HostFrame[]): LiveItem[] {
	return frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

/** Every time the client was told the extension status `key`. */
function statusSets(frames: HostFrame[], key: string): LiveValue[] {
	return liveItems(frames).flatMap((item) =>
		item.type === "set" && item.key === `ext_status/test-extension/${key}` ? [item.value] : [],
	);
}

function notices(frames: HostFrame[], level: "info" | "error"): Array<Extract<LiveItem, { type: "notice" }>> {
	return liveItems(frames).filter(
		(item): item is Extract<LiveItem, { type: "notice" }> => item.type === "notice" && item.level === level,
	);
}

/** The pending confirm dialog in the client's live state. */
function pendingConfirm(client: ProtocolClient): Extract<LiveValue, { kind: "host_request" }> | undefined {
	for (const value of client.live.values.values()) {
		if (value.kind === "host_request" && value.request.kind === "confirm") return value;
	}
	return undefined;
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

	it("emits session_start once for two protocol clients and once for the session a client opens", async () => {
		const { fixture, starts, modes } = await setup();
		const first = await connect(fixture);
		const second = await connect(fixture);
		cleanups.push(async () => {
			await first.client.stop();
			await second.client.stop();
		});

		expect(starts.map((event) => event.reason)).toEqual(["startup"]);
		expect(modes).toEqual(["rpc"]);

		const opened = await first.client.intent("new_session", {});
		if (opened.conversation === undefined) throw new Error("Expected the first client to move");
		await vi.waitFor(() => expect(first.client.conversation).toBe(opened.conversation));
		await first.client.caughtUp();
		expect(starts.map((event) => event.reason)).toEqual(["startup", "new"]);
		expect(modes).toEqual(["rpc", "rpc"]);
		// The first client moved alone; the second stays, and neither conversation binds twice.
		expect(second.client.conversation).toBe(fixture.conversation.id);
		expect(fixture.conversation.closed).toBe(false);
		expect(starts).toHaveLength(2);
	});

	it("shows extension UI on every client, replays status on attach, and fans errors out to every client", async () => {
		const { fixture, leaves } = await setup();
		const first = await connect(fixture);
		const second = await connect(fixture);
		cleanups.push(async () => {
			await first.client.stop();
			await second.client.stop();
		});

		// session_start ran while only the first client was attached; the second one received the status on attach.
		for (const client of [first, second]) {
			const status = { kind: "ext_status", extension: "test-extension", text: "ready:startup" };
			expect(statusSets(client.frames, "ext")).toEqual([status]);
			expect(client.client.live.values.get("ext_status/test-extension/ext")).toEqual(status);
		}

		await first.client.prompt("/ping");
		for (const client of [first, second]) {
			await vi.waitFor(() =>
				expect(notices(client.frames, "info")).toEqual([expect.objectContaining({ message: "pong" })]),
			);
		}

		await first.client.prompt("/fail").catch(() => undefined);
		for (const client of [first, second]) {
			await vi.waitFor(() =>
				expect(notices(client.frames, "error")).toEqual([
					expect.objectContaining({
						source: "test-extension",
						message: expect.stringContaining("command failed"),
					}),
				]),
			);
		}

		// The client whose command asked for shutdown leaves; the other stays.
		await second.client.prompt("/leave").catch(() => undefined);
		await vi.waitFor(() => expect(leaves).toEqual(["leave"]));
		await second.closed;
		expect(second.frames.at(-1)).toMatchObject({ type: "ended", reason: "shutdown" });
		expect(fixture.conversation.closed).toBe(false);
		expect(first.client.conversation).toBe(fixture.conversation.id);

		// The remaining client kept showing UI all along.
		expect(statusSets(first.frames, "ext")).toHaveLength(1);
		await first.client.prompt("/ping");
		await vi.waitFor(() => expect(notices(first.frames, "info")).toHaveLength(2));
	});

	it("asks every client that shows UI, takes the first answer, and shows a pending dialog to a client that attaches", async () => {
		const answers: boolean[] = [];
		const fixture = await createExtensionRuntime(
			(volt) => {
				volt.registerCommand("ask", {
					handler: async (_args, ctx) => {
						answers.push(await ctx.ui.confirm("Proceed?", "Continue with the change?"));
					},
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());
		const first = await connect(fixture, ["confirm"]);
		const second = await connect(fixture, ["confirm"]);
		cleanups.push(async () => {
			await first.client.stop();
			await second.client.stop();
		});

		// The command's prompt is admitted once the command ran: it waits for the answer.
		const asking = first.client.prompt("/ask");
		await vi.waitFor(() => {
			expect(pendingConfirm(first.client)).toMatchObject({
				request: { kind: "confirm", title: "Proceed?", message: "Continue with the change?" },
			});
			expect(pendingConfirm(second.client)).toEqual(pendingConfirm(first.client));
		});
		const requestId = pendingConfirm(first.client)!.requestId;

		// A client that attaches while the dialog is pending is shown it too.
		const third = await connect(fixture, ["confirm"]);
		cleanups.push(async () => third.client.stop());
		expect(pendingConfirm(third.client)).toEqual(pendingConfirm(first.client));

		// The first answer wins; a later one finds the dialog gone.
		second.client.answer(requestId, { confirmed: true });
		await vi.waitFor(() => expect(answers).toEqual([true]));
		first.client.answer(requestId, { confirmed: false });
		await asking;
		await vi.waitFor(() => expect(pendingConfirm(first.client)).toBeUndefined());
		expect(first.client.conversation).toBe(fixture.conversation.id);
		expect(answers).toEqual([true]);
		expect(fixture.conversation.liveState.pendingRequests()).toEqual([]);
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
		const first = open(fixture);
		const second = open(fixture);
		cleanups.push(async () => {
			gate.resolve();
			await first.client.stop();
			await second.client.stop();
		});

		// The second client gives up during startup without waiting for the first client's session_start.
		await second.client.stop();
		await second.closed;
		await expect(second.ready).rejects.toThrow();

		gate.resolve();
		await first.ready;
		expect(first.client.conversation).toBe(fixture.conversation.id);
		expect(fixture.conversation.closed).toBe(false);
	});
});
