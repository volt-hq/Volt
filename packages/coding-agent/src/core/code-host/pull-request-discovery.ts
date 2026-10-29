import { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";
import type {
	CanonicalCodeHostRepository,
	CodeHostProvider,
	CodeHostPullRequestAssociation,
	CodeHostPullRequestDiscoveryOutcome,
	CodeHostPullRequestDiscoveryRequest,
} from "./types.ts";

const MAX_REMOTES = 16;
const MAX_REPOSITORIES = 8;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_BRANCH_CHARS = 1024;
const MAX_TITLE_CHARS = 512;
const GIT_TIMEOUT_MS = 2500;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_NAME_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const PULL_REQUEST_STATUSES: ReadonlySet<unknown> = new Set(["open", "draft", "merged", "closed"]);

interface GitCommandResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly failure: "exit" | "spawn" | "timeout" | "output" | "cancelled" | null;
}

interface RemoteRepository {
	readonly remote: string;
	readonly repository: CanonicalCodeHostRepository;
}

type Canonicalize = (url: string) => CanonicalCodeHostRepository | null;

function createGitEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CEILING_DIRECTORIES",
		"GIT_CONFIG",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_SYSTEM",
		"GIT_CONFIG_COUNT",
	]) {
		delete environment[key];
	}
	for (const key of Object.keys(environment)) {
		if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete environment[key];
	}
	environment.GIT_TERMINAL_PROMPT = "0";
	environment.GIT_OPTIONAL_LOCKS = "0";
	environment.GIT_PAGER = "cat";
	environment.LC_ALL = "C";
	return environment;
}

function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ ok: false, stdout: "", failure: "cancelled" });
			return;
		}
		const child: ChildProcess = spawnProcess("git", [...args], {
			cwd,
			env: createGitEnvironment(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let byteCount = 0;
		let failure: GitCommandResult["failure"] = null;
		let settled = false;
		const terminate = (): void => {
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const timeout = setTimeout(() => {
			if (failure === null) failure = "timeout";
			terminate();
		}, GIT_TIMEOUT_MS);
		timeout.unref?.();
		const onAbort = (): void => {
			if (failure === null) failure = "cancelled";
			terminate();
		};
		const finish = (result: GitCommandResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failure !== null) return;
			byteCount += chunk.length;
			if (byteCount > MAX_GIT_OUTPUT_BYTES) {
				failure = "output";
				terminate();
				return;
			}
			chunks.push(chunk);
		});
		child.once("error", () => {
			failure = "spawn";
			finish({ ok: false, stdout: "", failure });
		});
		child.once("close", (code) => {
			const finalFailure = failure ?? (code === 0 ? null : "exit");
			finish({
				ok: finalFailure === null,
				stdout: finalFailure === null ? Buffer.concat(chunks, byteCount).toString("utf8") : "",
				failure: finalFailure,
			});
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

/** The repository the first provider in registration order recognizes a remote URL as. */
function canonicalizer(providers: readonly CodeHostProvider[]): Canonicalize {
	return (url) => {
		for (const provider of providers) {
			const repository = provider.canonicalizeRemoteUrl(url);
			if (repository) return repository;
		}
		return null;
	};
}

async function discoverRemoteRepositories(
	request: CodeHostPullRequestDiscoveryRequest,
	canonicalize: Canonicalize,
): Promise<RemoteRepository[] | CodeHostPullRequestDiscoveryOutcome> {
	const remotesResult = await runGit(["remote"], request.cwd, request.signal);
	if (!remotesResult.ok) {
		return {
			state: "unavailable",
			reason: remotesResult.failure === "cancelled" ? "cancelled" : "provider_error",
		};
	}
	const remoteNames = remotesResult.stdout
		.split(/\r?\n/)
		.map((name) => name.trim())
		.filter((name) => REMOTE_NAME_PATTERN.test(name))
		.slice(0, MAX_REMOTES);
	const repositories: RemoteRepository[] = [];
	for (const remote of remoteNames) {
		const urls = await runGit(["remote", "get-url", "--all", remote], request.cwd, request.signal);
		if (!urls.ok) {
			if (urls.failure === "cancelled") return { state: "unavailable", reason: "cancelled" };
			continue;
		}
		for (const line of urls.stdout.split(/\r?\n/)) {
			const repository = canonicalize(line);
			if (repository) repositories.push({ remote, repository });
		}
	}
	return repositories;
}

function remoteForTrackingRef(ref: string, remotes: readonly RemoteRepository[], branch: string): string | null {
	const expectedSuffix = `/${branch}`;
	if (!ref.endsWith(expectedSuffix)) return null;
	const remote = remotes
		.map((candidate) => candidate.remote)
		.sort((left, right) => right.length - left.length)
		.find((candidate) => ref === `${candidate}/${branch}`);
	return remote ?? null;
}

/**
 * The repository and branch the observed local branch's head is in: its tracked remote branch, else a remote whose
 * tracking ref of the same name is at the head commit, else the only repository the remotes name.
 */
async function selectHeadTarget(
	request: CodeHostPullRequestDiscoveryRequest,
	remotes: readonly RemoteRepository[],
	canonicalize: Canonicalize,
): Promise<{ repository: CanonicalCodeHostRepository; branch: string } | CodeHostPullRequestDiscoveryOutcome> {
	const candidates = new Map<string, CanonicalCodeHostRepository>();
	const addRemote = (remote: string | null): void => {
		if (!remote) return;
		for (const candidate of remotes) {
			if (candidate.remote === remote) candidates.set(candidate.repository.canonicalId, candidate.repository);
		}
	};

	const localRef = `refs/heads/${request.branch}`;
	const upstream = await runGit(
		["for-each-ref", "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)", localRef],
		request.cwd,
		request.signal,
	);
	if (!upstream.ok) {
		return { state: "unavailable", reason: upstream.failure === "cancelled" ? "cancelled" : "provider_error" };
	}
	if (upstream.stdout.trim()) {
		const [observedRef, remote, remoteRef, extra] = upstream.stdout.trim().split("\0");
		if (observedRef !== localRef || remote === undefined || remoteRef === undefined || extra !== undefined) {
			return { state: "unavailable", reason: "invalid_response" };
		}
		if (remote && remote !== ".") {
			const branch = remoteRef.startsWith("refs/heads/") ? remoteRef.slice("refs/heads/".length) : "";
			if (
				!REMOTE_NAME_PATTERN.test(remote) ||
				!branch ||
				branch.length > MAX_BRANCH_CHARS ||
				/[\0\r\n]/.test(branch)
			) {
				return { state: "unavailable", reason: "invalid_response" };
			}
			// Revalidate every URL of the selected remote: discovery omits unsupported URLs.
			// A mixed supported/credential-bearing remote must not become a partial match.
			const urls = await runGit(["remote", "get-url", "--all", remote], request.cwd, request.signal);
			if (!urls.ok) {
				return { state: "unavailable", reason: urls.failure === "cancelled" ? "cancelled" : "provider_error" };
			}
			for (const url of urls.stdout.trim().split(/\r?\n/)) {
				const repository = canonicalize(url);
				if (!repository) return { state: "unavailable", reason: "unsupported_repository" };
				candidates.set(repository.canonicalId, repository);
			}
			if (candidates.size !== 1) return { state: "unavailable", reason: "repository_ambiguous" };
			const repository = candidates.values().next().value!;
			if (
				!remotes.some(
					(candidate) =>
						candidate.remote === remote && candidate.repository.canonicalId === repository.canonicalId,
				)
			) {
				return { state: "unavailable", reason: "repository_ambiguous" };
			}
			return { repository, branch };
		}
		if (!remote && remoteRef) return { state: "unavailable", reason: "invalid_response" };
	}

	if (candidates.size === 0) {
		const refs = await runGit(
			["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/remotes"],
			request.cwd,
			request.signal,
		);
		if (refs.failure === "cancelled") return { state: "unavailable", reason: "cancelled" };
		if (!refs.ok && refs.failure !== "exit") return { state: "unavailable", reason: "provider_error" };
		for (const line of refs.stdout.split(/\r?\n/)) {
			const [ref, oid] = line.split("\0");
			if (!ref || oid?.toLowerCase() !== request.headOid) continue;
			const shortRef = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : "";
			addRemote(remoteForTrackingRef(shortRef, remotes, request.branch));
		}
	}

	if (candidates.size === 0) {
		for (const candidate of remotes) candidates.set(candidate.repository.canonicalId, candidate.repository);
	}
	if (candidates.size !== 1) return { state: "unavailable", reason: "repository_ambiguous" };
	return { repository: candidates.values().next().value!, branch: request.branch };
}

/**
 * The pull request a session's branch and head belong to, across the registered code-host providers: the provider
 * that recognizes the head repository lists the base repositories' pull requests from its branch, and only those at
 * exactly the observed head commit match. One open or draft match wins over historical ones; more than one of the
 * same kind is ambiguous, never guessed.
 */
export async function discoverPullRequest(
	request: CodeHostPullRequestDiscoveryRequest,
	providers: readonly CodeHostProvider[],
): Promise<CodeHostPullRequestDiscoveryOutcome> {
	const branch = request.branch.trim();
	const headOid = request.headOid.toLowerCase();
	if (!branch || branch.length > MAX_BRANCH_CHARS || /[\0\r\n]/.test(branch) || !OID_PATTERN.test(headOid)) {
		return { state: "unavailable", reason: "invalid_response" };
	}
	if (request.signal?.aborted) return { state: "unavailable", reason: "cancelled" };

	const canonicalize = canonicalizer(providers);
	const normalized = { ...request, branch, headOid };
	const discovered = await discoverRemoteRepositories(normalized, canonicalize);
	if (!Array.isArray(discovered)) return discovered;
	if (discovered.length === 0) return { state: "unavailable", reason: "unsupported_repository" };
	const headTarget = await selectHeadTarget(normalized, discovered, canonicalize);
	if ("state" in headTarget) return headTarget;
	const head = headTarget.repository;
	const provider = providers.find((candidate) => candidate.id === head.providerId);
	if (!provider?.listPullRequestsForHeadBranch) return { state: "unavailable", reason: "unsupported_repository" };

	// Base candidates: every repository the remotes name on the head's provider and host, such as a fork's parent.
	const repositories = new Map<string, CanonicalCodeHostRepository>();
	for (const { repository } of discovered) {
		if (repository.providerId === head.providerId && repository.host === head.host) {
			repositories.set(repository.canonicalId, repository);
		}
	}
	if (repositories.size > MAX_REPOSITORIES) return { state: "unavailable", reason: "repository_ambiguous" };

	const matches = new Map<string, CodeHostPullRequestAssociation>();
	try {
		for (const repository of repositories.values()) {
			const listed = await provider.listPullRequestsForHeadBranch({
				cwd: request.cwd,
				repository,
				branch: headTarget.branch,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
			if (!listed.ok) return { state: "unavailable", reason: listed.reason };
			if (!Array.isArray(listed.pullRequests)) return { state: "unavailable", reason: "invalid_response" };
			for (const pullRequest of listed.pullRequests) {
				if (
					typeof pullRequest !== "object" ||
					pullRequest === null ||
					!Number.isSafeInteger(pullRequest.number) ||
					pullRequest.number < 1 ||
					typeof pullRequest.title !== "string" ||
					!PULL_REQUEST_STATUSES.has(pullRequest.status) ||
					typeof pullRequest.headRepository !== "object" ||
					pullRequest.headRepository === null ||
					typeof pullRequest.headRepository.canonicalId !== "string" ||
					typeof pullRequest.headBranch !== "string" ||
					typeof pullRequest.headOid !== "string"
				) {
					return { state: "unavailable", reason: "invalid_response" };
				}
				if (
					pullRequest.headRepository.canonicalId !== head.canonicalId ||
					pullRequest.headBranch !== headTarget.branch ||
					pullRequest.headOid.toLowerCase() !== headOid
				) {
					continue;
				}
				matches.set(`${repository.canonicalId}#${pullRequest.number}`, {
					providerId: head.providerId,
					repository,
					headRepository: head,
					number: pullRequest.number,
					title: pullRequest.title.slice(0, MAX_TITLE_CHARS),
					status: pullRequest.status,
					headBranch: headTarget.branch,
					matchedHeadOid: headOid,
				});
			}
		}
	} catch {
		return {
			state: "unavailable",
			reason: request.signal?.aborted ? "cancelled" : "provider_error",
		};
	}

	const candidates = [...matches.values()];
	const active = candidates.filter((candidate) => candidate.status === "open" || candidate.status === "draft");
	if (active.length === 1) return { state: "resolved", pullRequest: active[0]! };
	if (active.length > 1) return { state: "ambiguous" };
	const historical = candidates.filter((candidate) => candidate.status === "merged" || candidate.status === "closed");
	if (historical.length === 1) return { state: "resolved", pullRequest: historical[0]! };
	if (historical.length > 1) return { state: "ambiguous" };
	return { state: "none" };
}
