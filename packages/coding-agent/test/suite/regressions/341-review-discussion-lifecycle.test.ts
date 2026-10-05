import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import { type FauxModelDefinition, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { QUERY_SCHEMAS, REMOTE_CAPABILITIES, type RemoteGrant } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import {
	type IntentContext,
	intentRegistry,
	intentStateOf,
	LOCAL_INTENT_PROFILE,
} from "../../../src/core/protocol/intents/index.ts";
import { queryRegistry } from "../../../src/core/protocol/queries/index.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import { REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE } from "../../../src/core/review-discussion-policy.ts";
import { HostReviewDiscussionService, type ReviewDiscussionService } from "../../../src/core/review-discussions.ts";
import { registerReviewHandoffAliases } from "../../../src/core/review-links.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	getReviewRun,
	type ReviewRunRecord,
} from "../../../src/core/review-state.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../../../src/core/session-store/client.ts";
import { connectTestClient, openTestHost, type TestClient } from "../../utilities/host-client.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
import { anchorLiveReviewRun } from "../../utilities/review-runs.ts";
import { seedSession } from "../../utilities/seed-log.ts";
import { createHarness, type Harness } from "../harness.ts";

/** A test client of a hosted conversation, with the review discussion service a daemon would give it. */
type Owned = TestClient & { reviewDiscussions?: ReviewDiscussionService };

/** A local intent context for the conversation `owned` is on. */
function contextOf(owned: Owned): IntentContext {
	return {
		target: { session: owned.session, conversation: owned.conversation, host: owned.host, client: owned.client },
		services: {
			abortRun: (session: AgentSession) => session.abort(),
			...(owned.reviewDiscussions === undefined ? {} : { reviewDiscussions: owned.reviewDiscussions }),
		},
		profile: LOCAL_INTENT_PROFILE,
	};
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

const FULL_GRANT: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

/** A paired device on `owned`'s conversation, over the remote profile, with the discussion service a daemon gives it. */
async function connectPhone(owned: Owned): Promise<RemotePhone> {
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		host: owned.host,
		conversation: owned.conversation,
		stream: pair.host,
		grant: FULL_GRANT,
		redaction: { workspacePath: owned.conversation.cwd },
		redirect: {},
		services: () => (owned.reviewDiscussions === undefined ? {} : { reviewDiscussions: owned.reviewDiscussions }),
	});
	const phone = connectRemotePhone(pair.phone);
	cleanups.push(async () => {
		await phone.close();
		await connection.close().catch(() => undefined);
	});
	await phone.hello();
	await phone.subscribe(owned.conversation.id);
	return phone;
}

function record(): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review-341",
		workflowAction: "review.uncommitted",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "selected revision",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "Findings",
			overallExplanation: "Evidence",
			findings: [1, 2, 3, 4].map((n) => ({
				id: `f${n}`,
				fingerprint: `fingerprint-${n}`,
				status: "open",
				title: `Finding ${n}`,
				body: "Immutable evidence",
				trigger: "Input",
				impact: "Wrong result",
				category: "correctness",
				rootCauseKey: `cause-${n}`,
				priority: 2,
				confidence: 0.9,
				changeLocation: { path: "src/value.ts", side: "head", startLine: 1, endLine: 2 },
				evidenceLocations: [],
				verification: { outcome: "accepted", method: "inspection", rationale: "Evidence", confidence: 0.9 },
			})),
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
		},
	};
}

async function fixture(models?: FauxModelDefinition[]) {
	const root = mkdtempSync(join(tmpdir(), "volt-341-lifecycle-"));
	const harness = await createHarness({
		models,
		settings: { lsp: { enabled: false }, compaction: { enabled: false } },
	});
	const runtimes: Owned[] = [];
	const hosts: ConversationHost[] = [];
	const gates: Array<() => void> = [];
	cleanups.push(async () => {
		for (const release of gates) release();
		await Promise.all(runtimes.map((runtime) => runtime.dispose()));
		await Promise.all(hosts.map((host) => host.dispose()));
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			tools: ["read", "write", "bash", "lsp"],
			disableMcp: true,
		});
		return {
			...created,
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				gitContextProvider: created.session.gitContextProvider,
				releaseGitContextProvider: () => {},
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	/** Open `manager`'s log in a host of its own, as the daemon does for a conversation a client attaches to. */
	async function own(manager: SessionManager): Promise<Owned> {
		const opened = await openTestHost(factory, { sessionManager: manager, cwd: root, agentDir: root });
		hosts.push(opened.host);
		const owned: Owned = await connectTestClient(opened.host, opened.conversation);
		runtimes.push(owned);
		return owned;
	}
	const siblings = {
		/** Open a review discussion beside `parent`, in its host, without moving any client. */
		async open(parent: HostedConversation, manager: SessionManager): Promise<Owned> {
			const owner = runtimes.find((runtime) => runtime.conversation === parent);
			if (!owner || !manager.getReviewDiscussion() || manager.getCwd() !== parent.cwd) {
				await manager.closePersistence();
				throw new Error("Review sibling requires an exact source cwd and a durable child binding");
			}
			const opened = await owner.host.open({ kind: "adopt", sessionManager: manager, cwd: parent.cwd });
			if (opened.cancelled) throw new Error("Review sibling open was cancelled");
			const child: Owned = await connectTestClient(owner.host, opened.conversation);
			runtimes.push(child);
			child.reviewDiscussions = service.forRuntime(child.conversation);
			return child;
		},
	};
	const source = await own(await SessionManager.create(root, join(root, "sessions")));
	await source.session.setSessionName("Source");
	await anchorLiveReviewRun(source.session, "review-341");
	await appendReviewRunDurably(source.session.sessionWriter, record());
	const service = new HostReviewDiscussionService({
		findRuntime: (ref) =>
			runtimes.find((runtime) => {
				const current = runtime.session.sessionRef;
				return (
					current?.storeId === ref.storeId &&
					current.sessionId === ref.sessionId &&
					current.sessionGeneration === ref.sessionGeneration
				);
			})?.conversation,
		assertCurrent: (conversation) => {
			if (!runtimes.some((runtime) => runtime.conversation === conversation)) throw new Error("retired");
		},
		createSibling: async (parent, ref, assertCurrent) => {
			const manager = await SessionManager.open(ref);
			const child = await siblings.open(parent, manager);
			assertCurrent();
			return child.conversation;
		},
	});
	source.reviewDiscussions = service.forRuntime(source.conversation);
	return { root, source, service, api: source.reviewDiscussions, harness, runtimes, own, siblings, gates };
}

function holdResponses(harness: Harness, count: number, gates: Array<() => void>) {
	harness.setResponses(
		Array.from({ length: count }, () => async () => {
			await new Promise<void>((resolve) => gates.push(resolve));
			return fauxAssistantMessage("Discussion answer");
		}),
	);
}

function successful(result: Awaited<ReturnType<ReviewDiscussionService["start"]>>) {
	return result.results.map((item) => {
		expect(item.outcome).not.toBe("failed");
		if (!item.discussion) throw new Error("missing discussion");
		return item.discussion;
	});
}

describe("Regression #341 host sibling lifecycle", () => {
	it.each(["both", "model", "thinking", "neither"] as const)(
		"applies %s configuration before kickoff and preserves it across retry and reset",
		async (selection) => {
			const { source, api, harness, runtimes } = await fixture([
				{ id: "chat", reasoning: true },
				{ id: "selected", reasoning: true },
				{ id: "review", reasoning: true },
			]);
			const provider = harness.models[0].provider;
			harness.settingsManager.setDefaultModelAndProvider(provider, "chat");
			harness.settingsManager.setDefaultThinkingLevel("low");
			await source.session.setModel(harness.getModel("review")!, { persistDefault: false });
			source.session.setThinkingLevel("high", { persistDefault: false });
			const expectedModel = selection === "both" || selection === "model" ? "selected" : "chat";
			const expectedThinking = selection === "both" || selection === "thinking" ? "medium" : "low";
			let observed: unknown;
			harness.setResponses([
				(_context, _options, _state, model) => {
					observed = { model: model.id, thinking: runtimes[1]!.session.thinkingLevel };
					return fauxAssistantMessage("answer");
				},
			]);
			const discussionConfiguration =
				selection === "neither"
					? undefined
					: {
							...(selection === "both" || selection === "model"
								? { model: { provider, modelId: "selected" } }
								: {}),
							...(selection === "both" || selection === "thinking" ? { thinkingLevel: "medium" } : {}),
						};
			const input = { runId: "review-341", findingIds: ["f1"], requestId: "start", discussionConfiguration };
			// A paired device's intent carries the nested configuration across the remote profile unchanged.
			const phone = await connectPhone(source);
			expect(await phone.intent("review_start_discussions", JSON.parse(JSON.stringify(input)))).toMatchObject({
				type: "accepted",
				result: { results: [{ outcome: "created" }] },
			});
			await runtimes[1]!.session.waitForIdle();
			expect(observed).toEqual({ model: expectedModel, thinking: expectedThinking });
			const first = (await api.list("review-341")).discussions[0]!;
			const retry = successful(
				await api.start("review-341", ["f1"], "retry", {
					model: { provider, modelId: "review" },
					thinkingLevel: "high",
				}),
			)[0]!;
			expect(retry.sessionId).toBe(first.sessionId);
			expect(runtimes[1]!.session.model?.id).toBe(expectedModel);
			harness.settingsManager.setDefaultModelAndProvider(provider, "review");
			harness.settingsManager.setDefaultThinkingLevel("high");
			await api.reset(first.discussionId, first.sessionId, "reset");
			expect(runtimes[2]!.session.model?.id).toBe(expectedModel);
			expect(runtimes[2]!.session.thinkingLevel).toBe(expectedThinking);
			expect(runtimes[2]!.session.messages.some((message) => message.role === "user")).toBe(false);
		},
	);

	it("rejects unavailable models and unsupported thinking before creating any children", async () => {
		const { source, api, harness, runtimes } = await fixture([{ id: "chat", reasoning: false }]);
		const provider = harness.models[0].provider;
		for (const discussionConfiguration of [
			{ model: { provider, modelId: "missing" } },
			{ thinkingLevel: "high" },
			{ thinkingLevel: "unknown" },
		]) {
			// A thinking level outside the protocol's set fails the intent's input schema.
			await expect(
				intentRegistry.invokeFrame(contextOf(source), "review_start_discussions", {
					runId: "review-341",
					findingIds: ["f1", "f2"],
					requestId: "invalid",
					discussionConfiguration,
				}),
			).rejects.toThrow(/unavailable|Unsupported|Invalid/);
			expect((await api.list("review-341")).discussions).toEqual([]);
			expect(runtimes).toHaveLength(1);
		}
		vi.spyOn(source.session.modelRegistry, "getAvailable").mockReturnValue([]);
		await expect(
			api.start("review-341", ["f1"], "no-auth", { model: { provider, modelId: "chat" } }),
		).rejects.toThrow("unavailable");
		expect((await api.list("review-341")).discussions).toEqual([]);
	});

	it("rejects malformed nested discussion configuration at the intent boundary", () => {
		for (const discussionConfiguration of [
			null,
			{ model: { provider: "p", id: "m" } },
			{ model: { provider: "p" } },
			{ thinkingLevel: 2 },
			{ extra: true },
		]) {
			expect(() =>
				intentRegistry.prepareFrame({ services: {}, profile: LOCAL_INTENT_PROFILE }, "review_start_discussions", {
					runId: "review-341",
					findingIds: ["f1"],
					requestId: "invalid",
					discussionConfiguration,
				}),
			).toThrow(expect.objectContaining({ code: "invalid_input" }));
		}
	});
	it("projects identity without permission claims and executes intent bash and current-context plans", async () => {
		const { api, harness, runtimes, root, source } = await fixture();
		await source.session.setAgentMode("plan");
		expect(source.session.getActiveToolNames()).not.toContain("write");
		harness.setResponses([fauxAssistantMessage("Analysis only")]);
		await api.start("review-341", ["f1"], "start");
		const child = runtimes[1]!;
		await child.session.waitForIdle();
		expect(child.session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "bash", "lsp"]));
		const context = contextOf(child);
		const served = await queryRegistry.run(context, "review.discussion_source", {});
		expect(Compile(QUERY_SCHEMAS["review.discussion_source"].result).Errors(served)).toEqual([]);
		const link = served.discussion!;
		expect(link).not.toHaveProperty("readOnly");
		expect(
			(await intentRegistry.invoke(context, "bash", { command: "printf rpc-fixed > rpc.txt" })).result,
		).toMatchObject({ exitCode: 0 });
		expect(readFileSync(join(root, "rpc.txt"), "utf8")).toBe("rpc-fixed");
		await child.session.setAgentMode("plan");
		let plan = await child.session.updatePlan({ steps: [{ text: "Apply fix" }] });
		plan = await child.session.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
			title: "Fix",
			summary: "Fix the selected finding",
		});
		expect(
			intentRegistry.availability(intentRegistry.get("plan_execute"), {
				state: intentStateOf(child.session),
				services: {},
				profile: LOCAL_INTENT_PROFILE,
			}).enabled,
		).toBe(true);
		expect(() =>
			intentRegistry.prepare(context, "plan_execute", {
				planId: plan.id,
				expectedRevision: plan.revision,
				strategy: "new_session",
			}),
		).toThrow("source review");
		expect(
			(await intentRegistry.invoke(context, "plan_change", { planId: plan.id, expectedRevision: plan.revision }))
				.outcome,
		).toMatchObject({ plan: { phase: "draft" } });
		plan = child.session.planningState.plan!;
		plan = await child.session.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
			title: "Fix",
			summary: "Fix the selected finding",
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: join(root, "plan-fix.txt"), content: "fixed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fix applied"),
		]);
		const execute = {
			planId: plan.id,
			expectedRevision: plan.revision,
			strategy: "retain_context",
		} as const;
		const executed = await intentRegistry.invoke(context, "plan_execute", execute);
		expect(executed).toMatchObject({ result: { started: true }, outcome: { selectedSessionId: link.sessionId } });
		expect(executed.conversation).toBeUndefined();
		await child.session.waitForIdle();
		expect(readFileSync(join(root, "plan-fix.txt"), "utf8")).toBe("fixed");
		expect((await intentRegistry.invoke(context, "plan_execute", execute)).outcome).toMatchObject({
			started: false,
			selectedSessionId: link.sessionId,
		});
		plan = child.session.planningState.plan!;
		expect(
			(await intentRegistry.invoke(context, "plan_discard", { planId: plan.id, expectedRevision: plan.revision }))
				.outcome,
		).toMatchObject({ plan: null });
		expect(child.session.sessionId).toBe(link.sessionId);
	});
	it("invokes co-client create/list and rejects explicitly without a sibling service", async () => {
		const { source, harness, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const start = { runId: "review-341", findingIds: ["f1"], requestId: "stable" };
		const first = await intentRegistry.invoke(contextOf(source), "review_start_discussions", start);
		expect(first.result).toMatchObject({ results: [{ outcome: "created" }] });
		await runtimes[1]!.session.waitForIdle();
		const second = await intentRegistry.invoke(contextOf(source), "review_start_discussions", start);
		expect(second.result).toMatchObject({ results: [{ outcome: "existing" }] });
		expect(await queryRegistry.run(contextOf(source), "review.discussions", { runId: "review-341" })).toMatchObject({
			discussions: [{ status: "completed" }],
		});
		source.reviewDiscussions = undefined;
		await expect(
			queryRegistry.run(contextOf(source), "review.discussions", { runId: "review-341" }),
		).rejects.toMatchObject({ code: "review_discussions_unavailable" });
	});
	it("starts four overlapping turns, co-client deduplicates and lists, and keeps one-child cancellation isolated", async () => {
		const { api, harness, runtimes, source, service, gates, root } = await fixture();
		holdResponses(harness, 4, gates);
		const first = successful(await api.start("review-341", ["f1", "f2", "f3", "f4"], "request"));
		await vi.waitFor(() => expect(gates).toHaveLength(4));
		expect(new Set(first.map((row) => row.discussionId)).size).toBe(4);
		expect(runtimes).toHaveLength(5);
		expect(
			runtimes
				.slice(1)
				.every((runtime) => runtime.session.isBusy && runtime.cwd === root && runtime.session.isReviewDiscussion),
		).toBe(true);
		const second = service.forRuntime(source.conversation);
		expect(
			(await second.start("review-341", ["f1", "f2", "f3", "f4"], "retry")).results.every(
				(row) => row.outcome === "existing",
			),
		).toBe(true);
		expect((await second.list("review-341")).discussions).toHaveLength(4);
		expect(gates).toHaveLength(4);
		const child = runtimes[1]!;
		expect(child.session.sessionManager.getReviewDiscussion()?.source.sessionId).toBe(source.session.sessionId);
		expect((await child.reviewDiscussions!.source())?.sourceSessionId).toBe(source.session.sessionId);
		const abort = child.session.abort();
		for (const release of gates) release();
		await abort;
		await Promise.all(runtimes.slice(1).map((runtime) => runtime.session.waitForIdle()));
		expect(
			runtimes
				.slice(2)
				.every((runtime) =>
					runtime.session.messages.some(
						(message) => message.role === "assistant" && message.stopReason !== "aborted",
					),
				),
		).toBe(true);
		expect(
			getReviewRun(source.session.sessionManager, "review-341")?.result?.findings.every(
				(finding) => finding.status === "open",
			),
		).toBe(true);
		for (const runtime of runtimes.slice(1))
			expect(runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("contains partial failures, retries only definitively unsubmitted launches, and never repeats completed kickoff", async () => {
		const { api, harness, runtimes, siblings } = await fixture();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("retry")]);
		const create = vi.spyOn(siblings, "open");
		create.mockImplementationOnce(async (_parent, manager) => {
			await manager.closePersistence();
			throw new Error("injected");
		});
		const result = await api.start("review-341", ["f1", "f2", "unknown"], "partial");
		expect(result.results.map((row) => row.outcome)).toEqual(["failed", "created", "failed"]);
		expect(result.results[2]).toMatchObject({ errorCode: "unknown_finding" });
		await runtimes[1]!.session.waitForIdle();
		const retry = successful(await api.start("review-341", ["f1", "f2"], "retry"));
		expect(retry.map((row) => row.discussionId)).toEqual(
			result.results.slice(0, 2).map((row) => row.discussion!.discussionId),
		);
		await Promise.all(runtimes.map((runtime) => runtime.session.waitForIdle()));
		await api.start("review-341", ["f1", "f2"], "lost-response");
		expect(runtimes).toHaveLength(3);
		for (const runtime of runtimes.slice(1))
			expect(runtime.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
	});

	it("idle reset uses expected-child CAS and request history without automatically spending", async () => {
		const { api, harness, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const [first] = successful(await api.start("review-341", ["f1"], "start"));
		await runtimes[1]!.session.waitForIdle();
		const [a, b] = await Promise.all([
			api.reset(first!.discussionId, first!.sessionId, "a"),
			api.reset(first!.discussionId, first!.sessionId, "b"),
		]);
		expect([a.status, b.status].sort()).toEqual(["conflict", "reset"]);
		expect(a.discussion.discussionId).toBe(first!.discussionId);
		expect(a.discussion.currentSessionId).not.toBe(first!.sessionId);
		expect(a.discussion.status).toBe("idle");
		expect(await api.reset(first!.discussionId, first!.sessionId, "a")).toEqual(a);
		expect(runtimes).toHaveLength(3);
		expect(runtimes[2]!.session.isBusy).toBe(false);
		await expect(runtimes[1]!.newSession()).rejects.toThrow("source-linked");
		await expect(runtimes[1]!.importFromJsonl("missing")).rejects.toThrow("source-linked");
	});

	it.each([false, true])(
		"shows interrupted later input after reconnect (reset: %s) until an explicit retry answers",
		async (reset) => {
			const { api, harness, runtimes, source, siblings } = await fixture();
			harness.setResponses([fauxAssistantMessage("Initial answer")]);
			const [first] = successful(await api.start("review-341", ["f1"], "start"));
			await runtimes[1]!.session.waitForIdle();
			if (reset) await api.reset(first!.discussionId, first!.sessionId, "reset");
			const child = runtimes.at(-1)!;
			const ref = child.session.sessionRef!;
			await child.dispose();
			runtimes.splice(runtimes.indexOf(child), 1);
			// The crash boundary: a follow-up was queued durably but never delivered.
			const manager = await SessionManager.open(ref);
			await seedSession(manager, (seed) =>
				seed.clientInput(
					"interrupted-follow-up",
					"follow_up",
					{ message: "Check another case" },
					{ queued: "follow_up" },
				),
			);
			expect((await api.list("review-341")).discussions[0]!.status).toBe("interrupted");
			const reopened = await siblings.open(source.conversation, manager);
			await reopened.startRecoveredClientInputs();
			expect(reopened.session.sessionManager.getClientInput("interrupted-follow-up")).toMatchObject({
				state: "failed",
				error: expect.stringContaining("interrupted"),
			});
			expect((await api.list("review-341")).discussions[0]!.status).toBe("failed");
			harness.setResponses([fauxAssistantMessage("Explicit retry answer")]);
			await reopened.session.prompt("Retry the interrupted request", { source: "rpc", clientMessageId: "retry" });
			expect((await api.list("review-341")).discussions[0]!.status).toBe("completed");
			expect(reopened.session.messages.filter((message) => message.role === "user")).toHaveLength(reset ? 1 : 2);
		},
	);

	it("keeps an older undelivered follow-up visible after a newer input answers and recovery fails it", async () => {
		const { api, harness, runtimes, source, siblings } = await fixture();
		harness.setResponses([fauxAssistantMessage("Initial answer")]);
		await api.start("review-341", ["f1"], "start");
		const child = runtimes[1]!;
		await child.session.waitForIdle();
		const ref = child.session.sessionRef!;
		await child.dispose();
		runtimes.splice(1, 1);
		// Persist the crash boundary after a newer steering request overtakes an
		// older follow-up, but before the follow-up reaches canonical delivery.
		const manager = await SessionManager.open(ref);
		await seedSession(
			manager,
			(seed) =>
				seed
					.clientInput("older-follow-up", "follow_up", { message: "Deferred work" }, { queued: "follow_up" })
					.clientInput("newer", "prompt", { message: "Newer steering request" }, { states: ["started"] })
					.user("Newer steering request", { clientMessageId: "newer" })
					.assistant("Newer steering answer"),
			{ model: harness.getModel() },
		);
		expect(clientInputRecovery(manager.getConversationState()).kind).toBe("replay");
		expect((await api.list("review-341")).discussions[0]!.status).toBe("interrupted");
		const reopened = await siblings.open(source.conversation, manager);
		await reopened.startRecoveredClientInputs();
		expect(reopened.session.sessionManager.getClientInput("older-follow-up")?.state).toBe("failed");
		expect((await api.list("review-341")).discussions[0]!.status).toBe("failed");
		harness.setResponses([fauxAssistantMessage("Explicit retry answer")]);
		await reopened.session.prompt("Retry deferred work", { source: "rpc", clientMessageId: "retry" });
		expect((await api.list("review-341")).discussions[0]!.status).toBe("completed");
		expect(reopened.session.messages.filter((message) => message.role === "user")).toHaveLength(3);
	});

	it("projects the selected branch when navigating between completed and failed answers", async () => {
		const { api, harness, runtimes } = await fixture();
		harness.setResponses([
			fauxAssistantMessage("Initial answer"),
			fauxAssistantMessage("Failure", {
				stopReason: "error",
				error: { kind: "unknown", retryable: false, message: "Failed" },
			}),
		]);
		const [discussion] = successful(await api.start("review-341", ["f1"], "start"));
		const child = runtimes[1]!;
		await child.session.waitForIdle();
		const initialLeaf = child.session.sessionManager.getLeafId()!;
		await child.session.prompt("Later attempt", { source: "rpc", clientMessageId: "later" });
		const failedLeaf = child.session.sessionManager.getLeafId()!;
		expect((await api.list("review-341")).discussions[0]!.status).toBe("failed");
		await child.session.navigateTree(initialLeaf);
		expect(child.session.sessionManager.getLeafId()).toBe(initialLeaf);
		expect((await api.list("review-341")).discussions[0]).toMatchObject({
			currentSessionId: discussion!.sessionId,
			status: "completed",
		});
		await child.session.navigateTree(failedLeaf);
		expect((await api.list("review-341")).discussions[0]!.status).toBe("failed");
	});

	it("source handoff aliases converge and copied/forked metadata cannot grant authority", async () => {
		const { api, harness, source, service, runtimes, own, root } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const first = successful(await api.start("review-341", ["f1"], "start"))[0]!;
		await runtimes[1]!.session.waitForIdle();
		const target = await SessionManager.create(root, join(root, "sessions"));
		await appendReviewRun(target.logWriter, record());
		const alias = await own(target);
		await expect(service.forRuntime(alias.conversation).list("review-341")).rejects.toThrow("not owned");
		await registerReviewHandoffAliases(source.session.sessionManager, alias.session.sessionWriter, ["review-341"]);
		expect(
			successful(await service.forRuntime(alias.conversation).start("review-341", ["f1"], "alias"))[0]!.discussionId,
		).toBe(first.discussionId);
		await service
			.forRuntime(alias.conversation)
			.recordOutcome({ runId: "review-341", findingId: "f1", status: "fixed" });
		expect(getReviewRun(source.session.sessionManager, "review-341")?.result?.findings[0]?.status).toBe("fixed");
		expect(getReviewRun(alias.session.sessionManager, "review-341")?.result?.findings[0]?.status).toBe("open");
	});

	it("survives a source session change and a child reconnect without another initial turn", async () => {
		const { api, harness, source, service, runtimes } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const sourceId = source.session.sessionId;
		const [first] = successful(await api.start("review-341", ["f1"], "first"));
		await runtimes[1]!.session.waitForIdle();
		await runtimes[1]!.dispose();
		runtimes.splice(1, 1);
		await source.newSession({
			setup: async (manager) => {
				await appendReviewRun(manager, record());
			},
		});
		expect(source.session.sessionId).not.toBe(sourceId);
		// The service serves the conversation the source client moved to, an alias of the review's source.
		const moved = service.forRuntime(source.conversation);
		const [existing] = successful(await moved.start("review-341", ["f1"], "after-rebind"));
		expect(existing).toMatchObject({
			discussionId: first!.discussionId,
			sourceSessionId: sourceId,
			currentSessionId: first!.currentSessionId,
		});
		expect(runtimes).toHaveLength(1);
	});

	it("fails closed on deleted children and stale source generations", async () => {
		const { api, harness, source, runtimes, root } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		const [first] = successful(await api.start("review-341", ["f1"], "first"));
		await runtimes[1]!.session.waitForIdle();
		const childRef = runtimes[1]!.session.sessionRef!;
		await runtimes[1]!.dispose();
		runtimes.splice(1, 1);
		await SessionManager.delete(childRef);
		expect((await api.list("review-341")).discussions[0]).toMatchObject({ available: false, status: "unavailable" });
		const store = await SQLiteSessionStoreClient.open(join(root, "sessions"));
		try {
			const sourceRef = source.session.sessionRef!;
			// Runs and children are exact incarnations: another generation of either is neither.
			expect(await store.findReviewRun("review-341")).toMatchObject({
				source: { sessionId: sourceRef.sessionId, sessionGeneration: sourceRef.sessionGeneration },
			});
			expect(
				await store.findReviewDiscussionChild({ sessionId: childRef.sessionId, sessionGeneration: "stale" }),
			).toBeNull();
			expect(
				await store.findReviewDiscussionChild({
					sessionId: childRef.sessionId,
					sessionGeneration: childRef.sessionGeneration,
				}),
			).toMatchObject({ discussionId: first!.discussionId, ordinal: 1 });
		} finally {
			await store.close();
		}
		const reset = await api.reset(first!.discussionId, first!.sessionId, "reset-deleted");
		expect(reset).toMatchObject({ status: "reset", discussion: { available: true, status: "idle" } });
	});

	it("limits source-owned lifecycle intents only, bounds requests and preserves general conversations", async () => {
		const { api, harness, runtimes, source } = await fixture();
		harness.setResponses([fauxAssistantMessage("answer")]);
		await api.start("review-341", ["f1"], "start");
		const child = contextOf(runtimes[1]!);
		for (const [name, input] of [
			["new_session", {}],
			["review_record_finding_outcome", { runId: "review-341", findingId: "f1", status: "fixed" }],
			["plan_execute", { planId: "p", expectedRevision: 1, strategy: "new_session" }],
			["review_open_session", { runId: "review-341" }],
		] as const) {
			expect(() => intentRegistry.prepareFrame(child, name, input)).toThrow(REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE);
			expect(() => intentRegistry.prepareFrame(contextOf(source), name, input)).not.toThrow();
		}
		for (const [name, input] of [
			["start_subagent", { agent: "general", prompt: "fix" }],
			["open_work", { workId: "sa_1" }],
			["mcp.connect", { server: "x" }],
			["bash", { command: "echo allowed" }],
			["plan_execute", { planId: "p", expectedRevision: 1, strategy: "retain_context" }],
		] as const)
			expect(() => intentRegistry.prepareFrame(child, name, input)).not.toThrow();
		const start = { runId: "review-341", requestId: "request" };
		expect(() =>
			intentRegistry.prepare(contextOf(source), "review_start_discussions", {
				...start,
				findingIds: Array.from({ length: 51 }, (_, n) => String(n)),
			}),
		).toThrow(expect.objectContaining({ code: "invalid_input" }));
		expect(() =>
			intentRegistry.prepare(contextOf(source), "review_start_discussions", { ...start, findingIds: ["f1"] }),
		).not.toThrow();
	});
});
