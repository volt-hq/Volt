/**
 * Subagents a local protocol client starts (docs/rpc.md): the
 * `subagent_definitions` query, `subagent_start`, `subagent_abort`, and
 * `subagent_dispose` intents, each child's status as the parent's live
 * `subagent/<id>` value, and each child's log by subscribing to its
 * conversation. A connection's children are disposed when it ends or moves.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostFrame } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import { localProfile } from "../src/core/protocol/profiles.ts";
import { type ProtocolConnection, serveConnection } from "../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/index.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import type { SubagentDefinition, SubagentHandle, SubagentResult } from "../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../src/core/tools/index.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;
type IntentOutcome = Frame<"accepted"> | Frame<"rejected">;
type QueryOutcome = Frame<"result"> | Frame<"query_error">;

interface ControlledSubagent {
	handle: SubagentHandle;
	abort: ReturnType<typeof vi.fn<(source?: string) => Promise<void>>>;
	dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
	prompt: ReturnType<typeof vi.fn<(message: string) => Promise<void>>>;
	complete(result?: SubagentResult): void;
}

/** A local protocol client that records every frame and may hold several subscriptions. */
interface LocalClient {
	readonly frames: HostFrame[];
	readonly connection: ProtocolConnection;
	intent(type: string, input?: object, options?: { conversation?: string }): Promise<IntentOutcome>;
	query(query: string, params?: object): Promise<QueryOutcome>;
	/** Subscribe from a snapshot; resolves with the snapshot, or the `ended` frame when refused. */
	subscribe(conversation: string, subscriptionId: string): Promise<Frame<"snapshot"> | Frame<"ended">>;
	close(): Promise<void>;
}

async function connectLocal(harness: HostHarness, conversation: HostedConversation): Promise<LocalClient> {
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, localProfile, { host: harness.host, conversation });
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
	let ids = 0;
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
			await waitFor(
				(frame): frame is HostFrame =>
					(frame.type === "live" && frame.subscriptionId === subscriptionId && frame.reset === true) ||
					(frame.type === "ended" && frame.subscriptionId === subscriptionId),
			);
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

function createDefinition(
	name: string,
	filePath: string,
	overrides: Partial<SubagentDefinition> = {},
): SubagentDefinition {
	return {
		name,
		description: `${name} description`,
		tools: ["read", "grep"],
		model: "faux/model",
		thinking: "off",
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

function createResult(subagentId: string, sessionId: string): SubagentResult {
	return {
		id: subagentId,
		sessionId,
		event: { type: "agent_end", messages: [], willRetry: false },
		status: "completed",
	};
}

/** A child whose run the test ends; its conversation is a real one in the children's host. */
function createControlledSubagent(
	subagentId: string,
	conversation: HostedConversation,
	run: (message: string) => Promise<void> = async () => undefined,
): ControlledSubagent {
	const completion = Promise.withResolvers<SubagentResult>();
	const prompt = vi.fn(run);
	const abort = vi.fn(async (_source?: string) => undefined);
	const dispose = vi.fn(async () => undefined);
	const unused = async (): Promise<never> => {
		throw new Error("not used");
	};
	return {
		handle: {
			id: subagentId,
			sessionId: conversation.id,
			conversation,
			prompt,
			abort,
			getState: unused,
			getTranscript: unused,
			getSessionStats: unused,
			waitForEnd: () => completion.promise,
			dispose,
			onEvent: () => () => undefined,
		},
		abort,
		dispose,
		prompt,
		complete(result = createResult(subagentId, conversation.id)) {
			completion.resolve(result);
		},
	};
}

function subagentValue(conversation: HostedConversation, subagentId: string) {
	return conversation.liveState.get(`subagent/${subagentId}`);
}

describe("local protocol subagent lifecycle intents", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		vi.restoreAllMocks();
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	/** A parent conversation whose subagent manager is `manager`, and a local client of it. */
	async function setup(manager: SubagentToolManager, definitions: SubagentDefinition[] = []) {
		const harness = await createHostHarness();
		cleanups.push(() => harness.cleanup());
		const parent = await harness.openStartup();
		vi.spyOn(parent.session, "getSubagentToolManager").mockReturnValue(manager);
		vi.spyOn(parent.session, "getActiveToolNames").mockReturnValue(["read"]);
		vi.spyOn(parent.session.resourceLoader, "getSubagents").mockReturnValue({ definitions, diagnostics: [] });
		const client = await connectLocal(harness, parent);
		cleanups.push(() => client.close());
		return { harness, parent, client };
	}

	test("subagent_definitions returns safe discovered definition summaries", async () => {
		const filePath = join(tmpdir(), "unsafe-project", ".volt", "agents", "scout.md");
		const manager = {
			getDefinition: () => createDefinition("scout", filePath),
			startByName: async () => {
				throw new Error("not used");
			},
		} satisfies SubagentToolManager;
		const definition = createDefinition("scout", filePath, {
			excludedTools: ["subagent"],
			allowedSubagents: ["researcher"],
			maxSubagentDepth: 2,
			maxChildAgents: 3,
		});
		const { client } = await setup(manager, [definition]);

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
						model: "faux/model",
						thinking: "off",
					},
				],
			},
		});
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toContain(filePath);
		expect(serialized).not.toContain("secret system prompt");
		expect(serialized).not.toContain("baseDir");
	});

	test("subagent_start answers the child's id and conversation and shows its status until it ends", async () => {
		const childHarness = await createHostHarness();
		cleanups.push(() => childHarness.cleanup());
		const childConversation = await childHarness.openStartup();
		const child = createControlledSubagent("sa_child", childConversation);
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const { parent, client } = await setup(manager);

		await expect(client.intent("subagent_start", { agent: "scout", prompt: "inspect auth" })).resolves.toMatchObject({
			type: "accepted",
			result: { subagentId: "sa_child", conversation: childConversation.id },
		});
		expect(manager.startByName).toHaveBeenCalledWith("scout", { allowedTools: ["read"] });
		expect(child.prompt).toHaveBeenCalledWith("inspect auth");
		expect(subagentValue(parent, "sa_child")).toEqual({
			kind: "subagent",
			subagentId: "sa_child",
			conversation: childConversation.id,
			agent: "scout",
			status: "running",
		});

		child.complete();
		await vi.waitFor(() => expect(subagentValue(parent, "sa_child")).toMatchObject({ status: "completed" }));
		// The client saw the status change on its live lane.
		await client.subscribe(parent.id, "parent");
		const live = client.frames.find((frame) => frame.type === "live" && frame.subscriptionId === "parent");
		expect(live?.type === "live" ? live.items : []).toContainEqual(
			expect.objectContaining({
				type: "set",
				key: "subagent/sa_child",
				value: expect.objectContaining({ status: "completed" }),
			}),
		);
	});

	test("subagent_abort calls through, disposes, and removes the child", async () => {
		const childHarness = await createHostHarness();
		cleanups.push(() => childHarness.cleanup());
		const childConversation = await childHarness.openStartup();
		const child = createControlledSubagent("sa_abort", childConversation);
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const { parent, client } = await setup(manager);

		await expect(client.intent("subagent_start", { agent: "scout", prompt: "slow" })).resolves.toMatchObject({
			type: "accepted",
		});
		await expect(client.intent("subagent_abort", { subagentId: "sa_abort" })).resolves.toMatchObject({
			type: "accepted",
		});
		expect(child.abort).toHaveBeenCalledWith("remote_request");
		expect(child.dispose).toHaveBeenCalledOnce();
		expect(subagentValue(parent, "sa_abort")).toBeUndefined();

		await expect(client.intent("subagent_abort", { subagentId: "sa_abort" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "Subagent sa_abort is not active" },
		});
		// Its conversation is no longer readable through this connection.
		await expect(client.subscribe(childConversation.id, "child")).resolves.toEqual({
			type: "ended",
			subscriptionId: "child",
			reason: "closed",
		});
	});

	test("a client reads each child's log by subscribing to the child's conversation", async () => {
		const childHarness = await createHostHarness({ responses: ["first answer", "second answer"] });
		cleanups.push(() => childHarness.cleanup());
		const firstConversation = await childHarness.openStartup();
		const secondConversation = await childHarness.openStartup();
		const run = (conversation: HostedConversation) => async (message: string) => {
			await conversation.session.prompt(message);
			await conversation.session.waitForIdle();
		};
		const first = createControlledSubagent("sa_first", firstConversation, run(firstConversation));
		const second = createControlledSubagent("sa_second", secondConversation, run(secondConversation));
		const manager = {
			getDefinition: (agent: string) => createDefinition(agent, `/tmp/${agent}.md`),
			startByName: vi.fn(async (agent: string) => (agent === "first" ? first.handle : second.handle)),
		} satisfies SubagentToolManager;
		const { client } = await setup(manager);

		await expect(client.intent("subagent_start", { agent: "first", prompt: "one" })).resolves.toMatchObject({
			type: "accepted",
			result: { conversation: firstConversation.id },
		});
		await expect(client.intent("subagent_start", { agent: "second", prompt: "two" })).resolves.toMatchObject({
			type: "accepted",
			result: { conversation: secondConversation.id },
		});

		const snapshot = await client.subscribe(secondConversation.id, "second");
		if (snapshot.type !== "snapshot") throw new Error("Expected the child's snapshot");
		expect(snapshot.conversation).toBe(secondConversation.id);
		expect(
			snapshot.state.entries.flatMap((entry) =>
				entry.type === "message" ? [[entry.view?.role, entry.view?.text]] : [],
			),
		).toEqual([
			["user", "two"],
			["assistant", "second answer"],
		]);
		// A child is observe-only: an intent on its conversation is refused.
		await expect(
			client.intent("set_session_name", { name: "renamed" }, { conversation: firstConversation.id }),
		).resolves.toMatchObject({ type: "rejected", reason: { code: "read_only" } });
		expect(firstConversation.session.sessionManager.getSessionName()).toBeUndefined();
	});

	test("subagent_dispose removes the child and later intents fail clearly", async () => {
		const childHarness = await createHostHarness();
		cleanups.push(() => childHarness.cleanup());
		const childConversation = await childHarness.openStartup();
		const child = createControlledSubagent("sa_dispose", childConversation);
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => child.handle),
		} satisfies SubagentToolManager;
		const { parent, client } = await setup(manager);

		await client.intent("subagent_start", { agent: "scout", prompt: "work" });
		await expect(client.intent("subagent_dispose", { subagentId: "sa_dispose" })).resolves.toMatchObject({
			type: "accepted",
		});
		expect(child.dispose).toHaveBeenCalledOnce();
		expect(subagentValue(parent, "sa_dispose")).toBeUndefined();

		await expect(client.intent("subagent_dispose", { subagentId: "sa_dispose" })).resolves.toMatchObject({
			type: "rejected",
			reason: { code: "failed", message: "Subagent sa_dispose is not active" },
		});
	});

	test("ending the connection and moving it to a new session dispose the children it started", async () => {
		const childHarness = await createHostHarness();
		cleanups.push(() => childHarness.cleanup());
		const first = createControlledSubagent("sa_shutdown", await childHarness.openStartup());
		const second = createControlledSubagent("sa_replaced", await childHarness.openStartup());
		let nextHandle = first.handle;
		const manager = {
			getDefinition: () => createDefinition("scout", "/tmp/scout.md"),
			startByName: vi.fn(async () => nextHandle),
		} satisfies SubagentToolManager;
		const { harness, parent, client } = await setup(manager);

		await client.intent("subagent_start", { agent: "scout", prompt: "keep alive" });
		await client.close();
		expect(first.dispose).toHaveBeenCalledOnce();

		nextHandle = second.handle;
		const reopened = await harness.openStartup();
		vi.spyOn(reopened.session, "getSubagentToolManager").mockReturnValue(manager);
		const mover = await connectLocal(harness, reopened);
		cleanups.push(() => mover.close());
		await mover.intent("subagent_start", { agent: "scout", prompt: "replace me" });
		const moved = await mover.intent("new_session", {});
		expect(moved).toMatchObject({ type: "accepted", conversation: expect.any(String) });
		expect(moved.type === "accepted" ? moved.conversation : undefined).not.toBe(reopened.id);
		await vi.waitFor(() => expect(second.dispose).toHaveBeenCalledOnce());
		expect(subagentValue(reopened, "sa_replaced")).toBeUndefined();
		expect(parent.closed).toBe(true);
	});
});
