import { describe, expect, it } from "vitest";
import {
	type GhResult,
	type GhRunner,
	GitHubTracker,
	parseReviewMarkers,
	reviewMarker,
	sameLogin,
} from "../../examples/extensions/issue-orchestrator/github.ts";

const SHA = "a".repeat(40);

/** A `gh` that answers each command (its arguments joined by spaces, up to `--json`/`--jq`) as scripted, recording calls. */
function scriptedGh(script: Record<string, GhResult | string>): { run: GhRunner; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push([...args]);
			const command = args.join(" ");
			const key = Object.keys(script).find((prefix) => command.startsWith(prefix));
			if (key === undefined) return { stdout: "", stderr: `unscripted: ${command}`, code: 1 };
			const answer = script[key];
			return typeof answer === "string" ? { stdout: answer, stderr: "", code: 0 } : (answer as GhResult);
		},
	};
}

describe("issue orchestrator GitHub tracker", () => {
	it("asks gh for the repository and the reviewer it does not know", async () => {
		const gh = scriptedGh({ "repo view": "volt-hq/Volt\n", "api user": "maintainer\n" });
		const tracker = await GitHubTracker.connect(gh.run, {});
		expect(tracker.repo).toBe("volt-hq/Volt");
		const known = scriptedGh({});
		expect((await GitHubTracker.connect(known.run, { repo: "o/r", reviewAuthor: "bot" })).repo).toBe("o/r");
		expect(known.calls).toEqual([]);
	});

	it("reads labeled issues, lowercasing their labels", async () => {
		const gh = scriptedGh({
			"issue list --repo o/r --state open": JSON.stringify([
				{
					number: 12,
					title: "Fix the thing",
					body: "Details",
					url: "https://github.com/o/r/issues/12",
					labels: [{ name: "Agent-Ready" }],
					state: "OPEN",
					createdAt: "2026-10-01T00:00:00Z",
				},
				{ title: "no number" },
			]),
		});
		const tracker = new GitHubTracker(gh.run, "o/r", "bot");
		expect(await tracker.candidates(["agent-ready", "roadmap"])).toEqual([
			{
				number: 12,
				identifier: "o/r#12",
				title: "Fix the thing",
				body: "Details",
				url: "https://github.com/o/r/issues/12",
				labels: ["agent-ready"],
				open: true,
				createdAt: "2026-10-01T00:00:00Z",
			},
		]);
		expect(gh.calls[0]).toEqual(expect.arrayContaining(["--label", "agent-ready", "--label", "roadmap"]));
	});

	it("finds an issue's open pull request, else its latest", async () => {
		const prs = (states: string[]) =>
			JSON.stringify(
				states.map((state, index) => ({
					number: index + 1,
					url: `u${index + 1}`,
					state,
					headRefOid: SHA,
					isDraft: false,
					baseRefName: "main",
					mergeable: ["MERGEABLE", "CONFLICTING", "UNKNOWN"][index],
				})),
			);
		const open = new GitHubTracker(scriptedGh({ "pr list": prs(["CLOSED", "OPEN"]) }).run, "o/r", "bot");
		expect(await open.pullRequest("volt/issue-12")).toEqual({
			number: 2,
			url: "u2",
			state: "open",
			headSha: SHA,
			draft: false,
			baseRef: "main",
			mergeable: "conflicting",
		});
		const unknown = new GitHubTracker(scriptedGh({ "pr list": prs(["CLOSED", "CLOSED", "OPEN"]) }).run, "o/r", "bot");
		expect(await unknown.pullRequest("volt/issue-12")).toMatchObject({ number: 3, mergeable: "unknown" });
		const closed = new GitHubTracker(scriptedGh({ "pr list": prs(["CLOSED", "MERGED"]) }).run, "o/r", "bot");
		expect(await closed.pullRequest("volt/issue-12")).toMatchObject({ number: 2, state: "merged" });
		const none = new GitHubTracker(scriptedGh({ "pr list": "[]" }).run, "o/r", "bot");
		expect(await none.pullRequest("volt/issue-12")).toBeUndefined();
	});

	it("counts only the review author's verdicts", async () => {
		const comments = [
			{ author: { login: "bot" }, body: `Findings...\n${reviewMarker(SHA, "changes")}`, createdAt: "2026-10-02" },
			{ author: { login: "stranger" }, body: reviewMarker(SHA, "clean"), createdAt: "2026-10-03" },
			{ author: { login: "bot" }, body: "No marker here", createdAt: "2026-10-04" },
			{ author: { login: "bot" }, body: reviewMarker("b".repeat(40), "clean"), createdAt: "2026-10-01" },
		];
		const tracker = new GitHubTracker(scriptedGh({ "pr view 7": JSON.stringify({ comments }) }).run, "o/r", "bot");
		expect(await tracker.reviews(7)).toEqual([
			{ headSha: "b".repeat(40), verdict: "clean", createdAt: "2026-10-01" },
			{ headSha: SHA, verdict: "changes", createdAt: "2026-10-02" },
		]);
		expect(parseReviewMarkers("<!-- volt-orchestrator review head=abc verdict=clean -->", "t")).toEqual([]);

		// gh reports an app's comments as `volt-agent`, which REST calls `volt-agent[bot]`: either spelling counts.
		const bot = [{ author: { login: "volt-agent" }, body: reviewMarker(SHA, "clean"), createdAt: "2026-10-05" }];
		const asBot = new GitHubTracker(
			scriptedGh({ "pr view 8": JSON.stringify({ comments: bot }) }).run,
			"o/r",
			"volt-agent[bot]",
		);
		expect(await asBot.reviews(8)).toEqual([{ headSha: SHA, verdict: "clean", createdAt: "2026-10-05" }]);
		expect(sameLogin("app/volt-agent", "Volt-Agent[bot]")).toBe(true);
		expect(sameLogin("volt-agent", "volt-agent-two")).toBe(false);
	});

	it("reads checks: none, pending, failing, and passing", async () => {
		const checks = (stdout: string, code = 0, stderr = "") =>
			new GitHubTracker(scriptedGh({ "pr checks 7": { stdout, stderr, code } }).run, "o/r", "bot").checks(7);
		expect(await checks("", 1, "no checks reported on the 'volt/issue-12' branch")).toEqual({ state: "none" });
		expect(await checks(JSON.stringify([{ name: "ci", bucket: "pending" }]), 8)).toEqual({ state: "pending" });
		expect(
			await checks(
				JSON.stringify([
					{ name: "ci", bucket: "fail" },
					{ name: "lint", bucket: "pending" },
				]),
				1,
			),
		).toEqual({ state: "failing", failing: ["ci"] });
		expect(
			await checks(
				JSON.stringify([
					{ name: "ci", bucket: "pass" },
					{ name: "docs", bucket: "skipping" },
				]),
			),
		).toEqual({ state: "passing" });
		await expect(checks("", 1, "HTTP 502")).rejects.toThrow("HTTP 502");
	});

	it("tells merge commits by their parents, asking once per commit", async () => {
		const gh = scriptedGh({ [`api repos/o/r/commits/${SHA}`]: "2\n", "api repos/o/r/commits/bbb": "1\n" });
		const tracker = new GitHubTracker(gh.run, "o/r", "bot");
		expect(await tracker.isMergeCommit(SHA)).toBe(true);
		expect(await tracker.isMergeCommit(SHA)).toBe(true);
		expect(await tracker.isMergeCommit("bbb")).toBe(false);
		expect(gh.calls).toEqual([
			["api", `repos/o/r/commits/${SHA}`, "--jq", ".parents | length"],
			["api", "repos/o/r/commits/bbb", "--jq", ".parents | length"],
		]);
	});

	it("takes an approval back with a comment", async () => {
		const gh = scriptedGh({ "issue comment 12": "", "issue edit 12": "" });
		await new GitHubTracker(gh.run, "o/r", "bot").takeBack(12, "agent-approved", "Conflicts now");
		expect(gh.calls).toEqual([
			["issue", "comment", "12", "--repo", "o/r", "--body", "Conflicts now"],
			["issue", "edit", "12", "--repo", "o/r", "--remove-label", "agent-approved"],
		]);
	});

	it("merges, and hands off with a comment even when the label is missing", async () => {
		const gh = scriptedGh({
			"pr merge 7": "",
			"issue comment 12": "",
			"issue edit 12": { stdout: "", stderr: "'agent-needs-human' not found", code: 1 },
		});
		const tracker = new GitHubTracker(gh.run, "o/r", "bot");
		await tracker.merge(7, "squash");
		expect(await tracker.handOff(12, "agent-needs-human", "Stopped: why")).toBe(false);
		expect(gh.calls).toEqual([
			["pr", "merge", "7", "--repo", "o/r", "--squash"],
			["issue", "comment", "12", "--repo", "o/r", "--body", "Stopped: why"],
			["issue", "edit", "12", "--repo", "o/r", "--add-label", "agent-needs-human"],
		]);
	});
});
