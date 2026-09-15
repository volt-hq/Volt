import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonValue, type Usage } from "@hansjm10/volt-ai";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeHostProvider } from "../../../src/core/code-host/index.ts";
import { convertToLlm, createCustomMessage } from "../../../src/core/messages.ts";
import {
	type ExecuteReviewWorkflowOptions,
	executeReviewWorkflow,
	prepareReviewWorkflow,
} from "../../../src/core/review.ts";
import { registerReviewHandoffAliases } from "../../../src/core/review-anchors.ts";
import {
	createReviewAccountingMessage,
	createReviewSeedMessage,
	formatReviewUsage,
} from "../../../src/core/review-presentation.ts";
import { publishReviewRun } from "../../../src/core/review-publish.ts";
import {
	appendReviewRun,
	appendReviewRunDurably,
	appendReviewUsageCheckpoint,
	captureReviewStateForHandoff,
	getCanonicalReviewRun,
	getReviewRun,
	listReviewRuns,
	type ReviewRunRecord,
	restoreReviewStateFromHandoff,
} from "../../../src/core/review-state.ts";
import {
	createEmptyReviewUsage,
	parseReviewUsage,
	type ReviewUsageAccounting,
	type ReviewUsageAttempt,
	ReviewUsageCollector,
} from "../../../src/core/review-usage.ts";
import { ReviewWorkflowManager } from "../../../src/core/review-workflows.ts";
import { RPC_RESPONSE_SCHEMAS } from "../../../src/core/rpc/schema/responses.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { CustomMessageComponent } from "../../../src/modes/interactive/components/custom-message.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../../src/modes/rpc/rpc-command-dispatcher.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const identity: ReviewUsageAttempt = {
	passId: 1,
	phase: "discovery",
	purpose: "findings",
	round: 1,
	attempt: 1,
	kind: "turn",
};
function usage(input = 10, availability: Usage["availability"] = "complete"): Usage {
	return {
		availability,
		input,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: input + 9,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
	};
}
async function harness() {
	const h = await createHarness({
		settings: { retry: { enabled: false }, compaction: { enabled: false }, lsp: { enabled: false } },
	});
	cleanups.push(() => h.cleanupAsync());
	return h;
}
async function fixture() {
	const h = await harness();
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, { cwd: h.tempDir, encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr);
	};
	git("init", "--initial-branch=main");
	git("config", "user.email", "review@example.test");
	git("config", "user.name", "Review Test");
	writeFileSync(join(h.tempDir, "file.ts"), "export const value = 1;\n");
	git("add", "file.ts");
	git("commit", "-m", "initial");
	writeFileSync(join(h.tempDir, "file.ts"), "export const value = 2;\n");
	const manager = await SessionManager.create(h.tempDir, join(h.tempDir, "sessions"));
	cleanups.push(() => manager.closePersistence());
	const prepared = await prepareReviewWorkflow({
		target: { kind: "uncommitted" },
		cwd: h.tempDir,
		settingsManager: h.settingsManager,
		modelRegistry: h.session.modelRegistry,
		currentModel: h.getModel(),
		sessionManager: manager,
	});
	cleanups.push(() => prepared.resolution.dispose());
	const options: ExecuteReviewWorkflowOptions = {
		prepared,
		cwd: h.tempDir,
		agentDir: h.tempDir,
		authStorage: h.authStorage,
		modelRegistry: h.session.modelRegistry,
		settingsManager: h.settingsManager,
		sessionManager: manager,
	};
	return { h, manager, options };
}
function candidates(value = usage()) {
	return fauxAssistantMessage(
		fauxToolCall("report_review_candidates", { summary: "No candidates", candidates: [], limitations: [] }),
		{ stopReason: "toolUse", usage: value },
	);
}
function verification(incomplete = false, value = usage()) {
	return fauxAssistantMessage(
		fauxToolCall("report_review_verification", {
			summary: "Checked",
			assessment: incomplete ? "incomplete" : "complete",
			...(incomplete ? { challenge: "Inspect the remaining changed behavior" } : {}),
			decisions: [],
			priorFindingDecisions: [],
			limitations: [],
		}),
		{ stopReason: "toolUse", usage: value },
	);
}

function unfinished(runId = "review:409"): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId,
		workflowAction: "review.uncommitted",
		status: "unfinished",
		startedAt: 1,
		target: {
			description: "Test",
			diffCommand: "git diff",
			identity: { kind: "uncommitted", baseTree: "base", headTree: "head" },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
	};
}

describe("#409 initial review accounting", () => {
	it("replaces cumulative usage, ignores duplicate/stale/late updates, and totals parallel requests once", async () => {
		const h = await harness();
		const saved: ReviewUsageAccounting[] = [];
		const collector = new ReviewUsageCollector(async (snapshot) => {
			saved.push(snapshot);
		});
		const first = await collector.start(identity, h.getModel());
		const second = await collector.start({ ...identity, kind: "compaction" }, h.getModel());
		await first.observe(usage(5, "partial"), 1, false, false);
		await first.observe(usage(5, "partial"), 2, false, false);
		await first.observe(usage(999), 1, false, false);
		await second.observe(usage(20), 1, true, true);
		await first.observe(usage(10), 3, true, true);
		await first.observe(usage(900), 4, true, true);
		const final = await collector.finish();
		expect(final.summary).toMatchObject({
			status: "complete",
			requests: 2,
			turns: 1,
			pendingRequests: 0,
			tokens: { input: 30, output: 4, cacheRead: 6, cacheWrite: 8 },
			estimatedCost: { total: 0.2 },
		});
		expect(final.attempts).toHaveLength(2);
		expect(saved.every((entry) => parseReviewUsage(entry) !== undefined)).toBe(true);
		expect(saved.map((entry) => entry.revision)).toEqual([...new Set(saved.map((entry) => entry.revision))]);
		expect(await collector.finish()).toMatchObject({ revision: final.revision });
	});

	it("separates repair/pass/model/tier groups and never reprices a saved estimate", async () => {
		const h = await harness();
		const collector = new ReviewUsageCollector();
		for (let n = 1; n <= 3; n++) {
			const request = await collector.start(
				{ ...identity, passId: n, round: n === 3 ? 2 : 1, attempt: n === 2 ? 2 : 1 },
				{ ...h.getModel(), id: `model-${n}` },
			);
			await request.observe(
				{ ...usage(), serviceTier: { requested: "priority", effective: n === 2 ? "default" : "priority" } },
				1,
				true,
				true,
			);
		}
		const final = await collector.finish();
		expect(final.attempts.map((entry) => entry.model)).toEqual(["model-1", "model-2", "model-3"]);
		expect(final.attempts[1]).toMatchObject({ attempt: 2, requestedTier: "priority", effectiveTier: "default" });
		expect(final.summary.estimatedCost?.total).toBeCloseTo(0.3);
		expect(parseReviewUsage(JSON.parse(JSON.stringify(final)))).toEqual(final);
	});

	it("distinguishes zero, unavailable, partial, malformed and interrupted accounting", async () => {
		const h = await harness();
		expect(createEmptyReviewUsage().summary).toMatchObject({
			status: "complete",
			requests: 0,
			tokens: { input: 0 },
			estimatedCost: { total: 0 },
		});
		for (const value of [undefined, { ...usage(), availability: undefined }, usage(-1), usage(Number.NaN)]) {
			const collector = new ReviewUsageCollector();
			const request = await collector.start(identity, h.getModel());
			await request.observe(value, 1, true, false);
			expect((await collector.finish()).summary).toMatchObject({
				status: "unavailable",
				requests: 1,
				unavailableRequests: 1,
			});
			expect(collector.snapshot().summary.tokens).toBeUndefined();
		}
		const partial = new ReviewUsageCollector();
		const request = await partial.start(identity, h.getModel());
		await request.observe(usage(5, "partial"), 1, false, false);
		expect(partial.snapshot().summary).toMatchObject({ status: "partial", pendingRequests: 1, tokens: { input: 5 } });
		// A missing terminal report must not erase previously observed counters.
		await request.observe(undefined, 2, true, false);
		expect((await partial.finish()).summary).toMatchObject({
			status: "partial",
			pendingRequests: 0,
			partialRequests: 1,
		});
	});

	it("fail-stops accounting admission and cannot continue after a persistence rejection", async () => {
		const h = await harness();
		const collector = new ReviewUsageCollector(async () => {
			throw new Error("disk unavailable");
		});
		await expect(collector.start(identity, h.getModel())).rejects.toThrow("accounting could not be retained");
		await expect(collector.start(identity, h.getModel())).rejects.toThrow("accounting could not be retained");
		await expect(collector.finish()).rejects.toThrow("accounting could not be retained");
	});

	it("persists and lists checkpoint-only runs after close/reopen, with no fabricated end time", async () => {
		const h = await harness();
		const directory = join(h.tempDir, "store");
		const manager = await SessionManager.create(h.tempDir, directory);
		const record = unfinished();
		await appendReviewRunDurably(manager, record);
		const collector = new ReviewUsageCollector(async (value) => {
			appendReviewUsageCheckpoint(manager, record.runId, value);
			await manager.flush();
		});
		const request = await collector.start(identity, h.getModel());
		await request.observe(usage(5, "partial"), 1, false, false);
		const saved = getReviewRun(manager, record.runId)!;
		const ref = manager.getSessionRef()!;
		await manager.closePersistence();
		const reopened = await SessionManager.open(ref);
		cleanups.push(() => reopened.closePersistence());
		expect(getReviewRun(reopened, record.runId)).toEqual(saved);
		expect(saved.endedAt).toBeUndefined();
		expect(saved.usage?.summary).toMatchObject({
			status: "partial",
			requests: 1,
			pendingRequests: 1,
			tokens: { input: 5 },
		});
		expect((await SessionManager.list(h.tempDir, directory)).map((entry) => entry.id)).toContain(ref.sessionId);
		expect(h.faux.state.callCount).toBe(0);
	});

	it("uses latest checkpoints and canonical aliases without counting copies or stale terminal updates", async () => {
		const h = await harness();
		const directory = join(h.tempDir, "store");
		const source = await SessionManager.create(h.tempDir, directory);
		const alias = await SessionManager.create(h.tempDir, directory);
		cleanups.push(
			() => source.closePersistence(),
			() => alias.closePersistence(),
		);
		const record = unfinished();
		await appendReviewRunDurably(source, record);
		const collector = new ReviewUsageCollector(async (value) => {
			appendReviewUsageCheckpoint(source, record.runId, value);
			await source.flush();
		});
		const request = await collector.start(identity, h.getModel());
		await request.observe(usage(5, "partial"), 1, false, false);
		const stale = collector.snapshot();
		restoreReviewStateFromHandoff(alias, captureReviewStateForHandoff(source));
		await alias.flush();
		await registerReviewHandoffAliases(source, alias, [record.runId]);
		await request.observe(usage(10), 2, true, true);
		const final = { ...record, status: "failed" as const, endedAt: 3, usage: await collector.finish() };
		await appendReviewRunDurably(source, final);
		appendReviewUsageCheckpoint(source, record.runId, stale);
		appendReviewRun(source, record);
		await source.flush();
		expect(listReviewRuns(source).runs).toHaveLength(1);
		expect(await getCanonicalReviewRun(alias, record.runId)).toEqual(final);
		expect(getReviewRun(alias, record.runId)?.usage?.summary.tokens?.input).toBe(5);
		expect(getReviewRun(source, record.runId)?.usage?.summary.tokens?.input).toBe(10);
	});

	it("runs reviews with no UI observer, includes repairs/repeated passes, and leaves discussion totals alone", async () => {
		const { h, manager, options } = await fixture();
		h.setResponses([
			fauxAssistantMessage("Missing report", { usage: usage() }),
			candidates(),
			verification(true),
			candidates(),
			verification(),
		]);
		const result = await executeReviewWorkflow(options);
		expect(result.status).toBe("completed");
		const final = getReviewRun(manager, options.prepared.workflowId)!;
		expect(final.usage?.summary).toMatchObject({ status: "complete", requests: 5, turns: 5, tokens: { input: 50 } });
		expect(final.usage?.attempts.map((entry) => [entry.phase, entry.round, entry.attempt])).toEqual([
			["discovery", 1, 1],
			["discovery", 1, 2],
			["verification", 1, 1],
			["discovery", 2, 1],
			["verification", 2, 1],
		]);
		expect(h.faux.state.simpleCallCount).toBe(0);
		expect(h.session.getSessionStats().tokens.total).toBe(0);
		const ref = manager.getSessionRef()!;
		await manager.closePersistence();
		const reopened = await SessionManager.open(ref);
		cleanups.push(() => reopened.closePersistence());
		expect(getReviewRun(reopened, final.runId)).toEqual(final);
	});

	it("retains accounting for both presentation purposes and swallowed follow-up failures", async () => {
		const { h, manager, options } = await fixture();
		options.prepared.resolution.codeHostContext = {
			manifest: {
				status: "complete",
				capturedAt: new Date().toISOString(),
				linkedIssueCount: 0,
				discussionEntryCount: 0,
				renderedLinkedIssueCount: 0,
				renderedDiscussionEntryCount: 0,
				renderedBytes: 0,
				limitations: [],
				fingerprint: "context",
			},
			linkedIssues: [],
			discussionEntries: [],
			rendered: "",
		};
		const location = { path: "file.ts", side: "head", startLine: 1, endLine: 1 };
		const report = fauxAssistantMessage(
			fauxToolCall("report_review_candidates", {
				summary: "Changed value",
				limitations: [],
				candidates: [
					{
						candidateId: "c1",
						title: "Wrong value",
						body: "The value changed",
						trigger: "Read value",
						impact: "Wrong result",
						category: "correctness",
						rootCauseKey: "wrong-value",
						priority: 2,
						confidence: 0.9,
						changeLocation: location,
						evidenceLocations: [],
					},
				],
			}),
			{ stopReason: "toolUse", usage: usage() },
		);
		h.setResponses([
			report,
			fauxAssistantMessage(
				fauxToolCall("report_review_verification", {
					summary: "Verified",
					assessment: "incomplete",
					challenge: "Another concern remains",
					challengeLocations: [location],
					decisions: [
						{
							candidateId: "c1",
							outcome: "accept",
							method: "Compared code",
							rationale: "Wrong value",
							confidence: 0.9,
						},
					],
					priorFindingDecisions: [],
					limitations: [],
				}),
				{ stopReason: "toolUse", usage: usage() },
			),
			fauxAssistantMessage("Follow-up failed", {
				stopReason: "error",
				errorMessage: "failed",
				usage: usage(5, "partial"),
			}),
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "file.ts" }), {
				stopReason: "toolUse",
				usage: usage(),
			}),
			(context) => {
				const presentationId = /[0-9a-f]{8}-[0-9a-f-]{27,}/i.exec(JSON.stringify(context.messages))?.[0];
				if (!presentationId) throw new Error("Missing presentation identity");
				return fauxAssistantMessage(
					fauxToolCall("report_review_presentations", {
						findings: [
							{
								presentationId,
								title: "Wrong value",
								body: "The value changed",
								trigger: "Read value",
								impact: "Wrong result",
								category: "correctness",
								rootCauseKey: "wrong-value",
								rationale: "Compared code",
							},
						],
					}),
					{ stopReason: "toolUse", usage: usage() },
				);
			},
			fauxAssistantMessage(fauxToolCall("review_diff", { path: "file.ts" }), {
				stopReason: "toolUse",
				usage: usage(),
			}),
			fauxAssistantMessage(
				fauxToolCall("report_review_presentations", {
					findings: [],
					challenge: { explanation: "Possible other issue", nextStep: "Check changed value" },
				}),
				{ stopReason: "toolUse", usage: usage() },
			),
		]);
		const result = await executeReviewWorkflow(options);
		expect(result.status).toBe("completed");
		const accounting = getReviewRun(manager, options.prepared.workflowId)?.usage;
		expect(accounting?.summary).toMatchObject({ status: "partial", requests: 7, tokens: { input: 65 } });
		expect(
			accounting?.attempts.filter((entry) => entry.phase === "presentation").map((entry) => entry.purpose),
		).toEqual(["findings", "challenge"]);
	});

	it("counts host retries independently from corrective report attempts", async () => {
		const { h, manager, options } = await fixture();
		h.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
		h.setResponses([
			fauxAssistantMessage("Interrupted", {
				stopReason: "error",
				errorMessage: "WebSocket error",
				usage: usage(5, "partial"),
			}),
			candidates(),
			verification(),
		]);
		await executeReviewWorkflow(options);
		const accounting = getReviewRun(manager, options.prepared.workflowId)?.usage;
		expect(h.faux.state.callCount).toBe(3);
		expect(accounting?.summary).toMatchObject({ requests: 3, tokens: { input: 25 }, status: "partial" });
		expect(accounting?.attempts[0]).toMatchObject({ phase: "discovery", attempt: 1, requests: 2 });
	});

	it("keeps concurrent runs isolated in their canonical sources", async () => {
		const { h, manager, options } = await fixture();
		const other = await SessionManager.create(h.tempDir, join(h.tempDir, "sessions"));
		cleanups.push(() => other.closePersistence());
		const prepared = await prepareReviewWorkflow({
			target: { kind: "uncommitted" },
			cwd: h.tempDir,
			settingsManager: h.settingsManager,
			modelRegistry: h.session.modelRegistry,
			currentModel: h.getModel(),
			sessionManager: other,
		});
		cleanups.push(() => prepared.resolution.dispose());
		h.setResponses(
			Array.from(
				{ length: 4 },
				() => (context) =>
					context.tools?.some((tool) => tool.name === "report_review_candidates") ? candidates() : verification(),
			),
		);
		await Promise.all([
			executeReviewWorkflow(options),
			executeReviewWorkflow({ ...options, prepared, sessionManager: other }),
		]);
		for (const [source, runId] of [
			[manager, options.prepared.workflowId],
			[other, prepared.workflowId],
		] as const) {
			expect(listReviewRuns(source).runs).toHaveLength(1);
			expect(getReviewRun(source, runId)?.usage?.summary).toMatchObject({ requests: 2, tokens: { input: 20 } });
		}
	});

	it("retains complete zero accounting for cancellation before the first request", async () => {
		const { h, manager, options } = await fixture();
		const controller = new AbortController();
		controller.abort();
		expect((await executeReviewWorkflow({ ...options, signal: controller.signal })).status).toBe("cancelled");
		expect(h.faux.state.callCount).toBe(0);
		expect(getReviewRun(manager, options.prepared.workflowId)?.usage?.summary).toMatchObject({
			status: "complete",
			requests: 0,
			tokens: { input: 0 },
			estimatedCost: { total: 0 },
		});
	});

	it("disposes the prepared snapshot when initial materialization fails", async () => {
		const { h, manager, options } = await fixture();
		const dispose = vi.spyOn(options.prepared.resolution, "dispose");
		vi.spyOn(manager, "materialize").mockRejectedValue(new Error("Initial write failed"));
		await expect(executeReviewWorkflow(options)).rejects.toThrow("Initial write failed");
		expect(dispose).toHaveBeenCalledOnce();
		expect(h.faux.state.callCount).toBe(0);
	});

	it("fences observations after the captured source generation changes", async () => {
		const { h, manager, options } = await fixture();
		const ref = manager.getSessionRef()!;
		h.setResponses([
			() => {
				vi.spyOn(manager, "getSessionRef").mockReturnValue({
					...ref,
					sessionGeneration: ref.sessionGeneration + 1,
				});
				return candidates();
			},
		]);
		await expect(executeReviewWorkflow(options)).rejects.toThrow("accounting could not be retained");
		expect(h.faux.state.callCount).toBe(1);
		expect(getReviewRun(manager, options.prepared.workflowId)?.usage?.summary).toMatchObject({
			requests: 1,
			pendingRequests: 1,
			status: "unavailable",
		});
	});

	it("prevents provider dispatch if the source checkpoint fails", async () => {
		const { h, manager, options } = await fixture();
		const append = manager.appendCustomEntry.bind(manager);
		vi.spyOn(manager, "appendCustomEntry").mockImplementation((type, data) => {
			if (type === "volt.review.usage") throw new Error("Store unavailable");
			return append(type, data);
		});
		h.setResponses([candidates(), verification()]);
		await expect(executeReviewWorkflow(options)).rejects.toThrow("accounting could not be retained");
		expect(h.faux.state.callCount).toBe(0);
		expect(getReviewRun(manager, options.prepared.workflowId)?.status).toBe("unfinished");
	});

	it.each(["failed", "cancelled"] as const)("preserves observed usage when the review is %s", async (status) => {
		const { h, manager, options } = await fixture();
		const controller = new AbortController();
		h.setResponses([
			candidates(),
			() => {
				if (status === "cancelled") controller.abort();
				return fauxAssistantMessage("Provider failure", {
					stopReason: "error",
					usage: usage(5, "partial"),
					errorMessage: "request failed",
				});
			},
		]);
		const result = await executeReviewWorkflow({ ...options, signal: controller.signal });
		expect(result.status).toBe(status);
		const record = getReviewRun(manager, options.prepared.workflowId)!;
		expect(record.usage?.summary.requests).toBe(2);
		expect(record.usage?.summary.tokens?.input).toBeGreaterThanOrEqual(10);
		expect(record.usage?.summary.status).not.toBe("unavailable");
		expect(
			manager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "custom_message" &&
						entry.details &&
						typeof entry.details === "object" &&
						"usage" in entry.details,
				),
		).toBe(true);
	});

	it("returns canonical usage through RPC, with historical accounting explicitly unavailable", async () => {
		const h = await harness();
		const collector = new ReviewUsageCollector();
		const request = await collector.start(identity, h.getModel());
		await request.observe(usage(), 1, true, true);
		const record = { ...unfinished(), status: "failed" as const, endedAt: 2, usage: await collector.finish() };
		appendReviewRun(h.sessionManager, record);
		const { usage: _usage, ...historical } = record;
		appendReviewRun(h.sessionManager, { ...historical, runId: "historical" });
		const context = {
			session: h.session,
			runtimeHost: { reviewWorkflows: new ReviewWorkflowManager() },
		} as unknown as RpcCommandDispatcherContext;
		const response = await handleRpcCommand({ type: "get_review_result", runId: record.runId }, context);
		expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_result).Errors(response)).toEqual([]);
		expect(response).toMatchObject({
			success: true,
			data: { usage: record.usage.summary, usageBreakdown: record.usage.attempts },
		});
		expect(await handleRpcCommand({ type: "get_review_result", runId: "historical" }, context)).toMatchObject({
			data: { usage: { status: "unavailable" } },
		});
		const live = new ReviewUsageCollector();
		await live.start(identity, h.getModel());
		appendReviewRun(h.sessionManager, { ...unfinished("interrupted"), usage: live.snapshot() });
		const interrupted = await handleRpcCommand({ type: "get_review_result", runId: "interrupted" }, context);
		expect(Compile(RPC_RESPONSE_SCHEMAS.get_review_result).Errors(interrupted)).toEqual([]);
		expect(interrupted).toMatchObject({ data: { status: "unfinished", usage: { pendingRequests: 1 } } });
		const listed = await handleRpcCommand({ type: "list_review_workflows" }, context);
		expect(Compile(RPC_RESPONSE_SCHEMAS.list_review_workflows).Errors(listed)).toEqual([]);
		expect(JSON.stringify(listed)).toContain("pendingRequests");
	});

	it("renders accounting details without adding them to model-facing seed content", async () => {
		const { h, manager, options } = await fixture();
		h.setResponses([candidates(), verification()]);
		await executeReviewWorkflow(options);
		const record = getReviewRun(manager, options.prepared.workflowId)!;
		const seed = createReviewSeedMessage(record);
		const message = createCustomMessage(
			seed.customType,
			seed.content,
			true,
			JSON.parse(JSON.stringify(seed.details)) as JsonValue,
			new Date().toISOString(),
		);
		expect(JSON.stringify(convertToLlm([message]))).not.toContain("estimatedCost");
		expect(seed.content).not.toContain(h.getModel().id);
		initTheme("dark");
		const component = new CustomMessageComponent(message);
		component.setExpanded(true);
		expect(component.render(120).lines.join("\n")).toContain("Model-priced estimate");
		expect(formatReviewUsage(record.usage, true)).toContain("discovery");
		const notice = createReviewAccountingMessage({ ...record, status: "failed" });
		expect(notice.content).not.toContain("accounting");
		const publish = vi.fn(async () => ({ reviewId: 1 }));
		const provider: CodeHostProvider = {
			id: "mock",
			displayName: "Mock",
			probeCurrentPullRequest: vi.fn(),
			capturePullRequestContext: vi.fn(),
			verifyPullRequestHead: vi.fn(async () => {}),
			publishPullRequestReview: publish,
		};
		await publishReviewRun(
			h.tempDir,
			{
				...record,
				status: "completed",
				result: { ...record.result!, completionStatus: "complete" },
				target: {
					...record.target,
					identity: {
						kind: "pr",
						baseTree: "base",
						headTree: "head",
						pullRequest: {
							providerId: "mock",
							number: 1,
							title: "Test",
							body: "",
							url: "https://example.invalid/pr/1",
							baseRefName: "main",
							headRefName: "feature",
							baseRefOid: "base",
							headRefOid: "head",
						},
					},
				},
			},
			provider,
		);
		expect(publish).toHaveBeenCalledOnce();
		expect(JSON.stringify(publish.mock.calls)).not.toContain("estimatedCost");
		expect(JSON.stringify(publish.mock.calls)).not.toContain(h.getModel().id);
	});

	it("accounts for SDK compaction requests independently from visible assistant turns", async () => {
		const h = await harness();
		const collector = new ReviewUsageCollector();
		const manager = SessionManager.inMemory(h.tempDir);
		manager.appendSessionInfo("Named test session");
		const created = await createAgentSession({
			cwd: h.tempDir,
			agentDir: h.tempDir,
			sessionManager: manager,
			authStorage: h.authStorage,
			modelRegistry: h.session.modelRegistry,
			settingsManager: h.settingsManager,
			resourceLoader: h.session.resourceLoader,
			model: h.getModel(),
			tools: [],
			disableMcp: true,
			inferenceAccounting: (model) =>
				collector.start({ ...identity, kind: created.session.isCompacting ? "compaction" : "turn" }, model),
		});
		cleanups.push(async () => {
			created.session.dispose();
			await created.session.waitForClosed();
		});
		h.setResponses([
			fauxAssistantMessage("A response", { usage: usage() }),
			fauxAssistantMessage("Checkpoint", { usage: usage(20) }),
		]);
		h.faux.setSimpleResponses([
			fauxAssistantMessage("A response", { usage: usage() }),
			fauxAssistantMessage("Checkpoint", { usage: usage(20) }),
		]);
		await created.session.prompt("Summarize later. ".repeat(100));
		await created.session.compact();
		const final = await collector.finish();
		expect(final.attempts.some((entry) => entry.kind === "compaction")).toBe(true);
		expect(final.summary.requests).toBeGreaterThan(final.summary.turns);
	});
});
