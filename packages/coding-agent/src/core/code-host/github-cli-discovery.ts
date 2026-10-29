import { runGitHubCli } from "./github-cli.ts";
import type {
	CanonicalCodeHostRepository,
	CodeHostHeadPullRequest,
	CodeHostHeadPullRequestListRequest,
	CodeHostHeadPullRequestListResult,
	CodeHostPullRequestDiscoveryUnavailableReason,
	CodeHostPullRequestStatus,
	CodeHostPullRequestStatusOutcome,
	CodeHostPullRequestStatusProvider,
	CodeHostPullRequestStatusRequest,
	CodeHostPullRequestStatusTarget,
} from "./types.ts";

const MAX_GH_OUTPUT_BYTES = 256 * 1024;
const MAX_TITLE_CHARS = 512;
const GH_TIMEOUT_MS = 15_000;
const STATUS_CHUNK_SIZE = 50;
const MAX_GRAPHQL_INT = 2_147_483_647;
const STATUS_IDENTITY_FORBIDDEN_PATTERN = /[\0-\x20\x7f/]/;

function normalizedRepository(host: string, owner: string, name: string): CanonicalCodeHostRepository | null {
	const normalizedHost = host.trim().toLowerCase();
	const normalizedOwner = owner.trim().toLowerCase();
	const normalizedName = name
		.trim()
		.replace(/\.git$/i, "")
		.toLowerCase();
	if (
		!normalizedHost ||
		normalizedHost.length > 253 ||
		!normalizedOwner ||
		normalizedOwner.length > 100 ||
		!normalizedName ||
		normalizedName.length > 100 ||
		![normalizedHost, normalizedOwner, normalizedName].every((part) => !/[\0-\x20\x7f]/.test(part)) ||
		normalizedOwner.includes("/") ||
		normalizedName.includes("/")
	) {
		return null;
	}
	const path = `${normalizedOwner}/${normalizedName}`;
	return Object.freeze({
		providerId: "github",
		host: normalizedHost,
		path,
		canonicalId: `github:${normalizedHost}/${path}`,
	});
}

/** Parse ordinary GitHub and GHES HTTPS/SSH remote forms without retaining credentials. */
export function canonicalizeGitHubRemoteUrl(value: string): CanonicalCodeHostRepository | null {
	const trimmed = value.trim();
	if (!trimmed || /[\0\r\n]/.test(trimmed)) return null;

	const scp = /^(?:git@)?([^:/\s]+):([^/\s]+)\/(.+)$/.exec(trimmed);
	if (scp?.[1] && scp[2] && scp[3]) return normalizedRepository(scp[1], scp[2], scp[3]);

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return null;
	}
	if (!url.hostname || url.search || url.hash || (url.username && url.username !== "git") || url.password) return null;
	if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return null;
	const segments = url.pathname.split("/").filter(Boolean);
	if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
	return normalizedRepository(url.host, segments[0], segments[1]);
}

function repositorySlug(repository: CanonicalCodeHostRepository): string {
	return repository.host === "github.com" ? repository.path : `${repository.host}/${repository.path}`;
}

function unavailableReason(
	stderr: string,
	outputLimited: boolean,
	timedOut: boolean,
): CodeHostPullRequestDiscoveryUnavailableReason {
	if (outputLimited) return "output_limited";
	if (timedOut) return "timeout";
	const normalized = stderr.toLowerCase();
	if (/auth|login|credential|token/.test(normalized)) return "not_authenticated";
	if (/rate.?limit|secondary limit|abuse detection/.test(normalized)) return "rate_limited";
	if (/network|connection|resolve host|timed? out|tls|socket/.test(normalized)) return "network";
	return "provider_error";
}

function parsePullRequests(
	text: string,
	baseRepository: CanonicalCodeHostRepository,
): CodeHostHeadPullRequest[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed) || parsed.length > 100) return null;
	const pullRequests: CodeHostHeadPullRequest[] = [];
	for (const item of parsed) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
		const value = item as Record<string, unknown>;
		const headRepositoryValue = value.headRepository;
		const headOwnerValue = value.headRepositoryOwner;
		const headRepositoryObject =
			typeof headRepositoryValue === "object" && headRepositoryValue !== null && !Array.isArray(headRepositoryValue)
				? (headRepositoryValue as Record<string, unknown>)
				: null;
		const headOwnerObject =
			typeof headOwnerValue === "object" && headOwnerValue !== null && !Array.isArray(headOwnerValue)
				? (headOwnerValue as Record<string, unknown>)
				: null;
		const nameWithOwner =
			typeof headRepositoryObject?.nameWithOwner === "string"
				? headRepositoryObject.nameWithOwner
				: typeof headRepositoryObject?.name === "string" && typeof headOwnerObject?.login === "string"
					? `${headOwnerObject.login}/${headRepositoryObject.name}`
					: null;
		const headParts = nameWithOwner?.split("/") ?? [];
		const headRepository =
			headParts.length === 2 && headParts[0] && headParts[1]
				? normalizedRepository(baseRepository.host, headParts[0], headParts[1])
				: null;
		if (
			typeof value.number !== "number" ||
			!Number.isSafeInteger(value.number) ||
			value.number < 1 ||
			typeof value.title !== "string" ||
			typeof value.state !== "string" ||
			typeof value.isDraft !== "boolean" ||
			typeof value.headRefName !== "string" ||
			typeof value.headRefOid !== "string" ||
			!headRepository
		) {
			return null;
		}
		const state = value.state.toUpperCase();
		const status =
			state === "OPEN"
				? value.isDraft
					? "draft"
					: "open"
				: state === "MERGED"
					? "merged"
					: state === "CLOSED"
						? "closed"
						: null;
		if (!status) return null;
		pullRequests.push({
			number: value.number,
			title: value.title,
			status,
			headRepository,
			headBranch: value.headRefName,
			headOid: value.headRefOid,
		});
	}
	return pullRequests;
}

/** Every pull request into `repository` from a head branch named `branch`, in any state, by `gh pr list`. */
export async function listPullRequestsForHeadBranchWithGitHubCli(
	request: CodeHostHeadPullRequestListRequest,
): Promise<CodeHostHeadPullRequestListResult> {
	const result = await runGitHubCli(
		[
			"pr",
			"list",
			"--repo",
			repositorySlug(request.repository),
			"--state",
			"all",
			"--head",
			request.branch,
			"--limit",
			"100",
			"--json",
			"number,title,state,isDraft,headRefName,headRefOid,headRepository,headRepositoryOwner",
		],
		{
			cwd: request.cwd,
			...(request.signal === undefined ? {} : { signal: request.signal }),
			stdoutMaxBytes: MAX_GH_OUTPUT_BYTES,
			stderrMaxBytes: 32 * 1024,
			timeoutMs: GH_TIMEOUT_MS,
			cancellationMessage: "GitHub pull request discovery was cancelled.",
		},
	);
	if (!result.ok) {
		return { ok: false, reason: unavailableReason(result.stderr, result.outputLimited, result.timedOut) };
	}
	const pullRequests = parsePullRequests(result.stdout.toString("utf8"), request.repository);
	return pullRequests ? { ok: true, pullRequests } : { ok: false, reason: "invalid_response" };
}

interface StatusChunkEntry {
	readonly index: number;
	readonly owner: string;
	readonly name: string;
	readonly number: number;
}

interface StatusQuery {
	readonly query: string;
	readonly variables: Record<string, string | number>;
	/** Response aliases in chunk order. */
	readonly aliases: ReadonlyArray<{ readonly repository: string; readonly pullRequest: string }>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatusIdentityPart(value: unknown, maximum: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		!STATUS_IDENTITY_FORBIDDEN_PATTERN.test(value)
	);
}

/** A target whose path is a GitHub `owner/name` and whose number fits a GraphQL Int; null otherwise. */
function statusChunkEntry(target: CodeHostPullRequestStatusTarget, index: number): StatusChunkEntry | null {
	const [owner, name, ...rest] = target.path.split("/");
	if (
		rest.length > 0 ||
		!isStatusIdentityPart(owner, 100) ||
		!isStatusIdentityPart(name, 100) ||
		!Number.isSafeInteger(target.number) ||
		target.number < 1 ||
		target.number > MAX_GRAPHQL_INT
	) {
		return null;
	}
	return { index, owner, name, number: target.number };
}

/** Build one aliased query; every owner, name, and number travels as a GraphQL variable. */
function buildStatusQuery(chunk: readonly StatusChunkEntry[]): StatusQuery {
	const groups = new Map<string, { index: number; owner: string; name: string; members: number[] }>();
	chunk.forEach((entry, position) => {
		const key = `${entry.owner}\0${entry.name}`;
		let group = groups.get(key);
		if (!group) {
			group = { index: groups.size, owner: entry.owner, name: entry.name, members: [] };
			groups.set(key, group);
		}
		group.members.push(position);
	});
	const variables: Record<string, string | number> = {};
	const declarations: string[] = [];
	const selections: string[] = [];
	const aliases: Array<{ repository: string; pullRequest: string }> = [];
	for (const group of groups.values()) {
		const repositoryAlias = `r${group.index}`;
		variables[`o${group.index}`] = group.owner;
		variables[`n${group.index}`] = group.name;
		declarations.push(`$o${group.index}:String!`, `$n${group.index}:String!`);
		const fields = group.members.map((position, memberIndex) => {
			const variable = `p${group.index}_${memberIndex}`;
			const pullRequestAlias = `${repositoryAlias}p${memberIndex}`;
			variables[variable] = chunk[position]!.number;
			declarations.push(`$${variable}:Int!`);
			aliases[position] = { repository: repositoryAlias, pullRequest: pullRequestAlias };
			return `${pullRequestAlias}: pullRequest(number:$${variable}){ state isDraft title }`;
		});
		selections.push(
			`${repositoryAlias}: repository(owner:$o${group.index},name:$n${group.index}){ ${fields.join(" ")} }`,
		);
	}
	return {
		query: `query ChangePullRequestStatuses(${declarations.join(",")}){ ${selections.join(" ")} }`,
		variables,
		aliases,
	};
}

function hasRateLimitedGraphqlError(value: unknown): boolean {
	return (
		isJsonObject(value) &&
		Array.isArray(value.errors) &&
		value.errors.some((error) => isJsonObject(error) && error.type === "RATE_LIMITED")
	);
}

function parseStatusNode(value: unknown): CodeHostPullRequestStatusOutcome {
	// GitHub nulls a repository or pull request it cannot resolve for this viewer.
	if (value === null) return { state: "unavailable", reason: "provider_error" };
	if (
		!isJsonObject(value) ||
		typeof value.state !== "string" ||
		typeof value.isDraft !== "boolean" ||
		typeof value.title !== "string"
	) {
		return { state: "unavailable", reason: "invalid_response" };
	}
	let status: CodeHostPullRequestStatus;
	switch (value.state) {
		case "OPEN":
			status = value.isDraft ? "draft" : "open";
			break;
		case "MERGED":
			status = "merged";
			break;
		case "CLOSED":
			status = "closed";
			break;
		default:
			return { state: "unavailable", reason: "invalid_response" };
	}
	return { state: "resolved", status, title: value.title.slice(0, MAX_TITLE_CHARS) };
}

async function refreshStatusChunk(
	request: CodeHostPullRequestStatusRequest,
	chunk: readonly StatusChunkEntry[],
): Promise<CodeHostPullRequestStatusOutcome[]> {
	const unavailable = (reason: CodeHostPullRequestDiscoveryUnavailableReason): CodeHostPullRequestStatusOutcome[] =>
		chunk.map(() => ({ state: "unavailable", reason }));
	const { query, variables, aliases } = buildStatusQuery(chunk);
	let result: Awaited<ReturnType<typeof runGitHubCli>>;
	try {
		result = await runGitHubCli(["api", "graphql", "--hostname", request.host, "--input", "-"], {
			cwd: request.cwd,
			input: JSON.stringify({ query, variables }),
			...(request.signal === undefined ? {} : { signal: request.signal }),
			stdoutMaxBytes: MAX_GH_OUTPUT_BYTES,
			stderrMaxBytes: 32 * 1024,
			timeoutMs: GH_TIMEOUT_MS,
			cancellationMessage: "GitHub pull request status refresh was cancelled.",
		});
	} catch {
		return unavailable(request.signal?.aborted ? "cancelled" : "provider_error");
	}
	// `gh api graphql` exits non-zero when any aliased lookup fails, but still prints
	// the partial `data` for the others, so parse stdout regardless of exit status.
	let parsed: unknown;
	if (!result.outputLimited && !result.timedOut) {
		try {
			parsed = JSON.parse(result.stdout.toString("utf8"));
		} catch {
			parsed = undefined;
		}
	}
	const data = isJsonObject(parsed) ? parsed.data : undefined;
	if (!isJsonObject(data)) {
		if (hasRateLimitedGraphqlError(parsed)) return unavailable("rate_limited");
		return unavailable(
			result.ok ? "invalid_response" : unavailableReason(result.stderr, result.outputLimited, result.timedOut),
		);
	}
	return aliases.map((alias) => {
		const repository = data[alias.repository];
		if (repository === null) return { state: "unavailable", reason: "provider_error" };
		if (!isJsonObject(repository) || !Object.hasOwn(repository, alias.pullRequest)) {
			return { state: "unavailable", reason: "invalid_response" };
		}
		return parseStatusNode(repository[alias.pullRequest]);
	});
}

/** Refresh the status of already-associated pull requests with batched GraphQL queries. */
export async function refreshPullRequestStatusesWithGitHubCli(
	request: CodeHostPullRequestStatusRequest,
): Promise<CodeHostPullRequestStatusOutcome[]> {
	const outcomes: CodeHostPullRequestStatusOutcome[] = request.pullRequests.map(() => ({
		state: "unavailable",
		reason: "invalid_response",
	}));
	if (!isStatusIdentityPart(request.host, 253) || request.host.startsWith("-")) return outcomes;
	const valid: StatusChunkEntry[] = [];
	request.pullRequests.forEach((target, index) => {
		const entry = statusChunkEntry(target, index);
		if (entry) valid.push(entry);
	});
	for (let offset = 0; offset < valid.length; offset += STATUS_CHUNK_SIZE) {
		const chunk = valid.slice(offset, offset + STATUS_CHUNK_SIZE);
		const chunkOutcomes: CodeHostPullRequestStatusOutcome[] = request.signal?.aborted
			? chunk.map(() => ({ state: "unavailable", reason: "cancelled" }))
			: await refreshStatusChunk(request, chunk);
		chunk.forEach((entry, position) => {
			outcomes[entry.index] = chunkOutcomes[position]!;
		});
	}
	return outcomes;
}

export const githubCliPullRequestStatusProvider: CodeHostPullRequestStatusProvider = {
	id: "github",
	refreshPullRequestStatuses: refreshPullRequestStatusesWithGitHubCli,
};
