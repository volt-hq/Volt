import type { HostFrame, HostRequestKind, LiveItem, RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionError, ExtensionMode, SessionStartEvent } from "../../../src/core/extensions/types.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import type { ProtocolConnection } from "../../../src/core/protocol/server/connection.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
} from "../../../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import { connectTestClient } from "../../utilities/host-client.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { createLiveRecorder } from "../../utilities/live-recorder.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";

const DIALOGS: HostRequestKind[] = ["select", "confirm", "input", "editor", "approval"];

/**
 * A phone stream on a conversation another client already holds, as the daemon
 * serves it or as a TUI relays it: a client whose moves redirect it alone.
 */
async function servePhone(
	host: ConversationHost,
	conversation: HostedConversation,
	tempDir: string,
	grant: RemoteGrant,
): Promise<{ phone: RemotePhone; connection: ProtocolConnection }> {
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		host,
		conversation,
		stream: pair.host,
		grant,
		redaction: { workspacePath: tempDir },
		redirect: {},
	});
	const phone = connectRemotePhone(pair.phone);
	await phone.hello(DIALOGS);
	await connection.ready;
	await phone.subscribe(conversation.id);
	return { phone, connection };
}

/** The live items the phone received. */
function liveItems(phone: RemotePhone): LiveItem[] {
	return phone.frames.flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

/** The host requests the phone was asked, by id. */
function hostRequestIds(phone: RemotePhone): string[] {
	return liveItems(phone).flatMap((item) =>
		item.type === "set" && item.value.kind === "host_request" ? [item.value.requestId] : [],
	);
}

describe("regression #585: a phone relayed through a TUI does not rebind the TUI's extensions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keeps session_start and ctx.mode with the TUI, shares its dialogs first answer wins, and the phone stays when the TUI moves", async () => {
		const starts: SessionStartEvent[] = [];
		const seen: Array<{ event: string; mode: ExtensionMode; hasUI: boolean }> = [];
		const fixture: ExtensionRuntime = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (event, ctx) => {
					starts.push(event);
					seen.push({ event: "session_start", mode: ctx.mode, hasUI: ctx.hasUI });
					ctx.ui.setStatus("ext", `ready:${event.reason}`);
				});
				volt.registerCommand("ask", {
					handler: async (_args, ctx) => {
						seen.push({ event: "ask", mode: ctx.mode, hasUI: ctx.hasUI });
						ctx.ui.notify("asked", "info");
					},
				});
				volt.registerCommand("fail", {
					handler: async () => {
						throw new Error("command failed");
					},
				});
				volt.registerCommand("proceed", {
					handler: async (_args, ctx) => {
						const confirmed = await ctx.ui.confirm("Proceed?", "Either client may answer");
						ctx.ui.notify(confirmed ? "proceeding" : "stopped", "info");
					},
				});
			},
			{ extensionMode: "rpc" },
		);
		cleanups.push(() => fixture.dispose());

		// The TUI attaches first; its host attaches its live view and surface again on each conversation it moves to.
		const tuiLive = createLiveRecorder(DIALOGS);
		const tuiErrors: ExtensionError[] = [];
		const runtime = await connectTestClient(fixture.host, fixture.conversation, {
			id: "tui",
			live: tuiLive,
			surface: { onError: (error) => tuiErrors.push(error) },
		});
		expect(starts.map((event) => event.reason)).toEqual(["startup"]);

		// Serve a phone stream the way the TUI serves a relay offer.
		const { phone, connection } = await servePhone(
			runtime.host,
			runtime.conversation,
			fixture.tempDir,
			createIrohRemotePresetAccess("full").rpcGrant,
		);
		cleanups.push(() => connection.close());

		// The phone's attach binds nothing again: session_start ran once, through the TUI.
		expect(starts.map((event) => event.reason)).toEqual(["startup"]);
		// A host action's approval reaches the TUI and the phone, whose grant manages the host; the first answer wins.
		const approval = runtime.session.hostActions.run({ action: "test.action", title: "Approve?" }, async () => ({
			outcome: "completed",
		}));
		await vi.waitFor(() => expect(tuiLive.pending()).toHaveLength(1));
		const approvalId = tuiLive.pending()[0]!.requestId;
		await vi.waitFor(() => expect(hostRequestIds(phone)).toEqual([approvalId]));
		expect(runtime.conversation.liveState.answer(approvalId, { decision: "approved" }, "tui")).toBe("accepted");
		await expect(approval).resolves.toEqual({ status: "ran", execution: { outcome: "completed" } });
		await vi.waitFor(() =>
			expect(liveItems(phone)).toContainEqual({ type: "clear", key: `host_request/${approvalId}` }),
		);
		const before = phone.frames.length;
		phone.send({ type: "host_response", requestId: approvalId, response: { decision: "denied" } });

		// A dialog the TUI's extension asks reaches the phone too; here the phone answers first.
		const proceeding = runtime.session.prompt("/proceed");
		await vi.waitFor(() => expect(tuiLive.pending().map((pending) => pending.request.kind)).toEqual(["confirm"]));
		const [dialog] = tuiLive.pending();
		await vi.waitFor(() => expect(hostRequestIds(phone)).toContain(dialog!.requestId));
		phone.send({ type: "host_response", requestId: dialog!.requestId, response: { confirmed: true } });
		await proceeding;
		expect(tuiLive.pending()).toEqual([]);
		expect(runtime.conversation.liveState.answer(dialog!.requestId, { confirmed: false }, "tui")).toBe("unknown");

		await runtime.session.prompt("/ask");
		await runtime.session.prompt("/fail");
		expect(tuiLive.notices()).toEqual([
			["info", "proceeding"],
			["info", "asked"],
		]);
		expect(seen).toEqual([
			{ event: "session_start", mode: "rpc", hasUI: true },
			{ event: "ask", mode: "rpc", hasUI: true },
		]);
		// Errors reach every client: the TUI and the phone.
		expect(tuiErrors).toEqual([expect.objectContaining({ extensionId: "test-extension", event: "command" })]);
		await vi.waitFor(() =>
			expect(liveItems(phone)).toContainEqual(
				expect.objectContaining({ type: "notice", level: "error", source: "test-extension" }),
			),
		);
		// The phone's late answer found nothing to answer, and its stream goes on.
		expect(phone.frames.slice(before).some((frame) => frame.type === "fatal")).toBe(false);
		expect(runtime.conversation.liveState.pendingRequests()).toEqual([]);

		// The TUI moves: the phone stays with the session it was on, which closed,
		// and is told to reconnect to it; the new session binds once, through the TUI.
		const sourceId = runtime.session.sessionId;
		await runtime.newSession();
		await phone.ended;
		const ended = phone.frames.filter(
			(frame): frame is Extract<HostFrame, { type: "ended" }> => frame.type === "ended",
		);
		expect(ended).toEqual([{ type: "ended", subscriptionId: "s1", reason: "closed" }]);
		expect(phone.frames.at(-1)).toEqual(ended[0]);
		expect(runtime.session.sessionId).not.toBe(sourceId);
		await runtime.session.prompt("/ask");
		expect(starts.map((event) => event.reason)).toEqual(["startup", "new"]);
		expect(seen.slice(2)).toEqual([
			{ event: "session_start", mode: "rpc", hasUI: true },
			{ event: "ask", mode: "rpc", hasUI: true },
		]);
		expect(tuiLive.notices()).toEqual([
			["info", "proceeding"],
			["info", "asked"],
			["info", "asked"],
		]);
		expect(tuiLive.statuses()).toEqual([
			["test-extension/ext", "ready:startup"],
			["test-extension/ext", "ready:new"],
		]);
		expect(starts).toHaveLength(2);
	});

	it("leaves extension UI with the clients that can answer it when a phone may only observe", async () => {
		const fixture = await createExtensionRuntime((volt) => {
			volt.registerCommand("ask", {
				handler: async (_args, ctx) => {
					const confirmed = await ctx.ui.confirm("Proceed?", "From the first phone");
					ctx.ui.notify(confirmed ? "confirmed" : "declined", "info");
				},
			});
		});
		cleanups.push(() => fixture.dispose());
		const session = fixture.conversation.session;
		const firstPhone = createLiveRecorder(["select", "confirm", "input", "editor"]);
		fixture.conversation.liveState.attach("first-phone", firstPhone);
		await session.attachExtensionClient({ id: "first-phone", mode: "rpc" }).ready;

		// The observer accepts every dialog in its hello; its grant answers none.
		const observer = await servePhone(
			fixture.host,
			fixture.conversation,
			fixture.tempDir,
			createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant,
		);
		cleanups.push(() => observer.connection.close());

		const asked = session.prompt("/ask");
		await vi.waitFor(() => expect(firstPhone.pending().map((pending) => pending.request.kind)).toEqual(["confirm"]));
		const [request] = firstPhone.pending();
		expect(fixture.conversation.liveState.answer(request!.requestId, { confirmed: true }, "first-phone")).toBe(
			"accepted",
		);
		await asked;
		expect(firstPhone.notices()).toEqual([["info", "confirmed"]]);
		await vi.waitFor(() =>
			expect(liveItems(observer.phone)).toContainEqual(
				expect.objectContaining({ type: "notice", level: "info", message: "confirmed" }),
			),
		);
		expect(hostRequestIds(observer.phone)).toEqual([]);
	});
});
