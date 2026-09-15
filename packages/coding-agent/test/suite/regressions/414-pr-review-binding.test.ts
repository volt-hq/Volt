import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../../src/core/agent-session-runtime.ts";
import { githubCliCodeHostProvider } from "../../../src/core/code-host/index.ts";
import type { ReviewCodeHostContextCaptureResult } from "../../../src/core/code-host/types.ts";
import { PR_CHECKOUT_CHANGED, readPrReviewBinding } from "../../../src/core/pr-review-binding.ts";
import type { PrReviewPlacement } from "../../../src/core/pr-review-placement.ts";
import { executeReviewWorkflow, prepareReviewWorkflow } from "../../../src/core/review.ts";
import { registerReviewHandoffAliases, resolveCanonicalReviewSource } from "../../../src/core/review-anchors.ts";
import * as snapshots from "../../../src/core/review-snapshot.ts";
import { appendReviewRun, appendReviewRunDurably, type ReviewRunRecord } from "../../../src/core/review-state.ts";
import {
	parseSessionEntryForAdmission,
	validatePersistedSessionEntrySequence,
} from "../../../src/core/session-entry-codec.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-414-binding-")));
	const source = join(root, "source");
	const cwd = join(root, "review");
	const directory = join(root, "sessions");
	mkdirSync(source);
	git(source, "init", "--initial-branch=main");
	git(source, "config", "user.name", "Review Test");
	git(source, "config", "user.email", "review@example.test");
	git(source, "config", "commit.gpgsign", "false");
	writeFileSync(join(source, "value.txt"), "base\n");
	git(source, "add", "value.txt");
	git(source, "commit", "-m", "base");
	const base = git(source, "rev-parse", "HEAD");
	writeFileSync(join(source, "value.txt"), "head\n");
	git(source, "commit", "-am", "head");
	const head = git(source, "rev-parse", "HEAD");
	git(source, "worktree", "add", "--detach", cwd, head);
	const placement: PrReviewPlacement = {
		workspaceName: "project",
		workspaceGeneration: 1,
		worktreeId: "review-414",
		cwd,
		sourceCwd: source,
		commonDirectory: join(source, ".git"),
		pullRequest: {
			provider: "github",
			url: "https://github.com/volt-hq/project/pull/414",
			number: 414,
			title: "Review",
			repository: "volt-hq/project",
			headRefName: "topic",
			headRefOid: head,
		},
		repositoryId: "github:github.com/volt-hq/project",
		headRepositoryId: "github:github.com/contributor/fork",
		remote: "origin",
	};
	const manager = await SessionManager.create(cwd, directory);
	const harness = await createHarness({
		sessionManager: manager,
		initialActiveToolNames: ["write"],
		allowedToolNames: ["write"],
		settings: { lsp: { enabled: false }, compaction: { enabled: false } },
	});
	const managers: SessionManager[] = [];
	cleanups.push(async () => {
		for (const owned of managers) await owned.closePersistence();
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const pullRequest = {
		providerId: "github",
		number: 414,
		title: "Review",
		body: "",
		url: placement.pullRequest.url,
		baseRefName: "main",
		headRefName: "topic",
		baseRefOid: base,
		headRefOid: head,
	};
	const snapshot: snapshots.ReviewSnapshot = {
		root: cwd,
		description: "PR #414",
		diffCommand: "git diff base..head",
		identity: {
			kind: "pr",
			baseCommit: base,
			headCommit: head,
			baseTree: git(source, "rev-parse", `${base}^{tree}`),
			headTree: git(source, "rev-parse", `${head}^{tree}`),
			pullRequest,
		},
		changedFiles: [],
		readFile: async () => undefined,
		listFiles: async () => [],
		search: async () => ({
			matches: [],
			filesScanned: 0,
			skippedPaths: [],
			nextFileIndex: 0,
			nextLineIndex: 0,
			complete: true,
		}),
		materializeHead: async () => cwd,
		dispose: vi.fn(async () => {}),
	};
	const captured: Extract<ReviewCodeHostContextCaptureResult, { ok: true }> = {
		ok: true,
		pullRequest,
		context: {
			manifest: {
				status: "complete",
				capturedAt: new Date().toISOString(),
				linkedIssueCount: 0,
				discussionEntryCount: 0,
				renderedLinkedIssueCount: 0,
				renderedDiscussionEntryCount: 0,
				renderedBytes: 0,
				limitations: [],
				fingerprint: "fixture",
			},
			linkedIssues: [],
			discussionEntries: [],
			rendered: "",
		},
		fetchPlan: {
			remote: "origin",
			remoteUrl: "https://github.com/volt-hq/project.git",
			base: { remoteRef: "refs/heads/main", localRef: "refs/heads/base" },
			head: { remoteRef: "refs/pull/414/head", localRef: "refs/heads/head" },
			diffCommand: "git diff base..head",
		},
	};
	const capture = vi.spyOn(githubCliCodeHostProvider, "capturePullRequestContext").mockResolvedValue(captured);
	const resolve = vi.spyOn(snapshots, "resolveReviewSnapshot").mockImplementation(async (target, _cwd, options) => {
		if (target.kind === "pr") {
			const result = await (options.codeHostProvider ?? githubCliCodeHostProvider).capturePullRequestContext({
				cwd,
				number: target.number,
				expectedUrl: target.expectedUrl,
				maxPullRequestNumber: options.maxPullRequestNumber,
			});
			if (!result.ok) return result;
		}
		return snapshot;
	});
	const prepare = (target: snapshots.ReviewTarget = { kind: "pr" }, sessionManager = manager, effectiveCwd = cwd) =>
		prepareReviewWorkflow({
			target,
			cwd: effectiveCwd,
			sessionManager,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			currentModel: harness.getModel(),
		});
	const record: ReviewRunRecord = {
		schemaVersion: 1,
		runId: "review:414",
		workflowAction: "review.pr",
		status: "failed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: snapshot.description,
			diffCommand: snapshot.diffCommand,
			identity: snapshot.identity,
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
	};
	return {
		root,
		source,
		cwd,
		directory,
		manager,
		managers,
		harness,
		placement,
		snapshot,
		capture,
		captured,
		resolve,
		prepare,
		record,
		base,
	};
}

async function runtimeFixture() {
	const f = await fixture();
	const replacements: Harness[] = [];
	const factory: CreateAgentSessionRuntimeFactory = async ({ sessionManager, cwd, agentDir }) => {
		const h =
			sessionManager === f.manager
				? f.harness
				: await createHarness({
						sessionManager,
						settings: { lsp: { enabled: false }, compaction: { enabled: false } },
					});
		if (h !== f.harness) replacements.push(h);
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
				diagnostics: [],
			},
		};
	};
	const runtime = await createAgentSessionRuntime(factory, {
		sessionManager: f.manager,
		cwd: f.cwd,
		agentDir: f.root,
	});
	cleanups.push(async () => {
		await runtime.dispose();
		for (const h of replacements) await h.cleanupAsync();
	});
	return { ...f, runtime };
}

describe("#414 host-owned PR review bindings", () => {
	it("persists once, survives reopen, and stays out of every portable conversation view", async () => {
		const { manager, placement, root, cwd, directory, managers } = await fixture();
		const listener = vi.fn();
		manager.subscribeEntries(listener);
		manager.recordPrReviewBinding(placement);
		manager.recordPrReviewBinding(structuredClone(placement));
		placement.pullRequest.title = "caller mutation";
		expect(manager.getPrReviewBinding()!.pullRequest.title).toBe("Review");
		const detached = manager.getPrReviewBinding()!;
		detached.pullRequest.title = "reader mutation";
		expect(manager.getPrReviewBinding()!.pullRequest.title).toBe("Review");
		expect(() => manager.recordPrReviewBinding(placement)).toThrow("immutable");
		expect(listener).not.toHaveBeenCalled();
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getTree()).toEqual([]);
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(manager.buildSessionContext().messages).toEqual([]);
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionRef()!);
		managers.push(reopened);
		expect(reopened.getPrReviewBinding()).toEqual(manager.getPrReviewBinding());
		const path = join(root, "export.jsonl");
		await SessionManager.exportJsonlSnapshot(manager.getSessionRef()!, path);
		expect(readFileSync(path, "utf8")).not.toContain("pr_review_binding");
		const imported = await SessionManager.importFromJsonl(path, cwd, directory, { id: randomUUID() });
		const forked = await SessionManager.forkFrom(manager.getSessionRef()!, cwd, directory);
		managers.push(imported, forked);
		expect(imported.getPrReviewBinding()).toBeUndefined();
		expect(forked.getPrReviewBinding()).toBeUndefined();
		const entry = {
			type: "pr_review_binding",
			id: "binding",
			parentId: null,
			timestamp: new Date().toISOString(),
			ordinal: 1,
			placement: manager.getPrReviewBinding(),
		};
		expect(() => validatePersistedSessionEntrySequence([entry], { snapshot: true })).toThrow("host-only");
		expect(() => validatePersistedSessionEntrySequence([entry, { ...entry, id: "duplicate", ordinal: 2 }])).toThrow(
			"more than one",
		);
	});

	it.each([
		{ workspaceGeneration: 0 },
		{ unexpected: true },
		{ cwd: "relative" },
		{ sourceRootRelativePath: "../escape" },
		{ repositoryId: "github:github.com/attacker/project" },
		{ headRepositoryId: "invalid" },
	])("rejects malformed host placement: %j", async (change) => {
		const { placement } = await fixture();
		expect(() =>
			parseSessionEntryForAdmission({
				type: "pr_review_binding",
				id: "binding",
				parentId: null,
				timestamp: new Date().toISOString(),
				placement: { ...placement, ...change },
			}),
		).toThrow();
	});

	it("pins omitted and explicit targets to the original authorized source cwd", async () => {
		const { manager, placement, prepare, capture, source, snapshot } = await fixture();
		manager.recordPrReviewBinding(placement);
		for (const target of [
			{ kind: "pr" } as const,
			{ kind: "pr", number: "414", expectedUrl: placement.pullRequest.url } as const,
		]) {
			const prepared = await prepare(target);
			expect(prepared.target).toEqual({ kind: "pr", number: "414", expectedUrl: placement.pullRequest.url });
			expect(capture).toHaveBeenLastCalledWith(
				expect.objectContaining({ cwd: source, number: "414", expectedUrl: placement.pullRequest.url }),
			);
			await snapshot.dispose();
		}
	});

	it("accepts GitHub repository casing without changing the authorized source identity", async () => {
		const { manager, placement, prepare, capture } = await fixture();
		placement.pullRequest.url = "https://github.com/Volt-HQ/Project/pull/414";
		manager.recordPrReviewBinding(placement);
		await expect(
			prepare({ kind: "pr", expectedUrl: placement.pullRequest.url.toLowerCase() }),
		).resolves.toMatchObject({ target: { expectedUrl: placement.pullRequest.url } });
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({ expectedUrl: placement.pullRequest.url }));
	});

	it.each([
		{ kind: "pr", number: "415" } as const,
		{ kind: "pr", expectedUrl: "https://github.com/attacker/project/pull/414" } as const,
	])("rejects a different explicit target without capture or inference", async (target) => {
		const { manager, placement, prepare, capture, harness } = await fixture();
		manager.recordPrReviewBinding(placement);
		harness.setResponses([fauxAssistantMessage("unused")]);
		await expect(prepare(target)).rejects.toThrow("different PR");
		expect(capture).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["dirty", "head", "untracked", "unreadable", "operation"])(
		"rejects %s checkout before capture or inference",
		async (mutation) => {
			const { manager, placement, cwd, base, prepare, capture, harness } = await fixture();
			manager.recordPrReviewBinding(placement);
			if (mutation === "dirty") writeFileSync(join(cwd, "value.txt"), "changed\n");
			if (mutation === "untracked") writeFileSync(join(cwd, "untracked.txt"), "new\n");
			if (mutation === "head") git(cwd, "checkout", "--detach", base);
			if (mutation === "unreadable") rmSync(join(cwd, ".git"));
			if (mutation === "operation")
				writeFileSync(git(cwd, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), base);
			harness.setResponses([fauxAssistantMessage("unused")]);
			await expect(prepare()).rejects.toThrow(PR_CHECKOUT_CHANGED);
			expect(capture).not.toHaveBeenCalled();
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("rechecks cleanliness after capture and disposes the snapshot before any inference", async () => {
		const { manager, placement, cwd, prepare, capture, captured, snapshot, harness } = await fixture();
		manager.recordPrReviewBinding(placement);
		capture.mockImplementationOnce(async () => {
			writeFileSync(join(cwd, "value.txt"), "changed during capture\n");
			return captured;
		});
		harness.setResponses([fauxAssistantMessage("unused")]);
		await expect(prepare()).rejects.toThrow(PR_CHECKOUT_CHANGED);
		expect(snapshot.dispose).toHaveBeenCalledOnce();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it.each(["dirty", "remote-head"])("rejects %s movement after preparation but before execution", async (mutation) => {
		const { manager, placement, cwd, source, prepare, snapshot, harness } = await fixture();
		manager.recordPrReviewBinding(placement);
		const prepared = await prepare();
		const verify = vi.spyOn(githubCliCodeHostProvider, "verifyPullRequestHead").mockResolvedValue();
		if (mutation === "dirty") writeFileSync(join(cwd, "value.txt"), "late edit\n");
		else verify.mockRejectedValue(new Error("PR head moved"));
		harness.setResponses([fauxAssistantMessage("unused")]);
		await expect(
			executeReviewWorkflow({
				prepared,
				cwd,
				agentDir: source,
				sessionManager: manager,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
			}),
		).rejects.toThrow(mutation === "dirty" ? PR_CHECKOUT_CHANGED : "PR head moved");
		expect(verify).toHaveBeenCalledWith(source, snapshot.identity.pullRequest);
		expect(snapshot.dispose).toHaveBeenCalledOnce();
		expect(harness.faux.state.callCount).toBe(0);
		expect(readFileSync(join(source, "value.txt"), "utf8")).toBe("head\n");
	});

	it("rejects a moved remote PR head instead of resetting the established checkout", async () => {
		const { manager, placement, cwd, prepare, capture, captured, base } = await fixture();
		manager.recordPrReviewBinding(placement);
		capture.mockResolvedValueOnce({ ...captured, pullRequest: { ...captured.pullRequest, headRefOid: base } });
		await expect(prepare()).rejects.toThrow(PR_CHECKOUT_CHANGED);
		expect(git(cwd, "rev-parse", "HEAD")).toBe(placement.pullRequest.headRefOid);
	});

	it("resolves official handoff aliases through the exact canonical source, never copied entries", async () => {
		const { manager, placement, cwd, directory, managers, record, prepare, root } = await fixture();
		manager.recordPrReviewBinding(placement);
		await appendReviewRunDurably(manager, record);
		const alias = await SessionManager.create(cwd, directory);
		const copied = await SessionManager.create(cwd, directory);
		managers.push(alias, copied);
		appendReviewRun(alias, record);
		appendReviewRun(copied, record);
		await alias.flush();
		await copied.flush();
		await registerReviewHandoffAliases(manager, alias, [record.runId]);
		expect(alias.getPrReviewBinding()).toBeUndefined();
		expect(await readPrReviewBinding(alias, record.runId)).toEqual(placement);
		expect(await readPrReviewBinding(alias)).toEqual(placement);
		expect(await readPrReviewBinding(copied, record.runId)).toBeUndefined();
		await expect(prepare({ kind: "pr", number: "415" }, alias)).rejects.toThrow("different PR");
		const moved = await SessionManager.open(alias.getSessionRef()!, root);
		managers.push(moved);
		await expect(readPrReviewBinding(moved, record.runId)).rejects.toMatchObject({
			code: "review_source_unavailable",
		});
	});

	it.each(["dirty", "head", "execution-dirty", "execution-remote-head"])(
		"preserves bound checkout enforcement after handoff, repeated reruns and reopen: %s",
		async (mutation) => {
			const f = await runtimeFixture();
			const { manager, placement, runtime, cwd, base, harness, capture } = f;
			manager.recordPrReviewBinding(placement);
			let record: ReviewRunRecord = {
				...f.record,
				status: "completed",
				result: {
					completionStatus: "complete",
					summary: "No findings",
					findings: [],
					overallExplanation: "No findings",
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
			await appendReviewRunDurably(manager, record);
			const original = manager.getSessionRef()!;
			// The binding must already be durable when the replacement becomes observable.
			const unsubscribe = runtime.subscribeSessionWillProject(async (session) => {
				const reader = await SessionManager.open(session.sessionRef!);
				try {
					expect(reader.getPrReviewBinding()).toEqual(placement);
				} finally {
					await reader.closePersistence();
				}
			});
			await runtime.newSession({ setup: async (target) => appendReviewRun(target, record) });
			unsubscribe();
			const target = runtime.session.sessionManager;
			expect(await resolveCanonicalReviewSource(target, record.runId)).toEqual(original);
			const prepareRerun = (sessionManager = target) =>
				prepareReviewWorkflow({
					target: { kind: "pr", number: "414", expectedUrl: placement.pullRequest.url },
					parentRunId: record.runId,
					controls: record.options,
					cwd,
					sessionManager,
					settingsManager: harness.settingsManager,
					modelRegistry: harness.session.modelRegistry,
					currentModel: harness.getModel(),
				});
			for (const index of [1, 2]) {
				const prepared = await prepareRerun();
				expect(prepared.incrementalPlan).toMatchObject({
					mode: "incremental",
					previousRun: { runId: record.runId },
				});
				record = { ...record, runId: prepared.workflowId, parentRunId: record.runId, endedAt: 2 + index };
				await appendReviewRunDurably(target, record);
				await prepared.resolution.dispose();
				expect(await resolveCanonicalReviewSource(target, record.runId)).toEqual(target.getSessionRef());
			}
			await runtime.dispose();
			const reopened = await SessionManager.open(target.getSessionRef()!);
			f.managers.push(reopened);
			expect(await readPrReviewBinding(reopened, record.runId)).toEqual(placement);
			const prepared = await prepareRerun(reopened);
			capture.mockClear();
			const verify = vi.spyOn(githubCliCodeHostProvider, "verifyPullRequestHead").mockResolvedValue();
			if (mutation.endsWith("dirty")) writeFileSync(join(cwd, "value.txt"), "late edit\n");
			else if (mutation === "head") git(cwd, "checkout", "--detach", base);
			else verify.mockRejectedValue(new Error("PR head moved"));
			if (mutation.startsWith("execution-")) {
				await expect(
					executeReviewWorkflow({
						prepared,
						cwd,
						agentDir: f.root,
						sessionManager: reopened,
						authStorage: harness.authStorage,
						modelRegistry: harness.session.modelRegistry,
						settingsManager: harness.settingsManager,
					}),
				).rejects.toThrow(mutation === "execution-remote-head" ? "PR head moved" : PR_CHECKOUT_CHANGED);
				expect(verify).toHaveBeenCalledWith(f.source, f.snapshot.identity.pullRequest);
			} else {
				await expect(prepareRerun(reopened)).rejects.toThrow(PR_CHECKOUT_CHANGED);
				await prepared.resolution.dispose();
			}
			expect(capture).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
		},
	);

	it("persists the binding through repeated General replacements without changing the canonical source", async () => {
		const { manager, placement, runtime, record } = await runtimeFixture();
		manager.recordPrReviewBinding(placement);
		await appendReviewRunDurably(manager, record);
		const original = manager.getSessionRef();
		for (const _ of [1, 2]) {
			await runtime.newSession({
				preserveReviewRunId: record.runId,
				replaceReviewGeneral: true,
				setup: async (target) => appendReviewRun(target, record),
			});
			expect(runtime.session.sessionManager.getPrReviewBinding()).toEqual(placement);
			expect(await resolveCanonicalReviewSource(runtime.session.sessionManager, record.runId)).toEqual(original);
		}
	});

	it.each(["empty", "copied", "unbound"])("leaves %s session handoffs unbound", async (kind) => {
		const { manager, placement, runtime, record } = await runtimeFixture();
		if (kind !== "unbound") manager.recordPrReviewBinding(placement);
		if (kind === "unbound") await appendReviewRunDurably(manager, record);
		await runtime.newSession({
			setup: async (target) => {
				if (kind !== "empty") appendReviewRun(target, record);
			},
		});
		expect(runtime.session.sessionManager.getPrReviewBinding()).toBeUndefined();
		expect(await readPrReviewBinding(runtime.session.sessionManager, record.runId)).toBeUndefined();
	});

	it("ignores injected Git environment and does not restrict ordinary discussion writes", async () => {
		const { manager, placement, cwd, source, prepare, harness } = await fixture();
		manager.recordPrReviewBinding(placement);
		vi.stubEnv("GIT_DIR", join(source, ".git"));
		vi.stubEnv("GIT_WORK_TREE", source);
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
		await expect(prepare()).resolves.toMatchObject({ target: { kind: "pr", number: "414" } });
		vi.unstubAllEnvs();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: join(cwd, "value.txt"), content: "discussion fix\n" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Fixed"),
		]);
		await harness.session.prompt("Fix this finding");
		expect(readFileSync(join(cwd, "value.txt"), "utf8")).toBe("discussion fix\n");
		await expect(prepare()).rejects.toThrow(PR_CHECKOUT_CHANGED);
	});

	it("leaves unbound PR and non-PR preparation behavior unchanged", async () => {
		const { manager, placement, cwd, prepare, capture, resolve } = await fixture();
		await prepare();
		expect(capture).toHaveBeenLastCalledWith(expect.objectContaining({ cwd, number: undefined }));
		manager.recordPrReviewBinding(placement);
		writeFileSync(join(cwd, "value.txt"), "dirty\n");
		await expect(prepare({ kind: "uncommitted" })).resolves.toMatchObject({ target: { kind: "uncommitted" } });
		expect(resolve).toHaveBeenLastCalledWith(
			{ kind: "uncommitted" },
			cwd,
			expect.objectContaining({ codeHostProvider: undefined }),
		);
	});
});
