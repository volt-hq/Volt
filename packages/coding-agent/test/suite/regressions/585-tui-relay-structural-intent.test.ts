import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { findSessionInfoById, SessionManager } from "../../../src/core/session-manager.ts";
import { runIrohRemoteRpcMode } from "../../../src/modes/rpc/iroh-remote-rpc-mode.ts";
import {
	createTestIrohConversationOptions,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
	withCurrentConversationAuthority,
} from "../../iroh-stream-doubles.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";

interface LifecycleEvent {
	type: string;
	sessionId: string;
}

/** A phone relayed through the TUI: served on a view of the TUI's session that stays on it. */
function servePhone(view: AgentSessionRuntime, tempDir: string) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const ready = Promise.withResolvers<void>();
	const sessionId = view.session.sessionId;
	const closed = runIrohRemoteRpcMode(view, {
		...createTestIrohConversationOptions(view),
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		stream: { recv, send },
		disposeRuntimeOnClose: false,
		suppressExtensionUiRequests: true,
		detachedTerminal: (detachment) => ({
			type: "remote_terminal",
			reason: detachment.kind === "redirected" ? "conversation_moved" : "lease_transferred",
			workspace: "test",
			sessionId,
			...(detachment.kind === "redirected" ? { targetSessionId: detachment.sessionId } : {}),
		}),
		workspacePath: tempDir,
		onReady: ready.resolve,
	});
	return { recv, send, closed, ready: Promise.race([ready.promise, closed]) };
}

/** The new log is stored and unlocked, for the daemon to open when the phone reconnects. */
async function expectStoredAndUnlocked(sessionDir: string, sessionId: string): Promise<void> {
	expect(await findSessionInfoById(sessionDir, sessionId)).toBeDefined();
	const probe = ConversationLock.tryAcquire(sessionDir, sessionId);
	expect(probe.status).toBe("acquired");
	if (probe.status === "acquired") probe.lock.close();
}

describe("regression #585: a phone relayed through a TUI changes sessions alone", () => {
	const cleanups: Array<() => Promise<void>> = [];
	let events: LifecycleEvent[] = [];
	let cancelSwitch = false;

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		events = [];
		cancelSwitch = false;
	});

	async function createTuiRuntime(): Promise<ExtensionRuntime> {
		const fixture = await createExtensionRuntime((volt) => {
			volt.on("session_start", (_event, ctx) => {
				events.push({ type: "session_start", sessionId: ctx.sessionManager.getSessionId() });
			});
			volt.on("session_before_switch", (_event, ctx) => {
				events.push({ type: "session_before_switch", sessionId: ctx.sessionManager.getSessionId() });
				return cancelSwitch ? { cancel: true } : undefined;
			});
			volt.on("session_shutdown", (_event, ctx) => {
				events.push({ type: "session_shutdown", sessionId: ctx.sessionManager.getSessionId() });
			});
		});
		cleanups.push(() => fixture.dispose());
		// The TUI is the session's anchor client.
		await fixture.runtime.session.attachExtensionClient({ id: "tui", mode: "tui" }).ready;
		return fixture;
	}

	it("answers new_session, then redirects the phone to the new log while the TUI stays", async () => {
		const { runtime, tempDir } = await createTuiRuntime();
		const sourceId = runtime.session.sessionId;
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const view = runtime.attachRedirectClient();
		cleanups.push(() => view.dispose());
		const phone = servePhone(view, tempDir);
		cleanups.push(async () => {
			phone.recv.end();
			await phone.closed.catch(() => undefined);
		});
		await phone.ready;
		events = [];

		phone.recv.pushLine(
			JSON.stringify(withCurrentConversationAuthority(phone.send, { id: "n1", type: "new_session" })),
		);
		await phone.closed;

		const frames = parseWrittenObjects(phone.send);
		const response = frames.find((frame) => frame.type === "response" && frame.command === "new_session");
		expect(response).toMatchObject({ id: "n1", success: true, data: { cancelled: false } });
		const targetId = (response?.data as { sessionId: string }).sessionId;
		expect(targetId).not.toBe(sourceId);
		// The response comes first; the redirect ends the stream.
		expect(frames.at(-1)).toEqual({
			type: "remote_terminal",
			reason: "conversation_moved",
			workspace: "test",
			sessionId: sourceId,
			targetSessionId: targetId,
		});
		expect(phone.send.finished).toBe(true);

		// The TUI stays on its session; the new conversation never opened here.
		expect(runtime.session.sessionId).toBe(sourceId);
		expect(events).toEqual([{ type: "session_before_switch", sessionId: sourceId }]);
		await expectStoredAndUnlocked(sessionDir, targetId);
		await runtime.session.prompt("still here");
		expect(runtime.session.sessionId).toBe(sourceId);
	});

	it("writes the log of an intent the phone's extension command starts, without running withSession here", async () => {
		const { runtime } = await createTuiRuntime();
		const sourceId = runtime.session.sessionId;
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		await runtime.session.prompt("first question");
		const userEntry = runtime.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("the user message is missing");

		const newView = runtime.attachRedirectClient();
		cleanups.push(() => newView.dispose());
		const detachments: unknown[] = [];
		newView.onClientDetached((detachment) => detachments.push(detachment));
		const withSession = vi.fn(async () => {});
		const created = await newView.newSession({
			setup: (writer) => writer.appendSessionInfo("from the phone"),
			withSession,
		});
		if (created.cancelled) throw new Error("the new session was cancelled");
		expect(created.seeded).toBe(false);
		expect(withSession).not.toHaveBeenCalled();
		expect(detachments).toEqual([{ kind: "redirected", sessionId: created.sessionId }]);
		await expectStoredAndUnlocked(sessionDir, created.sessionId);
		const createdInfo = await findSessionInfoById(sessionDir, created.sessionId);
		if (!createdInfo) throw new Error("the new session is not stored");
		const createdLog = await SessionManager.openReadOnly(createdInfo.ref);
		expect(createdLog.getSessionName()).toBe("from the phone");
		await createdLog.closePersistence();
		// A redirected view takes no further session changes.
		await expect(newView.newSession()).rejects.toThrow("no longer accepting structural operations");

		const forkView = runtime.attachRedirectClient();
		cleanups.push(() => forkView.dispose());
		const forked = await forkView.fork(userEntry.id);
		if (forked.cancelled) throw new Error("the fork was cancelled");
		expect(forked.selectedText).toBe("first question");
		const forkedInfo = await findSessionInfoById(sessionDir, forked.sessionId);
		if (!forkedInfo) throw new Error("the fork is not stored");
		const forkedLog = await SessionManager.openReadOnly(forkedInfo.ref);
		expect(forkedLog.getForkedFrom()).toEqual({ sessionId: sourceId, entryId: userEntry.parentId });
		await forkedLog.closePersistence();

		const switchView = runtime.attachRedirectClient();
		cleanups.push(() => switchView.dispose());
		const switched = await switchView.switchSession(createdInfo.ref);
		expect(switched).toEqual({ cancelled: false, sessionId: created.sessionId, seeded: false });

		expect(runtime.session.sessionId).toBe(sourceId);
		expect(events.filter((event) => event.type !== "session_before_switch")).toEqual([
			{ type: "session_start", sessionId: sourceId },
		]);
	});

	it("keeps the phone on the session when the TUI's extensions cancel the switch", async () => {
		const { runtime, tempDir } = await createTuiRuntime();
		const view = runtime.attachRedirectClient();
		cleanups.push(() => view.dispose());
		const phone = servePhone(view, tempDir);
		cleanups.push(async () => {
			phone.recv.end();
			await phone.closed.catch(() => undefined);
		});
		await phone.ready;
		cancelSwitch = true;

		phone.recv.pushLine(
			JSON.stringify(withCurrentConversationAuthority(phone.send, { id: "n1", type: "new_session" })),
		);
		await vi.waitFor(() =>
			expect(parseWrittenObjects(phone.send)).toContainEqual(
				expect.objectContaining({ id: "n1", command: "new_session", success: true, data: { cancelled: true } }),
			),
		);
		expect(parseWrittenObjects(phone.send).some((frame) => frame.type === "remote_terminal")).toBe(false);
		expect(phone.send.finished).toBe(false);
	});

	it("refuses to execute a plan in a new session from a relayed phone", async () => {
		const { runtime } = await createTuiRuntime();
		const view = runtime.attachRedirectClient();
		cleanups.push(() => view.dispose());

		await expect(view.executePlan("plan", 1, "new_session")).rejects.toThrow(
			"Executing a plan in a new session is unavailable while this session is open on the desktop",
		);
	});
});
