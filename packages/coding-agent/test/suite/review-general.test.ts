import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HostFrame,
	type RemoteCapability,
	RPC_COMMAND_SCHEMAS,
	RPC_RESPONSE_SCHEMAS,
} from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { Subscription } from "../../src/core/protocol/server/subscription.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import {
	registerDurableReviewAnchor,
	registerReviewHandoffAliases,
	resolveCanonicalReviewSource,
} from "../../src/core/review-anchors.ts";
import { getReviewGeneral } from "../../src/core/review-general.ts";
import { appendReviewRunDurably } from "../../src/core/review-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/client.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../src/modes/rpc/rpc-command-dispatcher.ts";
import { validateRpcCommandPayload } from "../../src/modes/rpc/rpc-command-validation.ts";
import { connectTestClient, openTestHost, type TestClient, type TestClientOptions } from "../utilities/host-client.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type QueryOutcome } from "../utilities/remote-phone.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Failures a test injects into how the main client follows a move. */
interface MoveHooks {
	prepare?: () => void;
	onMoved?: () => Promise<void>;
}

/** An RPC dispatcher context for `client`'s current conversation. */
function dispatcherContext(client: TestClient, extra: Record<string, unknown> = {}) {
	return {
		session: client.session,
		conversation: client.conversation,
		host: client.host,
		client: client.client,
		options: {},
		services: {},
		assertConversationGenerationCurrent: () => {},
		...extra,
	} as unknown as RpcCommandDispatcherContext;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-general-"));
	const directory = join(root, "sessions");
	const harnesses: Harness[] = [];
	const clients: TestClient[] = [];
	const managers: SessionManager[] = [];
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const h = await createHarness({ sessionManager, settings: { lsp: { enabled: false } } });
		harnesses.push(h);
		return {
			session: h.session,
			extensionsResult: h.session.resourceLoader.getExtensions(),
			diagnostics: [],
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: h.authStorage,
				modelRegistry: h.session.modelRegistry,
				settingsManager: h.settingsManager,
				resourceLoader: h.session.resourceLoader,
				gitContextProvider: h.session.gitContextProvider,
				releaseGitContextProvider: () => {},
				diagnostics: [],
			},
		};
	};
	async function own(manager: SessionManager, clientOptions: TestClientOptions = {}) {
		const { host, conversation } = await openTestHost(factory, {
			sessionManager: manager,
			cwd: root,
			agentDir: root,
		});
		const client = await connectTestClient(host, conversation, clientOptions);
		clients.push(client);
		return client;
	}
	cleanups.push(async () => {
		for (const client of clients) await client.host.dispose();
		for (const manager of managers) await manager.closePersistence();
		for (const h of harnesses) await h.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const hooks: MoveHooks = {};
	const client = await own(await SessionManager.create(root, directory), {
		prepare: () => hooks.prepare?.(),
		onMoved: () => hooks.onMoved?.(),
	});
	const source = client.session.sessionManager;
	await client.session.sessionWriter.appendSessionInfo("Review source");
	await registerDurableReviewAnchor(source, "run");
	const original = source.getSessionRef()!;
	const options = { preserveReviewRunId: "run", replaceReviewGeneral: true };
	return { client, hooks, root, directory, source, original, options, own, managers };
}

/**
 * Subscribe to the conversation `client` is on now from a snapshot, as a
 * protocol subscriber that is not one of its clients: it stays on that
 * conversation whatever the client does.
 */
function observe(client: TestClient) {
	const frames: HostFrame[] = [];
	const subscription = new Subscription({
		subscriptionId: "observer",
		liveClientId: `observer:${randomUUID()}`,
		conversation: client.conversation,
		profile: localProfile,
		sink: { send: (frame) => frames.push(frame) },
		live: true,
		accepts: () => false,
	});
	subscription.start("snapshot");
	cleanups.push(async () => subscription.dispose());
	return { frames, subscription };
}

/** Run `query` as a paired device holding `capabilities`, on the conversation `client` is on. */
async function remoteQuery(
	client: TestClient,
	capabilities: RemoteCapability[],
	query: string,
	params: unknown,
): Promise<QueryOutcome> {
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		host: client.host,
		conversation: client.conversation,
		stream: pair.host,
		grant: { schemaVersion: 1, revision: 1, capabilities },
		redaction: { workspacePath: client.cwd },
		redirect: {},
	});
	const phone = connectRemotePhone(pair.phone);
	try {
		await phone.hello();
		return await phone.query(query, params);
	} finally {
		await phone.close();
		await connection.closed.catch(() => undefined);
	}
}

describe("durable review General publication", () => {
	it("replaces repeatedly, preserves canonical source and does not promote ordinary aliases or reopened history", async () => {
		const { client, root, directory, source, original, options, managers } = await fixture();
		for (const revision of [1, 2]) {
			const opened = await client.newSession(options);
			expect(opened).toEqual({ cancelled: false, sessionId: client.session.sessionId, seeded: false });
			expect(await getReviewGeneral(client.session.sessionManager, "run")).toEqual({
				runId: "run",
				sourceSessionId: original.sessionId,
				generalSessionId: client.session.sessionId,
				generalSessionGeneration: client.session.sessionRef!.sessionGeneration,
				generalRevision: revision,
				generalAvailable: true,
			});
			expect(await resolveCanonicalReviewSource(client.session.sessionManager, "run")).toEqual(original);
		}
		const final = await getReviewGeneral(client.session.sessionManager, "run");
		const alias = await SessionManager.create(root, directory);
		managers.push(alias);
		await registerReviewHandoffAliases(client.session.sessionManager, alias, ["run"]);
		expect(await getReviewGeneral(alias, "run")).toEqual(final);
		await client.switchSession(original);
		expect(await getReviewGeneral(client.session.sessionManager, "run")).toEqual(final);
		await expect(client.newSession(options)).rejects.toThrow("exact current General");
		expect(await getReviewGeneral(source, "run")).toEqual(final);
	});

	// setup: the new log cannot be written; prepare: the client cannot point itself at the new
	// conversation and returns to the source; moved: the client's move handler fails once it
	// joined; seed: withSession fails after the move.
	it.each(["setup", "prepare", "moved", "seed"])("does not publish when %s fails", async (phase) => {
		const { client, hooks, source, original, options, own } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		const { frames, subscription } = observe(client);
		const fail = async () => {
			throw new Error("injected failure");
		};
		let candidate: SessionManager | undefined;
		if (phase === "prepare") {
			hooks.prepare = () => {
				// Only the move away fails: returning to the source succeeds.
				hooks.prepare = undefined;
				throw new Error("injected failure");
			};
		}
		if (phase === "moved") hooks.onMoved = fail;
		await expect(
			client.newSession({
				...options,
				setup: async (writer) => {
					candidate = writer.sessionManager;
					if (phase === "setup") await fail();
				},
				...(phase === "seed" ? { withSession: fail } : {}),
			}),
		).rejects.toThrow("injected failure");
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		await expect(getReviewGeneral(candidate!, "run")).rejects.toThrow("exact member");
		expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
		if (phase === "setup" || phase === "prepare") {
			// The client stays on the source, which stays open and keeps serving its subscribers.
			expect(client.session.sessionManager).toBe(source);
			expect(subscription.isEnded).toBe(false);
			await expect(client.session.prompt("The original General is still usable")).resolves.toBeUndefined();
			await vi.waitFor(() =>
				expect(
					frames.some(
						(frame) =>
							frame.type === "entry" && frame.entry.type === "message" && frame.entry.view?.role === "assistant",
					),
				).toBe(true),
			);
		} else {
			// The source's stream never follows the move: it hears nothing of the new conversation.
			expect(JSON.stringify(frames)).not.toContain(client.session.sessionId);
			const reopened = await own(await SessionManager.open(original));
			await expect(reopened.session.prompt("The original General can resume")).resolves.toBeUndefined();
			expect(await getReviewGeneral(reopened.session.sessionManager, "run")).toEqual(initial);
		}
	});

	it("commits General only after the seed completed, leaving the source's subscriptions behind", async () => {
		const { client, source, options } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		const { frames } = observe(client);
		expect(
			await client.newSession({
				...options,
				withSession: async (context) => {
					expect(await getReviewGeneral(source, "run")).toEqual(initial);
					await context.sendMessage({
						customType: "general-seed",
						content: "Preserved review context",
						display: true,
					});
				},
			}),
		).toEqual({ cancelled: false, sessionId: client.session.sessionId, seeded: true });
		// The source's stream never follows the move: it hears nothing of the new conversation.
		expect(JSON.stringify(frames)).not.toContain(client.session.sessionId);
		expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
		expect(await getReviewGeneral(source, "run")).toMatchObject({
			generalSessionId: client.session.sessionId,
			generalRevision: 1,
		});
		const reattached = observe(client);
		const snapshot = reattached.frames[0];
		expect(snapshot).toMatchObject({ type: "snapshot", conversation: client.session.sessionId });
		if (snapshot?.type !== "snapshot") throw new Error("Expected a snapshot");
		// The seed is the new conversation's one message.
		expect(
			snapshot.state.entries.filter((entry) => entry.type === "message" || entry.type === "custom_message"),
		).toHaveLength(1);
	});

	it.each([false, true])("keeps General unpublished through the durable commit (reject: %s)", async (rejectCommit) => {
		const { client, source, original, options, own } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		const lease = await acquireSharedSQLiteSessionStore(original.sessionDirectory);
		let releaseCommit!: () => void;
		let markCommitStarted!: () => void;
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve;
		});
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		const replaceReviewGeneral = lease.client.replaceReviewGeneral.bind(lease.client);
		const commit = vi.spyOn(lease.client, "replaceReviewGeneral").mockImplementation(async (request) => {
			markCommitStarted();
			await commitGate;
			if (rejectCommit) throw new Error("General commit rejected");
			return replaceReviewGeneral(request);
		});
		try {
			const replacement = client.newSession(options);
			const result = replacement.then(
				() => undefined,
				(error: unknown) => error,
			);
			await commitStarted;
			expect(await getReviewGeneral(source, "run")).toEqual(initial);
			releaseCommit();
			if (rejectCommit) {
				expect(await result).toMatchObject({ message: "General commit rejected" });
				expect(await getReviewGeneral(source, "run")).toEqual(initial);
				const reopened = await own(await SessionManager.open(original));
				await expect(reopened.session.prompt("Resume after rejected General commit")).resolves.toBeUndefined();
			} else {
				expect(await result).toBeUndefined();
				expect(await getReviewGeneral(source, "run")).toMatchObject({
					generalSessionId: client.session.sessionId,
					generalRevision: 1,
				});
			}
		} finally {
			releaseCommit();
			commit.mockRestore();
			await lease.release();
		}
	});

	it("does not promote cancelled or stale replacements and rejects same-source competitors", async () => {
		const { client, source, options } = await fixture();
		const initial = await getReviewGeneral(source, "run");
		vi.spyOn(client.session.extensionRunner, "hasHandlers").mockReturnValueOnce(true);
		vi.spyOn(client.session.extensionRunner, "emit").mockResolvedValueOnce({ cancel: true });
		expect(await client.newSession(options)).toEqual({ cancelled: true });
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		let stale = false;
		await expect(
			client.newSession({
				...options,
				setup: async () => {
					stale = true;
				},
				assertConversationGenerationCurrent: () => {
					if (stale) throw new Error("stale authority");
				},
			}),
		).rejects.toThrow("stale authority");
		expect(await getReviewGeneral(source, "run")).toEqual(initial);
		const results = await Promise.allSettled([client.newSession(options), client.newSession(options)]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(await getReviewGeneral(client.session.sessionManager, "run")).toMatchObject({ generalRevision: 1 });
	});

	it("authorizes RPC lookup from current and historical same-run children without canonical mutation authority", async () => {
		const { source, root, original, own } = await fixture();
		const lease = await acquireSharedSQLiteSessionStore(original.sessionDirectory);
		try {
			const member = { sessionId: original.sessionId, sessionGeneration: original.sessionGeneration, cwd: root };
			const createdAt = new Date().toISOString();
			const child = (id: string) => ({
				id,
				sessionGeneration: `generation:${id}`,
				formatVersion: 5,
				cwd: root,
				createdAt,
				parentSessionDirectory: null,
				parentStoreId: null,
				parentSessionId: null,
				parentSessionGeneration: null,
				origin: null,
			});
			const discussion = await lease.client.createOrGetReviewDiscussion({
				source: member,
				runId: "run",
				findingId: "finding",
				discussionId: "discussion",
				child: child("child"),
				contextSnapshot: {},
				createdAt,
				requestId: "start",
				kickoffClientMessageId: "kickoff",
			});
			const reset = await lease.client.resetReviewDiscussion({
				source: member,
				discussionId: "discussion",
				expectedChild: discussion.current.child,
				child: child("next"),
				createdAt,
				requestId: "reset",
				kickoffClientMessageId: "next-kickoff",
			});
			await lease.client.registerReviewAnchor({ runId: "foreign", source: member, createdAt });
			for (const identity of [discussion.current.child, reset.child.child]) {
				const client = await own(await SessionManager.open({ ...original, ...identity }));
				const context = dispatcherContext(client);
				expect(await handleRpcCommand({ type: "get_review_general", runId: "run" }, context)).toMatchObject({
					success: true,
					data: await getReviewGeneral(source, "run"),
				});
				await expect(handleRpcCommand({ type: "get_review_general", runId: "foreign" }, context)).rejects.toThrow(
					"exact member",
				);
				await expect(
					handleRpcCommand(
						{ type: "new_session", preserveReviewRunId: "run", replaceReviewGeneral: true },
						context,
					),
				).rejects.toThrow("source review");
				expect(await resolveCanonicalReviewSource(client.session.sessionManager, "run")).toBeUndefined();
			}
		} finally {
			await lease.release();
		}
	});

	it("returns explicit exact-generation unavailability after restart and rejects foreign stores", async () => {
		const { client, source, options, directory, root, managers } = await fixture();
		await client.newSession(options);
		const final = await getReviewGeneral(client.session.sessionManager, "run");
		const target = client.session.sessionRef!;
		await client.dispose();
		const reader = await SessionManager.open(source.getSessionRef()!);
		managers.push(reader);
		expect(await getReviewGeneral(reader, "run")).toEqual(final);
		await SessionManager.delete(target);
		const reused = await SessionManager.create(root, directory, { id: target.sessionId });
		managers.push(reused);
		expect(await getReviewGeneral(reader, "run")).toEqual({ ...final, generalAvailable: false });
		await expect(getReviewGeneral(reused, "run")).rejects.toThrow("exact member");
		const foreign = await SessionManager.create(root, join(root, "foreign"), { id: reader.getSessionId() });
		managers.push(foreign);
		await expect(getReviewGeneral(foreign, "run")).rejects.toThrow("exact member");
	});

	it("serves the required RPC shape as a read, rejects malformed flags and forwards explicit General replacement", async () => {
		const { client, original } = await fixture();
		await appendReviewRunDurably(client.session.sessionWriter, {
			schemaVersion: 1,
			runId: "run",
			workflowAction: "review.uncommitted",
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			target: {
				description: "Changes",
				diffCommand: "git diff",
				identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
				files: [],
			},
			options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		});
		const context = () => dispatcherContext(client);
		const command = { type: "get_review_general", runId: "run" } as const;
		const response = await handleRpcCommand(command, context());
		expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_general).Errors(response)).toEqual([]);
		expect(response).toMatchObject({
			success: true,
			data: { sourceSessionId: original.sessionId, generalRevision: 0 },
		});
		for (const field of [
			"runId",
			"sourceSessionId",
			"generalSessionId",
			"generalSessionGeneration",
			"generalRevision",
			"generalAvailable",
		]) {
			const data = { ...(response as { data: Record<string, unknown> }).data };
			delete data[field];
			expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_general).Check({ ...response, data })).toBe(false);
		}
		// A paired device reads General with observe access alone.
		expect(await remoteQuery(client, ["conversation.observe.v1"], "review.general", { runId: "run" })).toMatchObject({
			type: "result",
			data: { sourceSessionId: original.sessionId, generalRevision: 0 },
		});
		expect(await remoteQuery(client, [], "review.general", { runId: "run" })).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
		expect(validateRpcCommandPayload({ type: "get_review_general", runId: "é".repeat(200) })).toContain("UTF-8");
		for (const invalid of [
			{ type: "new_session", replaceReviewGeneral: true },
			{ type: "new_session", replaceReviewGeneral: "true", preserveReviewRunId: "run" },
		]) {
			expect(Compile(RPC_COMMAND_SCHEMAS.new_session).Check(invalid)).toBe(false);
			expect(validateRpcCommandPayload(invalid)).toBeDefined();
		}
		expect(
			await handleRpcCommand(
				{ type: "new_session", preserveReviewRunId: "run", replaceReviewGeneral: true },
				context(),
			),
		).toMatchObject({ success: true, data: { cancelled: false } });
		expect(await handleRpcCommand(command, context())).toMatchObject({ success: true, data: { generalRevision: 1 } });
		await expect(handleRpcCommand({ type: "get_review_general", runId: "foreign" }, context())).rejects.toThrow(
			"exact member",
		);
	});
});
