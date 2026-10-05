// Requires GitHub CLI (`gh`) and a GitHub repository checkout.
// Preloads the latest open issues once per session, then filters them locally for fast `#...` completion.
// A completion provider answers every client's editor completions with items: the host asks it when the
// token before the cursor starts with its trigger (`#`), waits at most a second, and keeps 50 items.

import { defineManifest, type ExtensionAPI, type ExtensionCompletionItem } from "@hansjm10/volt-coding-agent";

type GitHubIssue = {
	number: number;
	title: string;
	state: string;
};

type RepoResolution = { ok: true; repo: string } | { ok: false; error: string };

const MAX_ISSUES = 100;
const MAX_SUGGESTIONS = 20;

function parseGitHubRepo(remoteUrl: string): string | undefined {
	const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) {
		return sshMatch[1];
	}

	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	return undefined;
}

async function resolveGitHubRepo(volt: ExtensionAPI, cwd: string): Promise<RepoResolution> {
	const result = await volt.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
	if (result.code !== 0) {
		return { ok: false, error: "github-issue-autocomplete: cwd is not a git repository" };
	}

	for (const line of result.stdout.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const remoteUrl = columns[1];
		if (!remoteUrl) {
			continue;
		}
		const repo = parseGitHubRepo(remoteUrl);
		if (repo) {
			return { ok: true, repo };
		}
	}

	return { ok: false, error: "github-issue-autocomplete: cwd is not a GitHub repository" };
}

function formatIssueItem(issue: GitHubIssue): ExtensionCompletionItem {
	return {
		value: `#${issue.number}`,
		label: `#${issue.number}`,
		description: `[${issue.state.toLowerCase()}] ${issue.title}`,
	};
}

/** Whether every character of `query` appears in `text` in order, ignoring case. */
function matchesInOrder(text: string, query: string): boolean {
	let index = 0;
	for (const character of text.toLowerCase()) {
		if (character === query[index]) index++;
		if (index === query.length) return true;
	}
	return index === query.length;
}

function filterIssues(issues: GitHubIssue[], query: string): ExtensionCompletionItem[] {
	if (!query.trim()) {
		return issues.slice(0, MAX_SUGGESTIONS).map(formatIssueItem);
	}

	if (/^\d+$/.test(query)) {
		const numericMatches = issues
			.filter((issue) => String(issue.number).startsWith(query))
			.slice(0, MAX_SUGGESTIONS)
			.map(formatIssueItem);
		if (numericMatches.length > 0) {
			return numericMatches;
		}
	}

	const lowered = query.toLowerCase();
	return issues
		.filter((issue) => matchesInOrder(`${issue.number} ${issue.title}`, lowered))
		.slice(0, MAX_SUGGESTIONS)
		.map(formatIssueItem);
}

export const manifest = defineManifest({
	id: "github-issue-autocomplete",
	displayName: "GitHub Issue Autocomplete",
	permissions: ["exec"],
});

export default function (volt: ExtensionAPI): void {
	// The open issues of the session's repository, loaded once when the session starts.
	let getIssues: () => Promise<GitHubIssue[] | undefined> = async () => undefined;

	volt.registerCompletionProvider("issues", {
		trigger: "#",
		complete: async ({ query, signal }) => {
			const issues = await getIssues();
			if (signal.aborted || !issues) return undefined;
			return filterIssues(issues, query);
		},
	});

	volt.on("session_start", async (_event, ctx) => {
		const resolvedRepo = await resolveGitHubRepo(volt, ctx.cwd);
		if (!resolvedRepo.ok) {
			ctx.ui.notify(resolvedRepo.error, "error");
			return;
		}

		const repo = resolvedRepo.repo;
		let issuesPromise: Promise<GitHubIssue[] | undefined> | undefined;
		let loadErrorShown = false;

		getIssues = async (): Promise<GitHubIssue[] | undefined> => {
			issuesPromise ||= (async () => {
				const result = await volt.exec(
					"gh",
					[
						"issue",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--limit",
						String(MAX_ISSUES),
						"--json",
						"number,title,state",
					],
					{ cwd: ctx.cwd, timeout: 5_000 },
				);
				if (result.code !== 0) {
					if (!loadErrorShown) {
						loadErrorShown = true;
						const details = result.stderr.trim() || `exit code ${result.code}`;
						ctx.ui.notify(`github-issue-autocomplete: failed to load issues: ${details}`, "error");
					}
					return undefined;
				}

				try {
					return JSON.parse(result.stdout) as GitHubIssue[];
				} catch {
					if (!loadErrorShown) {
						loadErrorShown = true;
						ctx.ui.notify("github-issue-autocomplete: failed to parse gh issue list output", "error");
					}
					return undefined;
				}
			})();
			return issuesPromise;
		};

		void getIssues();
	});
}
