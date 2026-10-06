/**
 * Observation over the protocol (architecture rewrite Phase 6, slice 3): a
 * review's passes run as conversations its work links as its `child`, which
 * a client subscribes to for the review's inline view and usage, observe-only
 * and until each pass closes; a pass that reads code-host context is
 * local-only. Closed subagent children at any depth are read from their logs
 * (`subscribe` answers a snapshot, then `ended{closed}`; `history`, `content`,
 * and `work_output` read them), located only by the work records that link
 * them and charged per page of their logs.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@hansjm10/volt-ai";
import type { HostFrame, ProjectedEntry, RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import { localProfile, type Profile, remoteProfile } from "../../src/core/protocol/profiles.ts";
import { type ProtocolConnection, serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/protocol/transport/index.ts";
import { createIrohRemoteRpcGrant } from "../../src/core/remote/iroh/access-grant.ts";
import { REVIEW_PRIVATE_DIAGNOSTICS_ENV } from "../../src/core/review-private-diagnostics.ts";
import { reviewWorkInput } from "../../src/core/review-work.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";
import type { SubagentDefinition } from "../../src/core/subagents/index.ts";
import { createHostHarness, type HostHarness } from "../suite/host-harness.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
type IntentOutcome = Frame<"accepted"> | Frame<"rejected">;
type QueryOutcome = Frame<"result"> | Frame<"query_error">;

/** A protocol client that records every frame and may hold several subscriptions. */
interface Client {
	readonly frames: HostFrame[];
	readonly connection: ProtocolConnection;
	intent(type: string, input?: object, options?: { conversation?: string }): Promise<IntentOutcome>;
	query(query: string, params?: object, options?: { conversation?: string }): Promise<QueryOutcome>;
	/** Subscribe from a snapshot; resolves with the snapshot, or the `ended` frame when refused. */
	subscribe(conversation: string, subscriptionId: string): Promise<Frame<"snapshot"> | Frame<"ended">>;
	/** The frames of one subscription, in order. */
	framesOf(subscriptionId: string): HostFrame[];
	close(): Promise<void>;
}

/** Ids of intents and queries, unique across every client. */
let ids = 0;

async function connect(
	harness: HostHarness,
	conversation: HostedConversation,
	profile: Profile,
	hostRequests: readonly string[] = [],
): Promise<Client> {
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, profile, { host: harness.host, conversation, anchor: false });
	const frames: HostFrame[] = [];
	const waiters = new Set<() => void>();
	pair.client.onValue?.((value) => {
		frames.push(value as HostFrame);
		for (const waiter of [...waiters]) waiter();
	});
	const send = (frame: object): void => void pair.client.write(frame);
	// A reply can take the host's Git reads, which a loaded runner can slow past any polling deadline:
	// wait for the frame itself, within the test's timeout.
	const waitFor = <T extends HostFrame>(predicate: (frame: HostFrame) => frame is T): Promise<T> =>
		new Promise((resolve) => {
			const check = (): void => {
				const found = frames.find(predicate);
				if (found === undefined) return;
				waiters.delete(check);
				resolve(found);
			};
			waiters.add(check);
			check();
		});
	send({ type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests } });
	await connection.ready;
	return {
		frames,
		connection,
		intent(type, input, options = {}) {
			const intentId = `i-${++ids}`;
			send({
				type,
				intentId,
				...(options.conversation === undefined ? {} : { conversation: options.conversation }),
				...(input === undefined ? {} : { input }),
				...(profile.name === "remote" ? { expectedOrdinal: conversation.session.sessionManager.getOrdinal() } : {}),
			});
			return waitFor(
				(frame): frame is IntentOutcome =>
					(frame.type === "accepted" || frame.type === "rejected") && frame.intentId === intentId,
			);
		},
		query(query, params, options = {}) {
			const queryId = `q-${++ids}`;
			send({
				type: "query",
				queryId,
				query,
				...(options.conversation === undefined ? {} : { conversation: options.conversation }),
				...(params === undefined ? {} : { params }),
			});
			return waitFor(
				(frame): frame is QueryOutcome =>
					(frame.type === "result" || frame.type === "query_error") && frame.queryId === queryId,
			);
		},
		async subscribe(subscribed, subscriptionId) {
			send({ type: "subscribe", subscriptionId, conversation: subscribed, after: "snapshot" });
			return waitFor(
				(frame): frame is Frame<"snapshot"> | Frame<"ended"> =>
					(frame.type === "snapshot" || frame.type === "ended") && frame.subscriptionId === subscriptionId,
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

const GRANT: RemoteGrant = createIrohRemoteRpcGrant(["conversation.observe.v1", "conversation.control.v1"]);

function remote(conversation: HostedConversation, workspace: string, limits: Partial<Profile["limits"]> = {}) {
	return remoteProfile({
		grant: GRANT,
		redaction: { workspacePath: workspace, remoteWorkspacePath: "/workspace" },
		bound: conversation.id,
		limits,
	});
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** A response held until released; a stopped run ends it aborted. */
function held(message: AssistantMessage): { step: FauxResponseFactory; started: Promise<void>; release(): void } {
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		step: async (_context, options) => {
			started.resolve();
			const stopped = new Promise<"stopped">((resolve) => {
				if (options?.signal?.aborted) resolve("stopped");
				options?.signal?.addEventListener("abort", () => resolve("stopped"), { once: true });
			});
			const outcome = await Promise.race([released.promise, stopped]);
			return outcome === "stopped" ? fauxAssistantMessage("", { stopReason: "aborted" }) : message;
		},
		started: started.promise,
		release: () => released.resolve(),
	};
}

const DISCOVERY_REPORT = fauxAssistantMessage(
	fauxToolCall("report_review_candidates", { summary: "No candidates.", candidates: [], limitations: [] }),
	{ stopReason: "toolUse" },
);

const VERIFICATION_REPORT = fauxAssistantMessage(
	fauxToolCall("report_review_verification", {
		summary: "No omission found.",
		assessment: "complete",
		decisions: [],
		priorFindingDecisions: [],
		limitations: [],
	}),
	{ stopReason: "toolUse" },
);

function messageTexts(entries: readonly ProjectedEntry[]): Array<[string | undefined, string | undefined]> {
	return entries.flatMap((entry) => (entry.type === "message" ? [[entry.view?.role, entry.view?.text]] : []));
}

describe("review passes as observed children", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	beforeEach(() => {
		vi.stubEnv(REVIEW_PRIVATE_DIAGNOSTICS_ENV, "0");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** A conversation over a Git repository with an uncommitted change, and a local client of it. */
	async function setup() {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const repo = mkdtempSync(join(tmpdir(), "volt-review-passes-"));
		cleanups.push(() => rmSync(repo, { recursive: true, force: true }));
		git(repo, "init", "--initial-branch=main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		git(repo, "config", "commit.gpgsign", "false");
		writeFileSync(join(repo, "value.ts"), "export const value = 1;\n");
		git(repo, "add", "value.ts");
		git(repo, "commit", "-m", "initial");
		writeFileSync(join(repo, "value.ts"), "export const value = 2;\n");
		const opened = await harness.host.open({
			kind: "adopt",
			sessionManager: await SessionManager.create(repo, join(harness.tempDir, "sessions")),
		});
		if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
		const conversation = opened.conversation;
		const client = await connect(harness, conversation, localProfile);
		cleanups.push(() => client.close());
		return { harness, repo, conversation, client };
	}

	it("links each pass as the review's child while it runs; clients observe it, then it closes", async () => {
		const { harness, repo, conversation, client } = await setup();
		const discovery = held(DISCOVERY_REPORT);
		const verification = held(VERIFICATION_REPORT);
		harness.faux.setResponses([discovery.step, verification.step]);
		const home = await client.subscribe(conversation.id, "home");
		expect(home.type).toBe("snapshot");

		const started = await client.intent("review_uncommitted", {});
		if (started.type !== "accepted") throw new Error(`review_uncommitted was rejected: ${JSON.stringify(started)}`);
		const { workId } = started.result as { workId: string };
		await discovery.started;
		const firstPass = conversation.work.get(workId)?.child?.conversation;
		expect(firstPass).toEqual(expect.any(String));
		expect(conversation.session.reviewPasses.get(firstPass!)?.localOnly).toBe(false);

		// The client follows the review's child: the pass's log so far, then its live lane.
		const pass = await client.subscribe(firstPass!, "discovery");
		if (pass.type !== "snapshot") throw new Error("Expected the discovery pass's snapshot");
		expect(pass.conversation).toBe(firstPass);
		expect(messageTexts(pass.state.entries)).toEqual([["user", expect.stringContaining("<review_request>")]]);
		await vi.waitFor(() =>
			expect(
				client
					.framesOf("discovery")
					.flatMap((frame) => (frame.type === "live" ? frame.items : []))
					.some((item) => item.type === "set" && item.value.kind === "usage"),
			).toBe(true),
		);
		// Observe-only: nothing acts on a pass.
		await expect(client.intent("abort", {}, { conversation: firstPass })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "read_only" },
		});
		// The client's own log names the pass the review runs in.
		await vi.waitFor(() =>
			expect(
				client
					.framesOf("home")
					.some(
						(frame) =>
							frame.type === "entry" &&
							frame.entry.type === "work_checkpoint" &&
							JSON.stringify(frame.entry.payload).includes(firstPass!),
					),
			).toBe(true),
		);

		// The pass ends: its subscription ends with it, and the review moves to its next pass.
		discovery.release();
		await verification.started;
		await vi.waitFor(() =>
			expect(client.framesOf("discovery").at(-1)).toEqual({
				type: "ended",
				subscriptionId: "discovery",
				reason: "closed",
			}),
		);
		expect(client.framesOf("discovery").some((frame) => frame.type === "entry")).toBe(true);
		const secondPass = conversation.work.get(workId)?.child?.conversation;
		expect(secondPass).toEqual(expect.any(String));
		expect(secondPass).not.toBe(firstPass);

		// A paired device observes a pass that reads no code-host context, as its work links it.
		const phone = await connect(harness, conversation, remote(conversation, repo));
		cleanups.push(() => phone.close());
		await expect(phone.subscribe(secondPass!, "verification")).resolves.toMatchObject({
			type: "snapshot",
			conversation: secondPass,
		});
		const phoneHome = await phone.subscribe(conversation.id, "phone-home");
		if (phoneHome.type !== "snapshot") throw new Error("Expected the phone's snapshot");
		const checkpoints = phoneHome.state.entries.filter((entry) => entry.type === "work_checkpoint");
		expect(checkpoints.map((entry) => entry.payload)).toContainEqual(
			expect.objectContaining({ workId, child: { conversation: secondPass } }),
		);

		verification.release();
		await vi.waitFor(() => expect(conversation.work.get(workId)?.outcome).toBe("completed"), { timeout: 10_000 });
		await vi.waitFor(() =>
			expect(phone.framesOf("verification").at(-1)).toMatchObject({ type: "ended", reason: "closed" }),
		);
		expect(conversation.session.reviewPasses.get(secondPass!)).toBeUndefined();
		// A pass keeps no log: once closed, it cannot be read.
		await expect(client.subscribe(firstPass!, "closed-pass")).resolves.toEqual({
			type: "ended",
			subscriptionId: "closed-pass",
			reason: "closed",
		});
	});

	it("keeps a pass that reads code-host context from paired devices, and ends its subscriptions as it closes", async () => {
		const { harness, repo, conversation, client } = await setup();
		const created = await harness.factory({
			cwd: repo,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.inMemory(repo),
		});
		const pass = conversation.session.reviewPasses.adopt(created, { localOnly: true });
		const linked = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const record = await conversation.work.start("review", reviewWorkInput("review.pr", "PR #243"), async (ctx) => {
			await ctx.child({ conversation: pass.id });
			linked.resolve();
			await finish.promise;
			return { outcome: "cancelled" };
		});
		cleanups.push(() => finish.resolve());
		await linked.promise;
		expect(conversation.work.get(record.workId)?.child).toEqual({ conversation: pass.id });

		const phone = await connect(harness, conversation, remote(conversation, repo));
		cleanups.push(() => phone.close());
		await expect(phone.subscribe(pass.id, "private")).resolves.toEqual({
			type: "ended",
			subscriptionId: "private",
			reason: "closed",
		});
		await expect(
			phone.query("history", { before: 1_000, limit: 10 }, { conversation: pass.id }),
		).resolves.toMatchObject({ type: "query_error", reason: { code: "unavailable" } });
		await expect(client.subscribe(pass.id, "local")).resolves.toMatchObject({ type: "snapshot" });
		// An observer is never asked a child's host requests: with no client of its own, a pass's dialog has no answer.
		const asker = await connect(harness, conversation, localProfile, ["confirm"]);
		cleanups.push(() => asker.close());
		await expect(asker.subscribe(pass.id, "asked")).resolves.toMatchObject({ type: "snapshot" });
		await expect(pass.liveState.request({ kind: "confirm", title: "Run it?", message: "Proceed?" })).resolves.toEqual(
			{ status: "cancelled", reason: "unavailable" },
		);

		await conversation.session.reviewPasses.close(pass);
		await vi.waitFor(() =>
			expect(client.framesOf("local").at(-1)).toEqual({ type: "ended", subscriptionId: "local", reason: "closed" }),
		);
		finish.resolve();
		await vi.waitFor(() => expect(conversation.work.get(record.workId)?.outcome).toBe("cancelled"));
	});

	it("passes the auxiliary tools a local client names, and refuses them and a pinned pull request to paired devices", async () => {
		const { harness, repo, conversation, client } = await setup();
		await expect(client.intent("review_uncommitted", { tools: ["edit"] })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input", message: "Not available to reviews: edit" },
		});
		await expect(client.intent("review_uncommitted", { tools: ["no_such_tool"] })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input" },
		});
		const phone = await connect(harness, conversation, remote(conversation, repo));
		cleanups.push(() => phone.close());
		await expect(phone.intent("review_uncommitted", { tools: ["bash"] })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", message: "tools is not available over remote host" },
		});
		await expect(
			phone.intent("review_pr", { url: "https://github.com/contributor/project/pull/42" }),
		).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", message: "url is not available over remote host" },
		});
		await expect(
			phone.query("intent_completions", { intent: "review_pr", field: "url", prefix: "" }),
		).resolves.toMatchObject({ type: "result", data: { completions: [] } });

		// Completing a review reads the workspace's history for a device that may start reviews, and for no other.
		const complete = { intent: "review_commit", field: "ref", prefix: "" };
		await expect(phone.query("intent_completions", complete)).resolves.toMatchObject({
			type: "result",
			data: { completions: [{ label: "initial" }] },
		});
		const observer = await connect(
			harness,
			conversation,
			remoteProfile({
				grant: createIrohRemoteRpcGrant(["conversation.observe.v1"]),
				redaction: { workspacePath: repo, remoteWorkspacePath: "/workspace" },
				bound: conversation.id,
			}),
		);
		cleanups.push(() => observer.close());
		await expect(observer.query("intent_completions", complete)).resolves.toEqual({
			type: "result",
			queryId: expect.any(String),
			data: { completions: [] },
		});

		const discovery = held(DISCOVERY_REPORT);
		harness.faux.setResponses([discovery.step, VERIFICATION_REPORT]);
		const started = await client.intent("review_uncommitted", { tools: ["bash"] });
		if (started.type !== "accepted") throw new Error(`review_uncommitted was rejected: ${JSON.stringify(started)}`);
		await discovery.started;
		const firstPass = conversation.work.get((started.result as { workId: string }).workId)?.child?.conversation;
		expect(conversation.session.reviewPasses.get(firstPass!)?.session.getActiveToolNames()).toContain("bash");
		discovery.release();
		await vi.waitFor(
			() => expect(conversation.work.get((started.result as { workId: string }).workId)?.outcome).toBe("completed"),
			{ timeout: 10_000 },
		);
	});
});

function scout(): SubagentDefinition {
	const filePath = join(tmpdir(), "observation-agents", "scout.md");
	return {
		name: "scout",
		description: "scout description",
		systemPrompt: "scout system prompt",
		allowedSubagents: ["scout"],
		source: "project",
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			baseDir: join(filePath, ".."),
		}),
		filePath,
	};
}

/** The confirmation token the subagent tool's preflight returned last in `context`. */
function confirmation(context: Parameters<FauxResponseFactory>[0]): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "toolResult" || message.toolName !== "subagent") continue;
		const text = message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const token = /"confirm": "([^"]+)"/.exec(text)?.[1];
		if (token) return token;
	}
	throw new Error("Expected a subagent spawn confirmation in the preflight result");
}

describe("closed descendants read from their logs", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/**
	 * A conversation whose subagent `scout` started a nested `scout` by tool;
	 * both ran to completion and closed. Resolves with their ids and the
	 * grandchild's work id in the child's log.
	 */
	async function setup() {
		const harness = await createHostHarness({ subagents: [scout()], whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const parent = await harness.openStartup();
		const client = await connect(harness, parent, localProfile);
		cleanups.push(() => client.close());
		const spawn = { agent: "scout", task: "dig deeper" };
		const responses: FauxResponseStep[] = [
			fauxAssistantMessage(fauxToolCall("subagent", spawn), { stopReason: "toolUse" }),
			(context) =>
				fauxAssistantMessage(fauxToolCall("subagent", { ...spawn, confirm: confirmation(context) }), {
					stopReason: "toolUse",
				}),
			fauxAssistantMessage("grand result"),
			fauxAssistantMessage("child result"),
		];
		harness.faux.setResponses(responses);
		const started = await client.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		if (started.type !== "accepted") throw new Error(`start_subagent was rejected: ${JSON.stringify(started)}`);
		const { workId, conversation: child } = started.result as { workId: string; conversation: string };
		await vi.waitFor(() => expect(parent.work.get(workId)?.outcome).toBe("completed"), { timeout: 10_000 });
		await vi.waitFor(() =>
			expect(parent.session.getSubagentToolManager()?.childConversation?.(child)).toBeUndefined(),
		);
		const childSnapshot = await client.subscribe(child, "child");
		if (childSnapshot.type !== "snapshot") throw new Error("Expected the closed child's snapshot");
		const nested = childSnapshot.state.entries.find((entry) => entry.type === "work_started")?.payload as
			| { workId: string; child: { conversation: string } }
			| undefined;
		if (!nested) throw new Error("Expected the child's subagent work");
		return { harness, parent, client, child, grandchild: nested.child.conversation, nestedWorkId: nested.workId };
	}

	it("subscribes to a closed grandchild, pages its history, and reads its content and its parent's work output", async () => {
		const { parent, client, child, grandchild, nestedWorkId } = await setup();
		expect(parent.work.list().some((record) => record.child?.conversation === grandchild)).toBe(false);

		const snapshot = await client.subscribe(grandchild, "grandchild");
		if (snapshot.type !== "snapshot") throw new Error("Expected the closed grandchild's snapshot");
		expect(snapshot.conversation).toBe(grandchild);
		expect(messageTexts(snapshot.state.entries)).toEqual([
			["user", "dig deeper"],
			["assistant", "grand result"],
		]);
		await vi.waitFor(() =>
			expect(client.framesOf("grandchild").at(-1)).toEqual({
				type: "ended",
				subscriptionId: "grandchild",
				reason: "closed",
			}),
		);
		// Read-only: nothing acts on it.
		await expect(client.intent("abort", {}, { conversation: grandchild })).resolves.toMatchObject({
			type: "rejected",
		});

		const newest = await client.query("history", { before: 1_000_000, limit: 1 }, { conversation: grandchild });
		if (newest.type !== "result") throw new Error(`history failed: ${JSON.stringify(newest)}`);
		const page = newest.data as { entries: ProjectedEntry[]; earlier: boolean };
		expect(page.earlier).toBe(true);
		expect(messageTexts(page.entries)).toEqual([["assistant", "grand result"]]);
		const older = await client.query(
			"history",
			{ before: page.entries[0]!.ordinal, limit: 100 },
			{ conversation: grandchild },
		);
		if (older.type !== "result") throw new Error(`history failed: ${JSON.stringify(older)}`);
		expect(messageTexts((older.data as { entries: ProjectedEntry[] }).entries)).toEqual([["user", "dig deeper"]]);
		await expect(
			client.query("content", { entryId: page.entries[0]!.id }, { conversation: grandchild }),
		).resolves.toMatchObject({ type: "result", data: { content: { type: "text", text: "grand result" } } });
		await expect(
			client.query("work_output", { workId: nestedWorkId }, { conversation: child }),
		).resolves.toMatchObject({ type: "result", data: { workId: nestedWorkId, text: "grand result", final: true } });
		// Only the queries that read logs read a closed one.
		await expect(client.query("models", undefined, { conversation: grandchild })).resolves.toMatchObject({
			type: "query_error",
			reason: { code: "unavailable" },
		});
	});

	it("locates closed children only by the work that links them, for paired devices within their reads", async () => {
		const { harness, parent, child, grandchild } = await setup();
		const unrelated = await harness.openStartup();
		const unrelatedId = unrelated.id;
		await harness.host.close(unrelated);
		const phone = await connect(harness, parent, remote(parent, harness.tempDir));
		cleanups.push(() => phone.close());
		// A stored conversation no work links is not readable, whatever the client names.
		await expect(phone.subscribe(unrelatedId, "unrelated")).resolves.toMatchObject({
			type: "ended",
			reason: "closed",
		});
		await expect(phone.subscribe(grandchild, "grandchild")).resolves.toMatchObject({
			type: "snapshot",
			conversation: grandchild,
		});
		await expect(
			phone.query("history", { before: 1_000_000, limit: 5 }, { conversation: grandchild }),
		).resolves.toMatchObject({ type: "result" });

		// Reading the grandchild reads its parent's log for the link, then its own, a read per snapshot tail.
		const tight = await connect(harness, parent, remote(parent, harness.tempDir, { snapshotTail: 1, readBurst: 4 }));
		cleanups.push(() => tight.close());
		const reads = vi.spyOn(SessionManager, "openReadOnly");
		// A query the profile refuses, or with invalid parameters, reads no log.
		await expect(
			tight.query("history", { before: -1, limit: 5 }, { conversation: grandchild }),
		).resolves.toMatchObject({ type: "query_error", reason: { code: "invalid_input" } });
		expect(reads).not.toHaveBeenCalled();
		await expect(
			tight.query("history", { before: 1_000_000, limit: 5 }, { conversation: grandchild }),
		).resolves.toMatchObject({
			type: "query_error",
			reason: { code: "unavailable", retryAfterMs: expect.any(Number) },
		});
		expect(reads).toHaveBeenCalledTimes(1);
		// A log too long for the budget is charged what it held before it loads again: it is not reloaded.
		await expect(
			tight.query("history", { before: 1_000_000, limit: 5 }, { conversation: grandchild }),
		).resolves.toMatchObject({ type: "query_error", reason: { code: "unavailable" } });
		expect(reads).toHaveBeenCalledTimes(1);
		void tight.subscribe(child, "child").catch(() => undefined);
		await vi.waitFor(() => expect(tight.frames.some((frame) => frame.type === "fatal")).toBe(true));
		expect(tight.frames.some((frame) => frame.type === "snapshot")).toBe(false);
	});
});
