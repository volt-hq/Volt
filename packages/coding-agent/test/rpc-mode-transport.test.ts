/**
 * RPC mode over a caller-provided transport (docs/rpc.md): one protocol
 * connection on the local profile. The sessions a client lists and switches
 * to, the order its intents and queries run in, the Git context it is served,
 * approvals and their progress across clients, input validated before the
 * session is touched, and how a structural intent in flight, a failed write,
 * flush, input, or bind, and a close during startup end the mode. On the
 * remote profile, host requests follow the device's grant.
 */

import type { HostFrame, HostRequestKind, QueryParams, RemoteCapability } from "@hansjm10/volt-protocol";
import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopbackClient, ProtocolClient, ProtocolRejectedError } from "../src/client/protocol-client.ts";
import { GitContextProvider } from "../src/core/git-context-provider.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import {
	createLoopbackRpcTransportPair,
	type RpcCloseHandler,
	type RpcTransport,
} from "../src/core/protocol/transport/index.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import type { WorkExecution } from "../src/core/work/registry.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createHostHarness, type HostHarness, type HostHarnessOptions } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const HELLO = { type: "hello", protocol: 1, client: { name: "test", version: "1" }, accepts: { hostRequests: [] } };

interface ProbedTransport {
	readonly transport: RpcTransport;
	readonly close: ReturnType<typeof vi.fn>;
	/** End the mode's input with `error`, as a failing stream does. */
	failInput(error: Error): void;
}

/** The mode's end of a loopback pair, with a write that may fail, a replaceable flush, and a counted close. */
function probed(
	server: RpcTransport,
	options: { failWrite?: (frame: HostFrame) => Error | undefined; flush?: () => Promise<void> } = {},
): ProbedTransport {
	const closeHandlers = new Set<RpcCloseHandler>();
	const close = vi.fn(() => server.close());
	const transport: RpcTransport = {
		write(value) {
			const error = options.failWrite?.(value as HostFrame);
			return error ? Promise.reject(error) : server.write(value);
		},
		onLine: (handler) => server.onLine(handler),
		onValue(handler) {
			if (!server.onValue) throw new Error("The loopback transport passes values");
			return server.onValue(handler);
		},
		onClose(handler) {
			closeHandlers.add(handler);
			const detach = server.onClose?.(handler) ?? (() => {});
			return () => {
				closeHandlers.delete(handler);
				detach();
			};
		},
		flush: options.flush ?? (async () => server.flush?.()),
		close,
	};
	return {
		transport,
		close,
		failInput(error) {
			for (const handler of [...closeHandlers]) handler(error);
		},
	};
}

describe("RPC mode on a caller-provided transport", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		vi.restoreAllMocks();
	});

	async function setup(options: HostHarnessOptions = {}): Promise<HostHarness> {
		const harness = await createHostHarness(options);
		cleanups.push(() => harness.cleanup());
		return harness;
	}

	/** Run RPC mode on `conversation` over `transport` (the loopback pair's server end by default) and connect a client. */
	async function startMode(
		harness: HostHarness,
		conversation: HostedConversation,
		options: { hostRequests?: HostRequestKind[]; wrap?: (server: RpcTransport) => RpcTransport } = {},
	): Promise<{ mode: Promise<void>; client: ProtocolClient; frames: HostFrame[] }> {
		const pair = createLoopbackRpcTransportPair();
		const ready = Promise.withResolvers<void>();
		const mode = runRpcMode(harness.host, conversation, {
			transport: options.wrap ? options.wrap(pair.server) : pair.server,
			onReady: ready.resolve,
		});
		void mode.catch(() => undefined);
		const frames: HostFrame[] = [];
		const client = new ProtocolClient({
			hostRequests: options.hostRequests ?? [],
			onFrame: (frame) => frames.push(frame),
		});
		cleanups.push(async () => {
			await client.stop();
			await mode.catch(() => undefined);
		});
		await client.connect(pair.client);
		await ready.promise;
		return { mode, client, frames };
	}

	/** A stored session other than the one the client starts on, closed again. */
	async function storedSession(harness: HostHarness, prompt: string): Promise<string> {
		const other = await harness.openStartup();
		await other.session.prompt(prompt);
		await harness.host.close(other);
		return other.id;
	}

	it("lists the sessions and switches to one by id; the source closes with its anchor", async () => {
		const harness = await setup();
		const otherId = await storedSession(harness, "other session");
		const conversation = await harness.openStartup();
		await conversation.session.prompt("this session");
		const { client } = await startMode(harness, conversation);

		const listed = await client.query("sessions");
		expect(listed.sessions.map((session) => [session.sessionId, session.current])).toEqual(
			expect.arrayContaining([
				[conversation.id, true],
				[otherId, false],
			]),
		);
		expect(listed).toMatchObject({ hasMore: false, nextCursor: null });

		const accepted = await client.intent("switch_session", { sessionId: otherId });
		expect(accepted.conversation).toBe(otherId);
		await vi.waitFor(() => expect(client.conversation).toBe(otherId));
		await client.caughtUp();
		expect(conversation.closed).toBe(true);
		expect(client.state.entries.flatMap((entry) => (entry.type === "message" ? [entry.view?.text] : []))).toEqual([
			"other session",
			"one",
		]);
		const after = await client.query("sessions");
		expect(after.sessions.filter((session) => session.current).map((session) => session.sessionId)).toEqual([
			otherId,
		]);
	});

	it("runs a query sent during a session switch after the switch, against the conversation it moved to", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_before_switch", async (event) => {
					if (event.reason !== "resume") return;
					entered.resolve();
					await gate.promise;
				});
			},
		});
		cleanups.push(async () => gate.resolve());
		const otherId = await storedSession(harness, "other session");
		const conversation = await harness.openStartup();
		const { client, frames } = await startMode(harness, conversation);

		const switching = client.intent("switch_session", { sessionId: otherId });
		await entered.promise;
		const listing = client.query("sessions");
		gate.resolve();
		const [accepted, listed] = await Promise.all([switching, listing]);

		expect(listed.sessions.filter((session) => session.current).map((session) => session.sessionId)).toEqual([
			otherId,
		]);
		const acceptedAt = frames.findIndex((frame) => frame.type === "accepted" && frame.intentId === accepted.intentId);
		const resultAt = frames.findIndex((frame) => frame.type === "result");
		expect(acceptedAt).toBeGreaterThanOrEqual(0);
		expect(resultAt).toBeGreaterThan(acceptedAt);
	});

	it("leaves no conversation open when the transport closes while a structural intent runs", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_before_switch", async (event) => {
					if (event.reason !== "new") return;
					entered.resolve();
					await gate.promise;
				});
			},
		});
		cleanups.push(async () => gate.resolve());
		const conversation = await harness.openStartup();
		const { mode, client } = await startMode(harness, conversation);
		let settled = false;
		void mode.finally(() => {
			settled = true;
		});

		const opening = client.intent("new_session", {});
		await entered.promise;
		await client.stop();
		await expect(opening).rejects.toThrow();
		// The anchor's conversation closes with the connection; the mode ends once the intent did.
		await vi.waitFor(() => expect(conversation.closed).toBe(true));
		expect(settled).toBe(false);

		gate.resolve();
		await expect(mode).resolves.toBeUndefined();
		expect(harness.host.list()).toEqual([]);
		expect(harness.events.filter((event) => event.type === "session_start").map((event) => event.reason)).toEqual([
			"startup",
		]);
	});

	it("serves the cached Git context without waiting for a refresh", async () => {
		const gitContext: RpcGitContext = {
			repository: "workspace",
			head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
			upstream: null,
			base: null,
			status: {
				staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
				unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
				untracked: 0,
				conflicted: 0,
				total: 0,
				clean: true,
			},
			operation: null,
			revision: 1,
			observedAt: "2026-07-29T00:00:00.000Z",
			stale: false,
		};
		vi.spyOn(GitContextProvider.prototype, "getSnapshot").mockReturnValue(gitContext);
		// A refresh never finishes: the client is served what the provider holds.
		vi.spyOn(GitContextProvider.prototype, "refresh").mockReturnValue(new Promise(() => {}));
		const harness = await setup();
		const conversation = await harness.openStartup();
		const { client } = await startMode(harness, conversation);
		expect(client.live.values.get("git")).toEqual({ kind: "git", gitContext });
	});

	it("rejects invalid intent input and query parameters before touching the session", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const session = conversation.session;
		const touched = [
			vi.spyOn(session, "setAutoCompactionEnabled"),
			vi.spyOn(session, "setAutoRetryEnabled"),
			vi.spyOn(session, "setSteeringMode"),
			vi.spyOn(session, "setFollowUpMode"),
			vi.spyOn(session, "setThinkingLevel"),
			vi.spyOn(session, "setSessionName"),
			vi.spyOn(session, "prompt"),
			vi.spyOn(session, "steer"),
			vi.spyOn(session, "followUp"),
			vi.spyOn(session, "runUserBash"),
		];
		const entries = session.sessionManager.getEntries().length;
		const { client } = await startMode(harness, conversation);
		const invalid: Array<{ name: string; input: Record<string, unknown> }> = [
			{ name: "set_auto_compaction", input: { enabled: "false" } },
			{ name: "set_auto_retry", input: { enabled: "false" } },
			{ name: "set_steering_mode", input: { mode: "bad" } },
			{ name: "set_follow_up_mode", input: { mode: "bad" } },
			{ name: "set_thinking_level", input: { level: "bad" } },
			{ name: "set_session_name", input: { name: 123 } },
			{ name: "prompt", input: { message: 123 } },
			{ name: "steer", input: { message: 123 } },
			{ name: "follow_up", input: { message: 123 } },
			{ name: "bash", input: { command: 123 } },
		];
		for (const { name, input } of invalid) {
			const outcome = client.intent(name, input);
			await expect(outcome, name).rejects.toBeInstanceOf(ProtocolRejectedError);
			await expect(outcome, name).rejects.toMatchObject({ reason: { code: "invalid_input" } });
		}
		for (const params of [
			{ before: "10", limit: 10 },
			{ before: 10, limit: 10, branch: 123 },
		]) {
			await expect(
				client.query("history", params as unknown as QueryParams<"history">),
				JSON.stringify(params),
			).rejects.toMatchObject({ code: "invalid_input" });
		}
		for (const spy of touched) expect(spy).not.toHaveBeenCalled();
		expect(session.sessionManager.getEntries()).toHaveLength(entries);
	});

	it.each([
		{
			failing: "an intent's outcome",
			fails: (frame: HostFrame) => frame.type === "rejected",
			send: (client: ProtocolClient) => client.intent("no_such_intent", {}),
		},
		{
			failing: "a prompt's acceptance",
			fails: (frame: HostFrame) => frame.type === "accepted" && frame.intentId === "prompt-write-failure",
			send: (client: ProtocolClient) => client.prompt("hello", { clientMessageId: "prompt-write-failure" }),
		},
		{
			failing: "a live frame of the run",
			fails: (frame: HostFrame) =>
				frame.type === "live" && frame.items.some((item) => item.type === "assistant_start"),
			send: (client: ProtocolClient) => client.prompt("hello"),
		},
	])("ends the mode with the write's error when writing $failing fails", async ({ fails, send }) => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const writeError = new Error("write failed");
		let probe: ProbedTransport | undefined;
		const { mode, client } = await startMode(harness, conversation, {
			wrap: (server) => {
				probe = probed(server, { failWrite: (frame) => (fails(frame) ? writeError : undefined) });
				return probe.transport;
			},
		});
		void send(client).catch(() => undefined);

		await expect(mode).rejects.toBe(writeError);
		expect(conversation.closed).toBe(true);
		expect(probe?.close).toHaveBeenCalledOnce();
		expect(conversation.session.isBusy).toBe(false);
	});

	it("ends the mode without exiting the process when the client disconnects, and closes the anchored conversation", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});
		let probe: ProbedTransport | undefined;
		const { mode, client } = await startMode(harness, conversation, {
			wrap: (server) => {
				probe = probed(server);
				return probe.transport;
			},
		});

		await client.stop();
		await expect(mode).resolves.toBeUndefined();
		expect(exit).not.toHaveBeenCalled();
		expect(conversation.closed).toBe(true);
		expect(probe?.close).toHaveBeenCalledOnce();
	});

	it("ends the mode with the input's error when the transport fails", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const inputError = new Error("input failed");
		let probe: ProbedTransport | undefined;
		const { mode } = await startMode(harness, conversation, {
			wrap: (server) => {
				probe = probed(server);
				return probe.transport;
			},
		});

		probe?.failInput(inputError);
		await expect(mode).rejects.toBe(inputError);
		expect(conversation.closed).toBe(true);
		expect(probe?.close).toHaveBeenCalledOnce();
	});

	it("still closes the transport when the shutdown flush fails", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const flushError = new Error("flush failed");
		const flush = vi.fn(async () => {
			throw flushError;
		});
		let probe: ProbedTransport | undefined;
		const { mode, client } = await startMode(harness, conversation, {
			wrap: (server) => {
				probe = probed(server, { flush });
				return probe.transport;
			},
		});

		await client.stop();
		await expect(mode).rejects.toBe(flushError);
		expect(flush).toHaveBeenCalledOnce();
		expect(probe?.close).toHaveBeenCalledOnce();
	});

	it("ends without onReady when the transport closes during the extension bind, once session_start finished", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_start", async () => {
					await gate.promise;
				});
			},
		});
		cleanups.push(async () => gate.resolve());
		const conversation = await harness.openStartup();
		const attach = vi.spyOn(harness.host, "attach");
		const onReady = vi.fn();
		const pair = createLoopbackRpcTransportPair();
		const mode = runRpcMode(harness.host, conversation, { transport: pair.server, onReady });
		void pair.client.write(HELLO);
		await vi.waitFor(() => expect(attach).toHaveBeenCalledOnce());

		const dispose = vi.spyOn(conversation.session, "dispose");
		await pair.client.close();
		// session_start finishes once closing the conversation fenced its session.
		await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
		expect(conversation.closed).toBe(true);
		gate.resolve();
		await expect(mode).resolves.toBeUndefined();
		// The bind ended with its conversation: nothing starts after the mode ended.
		await expect(attach.mock.results[0]?.value).rejects.toThrow();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(onReady).not.toHaveBeenCalled();
	});

	it("ends the mode with the failure when onReady throws, leaving nothing open", async () => {
		const harness = await setup();
		const conversation = await harness.openStartup();
		const readyError = new Error("ready failed");
		const pair = createLoopbackRpcTransportPair();
		const mode = runRpcMode(harness.host, conversation, {
			transport: pair.server,
			onReady: () => {
				throw readyError;
			},
		});
		void pair.client.write(HELLO);

		await expect(mode).rejects.toBe(readyError);
		expect(conversation.closed).toBe(true);
	});

	it("cancels a dialog session_start asks when its client leaves during the bind", async () => {
		const answers: boolean[] = [];
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_start", async (_event, ctx) => {
					answers.push(await ctx.ui.confirm("Start?", "Continue?"));
				});
			},
		});
		const conversation = await harness.openStartup();
		const onReady = vi.fn();
		const pair = createLoopbackRpcTransportPair();
		const mode = runRpcMode(harness.host, conversation, { transport: pair.server, onReady });
		void pair.client.write({ ...HELLO, accepts: { hostRequests: ["confirm"] } });
		await vi.waitFor(() => expect(conversation.liveState.pendingRequests()).toHaveLength(1));

		await pair.client.close();
		await expect(mode).resolves.toBeUndefined();
		expect(answers).toEqual([false]);
		expect(conversation.closed).toBe(true);
		expect(onReady).not.toHaveBeenCalled();
	});

	it("asks a client whose bind failed none of the dialogs its conversation's shutdown raises", async () => {
		let target: HostedConversation | undefined;
		const outcomes: unknown[] = [];
		const harness = await setup({
			extension: (volt) => {
				volt.on("session_shutdown", async () => {
					if (target)
						outcomes.push(await target.liveState.request({ kind: "confirm", title: "Shut down?", message: "" }));
				});
			},
		});
		const conversation = await harness.openStartup();
		target = conversation;
		const session = conversation.session;
		const attachExtensionClient = session.attachExtensionClient.bind(session);
		vi.spyOn(session, "attachExtensionClient").mockImplementationOnce((options) => {
			const attached = attachExtensionClient(options);
			return { ...attached, ready: attached.ready.then(() => Promise.reject(new Error("bind failed"))) };
		});
		const pair = createLoopbackRpcTransportPair();
		const frames: HostFrame[] = [];
		pair.client.onValue?.((value) => {
			frames.push(value as HostFrame);
		});
		const mode = runRpcMode(harness.host, conversation, { transport: pair.server });
		void pair.client.write({ ...HELLO, accepts: { hostRequests: ["confirm"] } });

		await expect(mode).rejects.toThrow("bind failed");
		expect(outcomes).toEqual([{ status: "cancelled", reason: "unavailable" }]);
		expect(conversation.closed).toBe(true);
		expect(frames.map((frame) => frame.type)).toEqual(["welcome"]);
	});
});

describe("approvals over protocol connections", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function setup(): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		return { harness, conversation: await harness.openStartup() };
	}

	async function connect(
		harness: HostHarness,
		conversation: HostedConversation,
		hostRequests: HostRequestKind[],
		anchor = false,
	): Promise<ProtocolClient> {
		const client = await createLoopbackClient(harness.host, conversation, { hostRequests, anchor });
		cleanups.push(() => client.stop());
		return client;
	}

	/** The id of the one approval `client` holds: its host action's work id. */
	function approvalOf(client: ProtocolClient): string | undefined {
		const keys = [...client.live.values.keys()].filter((key) => key.startsWith("host_request/"));
		return keys.length === 1 ? keys[0]!.slice("host_request/".length) : undefined;
	}

	it("asks only clients that accept approvals, shows the action's progress, and takes the decision", async () => {
		const { harness, conversation } = await setup();
		const actions = conversation.session.hostActions;
		const observer = await connect(harness, conversation, ["confirm"]);
		let runs = 0;
		await expect(
			actions.run({ action: "test.action", title: "Unavailable action" }, async () => {
				runs++;
				return { outcome: "completed" };
			}),
		).resolves.toEqual({ status: "unavailable" });
		expect(conversation.work.list()).toEqual([]);

		const approver = await connect(harness, conversation, ["approval"]);
		const release = Promise.withResolvers<WorkExecution>();
		const ran = actions.run(
			{ action: "test.action", title: "Approve test action?", message: "This action is blocking.", blocking: true },
			async (ctx) => {
				runs++;
				ctx.checkpoint({ text: "Running the test action" });
				return await release.promise;
			},
		);
		await vi.waitFor(() => expect(approvalOf(approver)).toBeDefined());
		const workId = approvalOf(approver)!;
		expect(approver.live.values.get(`host_request/${workId}`)).toEqual({
			kind: "host_request",
			requestId: workId,
			request: {
				kind: "approval",
				action: "test.action",
				title: "Approve test action?",
				message: "This action is blocking.",
				blocking: true,
			},
		});
		expect(conversation.work.get(workId)).toMatchObject({ kind: "host_action", state: "awaiting_approval" });
		expect(runs).toBe(0);

		approver.answer(workId, { decision: "approved" });
		await vi.waitFor(() =>
			expect(approver.live.values.get(`work/${workId}`)).toMatchObject({
				progress: { text: "Running the test action" },
			}),
		);
		expect(conversation.work.get(workId)).toMatchObject({ state: "running" });
		release.resolve({ outcome: "completed", result: { summary: "done" } });
		await expect(ran).resolves.toEqual({
			status: "ran",
			execution: { outcome: "completed", result: { summary: "done" } },
		});
		expect(conversation.work.get(workId)).toMatchObject({ outcome: "completed", result: { summary: "done" } });
		await vi.waitFor(() => expect(approver.live.values.has(`host_request/${workId}`)).toBe(false));
		await vi.waitFor(() => expect(approver.live.values.has(`work/${workId}`)).toBe(false));
		for (const key of observer.live.values.keys()) expect(key).not.toMatch(/^host_request\//);
		expect(runs).toBe(1);
	});

	it("keeps a pending approval across a reconnect, for the next client that accepts approvals", async () => {
		const { harness, conversation } = await setup();
		const first = await connect(harness, conversation, ["approval"]);
		const ran = conversation.session.hostActions.run(
			{ action: "test.action", title: "Approve after reconnect?", blocking: true },
			async () => ({ outcome: "completed" }),
		);
		let settled = false;
		void ran.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(approvalOf(first)).toBeDefined());
		const workId = approvalOf(first)!;

		await first.stop();
		expect(settled).toBe(false);
		expect(conversation.closed).toBe(false);
		expect(conversation.liveState.pendingRequest(workId)).toBeDefined();

		const second = await connect(harness, conversation, ["approval"]);
		expect(second.live.values.get(`host_request/${workId}`)).toMatchObject({
			request: { kind: "approval", title: "Approve after reconnect?" },
		});
		second.answer(workId, { decision: "approved", message: "approved after reconnect" });
		await expect(ran).resolves.toEqual({ status: "ran", execution: { outcome: "completed" } });
		expect(conversation.work.get(workId)).toMatchObject({ state: "running", outcome: "completed" });
	});

	it("ends a pending approval unrun when its conversation closes with the anchor", async () => {
		const { harness, conversation } = await setup();
		const client = await connect(harness, conversation, ["approval"], true);
		let runs = 0;
		const ran = conversation.session.hostActions.run({ action: "test.action", title: "Dispose?" }, async () => {
			runs++;
			return { outcome: "completed" };
		});
		await vi.waitFor(() => expect(approvalOf(client)).toBeDefined());

		await client.stop();
		await expect(ran).resolves.toMatchObject({ status: "declined" });
		expect(conversation.closed).toBe(true);
		expect(runs).toBe(0);
	});
});

describe("host requests on the remote profile", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function phone(
		harness: HostHarness,
		conversation: HostedConversation,
		capabilities: RemoteCapability[],
	): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: { schemaVersion: 1, revision: 1, capabilities },
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		const device = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await device.close();
			await connection.close().catch(() => undefined);
		});
		await device.hello(["confirm", "approval"]);
		await device.subscribe(conversation.id);
		return device;
	}

	/** The host requests a device was shown on its first subscription. */
	const hostRequests = (device: RemotePhone) =>
		device.frames.flatMap((frame) =>
			frame.type === "live" && frame.subscriptionId === "s1"
				? frame.items.flatMap((item) =>
						item.type === "set" && item.value.kind === "host_request" ? [item.value] : [],
					)
				: [],
		);

	/**
	 * Answer a host request, then subscribe again: answers and subscriptions
	 * run in order, so the answer was handled once the new subscription is live.
	 */
	async function answer(
		device: RemotePhone,
		conversation: HostedConversation,
		requestId: string,
		response: object,
		barrier: string,
	): Promise<void> {
		device.send({ type: "host_response", requestId, response });
		await device.subscribe(conversation.id, barrier);
	}

	it("asks a phone only the host requests its grant lets it answer, and ignores its answers to others", async () => {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const live = conversation.liveState;
		const manager = await phone(harness, conversation, ["conversation.observe.v1", "host.manage.v1"]);
		// Dialogs need control: with only the manager attached, nobody can answer one.
		await expect(live.request({ kind: "confirm", title: "Sure?", message: "Really?" })).resolves.toEqual({
			status: "cancelled",
			reason: "unavailable",
		});

		const controller = await phone(harness, conversation, ["conversation.observe.v1", "conversation.control.v1"]);
		let runs = 0;
		const ran = conversation.session.hostActions.run(
			{ action: "test.action", title: "Ok?", commandPreview: `${conversation.cwd}/bin/install` },
			async () => {
				runs++;
				return { outcome: "completed" };
			},
		);
		await vi.waitFor(() => expect(hostRequests(manager)).toHaveLength(1));
		const approval = hostRequests(manager)[0]!;
		const workId = approval.requestId;
		expect(conversation.work.get(workId)).toMatchObject({ kind: "host_action", state: "awaiting_approval" });
		// The device sees the command without the host's workspace path.
		expect(approval.request).toMatchObject({ kind: "approval", title: "Ok?" });
		expect(JSON.stringify(approval)).not.toContain(conversation.cwd);
		// The controller was not asked, and neither its answer nor its cancel reaches the action.
		await answer(controller, conversation, workId, { decision: "approved" }, "barrier-1");
		expect(live.pendingRequest(workId)).toBeDefined();
		expect(await controller.intent("cancel_work", { workId })).toMatchObject({
			type: "rejected",
			reason: { code: "not_allowed", requiredCapability: "host.manage.v1" },
		});
		expect(conversation.work.get(workId)).toMatchObject({ state: "awaiting_approval" });
		manager.send({ type: "host_response", requestId: workId, response: { decision: "denied" } });
		await expect(ran).resolves.toEqual({ status: "declined" });
		expect(conversation.work.get(workId)).toMatchObject({ outcome: "cancelled" });
		expect(runs).toBe(0);

		const asked = live.request({ kind: "confirm", title: "Sure?", message: "Really?" });
		await vi.waitFor(() => expect(hostRequests(controller).map((value) => value.request.kind)).toEqual(["confirm"]));
		const requestId = hostRequests(controller)[0]!.requestId;
		await answer(manager, conversation, requestId, { confirmed: false }, "barrier-2");
		expect(live.pendingRequest(requestId)).toBeDefined();
		controller.send({ type: "host_response", requestId, response: { confirmed: true } });
		await expect(asked).resolves.toMatchObject({ status: "answered", response: { confirmed: true } });

		expect(hostRequests(controller).map((value) => value.request.kind)).toEqual(["confirm"]);
		expect(hostRequests(manager).map((value) => value.request.kind)).toEqual(["approval"]);
	});

	it("lets a device granted host management cancel a host action, before or after it was approved", async () => {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const manager = await phone(harness, conversation, [
			"conversation.observe.v1",
			"conversation.control.v1",
			"host.manage.v1",
		]);
		const observer = await phone(harness, conversation, ["conversation.observe.v1"]);
		const output = conversation.session.hostActions.run({ action: "test.action", title: "Output" }, async (ctx) => {
			ctx.output("installed test-tool\n");
			return { outcome: "completed" };
		});
		await vi.waitFor(() => expect(hostRequests(manager)).toHaveLength(1));
		const outputId = hostRequests(manager)[0]!.requestId;
		manager.send({ type: "host_response", requestId: outputId, response: { decision: "approved" } });
		await expect(output).resolves.toMatchObject({ status: "ran" });
		// A host action's output takes host management to read.
		expect(await observer.query("work_output", { workId: outputId })).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "host.manage.v1" },
		});
		expect(await manager.query("work_output", { workId: outputId })).toMatchObject({
			type: "result",
			data: { text: "installed test-tool\n" },
		});

		const pending = conversation.session.hostActions.run({ action: "test.action", title: "Pending" }, async () => ({
			outcome: "completed",
		}));
		await vi.waitFor(() => expect(hostRequests(manager)).toHaveLength(2));
		const pendingId = hostRequests(manager)[1]!.requestId;
		expect(await manager.intent("cancel_work", { workId: pendingId })).toMatchObject({ type: "accepted" });
		await expect(pending).resolves.toEqual({ status: "declined", message: "Host action cancelled" });
		expect(conversation.liveState.pendingRequest(pendingId)).toBeUndefined();
		expect(conversation.work.get(pendingId)).toMatchObject({ outcome: "cancelled" });

		const started = Promise.withResolvers<void>();
		const running = conversation.session.hostActions.run({ action: "test.action", title: "Running" }, async (ctx) => {
			started.resolve();
			await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
			return { outcome: "cancelled" };
		});
		await vi.waitFor(() => expect(hostRequests(manager)).toHaveLength(3));
		const runningId = hostRequests(manager)[2]!.requestId;
		manager.send({ type: "host_response", requestId: runningId, response: { decision: "approved" } });
		await started.promise;
		expect(await manager.intent("cancel_work", { workId: runningId })).toMatchObject({ type: "accepted" });
		await expect(running).resolves.toEqual({ status: "ran", execution: { outcome: "cancelled" } });
		expect(conversation.work.get(runningId)).toMatchObject({ state: "cancelling", outcome: "cancelled" });
	});
});
