import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionError, ExtensionMode, SessionStartEvent } from "../../../src/core/extensions/types.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import {
	createIrohRemoteExplicitAccess,
	createIrohRemotePresetAccess,
} from "../../../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteRpcGrant } from "../../../src/core/remote/iroh/index.ts";
import { runIrohRemoteRpcMode } from "../../../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestIrohConversationOptions,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
} from "../../iroh-stream-doubles.ts";
import { connectTestClient } from "../../utilities/host-client.ts";
import { createLiveRecorder } from "../../utilities/live-recorder.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";

/**
 * A phone stream on a conversation another client already holds, as the daemon
 * serves it or as a TUI relays it: a client whose moves redirect it alone.
 */
function servePhone(
	host: ConversationHost,
	conversation: HostedConversation,
	tempDir: string,
	options: { rpcGrant: IrohRemoteRpcGrant; relayed: boolean },
): { recv: ManualIrohRecvStream; send: ManualIrohSendStream; closed: Promise<void>; ready: Promise<void> } {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const ready = Promise.withResolvers<void>();
	const sessionId = conversation.id;
	const closed = runIrohRemoteRpcMode(host, conversation, {
		...createTestIrohConversationOptions(conversation),
		rpcGrant: options.rpcGrant,
		stream: { recv, send },
		redirect: {},
		suppressExtensionUiRequests: options.relayed,
		detachedTerminal: (detachment) => ({
			type: "remote_terminal",
			reason: detachment.kind === "redirected" ? "conversation_moved" : "lease_transferred",
			workspace: "test",
			sessionId,
		}),
		workspacePath: tempDir,
		onReady: ready.resolve,
	});
	return { recv, send, closed, ready: Promise.race([ready.promise, closed]) };
}

describe("regression #585: a phone relayed through a TUI does not rebind the TUI's extensions", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("keeps session_start, ctx.mode, extension UI, and host actions with the TUI; the phone stays when the TUI moves", async () => {
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
			},
			{ extensionMode: "tui" },
		);
		cleanups.push(() => fixture.dispose());

		// The TUI attaches first; its host attaches its live view and surface again on each conversation it moves to.
		const tuiLive = createLiveRecorder(["select", "confirm", "input", "editor", "approval"]);
		const tuiErrors: ExtensionError[] = [];
		const runtime = await connectTestClient(fixture.host, fixture.conversation, {
			id: "tui",
			live: tuiLive,
			surface: { onError: (error) => tuiErrors.push(error) },
		});
		expect(starts.map((event) => event.reason)).toEqual(["startup"]);

		// Serve a phone stream the way the TUI serves a relay offer.
		const {
			recv,
			send,
			closed: phone,
			ready,
		} = servePhone(runtime.host, runtime.conversation, fixture.tempDir, {
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			relayed: true,
		});
		cleanups.push(async () => {
			recv.end();
			await phone.catch(() => undefined);
		});
		await ready;

		expect(starts.map((event) => event.reason)).toEqual(["startup"]);
		// Approvals stay with the TUI, which answers them.
		const approval = runtime.conversation.liveState.hostInteraction.requestAction({
			id: "relay-approval",
			action: "test.action",
			title: "Approve?",
		});
		expect(tuiLive.pending().map((pending) => pending.requestId)).toEqual(["relay-approval"]);
		expect(runtime.conversation.liveState.answer("relay-approval", { decision: "approved" }, "tui")).toBe("accepted");
		await expect(approval).resolves.toEqual({ decision: "approved" });
		await runtime.session.prompt("/ask");
		await runtime.session.prompt("/fail");
		expect(tuiLive.notices()).toEqual([["info", "asked"]]);
		expect(seen).toEqual([
			{ event: "session_start", mode: "tui", hasUI: true },
			{ event: "ask", mode: "tui", hasUI: true },
		]);
		// Errors reach every client: the TUI and the phone.
		expect(tuiErrors).toEqual([expect.objectContaining({ extensionPath: "command:fail" })]);
		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({ type: "extension_error", extensionPath: "command:fail" }),
			),
		);

		// The TUI moves: the phone stays with the session it was on, which closed,
		// and is told to reconnect to it; the new session binds once, through the TUI.
		const sourceId = runtime.session.sessionId;
		await runtime.newSession();
		await phone;
		expect(parseWrittenObjects(send).at(-1)).toEqual({
			type: "remote_terminal",
			reason: "lease_transferred",
			workspace: "test",
			sessionId: sourceId,
		});
		await runtime.session.prompt("/ask");
		expect(starts.map((event) => event.reason)).toEqual(["startup", "new"]);
		expect(seen.slice(2)).toEqual([
			{ event: "session_start", mode: "tui", hasUI: true },
			{ event: "ask", mode: "tui", hasUI: true },
		]);
		expect(tuiLive.notices()).toEqual([
			["info", "asked"],
			["info", "asked"],
		]);
		expect(tuiLive.statuses()).toEqual([
			["ext", "ready:startup"],
			["ext", "ready:new"],
		]);
		expect(starts).toHaveLength(2);
		expect(
			parseWrittenObjects(send).filter(
				(frame) => frame.type === "extension_ui_request" || frame.type === "host_action_request",
			),
		).toEqual([]);
	});

	it("leaves extension UI with the clients that can answer it when a phone may only observe", async () => {
		const fixture = await createExtensionRuntime((volt) => {
			volt.registerCommand("ask", { handler: async (_args, ctx) => ctx.ui.notify("asked", "info") });
		});
		cleanups.push(() => fixture.dispose());
		const session = fixture.conversation.session;
		const firstPhone = createLiveRecorder(["select", "confirm", "input", "editor"]);
		fixture.conversation.liveState.attach("first-phone", firstPhone);
		await session.attachExtensionClient({ id: "first-phone", mode: "rpc" }).ready;

		const observer = servePhone(fixture.host, fixture.conversation, fixture.tempDir, {
			rpcGrant: createIrohRemoteExplicitAccess([], ["conversation.observe.v1"]).rpcGrant,
			relayed: false,
		});
		cleanups.push(async () => {
			observer.recv.end();
			await observer.closed.catch(() => undefined);
		});
		await observer.ready;

		await session.prompt("/ask");
		expect(firstPhone.notices()).toEqual([["info", "asked"]]);
		expect(parseWrittenObjects(observer.send).filter((frame) => frame.type === "extension_ui_request")).toEqual([]);
	});
});
