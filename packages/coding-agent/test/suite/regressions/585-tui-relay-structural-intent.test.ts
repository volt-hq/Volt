import { randomUUID } from "node:crypto";
import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import { executePlan } from "../../../src/core/host/plan-handoff.ts";
import { openFork, openNewSession, openStoredSession } from "../../../src/core/host/session-intents.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { PLAN_EXECUTION_CUSTOM_TYPE } from "../../../src/core/planning.ts";
import { findSessionInfoById, SessionManager } from "../../../src/core/session-manager.ts";
import type { RemotePhone } from "../../utilities/remote-phone.ts";
import { connectRelayedPhone, createTuiHarness, relayPhone, relayPreamble, type TuiHarness } from "../tui-harness.ts";

/** The new log is stored and unlocked, for the daemon to open when the phone reconnects. */
async function expectStoredAndUnlocked(sessionDir: string, sessionId: string): Promise<void> {
	expect(await findSessionInfoById(sessionDir, sessionId)).toBeDefined();
	const probe = ConversationLock.tryAcquire(sessionDir, sessionId);
	expect(probe.status).toBe("acquired");
	if (probe.status === "acquired") probe.lock.close();
}

describe("regression #585: a phone beside a TUI in one host changes sessions alone", () => {
	const harnesses: TuiHarness[] = [];
	let cancelSwitch = false;

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		cancelSwitch = false;
	});

	/** The host with the TUI's client connected; its extensions may cancel a switch. */
	async function createTui() {
		const harness = await createTuiHarness({
			extension: (volt) => {
				volt.on("session_before_switch", () => (cancelSwitch ? { cancel: true } : undefined));
			},
		});
		harnesses.push(harness);
		const client = await harness.connect();
		return { harness, client };
	}

	/** A phone the daemon relays into the conversation the TUI shows, served as a worker serves it. */
	async function attachRelayedPhone(harness: TuiHarness) {
		const sessionId = harness.connector.conversation.id;
		const relayed = relayPhone(harness, relayPreamble(sessionId, harness.tempDir));
		const phone: RemotePhone = await connectRelayedPhone(relayed, sessionId);
		return { phone, relayed };
	}

	/** A client of the TUI's conversation that its moves redirect alone; `detachments` records where it went. */
	async function attachPhone(harness: TuiHarness): Promise<{ phone: HostClient; detachments: unknown[] }> {
		const detachments: unknown[] = [];
		const phone: HostClient = {
			id: randomUUID(),
			move: {
				kind: "redirect",
				redirect: (sessionId) => void detachments.push({ kind: "redirected", sessionId }),
			},
		};
		await harness.host.attach(phone, harness.connector.conversation);
		return { phone, detachments };
	}

	it("answers new_session, then redirects the phone to the new log while the TUI stays", async () => {
		const { harness, client } = await createTui();
		const sourceId = harness.startup.id;
		const { phone, relayed } = await attachRelayedPhone(harness);
		harness.events.splice(0);

		const outcome = await phone.intent("new_session", {});
		expect(outcome).toMatchObject({ type: "accepted", conversation: expect.any(String) });
		const targetId = outcome.type === "accepted" ? outcome.conversation : undefined;
		if (targetId === undefined) throw new Error("new_session named no target");
		expect(targetId).not.toBe(sourceId);
		// The answer comes first; the subscription ends moved, then the stream and its relay.
		await phone.ended;
		await relayed.finished;
		const tail = phone.frames.slice(phone.frames.indexOf(outcome) + 1);
		expect(tail.filter((frame) => frame.type === "ended")).toEqual([
			{ type: "ended", subscriptionId: "s1", reason: "moved", target: targetId },
		]);
		expect(phone.frames.at(-1)).toEqual({ type: "ended", subscriptionId: "s1", reason: "moved", target: targetId });

		// The TUI stays on its session; the new conversation never opened here.
		expect(harness.connector.conversation.id).toBe(sourceId);
		expect(harness.events.map((event) => [event.type, event.sessionId])).toEqual([
			["session_before_switch", sourceId],
		]);
		await expectStoredAndUnlocked(harness.sessionDir, targetId);
		await client.promptAndWait("still here");
		expect(harness.connector.conversation.id).toBe(sourceId);
	});

	it("keeps the phone on the session when the TUI's extensions cancel the switch", async () => {
		const { harness, client } = await createTui();
		const { phone } = await attachRelayedPhone(harness);
		cancelSwitch = true;

		const outcome = await phone.intent("new_session", {});
		expect(outcome).toMatchObject({ type: "accepted", result: { cancelled: true } });
		expect(outcome).not.toHaveProperty("conversation");
		// The phone stays subscribed: the conversation goes on serving it.
		expect(phone.frames.some((frame) => frame.type === "ended" || frame.type === "fatal")).toBe(false);
		await client.promptAndWait("still here");
		await vi.waitFor(() =>
			expect(
				phone.frames.some(
					(frame) =>
						frame.type === "entry" && frame.entry.type === "message" && frame.entry.view?.text === "still here",
				),
			).toBe(true),
		);
		await phone.close();
	});

	it("writes the log of an intent the phone's extension command starts, without running withSession here", async () => {
		const { harness, client } = await createTui();
		const sourceId = harness.startup.id;
		await client.promptAndWait("first question");
		const userEntry = harness.startup.session.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		if (!userEntry) throw new Error("the user message is missing");
		harness.events.splice(0);

		const { phone: newPhone, detachments } = await attachPhone(harness);
		const withSession = vi.fn(async () => {});
		const created = await openNewSession(harness.host, newPhone, {
			setup: (writer) => writer.appendSessionInfo("from the phone"),
			withSession,
		});
		if (created.cancelled) throw new Error("the new session was cancelled");
		expect(created.seeded).toBe(false);
		expect(withSession).not.toHaveBeenCalled();
		expect(detachments).toEqual([{ kind: "redirected", sessionId: created.sessionId }]);
		await expectStoredAndUnlocked(harness.sessionDir, created.sessionId);
		const createdInfo = await findSessionInfoById(harness.sessionDir, created.sessionId);
		if (!createdInfo) throw new Error("the new session is not stored");
		const createdLog = await SessionManager.openReadOnly(createdInfo.ref);
		expect(createdLog.getSessionName()).toBe("from the phone");
		await createdLog.closePersistence();
		// A redirected client left the host: it takes no further session changes.
		expect(harness.host.conversationOf(newPhone)).toBeUndefined();
		await expect(openNewSession(harness.host, newPhone)).rejects.toThrow("not attached");

		const { phone: forkPhone } = await attachPhone(harness);
		const forked = await openFork(harness.host, forkPhone, userEntry.id);
		if (forked.cancelled) throw new Error("the fork was cancelled");
		expect(forked.selectedText).toBe("first question");
		const forkedInfo = await findSessionInfoById(harness.sessionDir, forked.sessionId);
		if (!forkedInfo) throw new Error("the fork is not stored");
		const forkedLog = await SessionManager.openReadOnly(forkedInfo.ref);
		expect(forkedLog.getForkedFrom()).toEqual({ sessionId: sourceId, entryId: userEntry.parentId });
		await forkedLog.closePersistence();

		const { phone: switchPhone } = await attachPhone(harness);
		const switched = await openStoredSession(harness.host, switchPhone, createdInfo.ref);
		expect(switched).toEqual({ cancelled: false, sessionId: created.sessionId, seeded: false });

		// The TUI stays; no conversation opened or closed here.
		expect(harness.connector.conversation.id).toBe(sourceId);
		expect(
			harness.events.filter((event) => event.type === "session_start" || event.type === "session_shutdown"),
		).toEqual([]);
	});

	it("executes a plan in a new session from a relayed phone: the new log queues the execution turn", async () => {
		const { harness } = await createTui();
		const sourceId = harness.startup.id;
		const session = harness.startup.session;
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({
			title: "From the phone",
			summary: "Execute in a fresh session.",
			steps: [{ text: "Make the change" }],
		});
		const ready = await session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "From the phone",
			summary: "Execute in a fresh session.",
		});
		const { phone } = await attachPhone(harness);

		const result = await executePlan(harness.host, phone, ready.id, ready.revision, "new_session");

		expect(result.started).toBe(true);
		expect(result.selectedSessionId).not.toBe(sourceId);
		// The TUI stays on its session, whose plan is handed off.
		expect(harness.connector.conversation.id).toBe(sourceId);
		expect(session.planningState.plan).toMatchObject({ id: ready.id, phase: "handed_off" });
		await expectStoredAndUnlocked(harness.sessionDir, result.selectedSessionId);
		const info = await findSessionInfoById(harness.sessionDir, result.selectedSessionId);
		if (!info) throw new Error("the new session is not stored");
		const written = await SessionManager.openReadOnly(info.ref);
		expect(written.getConversationState().planning?.plan).toMatchObject({ id: ready.id, phase: "active" });
		expect(clientInputRecovery(written.getConversationState())).toMatchObject({
			kind: "replay",
			records: [{ origin: "host", queuedInput: { messages: [{ customType: PLAN_EXECUTION_CUSTOM_TYPE }] } }],
		});
		await written.closePersistence();
	});

	it("serves only the session the daemon authorized, with the daemon's identity", async () => {
		const { harness } = await createTui();
		const sessionId = harness.startup.id;
		// The preamble names another session than the relay reached: the host closes it unanswered.
		const written: unknown[] = [];
		const mismatched = relayPhone(harness, relayPreamble("s-other", harness.tempDir), { relayed: written });
		await mismatched.finished;
		// Without the daemon's node id, the phone could not verify the host: refused too.
		const anonymous = relayPhone(harness, { ...relayPreamble(sessionId, harness.tempDir), hostNodeId: undefined });
		await anonymous.finished;
		expect(written).toEqual([]);
		// Neither relay got a connection of the host: the conversation shows no phone.
		expect(harness.startup.liveState.get("presence")).toBeUndefined();
	});
});
