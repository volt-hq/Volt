import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostFrame, INTENT_SCHEMAS, QUERY_SCHEMAS, type RemoteCapability } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationFactory } from "../../src/core/host/hosted-conversation.ts";
import { type IntentContext, intentRegistry, LOCAL_INTENT_PROFILE } from "../../src/core/protocol/intents/index.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { queryRegistry } from "../../src/core/protocol/queries/index.ts";
import { Subscription } from "../../src/core/protocol/server/subscription.ts";
import { serveIrohRemoteConnection } from "../../src/core/remote/iroh/connection.ts";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../../src/core/review-discussion-policy.ts";
import {
	getReviewGeneral,
	registerReviewHandoffAliases,
	resolveCanonicalReviewSource,
} from "../../src/core/review-links.ts";
import { appendReviewRunDurably } from "../../src/core/review-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { LogWriter } from "../../src/core/session-writer.ts";
import { connectTestClient, openTestHost, type TestClient, type TestClientOptions } from "../utilities/host-client.ts";
import { createIrohStreamPair } from "../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type QueryOutcome } from "../utilities/remote-phone.ts";
import {
	anchorLiveReviewRun,
	recordReviewDiscussion,
	resetRecordedReviewDiscussion,
} from "../utilities/review-runs.ts";
import { createHarness, type Harness } from "./harness.ts";

/** Failures a test injects into how the main client follows a move. */
interface MoveHooks {
	prepare?: () => void;
	onMoved?: () => Promise<void>;
}

/** A local intent context for `client`'s current conversation. */
function contextOf(client: TestClient): IntentContext {
	return {
		target: { session: client.session, conversation: client.conversation, host: client.host, client: client.client },
		services: {},
		profile: LOCAL_INTENT_PROFILE,
	};
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
	await anchorLiveReviewRun(client.session, "run");
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
		for (const _ of [1, 2]) {
			const opened = await client.newSession(options);
			expect(opened).toEqual({ cancelled: false, sessionId: client.session.sessionId, seeded: false });
			expect(await getReviewGeneral(client.session.sessionManager, "run")).toEqual({
				runId: "run",
				sourceSessionId: original.sessionId,
				generalSessionId: client.session.sessionId,
				generalSessionGeneration: client.session.sessionRef!.sessionGeneration,
				generalAvailable: true,
			});
			expect(await resolveCanonicalReviewSource(client.session.sessionManager, "run")).toEqual(original);
		}
		const final = await getReviewGeneral(client.session.sessionManager, "run");
		const alias = await SessionManager.create(root, directory);
		managers.push(alias);
		await registerReviewHandoffAliases(client.session.sessionManager, alias.logWriter, ["run"]);
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
		// The General never moved. A candidate whose seed completed carries the run, as any handoff does.
		if (phase === "setup") await expect(getReviewGeneral(candidate!, "run")).rejects.toThrow("exact member");
		else expect(await getReviewGeneral(candidate!, "run")).toEqual(initial);
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
		expect(await getReviewGeneral(source, "run")).toMatchObject({ generalSessionId: client.session.sessionId });
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
		let releaseCommit!: () => void;
		let markCommitStarted!: () => void;
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve;
		});
		const commitGate = new Promise<void>((resolve) => {
			releaseCommit = resolve;
		});
		// The General moves when the source's log records it: the source closed when the client left it,
		// so the host writes its log by opening it.
		const recordReviewState = LogWriter.prototype.recordReviewState;
		const commit = vi.spyOn(LogWriter.prototype, "recordReviewState").mockImplementation(async function (
			this: LogWriter,
			build,
		) {
			if (this.sessionManager.getSessionId() === original.sessionId) {
				markCommitStarted();
				await commitGate;
				if (rejectCommit) throw new Error("General commit rejected");
			}
			return recordReviewState.call(this, build);
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
				expect(await getReviewGeneral(source, "run")).toMatchObject({ generalSessionId: client.session.sessionId });
			}
		} finally {
			releaseCommit();
			commit.mockRestore();
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
		expect(await getReviewGeneral(client.session.sessionManager, "run")).toMatchObject({
			generalSessionId: client.session.sessionId,
		});
	});

	it("authorizes General lookup from current and historical same-run children without canonical mutation authority", async () => {
		const { client, source, root, directory, original, own, managers } = await fixture();
		// The discussion is recorded through the source's own log, which the client's live session holds.
		await client.dispose();
		const writable = await SessionManager.open(original);
		const discussion = { discussionId: "discussion", runId: "run", findingId: "finding", contextSnapshot: {} };
		const first = await recordReviewDiscussion(writable, discussion);
		const next = await resetRecordedReviewDiscussion(writable, discussion, "reset");
		await writable.closePersistence();
		const foreign = await own(await SessionManager.create(root, directory));
		await anchorLiveReviewRun(foreign.session, "foreign");
		const reader = await SessionManager.openReadOnly(original);
		managers.push(reader);
		const expected = await getReviewGeneral(reader, "run");
		expect(expected).toMatchObject({ sourceSessionId: source.getSessionId(), generalSessionId: original.sessionId });
		for (const ref of [first, next]) {
			const child = await own(await SessionManager.open(ref));
			const context = contextOf(child);
			expect(await queryRegistry.run(context, "review.general", { runId: "run" })).toEqual(expected);
			await expect(queryRegistry.run(context, "review.general", { runId: "foreign" })).rejects.toThrow(
				"exact member",
			);
			await expect(
				intentRegistry.invoke(context, "new_session", {
					preserveReviewRunId: "run",
					replaceReviewGeneral: true,
				}),
			).rejects.toMatchObject({ code: "unavailable", message: REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE });
			expect(await resolveCanonicalReviewSource(child.session.sessionManager, "run")).toBeUndefined();
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

	it("serves the required query shape as a read, rejects malformed input and forwards explicit General replacement", async () => {
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
		const generalResult = Compile(QUERY_SCHEMAS["review.general"].result);
		const general = await queryRegistry.run(contextOf(client), "review.general", { runId: "run" });
		expect(generalResult.Errors(general)).toEqual([]);
		expect(general).toEqual({
			runId: "run",
			sourceSessionId: original.sessionId,
			generalSessionId: original.sessionId,
			generalSessionGeneration: original.sessionGeneration,
			generalAvailable: true,
		});
		expect(generalResult.Check({ ...general, generalRevision: 0 })).toBe(false);
		for (const field of [
			"runId",
			"sourceSessionId",
			"generalSessionId",
			"generalSessionGeneration",
			"generalAvailable",
		]) {
			const data: Record<string, unknown> = { ...general };
			delete data[field];
			expect(generalResult.Check(data)).toBe(false);
		}
		// A paired device reads General with observe access alone.
		expect(await remoteQuery(client, ["conversation.observe.v1"], "review.general", { runId: "run" })).toMatchObject({
			type: "result",
			data: { sourceSessionId: original.sessionId, generalSessionId: original.sessionId },
		});
		expect(await remoteQuery(client, [], "review.general", { runId: "run" })).toMatchObject({
			type: "query_error",
			reason: { code: "not_allowed", requiredCapability: "conversation.observe.v1" },
		});
		await expect(
			queryRegistry.run(contextOf(client), "review.general", { runId: "é".repeat(200) }),
		).rejects.toMatchObject({
			code: "invalid_input",
			message: expect.stringContaining("UTF-8"),
		});
		for (const invalid of [
			{ replaceReviewGeneral: true },
			{ replaceReviewGeneral: "true", preserveReviewRunId: "run" },
		]) {
			expect(Compile(INTENT_SCHEMAS.new_session.input).Check(invalid)).toBe(false);
			await expect(intentRegistry.invokeFrame(contextOf(client), "new_session", invalid)).rejects.toMatchObject({
				code: "invalid_input",
			});
		}
		const replaced = await intentRegistry.invoke(contextOf(client), "new_session", {
			preserveReviewRunId: "run",
			replaceReviewGeneral: true,
		});
		expect(replaced.conversation).toBe(client.session.sessionId);
		expect(replaced.conversation).not.toBe(original.sessionId);
		expect(await queryRegistry.run(contextOf(client), "review.general", { runId: "run" })).toMatchObject({
			generalSessionId: client.session.sessionId,
		});
		await expect(queryRegistry.run(contextOf(client), "review.general", { runId: "foreign" })).rejects.toThrow(
			"exact member",
		);
	});
});
