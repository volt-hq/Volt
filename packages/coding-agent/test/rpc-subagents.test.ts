/**
 * Subagents a protocol client starts (docs/rpc.md): the `subagent_definitions`
 * query and the `start_subagent` intent, which starts the subagent as `subagent`
 * work of the conversation (RFC §7). The work's id is the subagent id; its
 * progress is the conversation's live `work/<id>` value; `cancel_work` stops
 * it and `open_work` names its conversation. A client reads only the children
 * its conversation links by subagent work, observe-only; a paired device may
 * neither start, cancel, nor resume them.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, RemoteGrant } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { localProfile, type Profile, remoteProfile } from "../src/core/protocol/profiles.ts";
import { type ProtocolConnection, serveConnection } from "../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../src/core/protocol/transport/index.ts";
import { createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { SubagentDefinition } from "../src/core/subagents/index.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
type IntentOutcome = Frame<"accepted"> | Frame<"rejected">;
type QueryOutcome = Frame<"result"> | Frame<"query_error">;

/** A protocol client that records every frame and may hold several subscriptions. */
interface Client {
	readonly frames: HostFrame[];
	readonly connection: ProtocolConnection;
	intent(type: string, input?: object, options?: { conversation?: string }): Promise<IntentOutcome>;
	query(query: string, params?: object): Promise<QueryOutcome>;
	/** Subscribe from a snapshot; resolves with the snapshot, or the `ended` frame when refused. */
	subscribe(conversation: string, subscriptionId: string): Promise<Frame<"snapshot"> | Frame<"ended">>;
	close(): Promise<void>;
}

/** Ids of intents and queries, unique across every client: a host remembers intent outcomes by id. */
let ids = 0;

async function connect(
	harness: HostHarness,
	conversation: HostedConversation,
	profile: Profile,
	options: { anchor?: boolean } = {},
): Promise<Client> {
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, profile, {
		host: harness.host,
		conversation,
		...(options.anchor === undefined ? {} : { anchor: options.anchor }),
	});
	const frames: HostFrame[] = [];
	pair.client.onValue?.((value) => {
		frames.push(value as HostFrame);
	});
	const send = (frame: object): void => void pair.client.write(frame);
	const waitFor = async <T extends HostFrame>(predicate: (frame: HostFrame) => frame is T): Promise<T> => {
		let found: T | undefined;
		await vi.waitFor(() => {
			found = frames.find(predicate);
			expect(found).toBeDefined();
		});
		return found!;
	};
	send({ type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } });
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
		query(query, params) {
			const queryId = `q-${++ids}`;
			send({ type: "query", queryId, query, ...(params === undefined ? {} : { params }) });
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
		async close() {
			await pair.client.close();
			await connection.closed.catch(() => undefined);
		},
	};
}

function definition(name: string, overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
	const filePath = join(tmpdir(), "unsafe-project", ".volt", "agents", `${name}.md`);
	return {
		name,
		description: `${name} description`,
		tools: ["read", "grep"],
		systemPrompt: `${name} secret system prompt`,
		source: "project",
		sourceInfo: createSyntheticSourceInfo(filePath, {
			source: "local",
			scope: "project",
			baseDir: join(filePath, ".."),
		}),
		filePath,
		...overrides,
	};
}

/** A child response that runs until the child's run is aborted. */
const runsUntilStopped: FauxResponseStep = async (_context, options) => {
	const signal = options?.signal;
	await new Promise<void>((resolve) => {
		if (signal?.aborted) resolve();
		signal?.addEventListener("abort", () => resolve(), { once: true });
	});
	return fauxAssistantMessage("", { stopReason: "aborted" });
};

const GRANT: RemoteGrant = createIrohRemoteRpcGrant(["conversation.observe.v1", "conversation.control.v1"]);

describe("protocol subagents", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** A parent conversation whose sessions start `scout` subagents, and a local client of it. */
	async function setup(options: { anchor?: boolean } = {}) {
		const harness = await createHostHarness({
			subagents: [definition("scout")],
			// A conversation stays open while unattached unless its anchor leaves.
			...(options.anchor === false ? { whenUnattached: "keep" as const } : {}),
		});
		cleanups.push(() => harness.cleanup());
		const parent = await harness.openStartup();
		const client = await connect(harness, parent, localProfile, options);
		cleanups.push(() => client.close());
		return { harness, parent, client };
	}

	/** Start a `scout` that runs until stopped, as a local client does. */
	async function startScout(context: Awaited<ReturnType<typeof setup>>) {
		context.harness.faux.setResponses([runsUntilStopped]);
		const outcome = await context.client.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		if (outcome.type !== "accepted") throw new Error(`start_subagent was rejected: ${JSON.stringify(outcome)}`);
		const result = outcome.result as { workId: string; conversation: string };
		await vi.waitFor(() => expect(context.harness.faux.state.callCount).toBe(1));
		return result;
	}

	test("subagent_definitions returns safe discovered definition summaries", async () => {
		const harness = await createHostHarness({
			subagents: [
				definition("scout", {
					excludedTools: ["subagent"],
					allowedSubagents: ["researcher"],
					maxSubagentDepth: 2,
					maxChildAgents: 3,
					thinking: "off",
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		const parent = await harness.openStartup();
		const client = await connect(harness, parent, localProfile);
		cleanups.push(() => client.close());

		const outcome = await client.query("subagent_definitions");
		expect(outcome).toMatchObject({
			type: "result",
			data: {
				subagents: [
					{
						name: "scout",
						description: "scout description",
						source: "project",
						sourceInfo: { source: "local", scope: "project", origin: "top-level" },
						tools: ["read", "grep"],
						excludedTools: ["subagent"],
						allowedSubagents: ["researcher"],
						maxSubagentDepth: 2,
						maxChildAgents: 3,
						thinking: "off",
					},
				],
			},
		});
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toContain(join(tmpdir(), "unsafe-project"));
		expect(serialized).not.toContain("secret system prompt");
		expect(serialized).not.toContain("baseDir");
	});

	test("start_subagent starts subagent work of the conversation and answers its id and child conversation", async () => {
		const context = await setup();
		context.harness.faux.setResponses([fauxAssistantMessage("auth is sound")]);
		const outcome = await context.client.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		expect(outcome).toMatchObject({
			type: "accepted",
			result: { workId: expect.stringMatching(/^sa_/), conversation: expect.any(String) },
		});
		const { workId, conversation } = (outcome as Frame<"accepted">).result as {
			workId: string;
			conversation: string;
		};
		await vi.waitFor(() => expect(context.parent.work.get(workId)?.outcome).toBe("completed"));
		expect(context.parent.work.get(workId)).toMatchObject({
			kind: "subagent",
			title: "scout: inspect auth",
			child: { conversation },
			result: { output: { text: "auth is sound" } },
		});
		expect(context.parent.work.get(workId)?.toolCallId).toBeUndefined();
		await expect(context.client.query("work_output", { workId })).resolves.toMatchObject({
			type: "result",
			data: { workId, text: "auth is sound", final: true },
		});
		// No live `subagent/<id>` value: a subagent's progress is its work's.
		expect(context.parent.liveState.get(`subagent/${workId}`)).toBeUndefined();
	});

	test("a running subagent's live work progress is the tool its conversation runs, without checkpoints", async () => {
		const context = await setup();
		context.harness.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "src/auth.ts" }), { stopReason: "toolUse" }),
			runsUntilStopped,
		]);
		const outcome = await context.client.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		if (outcome.type !== "accepted") throw new Error(`start_subagent was rejected: ${JSON.stringify(outcome)}`);
		const { workId } = outcome.result as { workId: string };
		await vi.waitFor(() => expect(context.harness.faux.state.callCount).toBe(2));
		await vi.waitFor(() =>
			expect(context.parent.liveState.get(`work/${workId}`)).toMatchObject({
				kind: "work",
				workId,
				progress: { text: "read src/auth.ts" },
			}),
		);
		// Activity is live only: the log keeps no checkpoint of it.
		const workTypes = context.parent.session.sessionManager
			.committedEntriesAfter(0)
			.filter((entry) => entry.type.startsWith("work_"))
			.map((entry) => entry.type);
		expect(workTypes).toEqual(["work_started"]);
		await context.parent.work.cancel(workId);
		await vi.waitFor(() => expect(context.parent.work.get(workId)?.outcome).toBe("cancelled"));
	});

	test("cancel_work stops a running subagent; its closed conversation stays readable from its log", async () => {
		const context = await setup();
		const { workId, conversation } = await startScout(context);
		expect(context.parent.work.running().map((record) => record.workId)).toEqual([workId]);
		expect(context.parent.liveState.get(`work/${workId}`)).toMatchObject({ kind: "work", workId });

		// A stop of the conversation leaves the subagent alone.
		await expect(context.client.intent("abort")).resolves.toMatchObject({ type: "accepted" });
		expect(context.parent.work.running().map((record) => record.workId)).toEqual([workId]);

		await expect(context.client.intent("cancel_work", { workId })).resolves.toMatchObject({ type: "accepted" });
		await vi.waitFor(() => expect(context.parent.work.get(workId)?.outcome).toBe("cancelled"));
		await vi.waitFor(() => expect(context.parent.liveState.get(`work/${workId}`)).toBeUndefined());
		await vi.waitFor(() =>
			expect(context.parent.session.getSubagentToolManager()?.childConversation?.(conversation)).toBeUndefined(),
		);
		// open_work still names the closed child, and a subscription reads its log once, then ends.
		await expect(context.client.intent("open_work", { workId })).resolves.toMatchObject({
			type: "accepted",
			result: { conversation },
		});
		const snapshot = await context.client.subscribe(conversation, "child");
		if (snapshot.type !== "snapshot") throw new Error("Expected the closed child's snapshot");
		expect(snapshot.conversation).toBe(conversation);
		expect(
			snapshot.state.entries.flatMap((entry) =>
				entry.type === "message" ? [[entry.view?.role, entry.view?.text]] : [],
			),
		).toContainEqual(["user", "inspect auth"]);
		await vi.waitFor(() =>
			expect(context.client.frames).toContainEqual({ type: "ended", subscriptionId: "child", reason: "closed" }),
		);
		// Read-only: nothing acts on the closed child.
		await expect(
			context.client.intent("set_session_name", { name: "renamed" }, { conversation }),
		).resolves.toMatchObject({ type: "rejected" });
		await expect(context.client.intent("cancel_work", { workId })).resolves.toMatchObject({ type: "rejected" });
	});

	test("a subscription to a conversation no work links ends without reading any log", async () => {
		const context = await setup();
		await startScout(context);
		await expect(context.client.subscribe("not-a-linked-child", "other")).resolves.toEqual({
			type: "ended",
			subscriptionId: "other",
			reason: "closed",
		});
	});

	test("a client reads a linked child's log, observe-only, and open_work names it", async () => {
		const context = await setup();
		const { workId, conversation } = await startScout(context);
		await expect(context.client.intent("open_work", { workId })).resolves.toMatchObject({
			type: "accepted",
			result: { conversation },
		});
		const snapshot = await context.client.subscribe(conversation, "child");
		if (snapshot.type !== "snapshot") throw new Error("Expected the child's snapshot");
		expect(snapshot.conversation).toBe(conversation);
		expect(
			snapshot.state.entries.flatMap((entry) =>
				entry.type === "message" ? [[entry.view?.role, entry.view?.text]] : [],
			),
		).toEqual([["user", "inspect auth"]]);
		// A child is observe-only: an intent on its conversation is refused.
		await expect(
			context.client.intent("set_session_name", { name: "renamed" }, { conversation }),
		).resolves.toMatchObject({ type: "rejected", reason: { code: "read_only" } });
	});

	test("the subagent outlives the connection that started it, not its conversation", async () => {
		const context = await setup({ anchor: false });
		const { workId } = await startScout(context);
		await context.client.close();
		expect(context.parent.work.running().map((record) => record.workId)).toEqual([workId]);
		await context.parent.work.cancel(workId);
		await vi.waitFor(() => expect(context.parent.work.get(workId)?.outcome).toBe("cancelled"));
	});

	test("a paired device observes linked children only, and may neither start, cancel, nor resume subagents", async () => {
		const harness = await createHostHarness({ subagents: [definition("scout")] });
		cleanups.push(() => harness.cleanup());
		const parent = await harness.openStartup();
		const unrelated = await harness.openStartup();
		const local = await connect(harness, parent, localProfile);
		cleanups.push(() => local.close());
		harness.faux.setResponses([runsUntilStopped]);
		const started = await local.intent("start_subagent", { agent: "scout", prompt: "inspect auth" });
		const { workId, conversation } = (started as Frame<"accepted">).result as {
			workId: string;
			conversation: string;
		};
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));

		const profile = remoteProfile({
			grant: GRANT,
			redaction: { workspacePath: tmpdir(), remoteWorkspacePath: "/workspace" },
			bound: parent.id,
		});
		const remote = await connect(harness, parent, profile);
		cleanups.push(() => remote.close());
		// The work a device sees carries the child's conversation, never its log's locator.
		const snapshot = await remote.subscribe(parent.id, "parent");
		if (snapshot.type !== "snapshot") throw new Error("Expected the parent's snapshot");
		const startedEntry = snapshot.state.entries.find((entry) => entry.type === "work_started");
		expect(startedEntry?.payload).toMatchObject({ workId, child: { conversation }, input: null });
		expect(JSON.stringify(startedEntry)).not.toContain("sessionDirectory");
		// The linked child is readable; an unrelated conversation is not.
		await expect(remote.subscribe(conversation, "child")).resolves.toMatchObject({ type: "snapshot" });
		await expect(remote.subscribe(unrelated.id, "unrelated")).resolves.toMatchObject({
			type: "ended",
			reason: "closed",
		});
		const opened = await remote.intent("open_work", { workId });
		expect(opened, JSON.stringify(opened)).toMatchObject({ type: "accepted", result: { conversation } });
		await expect(remote.intent("cancel_work", { workId })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		await expect(remote.intent("resume_work", { workId })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		await expect(remote.intent("start_subagent", { agent: "scout", prompt: "more" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed" },
		});
		expect(parent.work.running().map((record) => record.workId)).toEqual([workId]);
		await parent.work.cancel(workId);
		await vi.waitFor(() => expect(parent.work.get(workId)?.outcome).toBe("cancelled"));
		await vi.waitFor(() =>
			expect(parent.session.getSubagentToolManager()?.childConversation?.(conversation)).toBeUndefined(),
		);
		// The closed child stays readable, as a snapshot of its log.
		await expect(remote.subscribe(conversation, "closed-child")).resolves.toMatchObject({
			type: "snapshot",
			conversation,
		});
		// A read costs its log's length in snapshot tails: a device short of reads is cut off before it gets one.
		const tight = await connect(
			harness,
			parent,
			remoteProfile({
				grant: GRANT,
				redaction: { workspacePath: tmpdir(), remoteWorkspacePath: "/workspace" },
				bound: parent.id,
				limits: { snapshotTail: 1, readBurst: 2 },
			}),
		);
		cleanups.push(() => tight.close());
		void tight.subscribe(conversation, "tight").catch(() => undefined);
		await vi.waitFor(() => expect(tight.frames.some((frame) => frame.type === "fatal")).toBe(true));
		expect(tight.frames.some((frame) => frame.type === "snapshot")).toBe(false);
	});
});
