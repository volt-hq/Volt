import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCodeHostIdentity } from "../src/core/code-host/identity.ts";
import {
	type CanonicalCodeHostRepository,
	type CodeHostProvider,
	githubCliCodeHostProvider,
	type ResolvedPullRequestCheckout,
	type ReviewCodeHostContextCaptureOptions,
	type ReviewCodeHostPublishRequest,
	type ReviewPullRequestIdentity,
	registerCodeHostProvider,
	resolveCodeHostProvider,
} from "../src/core/code-host/index.ts";
import { parsePrReviewLaunches } from "../src/core/pr-review-placement.ts";
import { probeCurrentBranchPullRequest } from "../src/core/review.ts";
import { publishReviewRun } from "../src/core/review-publish.ts";
import { resolveReviewSnapshot } from "../src/core/review-snapshot.ts";
import type { ReviewRunRecord } from "../src/core/review-state.ts";
import { parseSessionEntryForAdmission } from "../src/core/session-entry-codec.ts";

const PULL_REQUEST_URL = "https://code.example.test/acme/widgets/pr/5";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
	root: string;
	repository: string;
	remoteUrl: string;
	baseOid: string;
	headOid: string;
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "volt-code-host-registry-"));
	const remote = join(root, "remote.git");
	mkdirSync(remote);
	git(remote, "init", "--bare", "--initial-branch=main");
	const repository = join(root, "work");
	mkdirSync(repository);
	git(repository, "init", "--initial-branch=main");
	git(repository, "config", "user.email", "review@example.test");
	git(repository, "config", "user.name", "Review Test");
	git(repository, "config", "commit.gpgsign", "false");
	writeFileSync(join(repository, "value.txt"), "base\n");
	git(repository, "add", "value.txt");
	git(repository, "commit", "-m", "base");
	git(repository, "remote", "add", "origin", remote);
	git(repository, "push", "origin", "main");
	const baseOid = git(repository, "rev-parse", "HEAD");
	git(repository, "checkout", "-b", "topic");
	writeFileSync(join(repository, "value.txt"), "head\n");
	git(repository, "commit", "-am", "head");
	git(repository, "push", "-u", "origin", "topic");
	const headOid = git(repository, "rev-parse", "HEAD");
	return { root, repository, remoteUrl: git(repository, "remote", "get-url", "origin"), baseOid, headOid };
}

const REPOSITORY: CanonicalCodeHostRepository = {
	providerId: "test-host",
	host: "code.example.test",
	path: "acme/widgets",
	canonicalId: "test-host:code.example.test/acme/widgets",
};

function createProvider(fixture: Fixture) {
	const pullRequest: ReviewPullRequestIdentity = {
		providerId: "test-host",
		number: 5,
		title: "Change value",
		body: "",
		url: PULL_REQUEST_URL,
		baseRefName: "main",
		headRefName: "topic",
		baseRefOid: fixture.baseOid,
		headRefOid: fixture.headOid,
	};
	const fetchPlan = {
		remote: "origin",
		remoteUrl: fixture.remoteUrl,
		base: { remoteRef: "refs/heads/main", localRef: "refs/review/base" },
		head: { remoteRef: "refs/heads/topic", localRef: "refs/review/head" },
		diffCommand: "test-host diff 5",
	};
	const capture = vi.fn(async (_options: ReviewCodeHostContextCaptureOptions) => ({
		ok: true as const,
		pullRequest,
		fetchPlan,
		context: {
			manifest: {
				status: "complete" as const,
				capturedAt: new Date(0).toISOString(),
				linkedIssueCount: 0,
				discussionEntryCount: 0,
				renderedLinkedIssueCount: 0,
				renderedDiscussionEntryCount: 0,
				renderedBytes: 0,
				limitations: [],
				fingerprint: "f".repeat(64),
			},
			linkedIssues: [],
			discussionEntries: [],
			rendered: "",
		},
	}));
	const verify = vi.fn(async (_cwd: string, _pullRequest: ReviewPullRequestIdentity, _options?: object) => {});
	const publish = vi.fn(async (_request: ReviewCodeHostPublishRequest) => ({ reviewId: 7 }));
	const provider: CodeHostProvider = {
		id: "test-host",
		displayName: "Test Host",
		canonicalizeRemoteUrl: (url) => (url === fixture.remoteUrl ? REPOSITORY : null),
		isCanonicalPullRequestCheckout: (checkout, repositoryId) =>
			checkout.url === PULL_REQUEST_URL && repositoryId === REPOSITORY.canonicalId,
		probeCurrentPullRequest: async () => ({ number: 5, title: pullRequest.title, url: PULL_REQUEST_URL }),
		resolvePullRequestCheckout: async () => ({ ok: false, error: "unused" }),
		capturePullRequestContext: capture,
		capturePullRequestIdentity: async () => ({ ok: true, pullRequest, fetchPlan }),
		verifyPullRequestHead: verify,
		publishPullRequestReview: publish,
	};
	return { provider, pullRequest, capture, verify, publish };
}

function completedRun(pullRequest: ReviewPullRequestIdentity): ReviewRunRecord {
	return {
		schemaVersion: 1,
		runId: "review:registry",
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #5",
			diffCommand: "test-host diff 5",
			identity: { kind: "pr", baseTree: "base-tree", headTree: "head-tree", pullRequest },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "No findings.",
			findings: [],
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
			overallCorrectness: "correct",
			overallExplanation: "Nothing to report.",
		},
	};
}

function checkoutPullRequest(): ResolvedPullRequestCheckout["pullRequest"] {
	return {
		provider: "test-host",
		url: PULL_REQUEST_URL,
		number: 5,
		title: "Change value",
		repository: "acme/widgets",
		headRefName: "topic",
		headRefOid: "b".repeat(40),
	};
}

function placement(root: string) {
	return {
		workspaceName: "widgets",
		workspaceGeneration: 1,
		worktreeId: "review-test",
		cwd: join(root, "review"),
		sourceCwd: join(root, "work"),
		commonDirectory: join(root, "work", ".git"),
		pullRequest: checkoutPullRequest(),
		repositoryId: REPOSITORY.canonicalId,
		headRepositoryId: REPOSITORY.canonicalId,
		remote: "origin",
	};
}

describe("code-host provider registry", () => {
	let fixture: Fixture;
	const cleanups: Array<() => unknown> = [];

	beforeEach(() => {
		fixture = createFixture();
		cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
	});

	afterEach(async () => {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
		vi.restoreAllMocks();
	});

	it("keeps built-in provider and identity rules aligned", () => {
		expect(findCodeHostIdentity(githubCliCodeHostProvider.id)?.isCanonicalPullRequestCheckout).toBe(
			githubCliCodeHostProvider.isCanonicalPullRequestCheckout,
		);
	});

	it("reports remotes no registered provider recognizes", async () => {
		await expect(resolveCodeHostProvider({ cwd: fixture.repository })).resolves.toMatchObject({
			ok: false,
			error: "The review remote is not a supported credential-free GitHub URL. Check its configuration on the host.",
		});
		const { provider } = createProvider(fixture);
		cleanups.push(registerCodeHostProvider(provider));
		git(fixture.repository, "remote", "set-url", "origin", "https://code.example.test/acme/_git/widgets");
		await expect(resolveCodeHostProvider({ cwd: fixture.repository, number: "5" })).resolves.toMatchObject({
			ok: false,
			error: "The review remote is not a supported credential-free GitHub or Test Host URL. Check its configuration on the host.",
		});
	});

	it("rejects duplicate provider ids", () => {
		const { provider } = createProvider(fixture);
		expect(() => registerCodeHostProvider({ ...provider, id: "github" })).toThrow("already registered");
	});

	it("selects the provider that recognizes the tracked and numbered review remote", async () => {
		const { provider } = createProvider(fixture);
		cleanups.push(registerCodeHostProvider(provider));
		for (const number of [undefined, "5"]) {
			const resolved = await resolveCodeHostProvider({ cwd: fixture.repository, number });
			expect(resolved.ok && resolved.provider).toBe(provider);
		}
	});

	it("routes probe, snapshot capture, and publish through a registered provider", async () => {
		const { provider, pullRequest, capture, verify, publish } = createProvider(fixture);
		cleanups.push(registerCodeHostProvider(provider));
		const githubCapture = vi.spyOn(githubCliCodeHostProvider, "capturePullRequestContext");

		await expect(probeCurrentBranchPullRequest(fixture.repository)).resolves.toEqual({
			number: 5,
			title: "Change value",
			url: PULL_REQUEST_URL,
		});

		const snapshot = await resolveReviewSnapshot({ kind: "pr", number: "5" }, fixture.repository, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: 2_147_483_647,
		});
		if ("error" in snapshot) throw new Error(snapshot.error);
		cleanups.push(() => snapshot.dispose());
		expect(capture).toHaveBeenCalledWith(expect.objectContaining({ number: "5" }));
		expect(githubCapture).not.toHaveBeenCalled();
		expect(snapshot.diffCommand).toBe("test-host diff 5");
		expect(snapshot.identity.pullRequest).toMatchObject({ providerId: "test-host", headRefOid: fixture.headOid });
		expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["value.txt"]);

		await expect(publishReviewRun(fixture.repository, completedRun(pullRequest))).resolves.toMatchObject({
			reviewId: 7,
		});
		expect(verify.mock.calls.map((call) => call.slice(0, 2))).toEqual([[fixture.repository, pullRequest]]);
		expect(publish).toHaveBeenCalledWith(expect.objectContaining({ pullRequest }));
	});

	it("validates persisted placements with the owning provider's identity rules", () => {
		const { provider } = createProvider(fixture);
		const binding = {
			type: "pr_review_binding",
			id: "binding",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			placement: placement(fixture.root),
		};
		const launch = {
			sessionId: "review-test",
			requestFingerprint: "a".repeat(64),
			placement: placement(fixture.root),
			disposition: "created",
		};
		expect(() => parseSessionEntryForAdmission(binding)).toThrow("unsupported provider");
		expect(() => parsePrReviewLaunches([launch])).toThrow("Invalid PR review worktree launch metadata");

		const unregister = registerCodeHostProvider(provider);
		cleanups.push(unregister);
		expect(parseSessionEntryForAdmission(binding)).toMatchObject({
			placement: { repositoryId: REPOSITORY.canonicalId },
		});
		expect(parsePrReviewLaunches([launch])).toHaveLength(1);
		expect(() =>
			parseSessionEntryForAdmission({
				...binding,
				placement: { ...binding.placement, repositoryId: "test-host:code.example.test/attacker/widgets" },
			}),
		).toThrow("inconsistent canonical repository identity");

		unregister();
		expect(() => parsePrReviewLaunches([launch])).toThrow("Invalid PR review worktree launch metadata");
	});
});
