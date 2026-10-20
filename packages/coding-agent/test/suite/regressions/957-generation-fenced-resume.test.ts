/**
 * Regression #957: a resume position was a bare ordinal, and ordinals restart
 * when a log is deleted and recreated under the same session ID. A phone that
 * cached position N of the old log and resumed the new one was replayed the
 * new log's entries after N, or nothing when the new log was exactly N long,
 * so its transcript mixed two logs or kept the deleted one. Positions are now
 * pinned to the log generation every snapshot names: another generation is
 * answered with a current snapshot, charged as one, whatever the ordinal; the
 * same generation, which survives closing and reopening a persisted log,
 * replays.
 *
 * Reused coverage of the bounds #957 leaves unchanged: a position past the
 * head or further back than `maxReplay` answers a snapshot
 * (test/protocol/remote-bounds.test.ts, "resumes after the phone's position,
 * and answers a position past the log or the replay bound with a snapshot"),
 * and a replay costs a read per `entriesPerRead` entries
 * (test/protocol/remote-profile.test.ts, "charges a resume one read per
 * entriesPerRead entries it replays").
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, type UserMessage } from "@hansjm10/volt-ai";
import {
	type HostFrame,
	type ProjectedEntry,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
	SnapshotFrameSchema,
} from "@hansjm10/volt-protocol";
import { Errors } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import {
	localProfile,
	type Profile,
	type RemoteProfileLimits,
	remoteProfile,
} from "../../../src/core/protocol/profiles.ts";
import { serveConnection } from "../../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/protocol/transport/index.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { SubagentDefinition } from "../../../src/core/subagents/index.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "../host-harness.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
type Position = { readonly after: "snapshot" } | { readonly after: number; readonly sessionGeneration: string };
type CachedPosition = { readonly after: number; readonly sessionGeneration: string };

const SESSION_ID = "regression-957";
const OLD_MESSAGES = ["old-1", "old-2", "old-3", "old-4", "old-5", "old-6"];
const GRANT: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

/** A protocol client that records every frame the host writes. */
interface Client {
	readonly frames: HostFrame[];
	send(frame: object): void;
	waitFor<T extends HostFrame>(predicate: (frame: HostFrame) => frame is T, from?: number): Promise<T>;
	/** Subscribe from `position`; resolves with the frame that settled it: its live reset, its end, or `fatal`. */
	subscribe(conversation: string, subscriptionId: string, position: Position): Promise<HostFrame>;
	/** The frames of one subscription, in order. */
	framesOf(subscriptionId: string): HostFrame[];
	close(): Promise<void>;
}

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function messageTexts(entries: readonly ProjectedEntry[]): Array<string | undefined> {
	return entries.flatMap((entry) => (entry.type === "message" ? [entry.view?.text] : []));
}

/** The snapshot a subscription's frames start with; it must be a valid snapshot frame. */
function snapshotOf(frames: readonly HostFrame[]): Frame<"snapshot"> {
	const first = frames[0];
	if (first?.type !== "snapshot") throw new Error(`Expected a snapshot first, got ${JSON.stringify(first)}`);
	expect(Errors(SnapshotFrameSchema, first)).toEqual([]);
	return first;
}

/** A paired device's profile of `conversation`. */
function phone(conversation: HostedConversation, limits: RemoteProfileLimits = {}): Profile {
	return remoteProfile({
		grant: GRANT,
		redaction: { workspacePath: conversation.cwd, remoteWorkspacePath: "/workspace" },
		bound: conversation.id,
		limits,
	});
}

async function connect(harness: HostHarness, conversation: HostedConversation, profile: Profile): Promise<Client> {
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, profile, { host: harness.host, conversation, anchor: false });
	const frames: HostFrame[] = [];
	const waiters = new Set<() => void>();
	pair.client.onValue?.((value) => {
		frames.push(value as HostFrame);
		for (const waiter of [...waiters]) waiter();
	});
	const send = (frame: object): void => void pair.client.write(frame);
	// A reply can wait on the host's Git reads: wait for the frame itself, within the test's timeout.
	const waitFor = <T extends HostFrame>(predicate: (frame: HostFrame) => frame is T, from = 0): Promise<T> =>
		new Promise((resolve) => {
			const check = (): void => {
				const found = frames.slice(from).find(predicate);
				if (found === undefined) return;
				waiters.delete(check);
				resolve(found);
			};
			waiters.add(check);
			check();
		});
	send({ type: "hello", protocol: 1, client: { name: "phone", version: "1" }, accepts: { hostRequests: [] } });
	await connection.ready;
	return {
		frames,
		send,
		waitFor,
		subscribe(subscribed, subscriptionId, position) {
			const from = frames.length;
			send({ type: "subscribe", subscriptionId, conversation: subscribed, ...position });
			return waitFor(
				(frame): frame is HostFrame =>
					frame.type === "fatal" ||
					(frame.type === "live" && frame.subscriptionId === subscriptionId && frame.reset === true) ||
					(frame.type === "ended" && frame.subscriptionId === subscriptionId),
				from,
			);
		},
		framesOf(subscriptionId) {
			return frames.filter((frame) => "subscriptionId" in frame && frame.subscriptionId === subscriptionId);
		},
		async close() {
			await pair.client.close();
			await connection.closed.catch(() => undefined);
		},
	};
}

describe("regression #957: resume positions are fenced by log generation", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(options: HostHarnessOptions = {}): Promise<HostHarness> {
		const harness = await createHostHarness({ whenUnattached: "keep", ...options });
		cleanups.push(() => harness.cleanup());
		return harness;
	}

	async function client(harness: HostHarness, conversation: HostedConversation, profile: Profile): Promise<Client> {
		const connected = await connect(harness, conversation, profile);
		cleanups.push(() => connected.close());
		return connected;
	}

	function sessionsOf(harness: HostHarness): string {
		return join(harness.tempDir, "sessions");
	}

	async function adopt(harness: HostHarness, sessionManager: SessionManager): Promise<HostedConversation> {
		const opened = await harness.host.open({ kind: "adopt", sessionManager });
		if (opened.cancelled) throw new Error("An adopted open cannot be cancelled");
		return opened.conversation;
	}

	async function append(conversation: HostedConversation, texts: readonly string[]): Promise<void> {
		for (const text of texts) await conversation.session.sessionWriter.appendMessage(user(text));
	}

	/**
	 * A persisted log of `SESSION_ID` holding the old messages, the position a
	 * phone cached from its snapshot, and the log's reference once it closed.
	 */
	async function cachedPosition(harness: HostHarness): Promise<{ position: CachedPosition; ref: SessionReference }> {
		const manager = await SessionManager.create(harness.tempDir, sessionsOf(harness), { id: SESSION_ID });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const conversation = await adopt(harness, manager);
		await append(conversation, OLD_MESSAGES);
		const device = await connect(harness, conversation, phone(conversation));
		await device.subscribe(SESSION_ID, "cache", { after: "snapshot" });
		const snapshot = snapshotOf(device.framesOf("cache"));
		expect(snapshot).toMatchObject({
			conversation: SESSION_ID,
			sessionGeneration: manager.getSessionGeneration(),
			ordinal: manager.getOrdinal(),
		});
		expect(messageTexts(snapshot.state.entries)).toEqual(OLD_MESSAGES);
		await device.close();
		await harness.host.close(conversation);
		return { position: { after: snapshot.ordinal, sessionGeneration: snapshot.sessionGeneration }, ref };
	}

	/** Delete the log `ref` names and open a new, empty one under the same session ID. */
	async function recreate(harness: HostHarness, ref: SessionReference): Promise<HostedConversation> {
		expect(await SessionManager.delete(ref)).toBe(true);
		const conversation = await adopt(
			harness,
			await SessionManager.create(harness.tempDir, sessionsOf(harness), { id: SESSION_ID }),
		);
		expect(conversation.id).toBe(SESSION_ID);
		return conversation;
	}

	/** Append new messages until the log's head is `head`. */
	async function fill(conversation: HostedConversation, head: number): Promise<void> {
		const manager = conversation.session.sessionManager;
		expect(manager.getOrdinal()).toBeLessThan(head);
		for (let index = 1; manager.getOrdinal() < head; index++) await append(conversation, [`new-${index}`]);
		expect(manager.getOrdinal()).toBe(head);
	}

	it("keeps a persisted log's generation across close and reopen, and gives a recreated log a new one", async () => {
		const harness = await setup();
		const created = await SessionManager.create(harness.tempDir, sessionsOf(harness), { id: SESSION_ID });
		const generation = created.getSessionGeneration();
		expect(generation).not.toBe("");
		const ref = created.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		expect(ref.sessionGeneration).toBe(generation);
		await created.logWriter.appendMessage(user("persisted"));
		await created.closePersistence();

		const reopened = await SessionManager.open(ref);
		expect(reopened.getSessionGeneration()).toBe(generation);
		await reopened.closePersistence();
		const read = await SessionManager.openReadOnly(ref);
		expect(read.getSessionGeneration()).toBe(generation);
		await read.closePersistence();
		expect((await SessionManager.findForResume(sessionsOf(harness), SESSION_ID))?.sessionGeneration).toBe(generation);

		expect(await SessionManager.delete(ref)).toBe(true);
		const recreated = await SessionManager.create(harness.tempDir, sessionsOf(harness), { id: SESSION_ID });
		expect(recreated.getSessionId()).toBe(SESSION_ID);
		expect(recreated.getSessionGeneration()).not.toBe("");
		expect(recreated.getSessionGeneration()).not.toBe(generation);
		await recreated.closePersistence();

		// An in-memory log has a generation of its own, too.
		const memory = SessionManager.inMemory(harness.tempDir, { id: SESSION_ID });
		const other = SessionManager.inMemory(harness.tempDir, { id: SESSION_ID });
		expect(memory.getSessionGeneration()).not.toBe("");
		expect(memory.getSessionGeneration()).toBe(memory.getSessionGeneration());
		expect(other.getSessionGeneration()).not.toBe(memory.getSessionGeneration());
	});

	it.each([
		["shorter than", -2],
		["as long as", 0],
		["longer than", 3],
	] as const)(
		"answers a position cached from a deleted log with a snapshot of a recreated log %s it",
		async (_, delta) => {
			const harness = await setup();
			const { position, ref } = await cachedPosition(harness);
			const conversation = await recreate(harness, ref);
			const generation = conversation.session.sessionManager.getSessionGeneration();
			expect(generation).not.toBe(position.sessionGeneration);
			const device = await client(harness, conversation, phone(conversation));
			const head = position.after + delta;
			await fill(conversation, head);

			const settled = await device.subscribe(SESSION_ID, "resume", position);
			expect(settled).toMatchObject({ type: "live", subscriptionId: "resume", reset: true });
			const frames = device.framesOf("resume");
			const snapshot = snapshotOf(frames);
			expect(snapshot).toMatchObject({ conversation: SESSION_ID, sessionGeneration: generation, ordinal: head });
			// Nothing of the new log is replayed as if it followed the old position.
			expect(frames.filter((frame) => frame.type === "entry" || frame.type === "head")).toEqual([]);
			const texts = messageTexts(snapshot.state.entries);
			expect(texts[0]).toBe("new-1");
			expect(texts.every((text) => text?.startsWith("new-"))).toBe(true);
			expect(device.frames.some((frame) => frame.type === "fatal")).toBe(false);
		},
	);

	it("replays after a position in the same log, whose generation survives closing and reopening it", async () => {
		const harness = await setup();
		const { position, ref } = await cachedPosition(harness);
		const reopened = await SessionManager.open(ref);
		expect(reopened.getSessionGeneration()).toBe(position.sessionGeneration);
		const conversation = await adopt(harness, reopened);
		await append(conversation, ["after-1", "after-2"]);
		const head = conversation.session.sessionManager.getOrdinal();
		const device = await client(harness, conversation, phone(conversation));

		const settled = await device.subscribe(SESSION_ID, "resume", position);
		expect(settled).toMatchObject({ type: "live", subscriptionId: "resume", reset: true });
		const frames = device.framesOf("resume");
		expect(frames.some((frame) => frame.type === "snapshot")).toBe(false);
		const entries = frames.flatMap((frame) => (frame.type === "entry" ? [frame.entry] : []));
		expect(messageTexts(entries)).toEqual(["after-1", "after-2"]);
		const resent = frames.flatMap((frame) =>
			frame.type === "entry" ? [frame.entry.ordinal] : frame.type === "head" ? [frame.ordinal] : [],
		);
		expect(Math.min(...resent)).toBeGreaterThan(position.after);
		expect(Math.max(...resent)).toBe(head);
	});

	it("charges another generation's position one snapshot read before replay cost; its own generation, the replay", async () => {
		const harness = await setup();
		const { position, ref } = await cachedPosition(harness);
		const conversation = await recreate(harness, ref);
		const generation = conversation.session.sessionManager.getSessionGeneration();
		// The old position is within the new log: replaying from it would cost 4 reads of 1 entry each.
		const head = position.after + 4;
		await fill(conversation, head);
		const limits = { entriesPerRead: 1, readBurst: 2, readRefillMs: 60_000 };

		const stale = await client(harness, conversation, phone(conversation, limits));
		for (const id of ["a", "b"]) {
			await expect(stale.subscribe(SESSION_ID, id, position)).resolves.toMatchObject({ type: "live", reset: true });
			expect(snapshotOf(stale.framesOf(id))).toMatchObject({ sessionGeneration: generation, ordinal: head });
			stale.send({ type: "unsubscribe", subscriptionId: id });
		}
		// Each was charged exactly one read: the third subscription finds the budget spent.
		await expect(stale.subscribe(SESSION_ID, "c", { after: "snapshot" })).resolves.toMatchObject({
			type: "fatal",
			code: "invalid_frame",
			message: "Too many subscriptions requested",
		});
		expect(stale.framesOf("c")).toEqual([]);

		const current = await client(harness, conversation, phone(conversation, limits));
		await expect(
			current.subscribe(SESSION_ID, "a", { after: position.after, sessionGeneration: generation }),
		).resolves.toMatchObject({ type: "fatal", code: "invalid_frame", message: "Too many subscriptions requested" });
		expect(current.framesOf("a")).toEqual([]);
	});

	it("refuses a numeric position without its generation as an invalid frame", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const device = await client(harness, conversation, phone(conversation));
		await expect(device.subscribe(conversation.id, "bare", { after: 0 } as unknown as Position)).resolves.toEqual({
			type: "fatal",
			code: "invalid_frame",
			message: "Invalid subscribe frame",
		});
		expect(device.framesOf("bare")).toEqual([]);
	});

	it("names a closed child's persisted generation in its snapshot", async () => {
		const harness = await setup({ subagents: [scout()] });
		const parent = await harness.openStartup();
		const local = await client(harness, parent, localProfile);
		harness.faux.setResponses([runsUntilStopped]);
		const from = local.frames.length;
		local.send({ type: "start_subagent", intentId: "start", input: { agent: "scout", prompt: "inspect auth" } });
		const started = await local.waitFor(
			(frame): frame is Frame<"accepted"> | Frame<"rejected"> =>
				(frame.type === "accepted" || frame.type === "rejected") && frame.intentId === "start",
			from,
		);
		if (started.type !== "accepted") throw new Error(`start_subagent was rejected: ${JSON.stringify(started)}`);
		const { workId, conversation: child } = started.result as { workId: string; conversation: string };
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		const running = parent.session.getSubagentToolManager()?.childConversation?.(child);
		if (!running) throw new Error("Expected the running child");
		const persisted = running.session.sessionManager.getSessionRef()?.sessionGeneration;
		expect(persisted).toBe(running.session.sessionManager.getSessionGeneration());

		await local.subscribe(child, "running", { after: "snapshot" });
		expect(snapshotOf(local.framesOf("running"))).toMatchObject({
			conversation: child,
			sessionGeneration: persisted,
		});

		await parent.work.cancel(workId);
		await vi.waitFor(() => expect(parent.work.get(workId)?.outcome).toBe("cancelled"));
		await vi.waitFor(() =>
			expect(parent.session.getSubagentToolManager()?.childConversation?.(child)).toBeUndefined(),
		);
		await expect(local.subscribe(child, "closed", { after: "snapshot" })).resolves.toEqual({
			type: "ended",
			subscriptionId: "closed",
			reason: "closed",
		});
		const closed = snapshotOf(local.framesOf("closed"));
		expect(closed).toMatchObject({ conversation: child, sessionGeneration: persisted });
		expect(messageTexts(closed.state.entries)).toContain("inspect auth");

		// A paired device reads the closed child through its parent, under the same generation.
		const device = await client(harness, parent, phone(parent));
		await expect(device.subscribe(child, "closed", { after: "snapshot" })).resolves.toMatchObject({
			type: "ended",
			reason: "closed",
		});
		expect(snapshotOf(device.framesOf("closed"))).toMatchObject({
			conversation: child,
			sessionGeneration: persisted,
		});
	});
});

/** A child response that runs until the child's run is aborted. */
const runsUntilStopped: FauxResponseStep = async (_context, options) => {
	const signal = options?.signal;
	await new Promise<void>((resolve) => {
		if (signal?.aborted) resolve();
		signal?.addEventListener("abort", () => resolve(), { once: true });
	});
	return fauxAssistantMessage("", { stopReason: "aborted" });
};

function scout(): SubagentDefinition {
	const baseDir = join(tmpdir(), "volt-957", ".volt", "agents");
	const filePath = join(baseDir, "scout.md");
	return {
		name: "scout",
		description: "scout description",
		tools: ["read"],
		systemPrompt: "scout system prompt",
		source: "project",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir }),
		filePath,
	};
}
