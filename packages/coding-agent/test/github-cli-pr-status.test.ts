import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../src/core/code-host/github-cli.ts";
import { refreshPullRequestStatusesWithGitHubCli } from "../src/core/code-host/github-cli-discovery.ts";
import type { CodeHostPullRequestStatusTarget } from "../src/core/code-host/types.ts";

vi.mock("../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

interface FixturePullRequest {
	state: string;
	isDraft: boolean;
	title: string;
}

/** Keyed by `owner/name#number`; missing keys resolve to null with a NOT_FOUND error, as GitHub does. */
let fixtures: Record<string, FixturePullRequest>;
let missingRepositories: Set<string>;

function result(overrides: Partial<Omit<GitHubCliResult, "stdout">> & { stdout?: string } = {}): GitHubCliResult {
	return {
		ok: overrides.ok ?? true,
		stdout: Buffer.from(overrides.stdout ?? ""),
		stderr: overrides.stderr ?? "",
		outputLimited: overrides.outputLimited ?? false,
		timedOut: overrides.timedOut ?? false,
	};
}

/** Minimal GitHub GraphQL emulation for the aliased repository/pullRequest query shape. */
function respond(input: string): GitHubCliResult {
	const { query, variables } = JSON.parse(input) as { query: string; variables: Record<string, string | number> };
	const data: Record<string, Record<string, unknown> | null> = {};
	const errors: Array<Record<string, unknown>> = [];
	const repositories = new Map<string, string>();
	for (const match of query.matchAll(/(r\d+): repository\(owner:\$(\w+),name:\$(\w+)\)/g)) {
		const slug = `${variables[match[2]!]}/${variables[match[3]!]}`;
		repositories.set(match[1]!, slug);
		if (missingRepositories.has(slug)) {
			data[match[1]!] = null;
			errors.push({ type: "NOT_FOUND", path: [match[1]] });
		} else {
			data[match[1]!] = {};
		}
	}
	for (const match of query.matchAll(/(r\d+)(p\d+): pullRequest\(number:\$(\w+)\)/g)) {
		const repository = data[match[1]!];
		if (!repository) continue;
		const key = `${repositories.get(match[1]!)}#${variables[match[3]!]}`;
		const fixture = fixtures[key];
		repository[`${match[1]}${match[2]}`] = fixture ?? null;
		if (!fixture) errors.push({ type: "NOT_FOUND", path: [match[1], `${match[1]}${match[2]}`] });
	}
	const stdout = JSON.stringify(errors.length > 0 ? { data, errors } : { data });
	return errors.length > 0
		? result({ ok: false, stdout, stderr: "gh: Could not resolve to a PullRequest." })
		: result({ stdout });
}

function target(owner: string, name: string, number: number): CodeHostPullRequestStatusTarget {
	return { owner, name, number };
}

function refresh(pullRequests: CodeHostPullRequestStatusTarget[], signal?: AbortSignal) {
	return refreshPullRequestStatusesWithGitHubCli({
		cwd: "/neutral",
		host: "github.com",
		pullRequests,
		...(signal === undefined ? {} : { signal }),
	});
}

beforeEach(() => {
	fixtures = {};
	missingRepositories = new Set();
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (_args, options) => respond(options.input ?? ""));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("batched GitHub pull request status refresh", () => {
	it("queries one host with variables only and maps every status in request order", async () => {
		fixtures = {
			"volt-hq/volt#4242": { state: "OPEN", isDraft: false, title: "Open PR" },
			"volt-hq/volt#4243": { state: "OPEN", isDraft: true, title: "Draft PR" },
			"other-org/tool#7": { state: "MERGED", isDraft: false, title: "Merged PR" },
			"volt-hq/volt#4244": { state: "CLOSED", isDraft: false, title: "x".repeat(600) },
		};
		const outcomes = await refresh([
			target("volt-hq", "volt", 4242),
			target("volt-hq", "volt", 4243),
			target("other-org", "tool", 7),
			target("volt-hq", "volt", 4244),
		]);

		expect(outcomes).toEqual([
			{ state: "resolved", status: "open", title: "Open PR" },
			{ state: "resolved", status: "draft", title: "Draft PR" },
			{ state: "resolved", status: "merged", title: "Merged PR" },
			{ state: "resolved", status: "closed", title: "x".repeat(512) },
		]);
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
		const [args, options] = vi.mocked(runGitHubCli).mock.calls[0]!;
		expect(args).toEqual(["api", "graphql", "--hostname", "github.com", "--input", "-"]);
		expect(options.cwd).toBe("/neutral");
		const body = JSON.parse(options.input!) as { query: string; variables: Record<string, unknown> };
		expect(Object.values(body.variables).sort()).toEqual(
			[4242, 4243, 4244, 7, "other-org", "tool", "volt", "volt-hq"].sort(),
		);
		for (const value of ["volt-hq", "other-org", "tool", "4242", "4243", "4244"]) {
			expect(body.query).not.toContain(value);
		}
	});

	it("keeps resolved results when gh exits non-zero for a missing pull request or repository", async () => {
		fixtures = { "volt-hq/volt#1": { state: "MERGED", isDraft: false, title: "Still here" } };
		missingRepositories.add("gone/repo");
		const outcomes = await refresh([
			target("volt-hq", "volt", 1),
			target("volt-hq", "volt", 999_999),
			target("gone", "repo", 3),
		]);
		expect(outcomes).toEqual([
			{ state: "resolved", status: "merged", title: "Still here" },
			{ state: "unavailable", reason: "provider_error" },
			{ state: "unavailable", reason: "provider_error" },
		]);
	});

	it("maps whole-query rate limiting and authentication failures to every pull request", async () => {
		vi.mocked(runGitHubCli).mockResolvedValueOnce(
			result({
				ok: false,
				stdout: JSON.stringify({ data: null, errors: [{ type: "RATE_LIMITED", message: "limit" }] }),
				stderr: "gh: API rate limit already exceeded",
			}),
		);
		expect(await refresh([target("volt-hq", "volt", 1), target("volt-hq", "volt", 2)])).toEqual([
			{ state: "unavailable", reason: "rate_limited" },
			{ state: "unavailable", reason: "rate_limited" },
		]);

		vi.mocked(runGitHubCli).mockResolvedValueOnce(
			result({ ok: false, stderr: "To get started with GitHub CLI, please run:  gh auth login" }),
		);
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([
			{ state: "unavailable", reason: "not_authenticated" },
		]);
	});

	it("reports malformed, oversized, timed-out, failed, and cancelled queries as unavailable", async () => {
		vi.mocked(runGitHubCli).mockResolvedValueOnce(result({ stdout: "{not json" }));
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([
			{ state: "unavailable", reason: "invalid_response" },
		]);

		vi.mocked(runGitHubCli).mockResolvedValueOnce(
			result({
				stdout: JSON.stringify({ data: { r0: { r0p0: { state: "LOCKED", isDraft: false, title: "t" } } } }),
			}),
		);
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([
			{ state: "unavailable", reason: "invalid_response" },
		]);

		vi.mocked(runGitHubCli).mockResolvedValueOnce(result({ ok: false, outputLimited: true }));
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([
			{ state: "unavailable", reason: "output_limited" },
		]);

		vi.mocked(runGitHubCli).mockResolvedValueOnce(result({ ok: false, timedOut: true }));
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([{ state: "unavailable", reason: "timeout" }]);

		vi.mocked(runGitHubCli).mockRejectedValueOnce(new Error("spawn failure"));
		expect(await refresh([target("volt-hq", "volt", 1)])).toEqual([
			{ state: "unavailable", reason: "provider_error" },
		]);

		const controller = new AbortController();
		controller.abort();
		vi.mocked(runGitHubCli).mockClear();
		expect(await refresh([target("volt-hq", "volt", 1)], controller.signal)).toEqual([
			{ state: "unavailable", reason: "cancelled" },
		]);
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("chunks large sets and preserves request order across chunks", async () => {
		const targets = Array.from({ length: 120 }, (_, index) => target("volt-hq", "volt", index + 1));
		for (const entry of targets) {
			fixtures[`volt-hq/volt#${entry.number}`] = { state: "OPEN", isDraft: false, title: `PR ${entry.number}` };
		}
		const outcomes = await refresh(targets);
		expect(runGitHubCli).toHaveBeenCalledTimes(3);
		const chunkSizes = vi
			.mocked(runGitHubCli)
			.mock.calls.map(
				([, options]) =>
					Object.keys((JSON.parse(options.input!) as { variables: Record<string, unknown> }).variables).filter(
						(key) => key.startsWith("p"),
					).length,
			);
		expect(chunkSizes).toEqual([50, 50, 20]);
		expect(outcomes.map((outcome) => (outcome.state === "resolved" ? outcome.title : outcome.reason))).toEqual(
			targets.map((entry) => `PR ${entry.number}`),
		);
	});

	it("rejects invalid hosts and out-of-range numbers without sending them", async () => {
		fixtures = { "volt-hq/volt#5": { state: "OPEN", isDraft: false, title: "Valid" } };
		expect(await refresh([target("volt-hq", "volt", 2 ** 31), target("volt-hq", "volt", 5)])).toEqual([
			{ state: "unavailable", reason: "invalid_response" },
			{ state: "resolved", status: "open", title: "Valid" },
		]);
		const body = JSON.parse(vi.mocked(runGitHubCli).mock.calls[0]![1].input!) as {
			variables: Record<string, unknown>;
		};
		expect(Object.values(body.variables)).not.toContain(2 ** 31);

		vi.mocked(runGitHubCli).mockClear();
		expect(
			await refreshPullRequestStatusesWithGitHubCli({
				cwd: "/neutral",
				host: "--hostname",
				pullRequests: [target("volt-hq", "volt", 5)],
			}),
		).toEqual([{ state: "unavailable", reason: "invalid_response" }]);
		expect(runGitHubCli).not.toHaveBeenCalled();
	});
});
