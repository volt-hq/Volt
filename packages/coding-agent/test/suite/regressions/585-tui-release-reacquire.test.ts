import type { HostFrame, HostRequest, LiveValue } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopbackClient } from "../../../src/client/protocol-client.ts";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import {
	connectRelayedPhone,
	createScriptedDaemonLink,
	createTuiHarness,
	relayPreamble,
	type ScriptedDaemonLink,
	type TuiHarness,
} from "../tui-harness.ts";

type HostRequestValue = Extract<LiveValue, { kind: "host_request" }>;

/** The host requests the TUI's client holds. */
function hostRequests(client: LoopbackClient): HostRequestValue[] {
	return [...client.live.values.values()].filter((value): value is HostRequestValue => value.kind === "host_request");
}

/** The dialog the client was asked, once it arrives. */
async function dialogOf(client: LoopbackClient, title: string | RegExp): Promise<HostRequestValue> {
	let found: HostRequestValue | undefined;
	await vi.waitFor(() => {
		found = hostRequests(client).find(
			(value) =>
				value.request.kind === "dialog" &&
				(typeof title === "string" ? value.request.title === title : title.test(value.request.title)),
		);
		expect(found).toBeDefined();
	});
	return found!;
}

function actionsOf(request: HostRequest): string[] {
	return request.kind === "dialog" ? request.actions.map((action) => action.label) : [];
}

describe("regression #585: the TUI host releases the session the TUI leaves and acquires the one it opens", () => {
	let link: ScriptedDaemonLink;
	let harness: TuiHarness;
	let frames: HostFrame[];

	beforeEach(async () => {
		link = createScriptedDaemonLink();
		frames = [];
		harness = await createTuiHarness({
			link,
			extension: (volt) => {
				volt.on("session_start", (_event, ctx) => {
					link.steps.push(`start:${ctx.sessionManager.getSessionId()}`);
				});
				volt.on("session_shutdown", (_event, ctx) => {
					link.steps.push(`shutdown:${ctx.sessionManager.getSessionId()}`);
				});
			},
		});
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	const connect = () => harness.connect({ onFrame: (frame) => frames.push(frame) });

	it("takes the lease of the session it shows once its client is ready, then recovers the session's queued input", async () => {
		const source = harness.startup.id;
		const recover = vi.spyOn(harness.startup, "startRecoveredClientInputs");

		await connect();

		expect(link.steps).toEqual([`start:${source}`, `acquire:${source}`]);
		expect(recover).toHaveBeenCalledOnce();
		expect(recover.mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(link.acquire).mock.invocationCallOrder[0]!);

		// A reconnect that reacquires the lease recovers it again.
		link.reacquire(source, { kind: "granted", handoff: "none" });
		await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
	});

	it("leaves the queued input of a session another TUI holds queued, and says so", async () => {
		const source = harness.startup.id;
		link.outcomes.set(source, () => ({ kind: "denied", reason: "held_by_tui" }));
		const recover = vi.spyOn(harness.startup, "startRecoveredClientInputs");

		await connect();

		expect(recover).not.toHaveBeenCalled();
		expect(frames.flatMap((frame) => (frame.type === "live" ? frame.items : []))).toContainEqual(
			expect.objectContaining({
				type: "notice",
				level: "warning",
				message: "This conversation is open in another desktop window; live sharing is disabled here.",
			}),
		);
	});

	it("on new_session, releases the session it left once it closed and its relayed phones ended, then acquires the new one", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const relayed = await link.offerRelay({ sessionId: source }, relayPreamble(source, harness.tempDir));
		if (!relayed) throw new Error("The TUI did not serve the phone");
		const phone = await connectRelayedPhone(relayed, source);
		expect(harness.tuiHost.relayCount()).toBe(1);
		link.steps.splice(0);
		void relayed.finished.then(() => link.steps.push("relay ended"));

		const accepted = await client.intent("new_session", {});
		const target = accepted.conversation;
		if (target === undefined) throw new Error("new_session named no conversation");

		await vi.waitFor(() =>
			expect(link.steps).toEqual([
				`start:${target}`,
				`shutdown:${source}`,
				// The phone relayed into the session the TUI left hears where to reconnect first.
				"relay ended",
				`release:${source}:switch`,
				`acquire:${target}`,
			]),
		);
		await phone.ended;
		expect(phone.frames).toContainEqual({ type: "ended", subscriptionId: "s1", reason: "closed" });
		expect(harness.tuiHost.relayCount()).toBe(0);
	});

	it("on switch_session, acquires the target before opening it, then releases the session it left", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		link.steps.splice(0);

		const accepted = await client.intent("switch_session", { sessionId: target.sessionId });

		expect(accepted.conversation).toBe(target.sessionId);
		await vi.waitFor(() =>
			expect(link.steps).toEqual([
				`acquire:${target.sessionId}`,
				`start:${target.sessionId}`,
				`shutdown:${source}`,
				`release:${source}:switch`,
				// The handover points the daemon at the session the TUI shows; its lease is already held.
				`acquire:${target.sessionId}`,
			]),
		);
		expect(harness.tuiHost.conversation.id).toBe(target.sessionId);
	});

	it("refuses a target open for writing elsewhere, handing its lease back", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		const elsewhere = ConversationLock.acquire(target.sessionDirectory, target.sessionId);
		link.steps.splice(0);

		try {
			await expect(client.intent("switch_session", { sessionId: target.sessionId })).rejects.toThrow(
				`Session ${target.sessionId} is already open`,
			);
		} finally {
			elsewhere.close();
		}

		expect(harness.tuiHost.conversation.id).toBe(source);
		expect(link.steps).toEqual([
			`acquire:${target.sessionId}`,
			`release:${target.sessionId}:switch`,
			`acquire:${source}`,
		]);
	});

	it("points the daemon back at the session it shows when a resume took no lease and failed", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		link.outcomes.set(target.sessionId, () => ({ kind: "noop" }));
		const elsewhere = ConversationLock.acquire(target.sessionDirectory, target.sessionId);
		link.steps.splice(0);

		try {
			await expect(client.intent("switch_session", { sessionId: target.sessionId })).rejects.toThrow();
		} finally {
			elsewhere.close();
		}

		expect(harness.tuiHost.conversation.id).toBe(source);
		expect(link.steps).toEqual([
			`acquire:${target.sessionId}`,
			`release:${target.sessionId}:switch`,
			`acquire:${source}`,
		]);
	});

	it("refuses, opening nothing, when another TUI holds the target's lease", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		link.outcomes.set(target.sessionId, () => ({ kind: "denied", reason: "held_by_tui" }));
		link.steps.splice(0);

		await expect(client.intent("switch_session", { sessionId: target.sessionId })).rejects.toThrow(
			`Session ${target.sessionId} is open in another Volt window (held_by_tui). Quit it there, then retry.`,
		);

		expect(harness.tuiHost.conversation.id).toBe(source);
		expect(harness.host.get(target.sessionId)).toBeUndefined();
		expect(link.steps).toEqual([
			`acquire:${target.sessionId}`,
			`release:${target.sessionId}:switch`,
			`acquire:${source}`,
		]);
	});

	it("asks the client that resumes to wait for the daemon's turn: cancelling keeps the session it shows", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		link.outcomes.set(target.sessionId, () => ({
			kind: "pending",
			viewerFeedId: "vf-cancel",
			granted: new Promise<never>(() => {}),
		}));
		link.steps.splice(0);

		const switching = client.intent("switch_session", { sessionId: target.sessionId });
		const wait = await dialogOf(
			client,
			`Waiting for the remote turn in session ${target.sessionId} to finish before opening it here`,
		);
		expect(actionsOf(wait.request)).toEqual(["Stop remote turn", "Cancel"]);
		client.answer(wait.requestId, { value: "cancel" });

		await expect(switching).resolves.toMatchObject({ result: { cancelled: true } });
		expect(hostRequests(client)).toEqual([]);
		expect(harness.tuiHost.conversation.id).toBe(source);
		expect(harness.host.get(target.sessionId)).toBeUndefined();
		expect(link.steps).toEqual([
			`acquire:${target.sessionId}`,
			`release:${target.sessionId}:switch`,
			`acquire:${source}`,
		]);
	});

	it("stops the daemon's turn when asked, then opens the session once the lease is granted", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const target = await harness.storeSession();
		const granted = Promise.withResolvers<{ handoff: "warm" }>();
		link.outcomes.set(target.sessionId, () => ({
			kind: "pending",
			viewerFeedId: "vf-stop",
			granted: granted.promise,
		}));
		link.steps.splice(0);

		const switching = client.intent("switch_session", { sessionId: target.sessionId });
		const wait = await dialogOf(client, /^Waiting for the remote turn/);
		client.answer(wait.requestId, { value: "stop_remote_turn" });
		const stopping = await dialogOf(client, `Stopping the remote turn in session ${target.sessionId}...`);
		expect(actionsOf(stopping.request)).toEqual(["Cancel"]);
		expect(link.steps).toEqual([`acquire:${target.sessionId}`, "abort:vf-stop"]);
		granted.resolve({ handoff: "warm" });

		await expect(switching).resolves.toMatchObject({ conversation: target.sessionId });
		// The grant cleared the dialog.
		await vi.waitFor(() => expect(hostRequests(client)).toEqual([]));
		await vi.waitFor(() =>
			expect(link.steps).toEqual([
				`acquire:${target.sessionId}`,
				"abort:vf-stop",
				`start:${target.sessionId}`,
				`shutdown:${source}`,
				`release:${source}:switch`,
				`acquire:${target.sessionId}`,
			]),
		);
	});

	it("asks only the client that resumes: a phone relayed into the same conversation neither sees nor answers the wait", async () => {
		const client = await connect();
		const source = harness.startup.id;
		const relayed = await link.offerRelay({ sessionId: source }, relayPreamble(source, harness.tempDir));
		if (!relayed) throw new Error("The TUI did not serve the phone");
		const phone = await connectRelayedPhone(relayed, source, ["dialog", "confirm", "select"]);
		const target = await harness.storeSession();
		link.outcomes.set(target.sessionId, () => ({
			kind: "pending",
			viewerFeedId: "vf-phone",
			granted: new Promise<never>(() => {}),
		}));

		const switching = client.intent("switch_session", { sessionId: target.sessionId });
		const wait = await dialogOf(client, /^Waiting for the remote turn/);
		phone.send({ type: "host_response", requestId: wait.requestId, response: { value: "stop_remote_turn" } });
		// The phone's answer reaches nothing: the TUI's dialog stays, and the daemon's turn runs on.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(hostRequests(client).map((value) => value.requestId)).toEqual([wait.requestId]);
		expect(link.steps).not.toContain("abort:vf-phone");
		expect(
			phone.frames.some(
				(frame) =>
					frame.type === "live" &&
					frame.items.some((item) => item.type === "set" && item.value.kind === "host_request"),
			),
		).toBe(false);

		client.answer(wait.requestId, { value: "cancel" });
		await expect(switching).resolves.toMatchObject({ result: { cancelled: true } });
	});

	it("serves a relay offered for the target of a resume once the client moved there, and lets other offers expire", async () => {
		const client = await connect();
		const target = await harness.storeSession();
		const granted = Promise.withResolvers<{ handoff: "cold" }>();
		link.outcomes.set(target.sessionId, () => ({
			kind: "pending",
			viewerFeedId: "vf-relay",
			granted: granted.promise,
		}));

		// An offer for a session the TUI does not show expires.
		expect(await link.offerRelay({ sessionId: "s-elsewhere" }, relayPreamble("s-elsewhere", harness.tempDir))).toBe(
			undefined,
		);

		const switching = client.intent("switch_session", { sessionId: target.sessionId });
		await dialogOf(client, /^Waiting for the remote turn/);
		const offered = link.offerRelay(
			{ sessionId: target.sessionId },
			relayPreamble(target.sessionId, harness.tempDir),
		);
		granted.resolve({ handoff: "cold" });
		await switching;
		const relayed = await offered;
		if (!relayed) throw new Error("The TUI did not serve the phone of the session it opened");
		const phone = await connectRelayedPhone(relayed, target.sessionId);
		expect(phone.frames.some((frame) => frame.type === "fatal")).toBe(false);
		await phone.close();
	});
});
