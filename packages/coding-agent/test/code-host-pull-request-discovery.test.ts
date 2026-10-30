import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CanonicalCodeHostRepository,
	type CodeHostHeadPullRequest,
	type CodeHostHeadPullRequestListRequest,
	type CodeHostHeadPullRequestListResult,
	type CodeHostProvider,
	codeHostPullRequestDiscoveryProvider,
	registerCodeHostProvider,
} from "../src/core/code-host/index.ts";

const BRANCH = "topic";
let cwd: string;
let headOid: string;
const cleanups: Array<() => void> = [];

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository `https://{host}/r/{owner}/{name}` names: three segments, so the GitHub provider never claims it. */
function repository(providerId: string, host: string, path: string): CanonicalCodeHostRepository {
	return { providerId, host, path, canonicalId: `${providerId}:${host}/${path}` };
}

function remoteUrl(host: string, path: string): string {
	return `https://${host}/r/${path}`;
}

type ListHook = (request: CodeHostHeadPullRequestListRequest) => Promise<CodeHostHeadPullRequestListResult>;

function provider(id: string, host: string, list?: ListHook): CodeHostProvider {
	return {
		id,
		displayName: id,
		parsePullRequestUrl: () => undefined,
		pullRequestUrl: () => undefined,
		isCanonicalPullRequestCheckout: () => false,
		canonicalizeRemoteUrl: (url) => {
			const prefix = `https://${host}/r/`;
			const path = url.startsWith(prefix) ? url.slice(prefix.length) : "";
			return /^[a-z]+\/[a-z]+$/.test(path) ? repository(id, host, path) : null;
		},
		probeCurrentPullRequest: async () => undefined,
		resolvePullRequestCheckout: async () => ({ ok: false, error: "unused" }),
		capturePullRequestContext: async () => ({ ok: false, error: "unused" }),
		capturePullRequestIdentity: async () => ({ ok: false, error: "unused" }),
		verifyPullRequestHead: async () => {},
		publishPullRequestReview: async () => ({}),
		...(list === undefined ? {} : { listPullRequestsForHeadBranch: list }),
	};
}

function register(...providers: CodeHostProvider[]): void {
	for (const candidate of providers) cleanups.push(registerCodeHostProvider(candidate));
}

function pullRequest(overrides: Partial<CodeHostHeadPullRequest> = {}): CodeHostHeadPullRequest {
	return {
		number: 7,
		title: "Change",
		status: "open",
		headRepository: repository("alpha", "alpha.example.test", "acme/fork"),
		headBranch: BRANCH,
		headOid,
		...overrides,
	};
}

function discover() {
	return codeHostPullRequestDiscoveryProvider.discoverPullRequest({ cwd, branch: BRANCH, headOid });
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "volt-pr-discovery-"));
	git("init", `--initial-branch=${BRANCH}`);
	git(
		"-c",
		"user.name=Discovery Test",
		"-c",
		"user.email=discovery@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"fixture",
	);
	headOid = git("rev-parse", "HEAD");
	git("remote", "add", "origin", remoteUrl("alpha.example.test", "acme/fork"));
	git("remote", "add", "parent", remoteUrl("alpha.example.test", "acme/widgets"));
	git("remote", "add", "mirror", remoteUrl("beta.example.test", "acme/widgets"));
	git("update-ref", `refs/remotes/origin/${BRANCH}`, headOid);
	git("branch", `--set-upstream-to=origin/${BRANCH}`);
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	rmSync(cwd, { recursive: true, force: true });
});

describe("provider-agnostic pull request discovery", () => {
	it("lists only on the head repository's provider and host, and resolves the exact head match", async () => {
		const alpha = vi.fn<ListHook>(async (request) => ({
			ok: true,
			pullRequests: request.repository.path === "acme/widgets" ? [pullRequest({ title: "x".repeat(600) })] : [],
		}));
		const beta = vi.fn<ListHook>(async () => ({ ok: true, pullRequests: [pullRequest({ number: 99 })] }));
		register(provider("alpha", "alpha.example.test", alpha), provider("beta", "beta.example.test", beta));

		expect(await discover()).toEqual({
			state: "resolved",
			pullRequest: {
				providerId: "alpha",
				repository: repository("alpha", "alpha.example.test", "acme/widgets"),
				headRepository: repository("alpha", "alpha.example.test", "acme/fork"),
				number: 7,
				title: "x".repeat(512),
				status: "open",
				headBranch: BRANCH,
				matchedHeadOid: headOid,
			},
		});
		expect(alpha.mock.calls.map(([request]) => [request.repository.path, request.branch])).toEqual([
			["acme/fork", BRANCH],
			["acme/widgets", BRANCH],
		]);
		expect(beta).not.toHaveBeenCalled();
	});

	it("reports a head repository whose provider cannot list pull requests as unsupported", async () => {
		const alpha = vi.fn<ListHook>(async () => ({ ok: true, pullRequests: [pullRequest()] }));
		register(provider("alpha", "alpha.example.test", alpha), provider("beta", "beta.example.test"));
		git("update-ref", `refs/remotes/mirror/${BRANCH}`, headOid);
		git("branch", `--set-upstream-to=mirror/${BRANCH}`);

		expect(await discover()).toEqual({ state: "unavailable", reason: "unsupported_repository" });
		expect(alpha).not.toHaveBeenCalled();
	});

	it("does not guess between providers for an untracked branch", async () => {
		const alpha = vi.fn<ListHook>(async () => ({ ok: true, pullRequests: [pullRequest()] }));
		register(provider("alpha", "alpha.example.test", alpha), provider("beta", "beta.example.test", alpha));
		// One repository on each provider: neither is the only repository.
		git("remote", "remove", "parent");
		git("branch", "--unset-upstream");
		git("update-ref", "-d", `refs/remotes/origin/${BRANCH}`);

		expect(await discover()).toEqual({ state: "unavailable", reason: "repository_ambiguous" });
		expect(alpha).not.toHaveBeenCalled();
	});

	it("matches only the head repository, branch, and commit, in any case", async () => {
		const pullRequests: CodeHostHeadPullRequest[] = [
			pullRequest({ number: 1, headRepository: repository("alpha", "alpha.example.test", "acme/widgets") }),
			pullRequest({ number: 2, headBranch: "other" }),
			pullRequest({ number: 3, headOid: "f".repeat(40) }),
		];
		register(
			provider("alpha", "alpha.example.test", async (request) => ({
				ok: true,
				pullRequests: request.repository.path === "acme/widgets" ? pullRequests : [],
			})),
		);
		expect(await discover()).toEqual({ state: "none" });

		pullRequests.push(pullRequest({ number: 4, status: "merged", headOid: headOid.toUpperCase() }));
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { number: 4, status: "merged" } });
	});

	it.each([
		["a number that is not positive", { number: 0 }],
		["an unknown status", { status: "pending" }],
		["a missing head repository", { headRepository: null }],
		["a head commit that is not a string", { headOid: 7 }],
	])("rejects a listing with %s", async (_label, overrides) => {
		const malformed = { ...pullRequest(), ...overrides } as unknown as CodeHostHeadPullRequest;
		register(provider("alpha", "alpha.example.test", async () => ({ ok: true, pullRequests: [malformed] })));
		expect(await discover()).toEqual({ state: "unavailable", reason: "invalid_response" });
	});

	it("keeps provider failures distinct from no pull request", async () => {
		const list = vi.fn<ListHook>(async () => ({ ok: false, reason: "rate_limited" }));
		register(provider("alpha", "alpha.example.test", list));
		expect(await discover()).toEqual({ state: "unavailable", reason: "rate_limited" });
		expect(list).toHaveBeenCalledTimes(1);

		list.mockRejectedValue(new Error("private diagnostic"));
		expect(await discover()).toEqual({ state: "unavailable", reason: "provider_error" });
	});

	it("reports a listing cancelled with its signal as cancelled", async () => {
		const controller = new AbortController();
		register(
			provider("alpha", "alpha.example.test", async () => {
				controller.abort();
				throw new Error("cancelled");
			}),
		);
		expect(
			await codeHostPullRequestDiscoveryProvider.discoverPullRequest({
				cwd,
				branch: BRANCH,
				headOid,
				signal: controller.signal,
			}),
		).toEqual({ state: "unavailable", reason: "cancelled" });
	});
});
