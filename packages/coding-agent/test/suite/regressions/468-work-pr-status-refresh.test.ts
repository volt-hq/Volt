import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestStatusOutcome,
	CodeHostPullRequestStatusProvider,
	CodeHostPullRequestStatusRequest,
} from "../../../src/core/code-host/types.ts";
import { type WorkAssociationObservation, WorkAssociationService } from "../../../src/daemon/work-association.ts";
import { WorkStateStore } from "../../../src/daemon/work-state.ts";
import { createHarness, type Harness } from "../harness.ts";

const FEATURE_OID = "0123456789abcdef0123456789abcdef01234567";
const MAIN_OID = "abcdef0123456789abcdef0123456789abcdef01";
const REPOSITORY = {
	providerId: "github",
	host: "github.com",
	owner: "volt-hq",
	name: "volt-app",
	canonicalId: "github:github.com/volt-hq/volt-app",
};

/** Head-branch discovery that always finds PR #340 as open. */
const discoveryProvider: CodeHostPullRequestDiscoveryProvider = {
	id: "github",
	async discoverPullRequest(): Promise<CodeHostPullRequestDiscoveryOutcome> {
		return {
			state: "resolved",
			pullRequest: {
				providerId: "github",
				repository: REPOSITORY,
				headRepository: REPOSITORY,
				number: 340,
				title: "fix(work): running indicator",
				status: "open",
				headBranch: "fix/work-running-orange",
				matchedHeadOid: FEATURE_OID,
			},
		};
	},
};

/** GitHub as seen by the batched status query: PRs are open until merged. */
class GitHubStatus implements CodeHostPullRequestStatusProvider {
	readonly id = "github";
	readonly requests: CodeHostPullRequestStatusRequest[] = [];
	readonly merged = new Set<number>();

	async refreshPullRequestStatuses(
		request: CodeHostPullRequestStatusRequest,
	): Promise<CodeHostPullRequestStatusOutcome[]> {
		this.requests.push(request);
		return request.pullRequests.map((pullRequest) => ({
			state: "resolved",
			status: this.merged.has(pullRequest.number) ? "merged" : "open",
			title: "fix(work): running indicator",
		}));
	}
}

let harness: Harness;
let now: number;

function observation(branch: string, headOid: string): WorkAssociationObservation {
	return {
		workspaceName: "volt-app",
		workspaceGeneration: 1,
		sessionId: "session-340",
		cwd: harness.tempDir,
		commonGitDir: join(harness.tempDir, ".git"),
		repositoryDisplayName: "volt-app",
		branch,
		headOid,
		trusted: true,
	};
}

async function openService(status: GitHubStatus): Promise<{ store: WorkStateStore; service: WorkAssociationService }> {
	const store = new WorkStateStore({ path: join(harness.tempDir, "daemon", "work-state.json"), now: () => now });
	await store.load();
	const service = new WorkAssociationService({
		store,
		discoveryProvider,
		statusProvider: status,
		statusCwd: harness.tempDir,
		now: () => now,
	});
	return { store, service };
}

async function waitFor(condition: () => boolean): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > 3000) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function pullRequestStatus(service: WorkAssociationService): string | undefined {
	const context = service.getWorkContext("volt-app", 1, "session-340");
	return context?.resolutionState === "resolved" ? context.pullRequest.status : undefined;
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	now = 1_000_000;
});

afterEach(async () => {
	await harness.cleanupAsync();
});

describe("#468 Work PR status refresh", () => {
	it("refreshes a merged PR after the session switches to main", async () => {
		const status = new GitHubStatus();
		const { service } = await openService(status);
		service.start();
		await service.observe(observation("fix/work-running-orange", FEATURE_OID));
		expect(service.getWorkContext("volt-app", 1, "session-340")).toMatchObject({
			pullRequest: { number: 340, status: "open", stale: false },
		});

		status.merged.add(340);
		now += 20_000;
		await service.observe(observation("main", MAIN_OID));
		await waitFor(() => pullRequestStatus(service) === "merged");
		expect(service.getWorkContext("volt-app", 1, "session-340")).toMatchObject({
			branch: "fix/work-running-orange",
			pullRequest: { number: 340, status: "merged", stale: false },
		});
		expect(status.requests.at(-1)).toMatchObject({
			host: "github.com",
			pullRequests: [{ owner: "volt-hq", name: "volt-app", number: 340 }],
		});
		await service.close();
	});

	it("refreshes a merged PR after the session runtime ends", async () => {
		const status = new GitHubStatus();
		const { service } = await openService(status);
		service.start();
		await service.observe(observation("fix/work-running-orange", FEATURE_OID));

		status.merged.add(340);
		now += 20_000;
		await service.retireSession("volt-app", 1, "session-340");
		await waitFor(() => pullRequestStatus(service) === "merged");
		expect(service.getWorkContext("volt-app", 1, "session-340")).toMatchObject({
			pullRequest: { status: "merged", stale: false },
		});
		await service.close();
	});

	it("refreshes a stored PR after a daemon restart without any session observation", async () => {
		const before = await openService(new GitHubStatus());
		await before.service.observe(observation("fix/work-running-orange", FEATURE_OID));
		await before.service.observe(observation("main", MAIN_OID));
		await before.service.close();

		now += 20 * 24 * 60 * 60_000;
		const status = new GitHubStatus();
		status.merged.add(340);
		const after = await openService(status);
		expect(after.service.getWorkContext("volt-app", 1, "session-340")).toMatchObject({
			pullRequest: { status: "open", stale: true },
		});
		expect(status.requests).toHaveLength(0);

		after.service.start();
		await waitFor(() => pullRequestStatus(after.service) === "merged");
		expect(after.service.getWorkContext("volt-app", 1, "session-340")).toMatchObject({
			pullRequest: { status: "merged", stale: false },
		});
		expect(status.requests).toHaveLength(1);
		await after.service.close();

		const reopened = new WorkStateStore({ path: join(harness.tempDir, "daemon", "work-state.json") });
		await reopened.load();
		expect(reopened.getWorkContext("volt-app", 1, "session-340", now)).toMatchObject({
			pullRequest: { status: "merged" },
		});
		await reopened.close();
	});
});
