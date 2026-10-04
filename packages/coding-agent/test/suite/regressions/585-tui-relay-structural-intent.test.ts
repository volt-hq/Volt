import { randomUUID } from "node:crypto";
import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { executePlan } from "../../../src/core/host/plan-handoff.ts";
import { openFork, openNewSession, openStoredSession } from "../../../src/core/host/session-intents.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { PLAN_EXECUTION_CUSTOM_TYPE } from "../../../src/core/planning.ts";
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
import { connectTestClient, type TestClient } from "../../utilities/host-client.ts";
import { createExtensionRuntime } from "../extension-runtime.ts";

interface LifecycleEvent {
	type: string;
	sessionId: string;
}

/** A phone relayed through the TUI: a client of the TUI's conversation that its moves redirect alone. */
function servePhone(host: ConversationHost, conversation: HostedConversation, tempDir: string) {
	const recv = new ManualIrohRecvStream();
	const send = new ManualIrohSendStream();
	const ready = Promise.withResolvers<void>();
	const sessionId = conversation.id;
	const closed = runIrohRemoteRpcMode(host, conversation, {
		...createTestIrohConversationOptions(conversation),
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
		stream: { recv, send },
		redirect: {},
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

	/** The TUI as its conversation's anchor client, in a host that binds extensions in TUI mode. */
	async function createTuiRuntime(): Promise<{ runtime: TestClient; tempDir: string }> {
		const fixture = await createExtensionRuntime(
			(volt) => {
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
			},
			{ extensionMode: "tui" },
		);
		cleanups.push(() => fixture.dispose());
		const runtime = await connectTestClient(fixture.host, fixture.conversation, { id: "tui", surface: {} });
		return { runtime, tempDir: fixture.tempDir };
	}

	/** A relayed phone attached to the TUI's conversation; `detachments` records where it was redirected. */
	async function attachPhone(runtime: TestClient): Promise<{ phone: HostClient; detachments: unknown[] }> {
		const detachments: unknown[] = [];
		const phone: HostClient = {
			id: randomUUID(),
			move: {
				kind: "redirect",
				redirect: (sessionId) => void detachments.push({ kind: "redirected", sessionId }),
			},
		};
		await runtime.host.attach(phone, runtime.conversation);
		return { phone, detachments };
	}

	it("answers new_session, then redirects the phone to the new log while the TUI stays", async () => {
		const { runtime, tempDir } = await createTuiRuntime();
		const sourceId = runtime.session.sessionId;
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		const phone = servePhone(runtime.host, runtime.conversation, tempDir);
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

		const { phone: newPhone, detachments } = await attachPhone(runtime);
		const withSession = vi.fn(async () => {});
		const created = await openNewSession(runtime.host, newPhone, {
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
		// A redirected client left the host: it takes no further session changes.
		expect(runtime.host.conversationOf(newPhone)).toBeUndefined();
		await expect(openNewSession(runtime.host, newPhone)).rejects.toThrow("not attached");

		const { phone: forkPhone } = await attachPhone(runtime);
		const forked = await openFork(runtime.host, forkPhone, userEntry.id);
		if (forked.cancelled) throw new Error("the fork was cancelled");
		expect(forked.selectedText).toBe("first question");
		const forkedInfo = await findSessionInfoById(sessionDir, forked.sessionId);
		if (!forkedInfo) throw new Error("the fork is not stored");
		const forkedLog = await SessionManager.openReadOnly(forkedInfo.ref);
		expect(forkedLog.getForkedFrom()).toEqual({ sessionId: sourceId, entryId: userEntry.parentId });
		await forkedLog.closePersistence();

		const { phone: switchPhone } = await attachPhone(runtime);
		const switched = await openStoredSession(runtime.host, switchPhone, createdInfo.ref);
		expect(switched).toEqual({ cancelled: false, sessionId: created.sessionId, seeded: false });

		expect(runtime.session.sessionId).toBe(sourceId);
		expect(events.filter((event) => event.type !== "session_before_switch")).toEqual([
			{ type: "session_start", sessionId: sourceId },
		]);
	});

	it("keeps the phone on the session when the TUI's extensions cancel the switch", async () => {
		const { runtime, tempDir } = await createTuiRuntime();
		const phone = servePhone(runtime.host, runtime.conversation, tempDir);
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

	it("executes a plan in a new session from a relayed phone: the new log queues the execution turn", async () => {
		const { runtime } = await createTuiRuntime();
		const sourceId = runtime.session.sessionId;
		const sessionDir = runtime.session.sessionManager.getSessionDir();
		await runtime.session.setAgentMode("plan");
		const draft = await runtime.session.updatePlan({
			title: "From the phone",
			summary: "Execute in a fresh session.",
			steps: [{ text: "Make the change" }],
		});
		const ready = await runtime.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "From the phone",
			summary: "Execute in a fresh session.",
		});
		const { phone } = await attachPhone(runtime);

		const result = await executePlan(runtime.host, phone, ready.id, ready.revision, "new_session");

		expect(result.started).toBe(true);
		expect(result.selectedSessionId).not.toBe(sourceId);
		// The TUI stays on its session, whose plan is handed off.
		expect(runtime.session.sessionId).toBe(sourceId);
		expect(runtime.session.planningState.plan).toMatchObject({ id: ready.id, phase: "handed_off" });
		await expectStoredAndUnlocked(sessionDir, result.selectedSessionId);
		const info = await findSessionInfoById(sessionDir, result.selectedSessionId);
		if (!info) throw new Error("the new session is not stored");
		const written = await SessionManager.openReadOnly(info.ref);
		expect(written.getConversationState().planning?.plan).toMatchObject({ id: ready.id, phase: "active" });
		expect(clientInputRecovery(written.getConversationState())).toMatchObject({
			kind: "replay",
			records: [{ origin: "host", queuedInput: { messages: [{ customType: PLAN_EXECUTION_CUSTOM_TYPE }] } }],
		});
		await written.closePersistence();
	});
});
