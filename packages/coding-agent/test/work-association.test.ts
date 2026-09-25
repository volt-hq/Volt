import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	CanonicalCodeHostRepository,
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryProvider,
	CodeHostPullRequestDiscoveryRequest,
	CodeHostPullRequestStatus,
	CodeHostPullRequestStatusOutcome,
	CodeHostPullRequestStatusProvider,
	CodeHostPullRequestStatusRequest,
} from "../src/core/code-host/types.ts";
import { isExactTuiWorkObservationLeaseHolder } from "../src/daemon/iroh-service.ts";
import { WorkAssociationService } from "../src/daemon/work-association.ts";
import {
	parseWorkState,
	WORK_STATE_MAX_BYTES,
	WORK_STATE_MAX_REPOSITORIES,
	type WorkBindingMutationResult,
	WorkStateStore,
} from "../src/daemon/work-state.ts";

const OID_A = "0123456789abcdef0123456789abcdef01234567";
const OID_B = "abcdef0123456789abcdef0123456789abcdef01";
const PR_REPOSITORY = { host: "github.com", owner: "volt-hq", name: "volt" };
const tempDirectories: string[] = [];

function tempDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `${label}-`));
	tempDirectories.push(directory);
	return directory;
}

function statePath(label: string): string {
	return join(tempDirectory(label), "daemon", "work-state.json");
}

function repository(owner: string, name: string): CanonicalCodeHostRepository {
	return {
		providerId: "github",
		host: "github.com",
		owner,
		name,
		canonicalId: `github:github.com/${owner}/${name}`,
	};
}

function resolved(
	number = 42,
	status: "open" | "draft" | "merged" | "closed" = "open",
): Extract<CodeHostPullRequestDiscoveryOutcome, { state: "resolved" }> {
	return {
		state: "resolved",
		pullRequest: {
			providerId: "github",
			repository: repository("volt-hq", "volt"),
			headRepository: repository("contributor", "fork"),
			number,
			title: `PR ${number}`,
			status,
			headBranch: "feature/work",
			matchedHeadOid: OID_A,
		},
	};
}

class FakeDiscoveryProvider implements CodeHostPullRequestDiscoveryProvider {
	readonly id = "fake";
	readonly requests: CodeHostPullRequestDiscoveryRequest[] = [];
	outcome: CodeHostPullRequestDiscoveryOutcome = { state: "none" };
	resolver?: (request: CodeHostPullRequestDiscoveryRequest) => Promise<CodeHostPullRequestDiscoveryOutcome>;
	active = 0;
	maxActive = 0;

	async discoverPullRequest(
		request: CodeHostPullRequestDiscoveryRequest,
	): Promise<CodeHostPullRequestDiscoveryOutcome> {
		this.requests.push(request);
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		try {
			return this.resolver ? await this.resolver(request) : this.outcome;
		} finally {
			this.active--;
		}
	}
}

class FakeStatusProvider implements CodeHostPullRequestStatusProvider {
	readonly id = "github";
	readonly requests: CodeHostPullRequestStatusRequest[] = [];
	readonly statuses = new Map<number, CodeHostPullRequestStatus>();
	resolver?: (request: CodeHostPullRequestStatusRequest) => Promise<CodeHostPullRequestStatusOutcome[]>;

	async refreshPullRequestStatuses(
		request: CodeHostPullRequestStatusRequest,
	): Promise<CodeHostPullRequestStatusOutcome[]> {
		this.requests.push(request);
		if (this.resolver) return this.resolver(request);
		return request.pullRequests.map((pullRequest) => ({
			state: "resolved",
			status: this.statuses.get(pullRequest.number) ?? "open",
			title: `PR ${pullRequest.number}`,
		}));
	}
}

function observation(
	overrides: Partial<{
		workspaceName: string;
		workspaceGeneration: number;
		sessionId: string;
		cwd: string;
		commonGitDir: string;
		repositoryDisplayName: string;
		branch: string;
		headOid: string;
		trusted: boolean;
		baseBranches: readonly string[];
	}> = {},
) {
	return {
		workspaceName: overrides.workspaceName ?? "volt",
		workspaceGeneration: overrides.workspaceGeneration ?? 1,
		sessionId: overrides.sessionId ?? "session-a",
		cwd: overrides.cwd ?? "/workspace/volt",
		commonGitDir: overrides.commonGitDir ?? "/workspace/volt/.git",
		repositoryDisplayName: overrides.repositoryDisplayName ?? "Volt",
		branch: overrides.branch ?? "feature/work",
		headOid: overrides.headOid ?? OID_A,
		trusted: overrides.trusted ?? true,
		...(overrides.baseBranches === undefined ? {} : { baseBranches: overrides.baseBranches }),
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function statusFixture(label: string) {
	const store = new WorkStateStore({ path: statePath(label), writeStateFile: async () => {} });
	await store.load();
	const discovery = new FakeDiscoveryProvider();
	discovery.outcome = resolved(42);
	const status = new FakeStatusProvider();
	const service = new WorkAssociationService({
		store,
		discoveryProvider: discovery,
		statusProvider: status,
		statusCwd: "/neutral",
	});
	return { store, discovery, status, service };
}

/** Resolve a PR on its branch, then switch the session to `main`, as after a merge. */
async function linkOffBranch(
	service: WorkAssociationService,
	overrides: Parameters<typeof observation>[0] = {},
): Promise<void> {
	await service.observe(observation(overrides));
	await service.observe(observation({ ...overrides, branch: "main", headOid: OID_B }));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

interface WorkStateFixtureChange {
	id: string;
	updatedAt: number;
	resolutionState?: "resolved" | "none";
	status?: "open" | "draft" | "merged" | "closed";
	number?: number;
	/** Session ids bound to this change; defaults to one session named after the change. */
	boundSessions?: string[];
}

/** Write a strict Work state file directly so unbound and terminal changes can be expressed. */
function writeWorkStateFixture(path: string, changes: WorkStateFixtureChange[]): void {
	mkdirSync(join(path, ".."), { recursive: true });
	const state = {
		version: 1,
		repositoryHashSalt: "a".repeat(64),
		repositories: [
			{
				id: "repository",
				workspaceName: "volt",
				workspaceGeneration: 1,
				commonGitDirHash: "b".repeat(64),
				displayName: "Volt",
				updatedAt: 1,
			},
		],
		changes: changes.map((change) => ({
			id: change.id,
			repositoryId: "repository",
			branch: `feature/${change.id}`,
			headOid: OID_A,
			baseBranch: false,
			resolutionState: change.resolutionState ?? "resolved",
			...((change.resolutionState ?? "resolved") === "resolved"
				? {
						pullRequest: {
							provider: "github",
							repository: PR_REPOSITORY,
							number: change.number ?? 1,
							title: `PR ${change.id}`,
							status: change.status ?? "open",
							matchedHeadOid: OID_A,
						},
					}
				: {}),
			checkedAt: 100,
			nextRefreshAt: 1000,
			failureCount: 2,
			lastRefreshSucceeded: true,
			updatedAt: change.updatedAt,
		})),
		bindings: changes.flatMap((change) =>
			(change.boundSessions ?? [change.id]).map((sessionId) => ({
				workspaceName: "volt",
				workspaceGeneration: 1,
				sessionId,
				bindingGeneration: 1,
				repositoryId: "repository",
				changeId: change.id,
				observedRepositoryId: "repository",
				observedBranch: `feature/${change.id}`,
				observedHeadOid: OID_A,
				updatedAt: change.updatedAt,
			})),
		),
	};
	writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

afterEach(() => {
	vi.useRealTimers();
	while (tempDirectories.length > 0) {
		rmSync(tempDirectories.pop()!, { recursive: true, force: true });
	}
});

describe("WorkStateStore", () => {
	it("persists owner-only bounded state without checkout paths and reloads it", async () => {
		const path = statePath("work-state-reload");
		const store = new WorkStateStore({ path });
		await store.load();
		const binding = await store.bindObservation({
			...observation(),
			baseBranch: false,
			now: 100,
		});
		await store.applyDiscovery(
			binding.fence,
			{
				state: "resolved",
				pullRequest: {
					provider: "github",
					repository: PR_REPOSITORY,
					number: 42,
					title: "Exact PR",
					status: "open",
					matchedHeadOid: OID_A,
				},
			},
			{ now: 101, nextRefreshAt: 1000, refreshSucceeded: true },
		);
		await store.close();

		if (process.platform !== "win32") {
			expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		const serialized = readFileSync(path, "utf8");
		expect(serialized).not.toContain("/workspace/volt");
		expect(serialized).not.toContain(".git");
		expect(serialized).not.toContain("github:github.com");

		const reopened = new WorkStateStore({ path });
		await reopened.load();
		expect(reopened.getWorkContext("volt", 1, "session-a", 200)).toMatchObject({
			changeId: binding.change.id,
			repository: "Volt",
			branch: "feature/work",
			resolutionState: "resolved",
			pullRequest: { number: 42, title: "Exact PR", stale: false },
		});
		await reopened.close();
	});

	it("backs up malformed and oversized state and regenerates a strict empty file", async () => {
		const path = statePath("work-state-corrupt");
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "{malformed", { mode: 0o666 });
		chmodSync(path, 0o666);
		let now = 123;
		const store = new WorkStateStore({ path, now: () => now });
		const loaded = await store.load();
		expect(loaded.corruptBackupPath).toBe(`${path}.corrupt-123`);
		expect(loaded.state.repositories).toEqual([]);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(() =>
			parseWorkState({
				...loaded.state,
				repositories: Array.from({ length: WORK_STATE_MAX_REPOSITORIES + 1 }, () => ({})),
			}),
		).toThrow(/invalid|unsupported/i);
		now++;
		await store.close();
	});

	it("resets persisted resolved pull requests that lack their repository", async () => {
		const path = statePath("work-state-missing-repository");
		const store = new WorkStateStore({ path });
		await store.load();
		const binding = await store.bindObservation({ ...observation(), baseBranch: false, now: 100 });
		await store.applyDiscovery(
			binding.fence,
			{
				state: "resolved",
				pullRequest: {
					provider: "github",
					repository: PR_REPOSITORY,
					number: 42,
					title: "Exact PR",
					status: "open",
					matchedHeadOid: OID_A,
				},
			},
			{ now: 101, nextRefreshAt: 1000, refreshSucceeded: true },
		);
		await store.close();
		const persisted = JSON.parse(readFileSync(path, "utf8")) as {
			changes: Array<{ pullRequest?: Record<string, unknown> }>;
		};
		expect(persisted.changes[0]?.pullRequest?.repository).toEqual(PR_REPOSITORY);
		delete persisted.changes[0]!.pullRequest!.repository;
		writeFileSync(path, JSON.stringify(persisted), { mode: 0o600 });

		const reopened = new WorkStateStore({ path, now: () => 500 });
		const loaded = await reopened.load();
		expect(loaded.corruptBackupPath).toBe(`${path}.corrupt-500`);
		expect(loaded.state.changes).toEqual([]);
		expect(reopened.getWorkContext("volt", 1, "session-a")).toBeUndefined();
		await reopened.close();
	});

	it("trims by serialized bytes while retaining the successful mutation", async () => {
		const path = statePath("work-state-byte-trim");
		let persisted = "";
		const store = new WorkStateStore({
			path,
			writeStateFile: async (_path, content) => {
				persisted = content;
			},
		});
		await store.load();
		const workspaceName = "\u0001界".repeat(128);
		const repositoryDisplayName = "界\u0001".repeat(128);
		const boundedUniqueValue = (maximum: number, index: number): string => {
			const suffix = `-${index}`;
			return `${"\u0001界".repeat(maximum).slice(0, maximum - suffix.length)}${suffix}`;
		};
		let oldestSessionId = "";
		let latestSessionId = "";
		let latestChangeId = "";
		let latestRepositoryId = "";
		let latestResult: WorkBindingMutationResult | undefined;
		let evictionObserved = false;

		for (let index = 0; index < 1000; index++) {
			latestSessionId = boundedUniqueValue(128, index);
			const result = await store.bindObservation({
				workspaceName,
				workspaceGeneration: 1,
				sessionId: latestSessionId,
				commonGitDir: "/workspace/volt/.git",
				repositoryDisplayName,
				branch: boundedUniqueValue(1024, index),
				headOid: OID_A,
				baseBranch: false,
				now: 1,
			});
			if (index === 0) oldestSessionId = latestSessionId;
			latestChangeId = result.change.id;
			latestRepositoryId = result.repository.id;
			latestResult = result;
			const parsed = parseWorkState(JSON.parse(persisted) as unknown);
			if (!parsed.bindings.some((binding) => binding.sessionId === oldestSessionId)) {
				evictionObserved = true;
				break;
			}
		}

		expect(evictionObserved).toBe(true);
		expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(WORK_STATE_MAX_BYTES);
		const persistedState = parseWorkState(JSON.parse(persisted) as unknown);
		const latestBinding = persistedState.bindings.find((binding) => binding.sessionId === latestSessionId);
		expect(latestBinding).toMatchObject({
			changeId: latestChangeId,
			repositoryId: latestRepositoryId,
			observedRepositoryId: latestRepositoryId,
		});
		expect(persistedState.changes.some((change) => change.id === latestChangeId)).toBe(true);
		expect(persistedState.repositories.some((repository) => repository.id === latestRepositoryId)).toBe(true);
		if (!latestResult) throw new Error("expected a retained Work mutation result");

		expect(
			await store.applyDiscovery(
				latestResult.fence,
				{
					state: "resolved",
					pullRequest: {
						provider: "github",
						repository: PR_REPOSITORY,
						number: 42,
						title: "\u0001界".repeat(256),
						status: "open",
						matchedHeadOid: OID_A,
					},
				},
				{ now: 1, nextRefreshAt: 2, refreshSucceeded: true },
			),
		).toBe(true);
		const crossRepository = await store.bindObservation({
			workspaceName,
			workspaceGeneration: 1,
			sessionId: latestSessionId,
			commonGitDir: "/workspace/other/.git",
			repositoryDisplayName,
			branch: boundedUniqueValue(1024, 1001),
			headOid: OID_B,
			baseBranch: false,
			now: 1,
		});
		expect(crossRepository.binding.repositoryId).toBe(latestRepositoryId);
		expect(crossRepository.binding.observedRepositoryId).toBe(crossRepository.repository.id);
		expect(crossRepository.repository.id).not.toBe(latestRepositoryId);

		const inheritedSessionId = boundedUniqueValue(128, 1002);
		expect(
			await store.inheritSessionBinding({
				workspaceName,
				workspaceGeneration: 1,
				sourceSessionId: latestSessionId,
				targetSessionId: inheritedSessionId,
				now: 1,
			}),
		).toBe(true);
		const finalState = parseWorkState(JSON.parse(persisted) as unknown);
		expect(finalState.bindings.find((binding) => binding.sessionId === inheritedSessionId)).toMatchObject({
			changeId: latestChangeId,
			repositoryId: latestRepositoryId,
			observedRepositoryId: crossRepository.repository.id,
		});
		expect(finalState.repositories.some((repository) => repository.id === latestRepositoryId)).toBe(true);
		expect(finalState.repositories.some((repository) => repository.id === crossRepository.repository.id)).toBe(true);
		expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(WORK_STATE_MAX_BYTES);

		writeFileSync(path, persisted, { mode: 0o600 });
		await store.close();
		const reopened = new WorkStateStore({ path });
		await reopened.load();
		expect(reopened.getBinding(workspaceName, 1, inheritedSessionId)).toMatchObject({ changeId: latestChangeId });
		await reopened.close();
	});

	it("shares feature changes, isolates base branches, and rebinds unresolved branch moves", async () => {
		const store = new WorkStateStore({ path: statePath("work-state-binding") });
		await store.load();
		const featureA = await store.bindObservation({ ...observation({ sessionId: "a" }), baseBranch: false, now: 1 });
		const featureB = await store.bindObservation({ ...observation({ sessionId: "b" }), baseBranch: false, now: 2 });
		expect(featureB.change.id).toBe(featureA.change.id);

		const baseA = await store.bindObservation({
			...observation({ sessionId: "base-a", branch: "main" }),
			baseBranch: true,
			now: 3,
		});
		const baseB = await store.bindObservation({
			...observation({ sessionId: "base-b", branch: "main" }),
			baseBranch: true,
			now: 4,
		});
		expect(baseB.change.id).not.toBe(baseA.change.id);

		const moved = await store.bindObservation({
			...observation({ sessionId: "a", branch: "feature/moved", headOid: OID_B }),
			baseBranch: false,
			now: 5,
		});
		expect(moved.change.id).not.toBe(featureA.change.id);
		expect(moved.binding.bindingGeneration).toBe(2);
		await store.close();
	});

	it("lists bound open and draft pull requests as the watch set, newest first and bounded", async () => {
		const path = statePath("work-state-watch-set");
		writeWorkStateFixture(path, [
			{ id: "open", updatedAt: 10, number: 1 },
			{ id: "shared", updatedAt: 20, number: 2, boundSessions: ["shared-a", "shared-b"] },
			{ id: "draft", updatedAt: 30, number: 3, status: "draft" },
			{ id: "merged", updatedAt: 40, number: 4, status: "merged" },
			{ id: "closed", updatedAt: 50, number: 5, status: "closed" },
			{ id: "unbound", updatedAt: 60, number: 6, boundSessions: [] },
			{ id: "unresolved", updatedAt: 70, resolutionState: "none" },
		]);
		const store = new WorkStateStore({ path });
		expect((await store.load()).corruptBackupPath).toBeUndefined();

		expect(store.listWatchedPullRequests(10).map((entry) => entry.changeId)).toEqual(["draft", "shared", "open"]);
		expect(store.listWatchedPullRequests(2).map((entry) => entry.changeId)).toEqual(["draft", "shared"]);
		expect(store.listWatchedPullRequests(10)[0]).toEqual({
			changeId: "draft",
			checkedAt: 100,
			provider: "github",
			number: 3,
			repository: PR_REPOSITORY,
		});
		await store.close();
	});

	it("applies fenced batched status results without touching discovery backoff", async () => {
		const path = statePath("work-state-apply-statuses");
		writeWorkStateFixture(path, [
			{ id: "open", updatedAt: 10, number: 1 },
			{ id: "draft", updatedAt: 20, number: 2, status: "draft" },
			{ id: "moved", updatedAt: 30, number: 3 },
			{ id: "merged", updatedAt: 40, number: 4, status: "merged" },
		]);
		let writes = 0;
		const store = new WorkStateStore({
			path,
			writeStateFile: async () => {
				writes++;
			},
		});
		await store.load();
		const watched = new Map(store.listWatchedPullRequests(10).map((entry) => [entry.changeId, entry]));
		expect(await store.applyPullRequestStatuses([], { now: 500, nextRefreshAt: 2000 })).toEqual([]);
		expect(writes).toBe(0);

		const changed = await store.applyPullRequestStatuses(
			[
				{ ...watched.get("open")!, outcome: { state: "resolved", status: "merged", title: "Renamed" } },
				{
					...watched.get("draft")!,
					checkedAt: 99,
					outcome: { state: "resolved", status: "merged", title: "Stale snapshot" },
				},
				{
					...watched.get("moved")!,
					repository: { ...PR_REPOSITORY, owner: "someone-else" },
					outcome: { state: "resolved", status: "closed", title: "Wrong repository" },
				},
				{
					changeId: "merged",
					checkedAt: 100,
					provider: "github",
					number: 4,
					repository: PR_REPOSITORY,
					outcome: { state: "resolved", status: "open", title: "Reopened" },
				},
			],
			{ now: 500, nextRefreshAt: 2000 },
		);
		expect(changed).toEqual(["open"]);
		expect(writes).toBe(1);
		expect(store.getChange("open")).toMatchObject({
			checkedAt: 500,
			nextRefreshAt: 2000,
			lastRefreshSucceeded: true,
			failureCount: 2,
			updatedAt: 10,
			headOid: OID_A,
			pullRequest: { status: "merged", title: "Renamed" },
		});
		expect(store.getChange("draft")).toMatchObject({
			checkedAt: 100,
			pullRequest: { status: "draft", title: "PR draft" },
		});
		expect(store.getChange("moved")).toMatchObject({ checkedAt: 100, pullRequest: { status: "open" } });
		expect(store.getChange("merged")).toMatchObject({ checkedAt: 100, pullRequest: { status: "merged" } });
		expect(store.listWatchedPullRequests(10).map((entry) => entry.changeId)).toEqual(["moved", "draft"]);
		expect(store.getWorkContext("volt", 1, "open", 1999)).toMatchObject({
			pullRequest: { status: "merged", stale: false },
		});
		expect(store.getWorkContext("volt", 1, "open", 2000)).toMatchObject({ pullRequest: { stale: true } });

		expect(
			await store.applyPullRequestStatuses(
				[{ ...watched.get("moved")!, outcome: { state: "resolved", status: "open", title: "PR moved" } }],
				{ now: 600, nextRefreshAt: 2100 },
			),
		).toEqual([]);
		expect(store.getChange("moved")).toMatchObject({
			checkedAt: 600,
			nextRefreshAt: 2100,
			lastRefreshSucceeded: true,
		});

		expect(
			await store.applyPullRequestStatuses([{ ...watched.get("draft")!, outcome: { state: "unavailable" } }], {
				now: 700,
				nextRefreshAt: 2200,
			}),
		).toEqual([]);
		expect(store.getChange("draft")).toMatchObject({
			checkedAt: 100,
			nextRefreshAt: 1000,
			lastRefreshSucceeded: false,
			failureCount: 2,
			updatedAt: 20,
			pullRequest: { status: "draft" },
		});
		expect(store.getWorkContext("volt", 1, "draft", 500)).toMatchObject({
			pullRequest: { status: "draft", stale: true },
		});
		await store.close();
	});
});

describe("TUI Work observation authority", () => {
	it("accepts only the exact TUI connection holding the session lease", () => {
		const lease = { state: "tui-owned" as const, tuiConnectionId: "connection-a" };
		expect(isExactTuiWorkObservationLeaseHolder({ client: "tui", connectionId: "connection-a" }, lease)).toBe(true);
		expect(isExactTuiWorkObservationLeaseHolder({ client: "tui", connectionId: "connection-b" }, lease)).toBe(false);
		expect(isExactTuiWorkObservationLeaseHolder({ client: "cli", connectionId: "connection-a" }, lease)).toBe(false);
		expect(
			isExactTuiWorkObservationLeaseHolder(
				{ client: "tui", connectionId: "connection-a" },
				{ state: "daemon-active", tuiConnectionId: "connection-a" },
			),
		).toBe(false);
	});
});

describe("WorkAssociationService", () => {
	it("shares slash-delimited feature branches ending in a default base branch name", async () => {
		const store = new WorkStateStore({ path: statePath("work-prefixed-feature") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		await service.observe(observation({ sessionId: "feature-a", branch: "feature/main" }));
		await service.observe(observation({ sessionId: "feature-b", branch: "feature/main" }));
		expect(service.getWorkContext("volt", 1, "feature-b")?.changeId).toBe(
			service.getWorkContext("volt", 1, "feature-a")?.changeId,
		);
		await service.close();
	});

	it("keeps an exact positive association sticky across checkout changes and branch reuse", async () => {
		let now = 100;
		const store = new WorkStateStore({ path: statePath("work-sticky"), now: () => now });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		provider.outcome = resolved(42);
		const service = new WorkAssociationService({ store, discoveryProvider: provider, now: () => now });
		await service.observe(observation());
		const initial = service.getWorkContext("volt", 1, "session-a")!;
		expect(initial).toMatchObject({ branch: "feature/work", pullRequest: { number: 42 } });

		now++;
		await service.observe(observation({ branch: "main", headOid: OID_B }));
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			changeId: initial.changeId,
			branch: "feature/work",
			pullRequest: { number: 42 },
		});
		expect(provider.requests).toHaveLength(1);

		now++;
		provider.outcome = resolved(99);
		await service.observe(observation({ sessionId: "session-reuse", headOid: OID_B }));
		expect(service.getWorkContext("volt", 1, "session-reuse")).toMatchObject({
			changeId: initial.changeId,
			pullRequest: { number: 42 },
		});
		await service.close();
	});

	it("refreshes and rearms a sticky association after its branch head advances", async () => {
		vi.useFakeTimers({ now: 1000 });
		const store = new WorkStateStore({ path: statePath("work-sticky-head-refresh") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		provider.resolver = async (request) => {
			const outcome = resolved(42);
			return {
				...outcome,
				pullRequest: { ...outcome.pullRequest, matchedHeadOid: request.headOid },
			};
		};
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		await service.observe(observation({ headOid: OID_A }));
		const changeId = service.getWorkContext("volt", 1, "session-a")!.changeId;
		const initialCheckedAt = store.getChange(changeId)!.checkedAt;

		await vi.advanceTimersByTimeAsync(1000);
		await service.observe(observation({ headOid: OID_B }));
		expect(provider.requests.map((request) => request.headOid)).toEqual([OID_A]);
		expect(store.getChange(changeId)).toMatchObject({ headOid: OID_B, checkedAt: initialCheckedAt });

		await vi.advanceTimersByTimeAsync(5 * 60_000 - 1000);
		await store.flush();
		expect(provider.requests.map((request) => request.headOid)).toEqual([OID_A, OID_B]);
		const refreshed = store.getChange(changeId)!;
		expect(refreshed).toMatchObject({ headOid: OID_B, pullRequest: { matchedHeadOid: OID_B } });
		expect(refreshed.checkedAt).toBeGreaterThan(initialCheckedAt);

		await vi.advanceTimersByTimeAsync(5 * 60_000);
		await store.flush();
		expect(provider.requests.map((request) => request.headOid)).toEqual([OID_A, OID_B, OID_B]);
		expect(store.getChange(changeId)!.checkedAt).toBeGreaterThan(refreshed.checkedAt);
		await service.close();
	});

	it("inherits Work context for a replacement session without moving or overwriting bindings", async () => {
		const path = statePath("work-session-inheritance");
		const store = new WorkStateStore({ path });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		provider.outcome = resolved(42);
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		await service.observe(observation({ sessionId: "source" }));
		const source = service.getWorkContext("volt", 1, "source")!;

		expect(await service.inheritSession("volt", 1, "source", "review-session")).toBe(true);
		await service.retireSession("volt", 1, "source");
		expect(service.getWorkContext("volt", 1, "review-session")).toMatchObject({
			changeId: source.changeId,
			pullRequest: { number: 42 },
		});

		provider.outcome = resolved(99);
		await service.observe(observation({ sessionId: "existing", branch: "feature/other", headOid: OID_B }));
		const existing = service.getWorkContext("volt", 1, "existing")!;
		expect(existing.changeId).not.toBe(source.changeId);
		expect(await service.inheritSession("volt", 1, "source", "existing")).toBe(false);
		expect(service.getWorkContext("volt", 1, "existing")?.changeId).toBe(existing.changeId);
		await service.close();

		const reopened = new WorkStateStore({ path });
		await reopened.load();
		expect(reopened.getWorkContext("volt", 1, "source")?.changeId).toBe(source.changeId);
		expect(reopened.getWorkContext("volt", 1, "review-session")?.changeId).toBe(source.changeId);
		await reopened.close();
	});

	it("fences delayed discovery by session binding generation, repository, branch, and OID", async () => {
		const store = new WorkStateStore({ path: statePath("work-cas") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const resolvers = new Map<string, (outcome: CodeHostPullRequestDiscoveryOutcome) => void>();
		provider.resolver = (request) => new Promise((resolve) => resolvers.set(request.branch, resolve));
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		const first = service.observe(observation());
		await waitFor(() => resolvers.has("feature/work"));
		const second = service.observe(observation({ branch: "feature/new", headOid: OID_B }));
		await waitFor(() => resolvers.has("feature/new"));
		resolvers.get("feature/work")!({
			state: "resolved",
			pullRequest: { ...resolved(1).pullRequest!, headBranch: "feature/work" },
		});
		resolvers.get("feature/new")!({ state: "none" });
		await Promise.all([first, second]);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			branch: "feature/new",
			resolutionState: "none",
		});
		await service.close();
	});

	it("rejects delayed discovery after another session advances the shared change head", async () => {
		const store = new WorkStateStore({ path: statePath("work-shared-head-cas") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const resolvers = new Map<string, (outcome: CodeHostPullRequestDiscoveryOutcome) => void>();
		provider.resolver = (request) => new Promise((resolve) => resolvers.set(request.headOid, resolve));
		const service = new WorkAssociationService({ store, discoveryProvider: provider });

		const older = service.observe(observation({ sessionId: "older", headOid: OID_A }));
		await waitFor(() => resolvers.has(OID_A));
		const newer = service.observe(observation({ sessionId: "newer", headOid: OID_B }));
		await waitFor(() => resolvers.has(OID_B));
		resolvers.get(OID_B)!({ state: "none" });
		await newer;

		const newerContext = service.getWorkContext("volt", 1, "newer");
		const olderContext = service.getWorkContext("volt", 1, "older");
		const changeId = newerContext!.changeId;
		const changeSnapshot = store.getChange(changeId);
		expect(changeSnapshot).toMatchObject({ headOid: OID_B, resolutionState: "none" });
		expect(olderContext).toEqual(newerContext);

		resolvers.get(OID_A)!(resolved(1));
		await older;

		expect(store.getChange(changeId)).toEqual(changeSnapshot);
		expect(service.getWorkContext("volt", 1, "older")).toEqual(olderContext);
		expect(service.getWorkContext("volt", 1, "newer")).toEqual(newerContext);
		await service.close();
	});

	it("skips a guarded binding that becomes stale while queued behind persistence", async () => {
		const writeGate = createDeferred();
		let writeCount = 0;
		let blockingWriteStarted = false;
		const store = new WorkStateStore({
			path: statePath("work-guarded-binding"),
			writeStateFile: async () => {
				writeCount++;
				if (writeCount === 2) {
					blockingWriteStarted = true;
					await writeGate.promise;
				}
			},
		});
		await store.load();
		const blocking = store.bindObservation({
			...observation({ sessionId: "blocking" }),
			baseBranch: false,
			now: 1,
		});
		await waitFor(() => blockingWriteStarted);

		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		let currentRevision = true;
		const stale = service.observe(
			observation({ sessionId: "stale", branch: "feature/stale", headOid: OID_B }),
			() => currentRevision,
		);
		currentRevision = false;
		writeGate.resolve();
		await Promise.all([blocking, stale]);

		expect(writeCount).toBe(2);
		expect(store.getBinding("volt", 1, "stale")).toBeUndefined();
		expect(provider.requests).toEqual([]);
		await service.close();
	});

	it("waits for an admitted guarded persistence mutation before retirement completes", async () => {
		const writeGate = createDeferred();
		let writeCount = 0;
		let observationWriteStarted = false;
		const store = new WorkStateStore({
			path: statePath("work-retirement-drain"),
			writeStateFile: async () => {
				writeCount++;
				if (writeCount === 2) {
					observationWriteStarted = true;
					await writeGate.promise;
				}
			},
		});
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		let currentRevision = true;
		const observing = service.observe(observation(), () => currentRevision);
		await waitFor(() => observationWriteStarted);
		currentRevision = false;

		let retirementSettled = false;
		const retirement = service.retireSession("volt", 1, "session-a").then(() => {
			retirementSettled = true;
		});
		await Promise.resolve();
		expect(retirementSettled).toBe(false);
		writeGate.resolve();
		await Promise.all([observing, retirement]);

		expect(retirementSettled).toBe(true);
		expect(provider.requests).toEqual([]);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			branch: "feature/work",
			resolutionState: "unavailable",
		});
		await service.close();
	});

	it("retires active discovery without waiting for the provider or allowing timers to reactivate", async () => {
		vi.useFakeTimers({ now: 1000 });
		const store = new WorkStateStore({ path: statePath("work-retired-discovery") });
		await store.load();
		const discoveryStarted = createDeferred();
		const discoveryGate = createDeferred();
		const provider = new FakeDiscoveryProvider();
		provider.resolver = async () => {
			discoveryStarted.resolve();
			await discoveryGate.promise;
			return { state: "none" };
		};
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		const observing = service.observe(observation());
		await discoveryStarted.promise;

		await service.retireSession("volt", 1, "session-a");
		expect(provider.active).toBe(1);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			resolutionState: "unavailable",
		});
		discoveryGate.resolve();
		await observing;
		await vi.advanceTimersByTimeAsync(15 * 60_000);

		expect(provider.requests).toHaveLength(1);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			resolutionState: "unavailable",
		});
		await service.close();
	});

	it("deduplicates in-flight and cached discovery and enforces provider concurrency", async () => {
		const store = new WorkStateStore({ path: statePath("work-dedupe") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const pending: Array<(outcome: CodeHostPullRequestDiscoveryOutcome) => void> = [];
		provider.resolver = () => new Promise((resolve) => pending.push(resolve));
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			providerConcurrency: 1,
		});
		const first = service.observe(observation({ sessionId: "first" }));
		const second = service.observe(observation({ sessionId: "second" }));
		await waitFor(() => provider.requests.length === 1);
		expect(provider.maxActive).toBe(1);
		pending.shift()!({ state: "none" });
		await Promise.all([first, second]);
		expect(provider.requests).toHaveLength(1);

		await service.observe(observation({ sessionId: "third" }));
		expect(provider.requests).toHaveLength(1);

		const branchA = service.observe(observation({ sessionId: "a", branch: "feature/a", headOid: OID_A }));
		const branchB = service.observe(observation({ sessionId: "b", branch: "feature/b", headOid: OID_B }));
		await waitFor(() => provider.requests.length === 2);
		expect(provider.active).toBe(1);
		pending.shift()!({ state: "none" });
		await waitFor(() => provider.requests.length === 3);
		expect(provider.maxActive).toBe(1);
		pending.shift()!({ state: "none" });
		await Promise.all([branchA, branchB]);
		await service.close();
	});

	it("contains thrown scheduled discovery failures and retries them with backoff", async () => {
		vi.useFakeTimers({ now: 1000 });
		const store = new WorkStateStore({ path: statePath("work-scheduled-provider-failure") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		let attempts = 0;
		provider.resolver = async () => {
			attempts++;
			if (attempts === 2) throw new Error("scheduled provider failure");
			return { state: "none" };
		};
		const failures: Array<{ phase: string; message: string }> = [];
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			onRefreshError: (phase, error) => {
				failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
			},
		});
		await service.observe(observation());

		await vi.advanceTimersByTimeAsync(60_000);
		await store.flush();
		expect(provider.requests).toHaveLength(2);
		expect(failures).toEqual([{ phase: "discovery", message: "scheduled provider failure" }]);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			resolutionState: "unavailable",
		});

		await vi.advanceTimersByTimeAsync(30_000);
		await store.flush();
		expect(provider.requests).toHaveLength(3);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({ resolutionState: "none" });
		await service.close();
	});

	it("contains scheduled persistence failures and retries them with backoff", async () => {
		vi.useFakeTimers({ now: 1000 });
		let failWrites = false;
		let writeAttempts = 0;
		const store = new WorkStateStore({
			path: statePath("work-scheduled-persistence-failure"),
			writeStateFile: async () => {
				writeAttempts++;
				if (failWrites) throw new Error("scheduled persistence failure");
			},
		});
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const failures: Array<{ phase: string; message: string }> = [];
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			onRefreshError: (phase, error) => {
				failures.push({ phase, message: error instanceof Error ? error.message : String(error) });
			},
		});
		await service.observe(observation());
		const changeId = service.getWorkContext("volt", 1, "session-a")!.changeId;
		const initialWriteAttempts = writeAttempts;

		failWrites = true;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(writeAttempts).toBe(initialWriteAttempts + 1);
		expect(failures).toEqual([{ phase: "scheduled_refresh", message: "scheduled persistence failure" }]);
		expect(store.getChange(changeId)!.nextRefreshAt).toBeLessThanOrEqual(Date.now());

		failWrites = false;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(writeAttempts).toBe(initialWriteAttempts + 2);
		expect(store.getChange(changeId)!.nextRefreshAt).toBeGreaterThan(Date.now());
		await service.close();
	});

	it("uses unavailable state and backoff while offline, disabled, or untrusted without provider calls", async () => {
		let now = 1000;
		const store = new WorkStateStore({ path: statePath("work-offline"), now: () => now });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({
			store,
			discoveryProvider: provider,
			now: () => now,
			isOnline: () => false,
		});
		await service.observe(observation());
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({ resolutionState: "unavailable" });
		expect(provider.requests).toEqual([]);
		now++;
		await service.observe(observation());
		expect(provider.requests).toEqual([]);
		await service.close();

		const disabledStore = new WorkStateStore({ path: statePath("work-disabled") });
		await disabledStore.load();
		const disabled = new WorkAssociationService({
			store: disabledStore,
			discoveryProvider: provider,
			enabled: false,
		});
		await disabled.observe(observation({ sessionId: "disabled" }));
		await disabled.close();

		const untrustedStore = new WorkStateStore({ path: statePath("work-untrusted") });
		await untrustedStore.load();
		const untrusted = new WorkAssociationService({ store: untrustedStore, discoveryProvider: provider });
		await untrusted.observe(observation({ sessionId: "untrusted", trusted: false }));
		await untrusted.close();
		expect(provider.requests).toEqual([]);
	});

	it("keeps repositories distinct by registered workspace generation and common Git directory", async () => {
		const store = new WorkStateStore({ path: statePath("work-repositories") });
		await store.load();
		const provider = new FakeDiscoveryProvider();
		const service = new WorkAssociationService({ store, discoveryProvider: provider });
		await service.observe(observation({ sessionId: "root", cwd: "/workspace/root" }));
		await service.observe(
			observation({
				sessionId: "worktree",
				cwd: "/workspace/worktree",
				commonGitDir: "/workspace/volt/.git",
			}),
		);
		expect(service.getWorkContext("volt", 1, "root")?.changeId).toBe(
			service.getWorkContext("volt", 1, "worktree")?.changeId,
		);
		await service.observe(
			observation({
				workspaceGeneration: 2,
				sessionId: "replacement",
				cwd: "/workspace/root",
			}),
		);
		expect(service.getWorkContext("volt", 2, "replacement")?.changeId).not.toBe(
			service.getWorkContext("volt", 1, "root")?.changeId,
		);
		await service.close();
	});
});

describe("WorkAssociationService background PR status refresh", () => {
	it("stays dormant until started, then polls immediately and every 15 minutes while idle", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status } = await statusFixture("work-status-idle");
		await linkOffBranch(service);
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		expect(status.requests).toHaveLength(0);

		service.start();
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(status.requests).toHaveLength(1);
		expect(status.requests[0]).toMatchObject({
			cwd: "/neutral",
			host: "github.com",
			pullRequests: [{ owner: "volt-hq", name: "volt", number: 42 }],
		});
		await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
		expect(status.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(status.requests).toHaveLength(2);

		await service.close();
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(status.requests).toHaveLength(2);
	});

	it("polls every minute while clients are active and returns to 15 minutes after the activity window", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status } = await statusFixture("work-status-active");
		await linkOffBranch(service);
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(status.requests).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(5_000);
		const release = service.retainClientActivity();
		const releaseSecond = service.retainClientActivity();
		expect(status.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(10_000 - 1);
		expect(status.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(status.requests).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(status.requests).toHaveLength(3);
		release();
		release();
		releaseSecond();
		await vi.advanceTimersByTimeAsync(3 * 60_000);
		expect(status.requests).toHaveLength(6);
		await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
		expect(status.requests).toHaveLength(6);
		await vi.advanceTimersByTimeAsync(1);
		expect(status.requests).toHaveLength(7);
		await service.close();
	});

	it("refreshes a linked PR as soon as its session leaves the PR branch", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status } = await statusFixture("work-status-leave");
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(status.requests).toHaveLength(0);

		await service.observe(observation());
		await service.observe(observation());
		expect(status.requests).toHaveLength(0);
		status.statuses.set(42, "merged");
		await vi.advanceTimersByTimeAsync(20_000);
		await service.observe(observation({ branch: "main", headOid: OID_B }));
		expect(status.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			branch: "feature/work",
			pullRequest: { number: 42, status: "merged", stale: false },
		});

		await vi.advanceTimersByTimeAsync(20_000);
		await service.observe(observation({ branch: "main", headOid: OID_A }));
		expect(status.requests).toHaveLength(1);
		await service.close();
	});

	it("refreshes a linked PR after its session runtime retires", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status } = await statusFixture("work-status-retire");
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		await service.observe(observation());
		await vi.advanceTimersByTimeAsync(20_000);
		await service.retireSession("volt", 1, "unknown-session");
		expect(status.requests).toHaveLength(0);

		status.statuses.set(42, "merged");
		await service.retireSession("volt", 1, "session-a");
		expect(status.requests).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			pullRequest: { number: 42, status: "merged", stale: false },
		});
		await service.close();
	});

	it("never polls when pull request discovery is disabled", async () => {
		vi.useFakeTimers({ now: 1000 });
		const path = statePath("work-status-disabled");
		writeWorkStateFixture(path, [{ id: "open", updatedAt: 10, number: 42 }]);
		const store = new WorkStateStore({ path, writeStateFile: async () => {} });
		await store.load();
		expect(store.listWatchedPullRequests(10)).toHaveLength(1);
		const status = new FakeStatusProvider();
		const service = new WorkAssociationService({ store, statusProvider: status, enabled: false });
		service.start();
		service.retainClientActivity();
		await service.retireSession("volt", 1, "open");
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(status.requests).toHaveLength(0);
		await service.close();
	});

	it("backs off after polls without a successful result and resets after success", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status } = await statusFixture("work-status-backoff");
		await linkOffBranch(service);
		service.retainClientActivity();
		let failing = true;
		status.resolver = async (request): Promise<CodeHostPullRequestStatusOutcome[]> =>
			request.pullRequests.map(() =>
				failing
					? { state: "unavailable", reason: "rate_limited" }
					: { state: "resolved", status: "open", title: "PR 42" },
			);
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(status.requests).toHaveLength(1);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			pullRequest: { status: "open", stale: true },
		});

		await vi.advanceTimersByTimeAsync(60_000);
		expect(status.requests).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(120_000 - 1);
		expect(status.requests).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(status.requests).toHaveLength(3);

		failing = false;
		await vi.advanceTimersByTimeAsync(240_000 - 1);
		expect(status.requests).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(status.requests).toHaveLength(4);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			pullRequest: { status: "open", stale: false },
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(status.requests).toHaveLength(5);
		await service.close();
	});

	it("deduplicates a pull request linked from several changes into one batched lookup", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status, discovery } = await statusFixture("work-status-dedupe");
		await linkOffBranch(service, { sessionId: "a", commonGitDir: "/a/.git" });
		await linkOffBranch(service, { sessionId: "b", commonGitDir: "/b/.git" });
		discovery.outcome = resolved(43);
		await linkOffBranch(service, { sessionId: "c", commonGitDir: "/c/.git" });
		expect(service.getWorkContext("volt", 1, "a")?.changeId).not.toBe(
			service.getWorkContext("volt", 1, "b")?.changeId,
		);

		status.statuses.set(42, "merged");
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(status.requests).toHaveLength(1);
		expect(status.requests[0]!.pullRequests.map((pullRequest) => pullRequest.number).sort()).toEqual([42, 43]);
		expect(service.getWorkContext("volt", 1, "a")).toMatchObject({ pullRequest: { status: "merged" } });
		expect(service.getWorkContext("volt", 1, "b")).toMatchObject({ pullRequest: { status: "merged" } });
		expect(service.getWorkContext("volt", 1, "c")).toMatchObject({ pullRequest: { number: 43, status: "open" } });
		await service.close();
	});

	it("settles an in-flight poll on close without marking the pull request stale", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status, store } = await statusFixture("work-status-close");
		await linkOffBranch(service);
		const changeId = service.getWorkContext("volt", 1, "session-a")!.changeId;
		status.resolver = (request) =>
			new Promise((resolve) => {
				request.signal?.addEventListener(
					"abort",
					() => resolve(request.pullRequests.map(() => ({ state: "unavailable", reason: "cancelled" }))),
					{ once: true },
				);
			});
		service.start();
		expect(status.requests).toHaveLength(1);
		await service.close();
		expect(status.requests[0]!.signal?.aborted).toBe(true);
		expect(store.getChange(changeId)).toMatchObject({ lastRefreshSucceeded: true, pullRequest: { status: "open" } });
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		expect(status.requests).toHaveLength(1);
	});

	it("drops cached discovery when a poll changes a pull request status", async () => {
		vi.useFakeTimers({ now: 1000 });
		const { service, status, discovery } = await statusFixture("work-status-cache");
		service.retainClientActivity();
		await service.observe(observation());
		expect(discovery.requests).toHaveLength(1);

		status.statuses.set(42, "merged");
		service.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({ pullRequest: { status: "merged" } });

		discovery.outcome = resolved(42, "merged");
		await vi.advanceTimersByTimeAsync(120_000);
		await service.observe(observation());
		expect(discovery.requests).toHaveLength(2);
		expect(service.getWorkContext("volt", 1, "session-a")).toMatchObject({
			pullRequest: { status: "merged", stale: false },
		});
		await service.close();
	});
});
