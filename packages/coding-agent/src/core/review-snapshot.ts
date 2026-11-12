import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnProcess } from "../utils/child-process.ts";
import { terminateProcessTree } from "../utils/shell.ts";
import { normalizeReviewPath, reviewPathFromBytes, reviewPathToUtf8 } from "./review-path.ts";

export { normalizeReviewPath } from "./review-path.ts";

import {
	type CodeHostProvider,
	type PullRequestFetchPlan,
	type ReviewCodeHostContext,
	type ReviewPullRequestIdentity,
	resolveCodeHostProvider,
} from "./code-host/index.ts";

export type { ReviewPullRequestIdentity } from "./code-host/index.ts";

export type ReviewBranchBase = { kind: "local"; ref: string } | { kind: "remote"; remote: string; remoteRef: string };

export type ReviewTarget =
	| { kind: "uncommitted" }
	| { kind: "branch"; base?: string; branchBase?: never }
	| { kind: "branch"; branchBase: ReviewBranchBase; base?: never }
	| { kind: "branch_uncommitted"; base?: string; branchBase?: never }
	| { kind: "branch_uncommitted"; branchBase: ReviewBranchBase; base?: never }
	| { kind: "pr"; number?: string; expectedUrl?: string }
	| { kind: "commit"; sha?: string };

export type ReviewSnapshotRevision = "base" | "head";
export type ReviewSnapshotSide = ReviewSnapshotRevision;
export type ReviewChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "type-changed";

export interface ReviewSnapshotTreeEntry {
	path: string;
	mode: string;
	type: "blob" | "tree" | "commit";
	oid: string;
	size?: number;
}

export interface ReviewSnapshotLineRange {
	startLine: number;
	endLine: number;
}

export interface ReviewSnapshotHunk {
	id: string;
	path: string;
	header: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	baseChangedLines: ReviewSnapshotLineRange[];
	headChangedLines: ReviewSnapshotLineRange[];
	patch: string;
}

export interface ReviewChangedFile {
	path: string;
	previousPath?: string;
	status: ReviewChangedFileStatus;
	base?: ReviewSnapshotTreeEntry;
	head?: ReviewSnapshotTreeEntry;
	hunks: ReviewSnapshotHunk[];
	additions?: number;
	deletions?: number;
	binary: boolean;
	reviewable: boolean;
	unsupportedReason?: string;
}

export interface ReviewSnapshotIdentity {
	kind: ReviewTarget["kind"];
	baseTree: string;
	headTree: string;
	baseCommit?: string;
	mergeBaseCommit?: string;
	headCommit?: string;
	pullRequest?: ReviewPullRequestIdentity;
}

export type ReviewSnapshotFile =
	| {
			available: true;
			entry: ReviewSnapshotTreeEntry;
			content: Buffer;
			binary: boolean;
			lineCount?: number;
	  }
	| {
			available: false;
			entry: ReviewSnapshotTreeEntry;
			reason: "oversized" | "output-limit" | "read-failed";
			message: string;
	  };

export interface ReviewSnapshotPage {
	text: string;
	startByte: number;
	endByte: number;
	totalBytes: number;
	nextOffset?: number;
}

export interface ReviewSnapshotListOptions {
	revision?: ReviewSnapshotRevision;
	prefix?: string;
}

export interface ReviewSnapshotSearchOptions {
	revision: ReviewSnapshotRevision;
	query: string;
	/** A file or directory to search within; the whole tree when omitted. */
	prefix?: string;
	ignoreCase?: boolean;
	/** The matches to skip before the page: how many the pages before it returned. */
	offset?: number;
	/** The most matches a page returns. */
	limit: number;
	signal?: AbortSignal;
}

export interface ReviewSnapshotSearchMatch {
	path: string;
	line: number;
	text: string;
}

export interface ReviewSnapshotSearchResult {
	matches: ReviewSnapshotSearchMatch[];
	/** Whether the search reached its end; `false` when more matches follow this page. */
	complete: boolean;
}

export interface ReviewSnapshot {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	codeHostContext?: ReviewCodeHostContext;
	identity: ReviewSnapshotIdentity;
	branchBase?: ReviewBranchBase;
	changedFiles: ReviewChangedFile[];
	root: string;
	/** The repository's Git common directory, its symlinks resolved: the same in every worktree of the repository. */
	commonDirectory: string;
	readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined>;
	listFiles(options?: ReviewSnapshotListOptions): Promise<ReviewSnapshotTreeEntry[]>;
	/**
	 * One page of the lines that contain `query`, a literal string, found by `git grep` on the revision's tree and in
	 * its order. Git's rules apply: a file with a NUL among its first 8,000 bytes is binary and is not searched, a file
	 * of any size is, and `ignoreCase` folds letters outside ASCII only where Git has a UTF-8 locale. A match's text
	 * is the first 500 characters of its line.
	 */
	search(options: ReviewSnapshotSearchOptions): Promise<ReviewSnapshotSearchResult>;
	materializeHead(): Promise<string>;
	/**
	 * Return `directory`, a checkout {@link materializeHead} made, to the reviewed head: tracked files restored and
	 * untracked ones removed, nested repositories included, while ignored ones (what a setup installed) stay. The same
	 * goes inside every populated submodule, nested ones included, whether initialized or a repository a setup cloned
	 * there: each is returned to the commit the head records and stays populated, and one not populated is left alone.
	 * Rejects when the checkout's Git directory, or a submodule's, is outside the checkout or shared with another.
	 * Aborting `signal` stops it and rejects, leaving the checkout only partly reset.
	 */
	resetHead(directory: string, signal?: AbortSignal): Promise<void>;
	dispose(): Promise<void>;
}

export interface ReviewSnapshotResolutionError {
	error: string;
	remoteError?: string;
	cancelled?: true;
}

export interface ResolveReviewSnapshotOptions {
	maxCommitRefBytes: number;
	maxPullRequestNumber: number;
	codeHostProvider?: CodeHostProvider;
	/**
	 * A pull request snapshot also carries the code host's context for it (linked issues, comments, reviews, and
	 * threads) unless this is `false`: the snapshot then has the pull request's identity only, no `codeHostContext`,
	 * and so none of the protections that context brings (a context-blind presentation pass).
	 */
	pullRequestContext?: boolean;
	limits?: Partial<ReviewSnapshotLimits>;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

interface ReviewSnapshotLimits {
	maxMetadataBytes: number;
	maxStderrBytes: number;
	maxPatchBytes: number;
	maxRetainedPatchBytes: number;
	maxBlobBytes: number;
}

interface CommandOutputLimitFailure {
	kind: "output-limit";
	stream: "stdout" | "stderr";
	limit: number;
}

interface CommandResult {
	ok: boolean;
	exitCode: number | null;
	stdout: Buffer;
	stderr: string;
	failure?: CommandOutputLimitFailure;
}

interface GitSource {
	cwd: string;
	env?: Record<string, string>;
	objectDirectories: string[];
	limits: ReviewSnapshotLimits;
	signal?: AbortSignal;
}

interface SnapshotInit {
	description: string;
	workflowDescription?: string;
	diffCommand: string;
	extraContext?: string;
	codeHostContext?: ReviewCodeHostContext;
	identity: ReviewSnapshotIdentity;
	branchBase?: ReviewBranchBase;
	root: string;
	source: GitSource;
	temporaryDirectories: string[];
	limits: ReviewSnapshotLimits;
}

const CANONICAL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const MAX_STABLE_CAPTURE_ATTEMPTS = 3;
/**
 * Git reads a blob as binary when a NUL is among its first 8,000 bytes (`buffer_is_binary`). `git grep -I` on a tree
 * object decides by that alone, so file reads decide the same way and agree with search.
 */
const BINARY_PROBE_BYTES = 8_000;
/** A search match shows at most this many characters of its line. */
const SEARCH_MATCH_TEXT_MAX_CHARS = 500;
/** The bytes of a matching line kept to cut that text from: 500 characters are at most 1,500 bytes of UTF-8. */
const SEARCH_MATCH_TEXT_KEEP_BYTES = 2_048;
/** The most a match's path and line number may take in `git grep` output. */
const SEARCH_MATCH_HEADER_MAX_BYTES = 64 * 1024;
const DEFAULT_REVIEW_SNAPSHOT_LIMITS: ReviewSnapshotLimits = {
	maxMetadataBytes: 32 * 1024 * 1024,
	maxStderrBytes: 64 * 1024,
	maxPatchBytes: 4 * 1024 * 1024,
	maxRetainedPatchBytes: 32 * 1024 * 1024,
	maxBlobBytes: 8 * 1024 * 1024,
};

function normalizeLimit(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
	return value;
}

function normalizeSnapshotLimits(overrides: Partial<ReviewSnapshotLimits> | undefined): ReviewSnapshotLimits {
	return {
		maxMetadataBytes: normalizeLimit(
			overrides?.maxMetadataBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxMetadataBytes,
			"maxMetadataBytes",
		),
		maxStderrBytes: normalizeLimit(
			overrides?.maxStderrBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxStderrBytes,
			"maxStderrBytes",
		),
		maxPatchBytes: normalizeLimit(
			overrides?.maxPatchBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxPatchBytes,
			"maxPatchBytes",
		),
		maxRetainedPatchBytes: normalizeLimit(
			overrides?.maxRetainedPatchBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxRetainedPatchBytes,
			"maxRetainedPatchBytes",
		),
		maxBlobBytes: normalizeLimit(
			overrides?.maxBlobBytes,
			DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxBlobBytes,
			"maxBlobBytes",
		),
	};
}

function formatByteLimit(bytes: number): string {
	if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
	if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
	return `${bytes} bytes`;
}

function runCommand(
	command: string,
	args: string[],
	cwd: string,
	options: {
		env?: Record<string, string>;
		input?: Buffer | string;
		signal?: AbortSignal;
		maxStdoutBytes?: number;
		maxStderrBytes?: number;
	} = {},
): Promise<CommandResult> {
	return new Promise((resolveResult) => {
		const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxMetadataBytes;
		const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_REVIEW_SNAPSHOT_LIMITS.maxStderrBytes;
		const proc = spawnProcess(command, args, {
			cwd,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		let stdout: Buffer[] = [];
		let stdoutBytes = 0;
		let stderr: Buffer[] = [];
		let stderrBytes = 0;
		let failure: CommandOutputLimitFailure | undefined;
		let processError: string | undefined;
		let terminationPromise: Promise<void> | undefined;
		let finishing = false;
		let settled = false;
		const onAbort = (): void => {
			proc.stdin?.destroy();
			terminationPromise ??= proc.pid
				? terminateProcessTree(proc.pid, () => proc.exitCode !== null || proc.signalCode !== null)
				: Promise.resolve().then(() => {
						proc.kill();
					});
		};
		const finish = (result: CommandResult): void => {
			if (settled || finishing) return;
			finishing = true;
			const settle = (): void => {
				if (settled) return;
				settled = true;
				options.signal?.removeEventListener("abort", onAbort);
				resolveResult(result);
			};
			if (terminationPromise) void terminationPromise.then(settle);
			else settle();
		};
		const exceed = (stream: CommandOutputLimitFailure["stream"], limit: number): void => {
			if (failure) return;
			failure = { kind: "output-limit", stream, limit };
			stdout = [];
			stderr = [];
			proc.kill();
		};
		proc.stdout?.on("data", (data: Buffer) => {
			if (failure) return;
			stdoutBytes += data.length;
			if (stdoutBytes > maxStdoutBytes) exceed("stdout", maxStdoutBytes);
			else stdout.push(data);
		});
		proc.stderr?.on("data", (data: Buffer) => {
			if (failure) return;
			stderrBytes += data.length;
			if (stderrBytes > maxStderrBytes) exceed("stderr", maxStderrBytes);
			else stderr.push(data);
		});
		proc.on("error", (error) => {
			if (failure) return;
			if (error.name === "AbortError") {
				processError = error.message;
				return;
			}
			finish({ ok: false, exitCode: null, stdout: Buffer.concat(stdout), stderr: error.message });
		});
		proc.on("close", (code) => {
			if (failure) {
				finish({ ok: false, exitCode: code, stdout: Buffer.alloc(0), stderr: "", failure });
				return;
			}
			finish({
				ok: code === 0 && processError === undefined,
				exitCode: code,
				stdout: Buffer.concat(stdout, stdoutBytes),
				stderr: processError ?? Buffer.concat(stderr, stderrBytes).toString("utf8"),
			});
		});
		proc.stdin?.on("error", () => {});
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		else if (options.input !== undefined) proc.stdin?.end(options.input);
	});
}

/**
 * Run a command whose stdout is read as it arrives and never held whole. `onStdout` returns `false` to stop the
 * command early; aborting `signal` or passing the stderr limit stops it too. Stopping ends the command's process
 * tree, and the result settles only once the process has closed. A stopped command's exit code says nothing about
 * it. Rejects with whatever `onStdout` throws, after stopping the command.
 */
function streamCommand(
	command: string,
	args: string[],
	cwd: string,
	options: {
		env?: Record<string, string>;
		signal?: AbortSignal;
		maxStderrBytes: number;
		onStdout: (chunk: Buffer) => boolean;
	},
): Promise<Pick<CommandResult, "exitCode" | "stderr" | "failure">> {
	return new Promise((resolveResult, rejectResult) => {
		const proc = spawnProcess(command, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: options.env ? { ...process.env, ...options.env } : process.env,
		});
		let stderr: Buffer[] = [];
		let stderrBytes = 0;
		let failure: CommandOutputLimitFailure | undefined;
		let readError: { error: unknown } | undefined;
		let stopped = false;
		let terminationPromise: Promise<void> | undefined;
		let finishing = false;
		const stop = (): void => {
			stopped = true;
			// A process that already exited has no tree left to end, and its id may by now be another's.
			if (terminationPromise || proc.exitCode !== null || proc.signalCode !== null) return;
			terminationPromise = proc.pid
				? terminateProcessTree(proc.pid, () => proc.exitCode !== null || proc.signalCode !== null)
				: Promise.resolve().then(() => {
						proc.kill();
					});
		};
		const finish = (exitCode: number | null, processError?: string): void => {
			if (finishing) return;
			finishing = true;
			const settle = (): void => {
				options.signal?.removeEventListener("abort", stop);
				if (readError) {
					rejectResult(readError.error);
					return;
				}
				resolveResult({
					exitCode,
					stderr: processError ?? Buffer.concat(stderr, stderrBytes).toString("utf8"),
					...(failure ? { failure } : {}),
				});
			};
			if (terminationPromise) void terminationPromise.then(settle, settle);
			else settle();
		};
		proc.stdout?.on("data", (data: Buffer) => {
			if (stopped) return;
			try {
				if (!options.onStdout(data)) stop();
			} catch (error) {
				readError = { error };
				stop();
			}
		});
		proc.stderr?.on("data", (data: Buffer) => {
			if (failure) return;
			stderrBytes += data.length;
			if (stderrBytes <= options.maxStderrBytes) {
				stderr.push(data);
				return;
			}
			failure = { kind: "output-limit", stream: "stderr", limit: options.maxStderrBytes };
			stderr = [];
			stderrBytes = 0;
			stop();
		});
		proc.on("error", (error) => finish(null, error.message));
		proc.on("close", (code) => finish(code));
		options.signal?.addEventListener("abort", stop, { once: true });
		if (options.signal?.aborted) stop();
	});
}

async function git(
	source: Pick<GitSource, "cwd" | "env" | "limits" | "signal">,
	args: string[],
	input?: Buffer | string,
	maxStdoutBytes = source.limits.maxMetadataBytes,
): Promise<CommandResult> {
	throwIfResolutionCancelled(source.signal);
	const result = await runCommand("git", args, source.cwd, {
		env: source.env,
		input,
		signal: source.signal,
		maxStdoutBytes,
		maxStderrBytes: source.limits.maxStderrBytes,
	});
	throwIfResolutionCancelled(source.signal);
	return result;
}

function text(result: CommandResult): string {
	return result.stdout.toString("utf8");
}

function commandError(result: Pick<CommandResult, "stderr" | "failure">): string {
	if (result.failure) {
		return `${result.failure.stream} exceeded the ${formatByteLimit(result.failure.limit)} capture limit`;
	}
	return result.stderr.trim() || "command exited unsuccessfully";
}

function throwIfOutputLimited(prefix: string, result: CommandResult): void {
	if (result.failure) throw new Error(`${prefix}: ${commandError(result)}`);
}

function commandFailure(prefix: string, result: CommandResult): ReviewSnapshotResolutionError {
	return { error: `${prefix}: ${commandError(result)}` };
}

async function requireCanonicalCommit(
	source: Pick<GitSource, "cwd" | "env" | "limits">,
	ref: string,
): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	throwIfOutputLimited("git rev-parse failed", result);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function requireCanonicalTree(
	source: Pick<GitSource, "cwd" | "env" | "limits">,
	ref: string,
): Promise<string | undefined> {
	const result = await git(source, ["rev-parse", "--verify", "--end-of-options", `${ref}^{tree}`]);
	throwIfOutputLimited("git rev-parse failed", result);
	const oid = text(result).trim();
	return result.ok && CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid) ? oid : undefined;
}

async function createEmptyTree(source: Pick<GitSource, "cwd" | "env" | "limits">): Promise<string> {
	const result = await git(source, ["mktree"], "");
	const oid = text(result).trim();
	if (!result.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid)) {
		throw new Error(`Could not create an empty review tree: ${commandError(result)}`);
	}
	return oid;
}

class ReviewSnapshotResolutionCancelledError extends Error {
	constructor() {
		super("Review snapshot resolution was cancelled.");
		this.name = "ReviewSnapshotResolutionCancelledError";
	}
}

function throwIfResolutionCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ReviewSnapshotResolutionCancelledError();
}

function commandOptions(
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): { signal?: AbortSignal; maxStdoutBytes: number; maxStderrBytes: number } {
	return { signal, maxStdoutBytes: limits.maxMetadataBytes, maxStderrBytes: limits.maxStderrBytes };
}

async function repositoryRoot(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand("git", ["rev-parse", "--show-toplevel"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryObjectDirectory(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "objects"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

async function repositoryCommonDirectory(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfOutputLimited("git rev-parse failed", result);
	const directory = result.ok ? text(result).trim() : "";
	return directory ? await realpath(directory) : undefined;
}

async function repositoryObjectFormat(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<"sha1" | "sha256" | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand("git", ["rev-parse", "--show-object-format"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	const format = text(result).trim();
	return result.ok && (format === "sha1" || format === "sha256") ? format : undefined;
}

async function repositoryIsShallow(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<boolean | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--is-shallow-repository"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	const shallow = text(result).trim();
	return result.ok && (shallow === "true" || shallow === "false") ? shallow === "true" : undefined;
}

async function repositoryIndexFile(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["rev-parse", "--path-format=absolute", "--git-path", "index"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", result);
	return result.ok ? text(result).trim() || undefined : undefined;
}

interface FetchConfigEntry {
	key: string;
	value: string;
}

interface ScopedFetchConfig {
	system: FetchConfigEntry[];
	global: FetchConfigEntry[];
	repository: FetchConfigEntry[];
	command: FetchConfigEntry[];
	partialClone: boolean;
}

interface AmbientFetchConfig {
	system: FetchConfigEntry[];
	global: FetchConfigEntry[];
}

interface ScopedGitConfigEntry extends FetchConfigEntry {
	scope: string;
}

function isUrlRewriteConfigKey(key: string): boolean {
	return key.startsWith("url.") && key.endsWith(".insteadof");
}

function isFetchConfigKey(key: string, remote: string): boolean {
	if (key.startsWith("http.") || key.startsWith("credential.")) return true;
	if (key === "core.askpass" || key === "core.gitproxy" || key === "core.sshcommand") return true;
	if (key === "ssh.variant" || key === "transfer.credentialsinurl") return true;
	if (key === "protocol.allow" || key === "protocol.version" || /^protocol\..+\.allow$/.test(key)) return true;
	if (isUrlRewriteConfigKey(key)) return true;
	const remotePrefix = `remote.${remote}.`;
	if (!key.startsWith(remotePrefix)) return false;
	return ["proxy", "proxyauthmethod", "serveroption", "uploadpack", "vcs"].includes(key.slice(remotePrefix.length));
}

function isIncludeConfigKey(key: string): boolean {
	return key === "include.path" || (key.startsWith("includeif.") && key.endsWith(".path"));
}

function configIndicatesPartialClone(key: string, value: string): boolean {
	const normalizedKey = key.toLowerCase();
	if (normalizedKey === "extensions.partialclone") return true;
	if (/^remote\..+\.partialclonefilter$/.test(normalizedKey)) return true;
	if (!/^remote\..+\.promisor$/.test(normalizedKey)) return false;
	return !["false", "no", "off", "0"].includes(value.trim().toLowerCase());
}

function parseScopedGitConfig(stdout: Buffer): ScopedGitConfigEntry[] {
	const tokens = stdout.toString("utf8").split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	if (tokens.length % 2 !== 0) throw new Error("git config returned malformed scoped output.");
	const entries: ScopedGitConfigEntry[] = [];
	for (let index = 0; index < tokens.length; index += 2) {
		const scope = tokens[index] ?? "";
		const entry = tokens[index + 1] ?? "";
		const separator = entry.indexOf("\n");
		if (separator < 1) throw new Error("git config returned a malformed scoped entry.");
		entries.push({ scope, key: entry.slice(0, separator), value: entry.slice(separator + 1) });
	}
	return entries;
}

function parseRepositoryFetchConfig(stdout: Buffer, remote: string): ScopedFetchConfig {
	const entries = parseScopedGitConfig(stdout);
	const config: ScopedFetchConfig = {
		system: [],
		global: [],
		repository: [],
		command: [],
		partialClone: entries.some(({ key, value }) => configIndicatesPartialClone(key, value)),
	};
	for (const { scope, key, value } of entries) {
		if (!isFetchConfigKey(key, remote)) continue;
		// The isolated remote URL comes from `git remote get-url`, which has
		// already applied these mappings. Preserve their effect, not the rules.
		if (isUrlRewriteConfigKey(key)) continue;
		if (scope === "system") config.system.push({ key, value });
		else if (scope === "global") config.global.push({ key, value });
		else if (scope === "local" || scope === "worktree") config.repository.push({ key, value });
		else if (scope === "command") config.command.push({ key, value });
	}
	return config;
}

function parseAmbientFetchConfig(stdout: Buffer, remote: string): AmbientFetchConfig {
	const config: AmbientFetchConfig = { system: [], global: [] };
	for (const { scope, key, value } of parseScopedGitConfig(stdout)) {
		if (isFetchConfigKey(key, remote) || isIncludeConfigKey(key)) continue;
		if (scope === "system") config.system.push({ key, value });
		else if (scope === "global") config.global.push({ key, value });
	}
	return config;
}

async function repositoryFetchConfig(
	cwd: string,
	remote: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<ScopedFetchConfig> {
	throwIfResolutionCancelled(signal);
	const result = await runCommand(
		"git",
		["config", "--null", "--show-scope", "--list", "--includes"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git config failed", result);
	if (!result.ok) throw new Error(`Could not inspect repository Git config: ${commandError(result)}`);
	return parseRepositoryFetchConfig(result.stdout, remote);
}

async function isolatedAmbientFetchConfig(
	source: GitSource,
	root: string,
	remote: string,
): Promise<AmbientFetchConfig> {
	const result = await git({ ...source, cwd: root }, [
		`--git-dir=${source.cwd}`,
		"config",
		"--null",
		"--show-scope",
		"--list",
		"--includes",
	]);
	throwIfOutputLimited("git config failed", result);
	if (!result.ok) throw new Error(`Could not inspect isolated Git config: ${commandError(result)}`);
	return parseAmbientFetchConfig(result.stdout, remote);
}

function quoteGitConfigValue(value: string): string {
	let escaped = "";
	for (const character of value) {
		switch (character) {
			case "\\":
				escaped += "\\\\";
				break;
			case '"':
				escaped += '\\"';
				break;
			case "\n":
				escaped += "\\n";
				break;
			case "\t":
				escaped += "\\t";
				break;
			case "\b":
				escaped += "\\b";
				break;
			default:
				escaped += character;
		}
	}
	return `"${escaped}"`;
}

function commandGitConfigEnvironment(entries: readonly FetchConfigEntry[]): Record<string, string> {
	const environment: Record<string, string> = { GIT_CONFIG_COUNT: String(entries.length) };
	for (const [index, entry] of entries.entries()) {
		environment[`GIT_CONFIG_KEY_${index}`] = entry.key;
		environment[`GIT_CONFIG_VALUE_${index}`] = entry.value;
	}
	return environment;
}

function serializeGitConfig(entries: readonly FetchConfigEntry[]): string {
	return entries
		.map(({ key, value }) => {
			const firstSeparator = key.indexOf(".");
			const lastSeparator = key.lastIndexOf(".");
			const section = key.slice(0, firstSeparator);
			const name = key.slice(lastSeparator + 1);
			if (firstSeparator < 1 || !section || !name || !/^[a-z0-9-]+$/i.test(section) || !/^[a-z0-9-]+$/i.test(name)) {
				throw new Error(`Cannot preserve malformed Git config key: ${key}`);
			}
			const header =
				firstSeparator === lastSeparator
					? `[${section}]`
					: `[${section} ${quoteGitConfigValue(key.slice(firstSeparator + 1, lastSeparator))}]`;
			return `${header}\n\t${name} = ${quoteGitConfigValue(value)}\n`;
		})
		.join("");
}

async function detectBaseBranch(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfResolutionCancelled(signal);
	const originHead = await runCommand(
		"git",
		["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git symbolic-ref failed", originHead);
	if (originHead.ok) {
		const ref = text(originHead).trim();
		if (ref) return ref;
	}
	for (const candidate of ["main", "master"]) {
		if (await resolveBranchBase(candidate, cwd, limits, signal)) return candidate;
	}
	return undefined;
}

type ResolvedBranchBase =
	| (Extract<ReviewBranchBase, { kind: "local" }> & { displayRef: string })
	| (Extract<ReviewBranchBase, { kind: "remote" }> & { displayRef: string });

async function listConfiguredRemotes(
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<string[]> {
	const result = await runCommand("git", ["remote"], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git remote failed", result);
	if (!result.ok) throw new Error(`git remote failed: ${commandError(result)}`);
	return text(result)
		.split("\n")
		.map((remote) => remote.trim())
		.filter(Boolean)
		.sort((left, right) => right.length - left.length || left.localeCompare(right));
}

function remoteBranchFromTrackingRef(
	ref: string,
	remotes: readonly string[],
): { remote: string; remoteRef: string } | undefined {
	for (const remote of remotes) {
		const prefix = `refs/remotes/${remote}/`;
		if (!ref.startsWith(prefix) || ref.length === prefix.length) continue;
		return { remote, remoteRef: `refs/heads/${ref.slice(prefix.length)}` };
	}
	return undefined;
}

async function refExists(
	ref: string,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await runCommand(
		"git",
		["show-ref", "--verify", "--quiet", "--", ref],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git show-ref failed", result);
	return result.ok;
}

async function refNameIsValid(
	ref: string,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await runCommand("git", ["check-ref-format", ref], cwd, commandOptions(limits, signal));
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git check-ref-format failed", result);
	return result.ok;
}

async function resolveStoredBranchBase(
	base: ReviewBranchBase,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<ResolvedBranchBase | undefined> {
	if (!base || typeof base !== "object" || (base.kind !== "local" && base.kind !== "remote")) return undefined;
	if (base.kind === "local") {
		if (typeof base.ref !== "string" || !base.ref.startsWith("refs/")) return undefined;
		if (!(await refNameIsValid(base.ref, cwd, limits, signal))) return undefined;
		return (await refExists(base.ref, cwd, limits, signal))
			? { kind: "local", ref: base.ref, displayRef: base.ref }
			: undefined;
	}
	if (
		typeof base.remote !== "string" ||
		typeof base.remoteRef !== "string" ||
		!base.remoteRef.startsWith("refs/heads/") ||
		!(await refNameIsValid(base.remoteRef, cwd, limits, signal))
	) {
		return undefined;
	}
	const remotes = await listConfiguredRemotes(cwd, limits, signal);
	return remotes.includes(base.remote)
		? {
				kind: "remote",
				remote: base.remote,
				remoteRef: base.remoteRef,
				displayRef: `${base.remote}/${base.remoteRef.slice("refs/heads/".length)}`,
			}
		: undefined;
}

async function resolveBranchBase(
	base: string,
	cwd: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<ResolvedBranchBase | undefined> {
	throwIfResolutionCancelled(signal);
	const remotes = await listConfiguredRemotes(cwd, limits, signal);
	const symbolic = await runCommand(
		"git",
		["rev-parse", "--symbolic-full-name", "--verify", "--quiet", "--end-of-options", base],
		cwd,
		commandOptions(limits, signal),
	);
	throwIfResolutionCancelled(signal);
	throwIfOutputLimited("git rev-parse failed", symbolic);
	const fullRef = symbolic.ok ? text(symbolic).trim() : "";

	// Full refs intentionally preserve local or cached Git state. Short names use
	// the authoritative remote-backed behavior below when one can be identified.
	if (base.startsWith("refs/")) {
		return symbolic.ok ? { kind: "local", ref: base, displayRef: base } : undefined;
	}

	if (fullRef.startsWith("refs/remotes/")) {
		const remoteBranch = remoteBranchFromTrackingRef(fullRef, remotes);
		if (remoteBranch) return { kind: "remote", ...remoteBranch, displayRef: base };
	}

	for (const remote of remotes) {
		const prefix = `${remote}/`;
		if (!base.startsWith(prefix) || base.length === prefix.length) continue;
		return {
			kind: "remote",
			remote,
			remoteRef: `refs/heads/${base.slice(prefix.length)}`,
			displayRef: base,
		};
	}

	const localBranchRef = `refs/heads/${base}`;
	if (fullRef === localBranchRef || (await refExists(localBranchRef, cwd, limits, signal))) {
		const branchName = base;
		const upstream = await runCommand(
			"git",
			[
				"for-each-ref",
				"--format=%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:short)",
				localBranchRef,
			],
			cwd,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		throwIfOutputLimited("git for-each-ref failed", upstream);
		if (!upstream.ok) throw new Error(`git for-each-ref failed: ${commandError(upstream)}`);
		const [upstreamRemote, upstreamRemoteRef, upstreamShort] = text(upstream).trim().split("\0");
		if (upstreamRemote && upstreamRemote !== "." && upstreamRemoteRef?.startsWith("refs/heads/")) {
			return {
				kind: "remote",
				remote: upstreamRemote,
				remoteRef: upstreamRemoteRef,
				displayRef: upstreamShort || `${upstreamRemote}/${upstreamRemoteRef.slice("refs/heads/".length)}`,
			};
		}

		const matchingRemotes: string[] = [];
		for (const remote of remotes) {
			if (await refExists(`refs/remotes/${remote}/${branchName}`, cwd, limits, signal)) matchingRemotes.push(remote);
		}
		const remote = matchingRemotes.includes("origin")
			? "origin"
			: matchingRemotes.length === 1
				? matchingRemotes[0]
				: undefined;
		if (remote) {
			return {
				kind: "remote",
				remote,
				remoteRef: `refs/heads/${branchName}`,
				displayRef: `${remote}/${branchName}`,
			};
		}
		return { kind: "local", ref: localBranchRef, displayRef: base };
	}

	const matchingRemotes: string[] = [];
	for (const remote of remotes) {
		if (await refExists(`refs/remotes/${remote}/${base}`, cwd, limits, signal)) matchingRemotes.push(remote);
	}
	const remote = matchingRemotes.includes("origin")
		? "origin"
		: matchingRemotes.length === 1
			? matchingRemotes[0]
			: undefined;
	return remote
		? { kind: "remote", remote, remoteRef: `refs/heads/${base}`, displayRef: `${remote}/${base}` }
		: undefined;
}

function normalizePullRequestNumber(value: string | undefined, maximum: number): string | undefined {
	const number = value?.trim();
	if (!number) return undefined;
	if (!/^[1-9]\d*$/.test(number)) return undefined;
	const numeric = Number(number);
	return Number.isSafeInteger(numeric) && numeric <= maximum ? number : undefined;
}

async function createLocalSource(root: string, limits: ReviewSnapshotLimits, signal?: AbortSignal): Promise<GitSource> {
	const objects = await repositoryObjectDirectory(root, limits, signal);
	if (!objects) throw new Error("Could not resolve the Git object directory.");
	return { cwd: root, objectDirectories: [objects], limits, signal };
}

function resolveRemoteFetchUrl(root: string, remoteUrl: string): string {
	const isTildePath = /^~(?:[/\\]|[^/\\]+[/\\])/.test(remoteUrl);
	const isTransportUrl = /^[^/\\]+:/.test(remoteUrl);
	return isAbsolute(remoteUrl) || isTildePath || isTransportUrl ? remoteUrl : resolve(root, remoteUrl);
}

async function fetchIsolatedRemote(
	source: GitSource,
	root: string,
	config: ScopedFetchConfig,
	remote: string,
	fetchUrl: string,
	options: string[],
	refspecs: string[],
): Promise<CommandResult> {
	const repositoryConfigPath = join(source.cwd, "volt-fetch.config");
	const systemConfigPath = join(source.cwd, "volt-fetch-system.config");
	const globalConfigPath = join(source.cwd, "volt-fetch-global.config");
	try {
		// Rebuild protected scopes so eligible settings use the original repository
		// context without duplicating multi-valued settings already active here.
		const ambient = await isolatedAmbientFetchConfig(source, root, remote);
		await Promise.all([
			writeFile(
				repositoryConfigPath,
				serializeGitConfig([{ key: `remote.${remote}.url`, value: fetchUrl }, ...config.repository]),
				{ encoding: "utf8", mode: 0o600 },
			),
			writeFile(systemConfigPath, serializeGitConfig([...ambient.system, ...config.system]), {
				encoding: "utf8",
				mode: 0o600,
			}),
			writeFile(globalConfigPath, serializeGitConfig([...ambient.global, ...config.global]), {
				encoding: "utf8",
				mode: 0o600,
			}),
		]);
		const includeConfig = await git(source, ["config", "--add", "include.path", repositoryConfigPath]);
		if (!includeConfig.ok) throw new Error(`Could not prepare isolated fetch config: ${commandError(includeConfig)}`);
		return await git(
			{
				...source,
				cwd: root,
				env: {
					...source.env,
					...commandGitConfigEnvironment(config.command),
					GIT_CONFIG_SYSTEM: systemConfigPath,
					GIT_CONFIG_GLOBAL: globalConfigPath,
				},
			},
			[`--git-dir=${source.cwd}`, "fetch", ...options, remote, ...refspecs],
		);
	} finally {
		if (!source.signal?.aborted) await git(source, ["config", "--unset-all", "include.path"]).catch(() => {});
		await Promise.all([
			rm(repositoryConfigPath, { force: true }).catch(() => {}),
			rm(systemConfigPath, { force: true }).catch(() => {}),
			rm(globalConfigPath, { force: true }).catch(() => {}),
		]);
	}
}

async function createRemoteBranchSource(
	root: string,
	remote: string,
	remoteRef: string,
	headCommit: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{
	source?: GitSource;
	baseCommit?: string;
	temporaryDirectory?: string;
	shallow?: boolean;
	error?: ReviewSnapshotResolutionError;
}> {
	throwIfResolutionCancelled(signal);
	const [localObjects, objectFormat, sourceIsShallow, remoteUrlResult, fetchConfig] = await Promise.all([
		repositoryObjectDirectory(root, limits, signal),
		repositoryObjectFormat(root, limits, signal),
		repositoryIsShallow(root, limits, signal),
		runCommand("git", ["remote", "get-url", remote], root, commandOptions(limits, signal)),
		repositoryFetchConfig(root, remote, limits, signal),
	]);
	throwIfResolutionCancelled(signal);
	if (!localObjects) {
		return {
			error: {
				error: "Could not resolve the Git object directory.",
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	}
	if (!objectFormat) {
		return {
			error: {
				error: "Could not resolve the Git object format.",
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	}
	if (fetchConfig.partialClone) {
		const error =
			"Remote-backed branch reviews are not supported from partial clones. Use a complete clone and retry.";
		return { error: { error, remoteError: error } };
	}
	const remoteUrl = text(remoteUrlResult).trim();
	if (!remoteUrlResult.ok || !remoteUrl) {
		return {
			error: {
				error: `Could not resolve Git remote "${remote}": ${commandError(remoteUrlResult)}`,
				remoteError: "Could not resolve the review base remote.",
			},
		};
	}
	const fetchUrl = resolveRemoteFetchUrl(root, remoteUrl);

	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-branch-"));
	let retainTemporaryDirectory = false;
	try {
		const init = await runCommand(
			"git",
			["init", "--bare", `--object-format=${objectFormat}`],
			temporaryDirectory,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		if (!init.ok) {
			return {
				error: {
					...commandFailure("git init failed", init),
					remoteError: "Could not prepare the isolated review base.",
				},
			};
		}

		const objects = join(temporaryDirectory, "objects");
		const borrowLocalObjects = sourceIsShallow === false && !fetchConfig.partialClone;
		if (borrowLocalObjects) {
			await mkdir(join(objects, "info"), { recursive: true });
			await writeFile(join(objects, "info", "alternates"), `${resolve(localObjects)}\n`, "utf8");
		}
		throwIfResolutionCancelled(signal);
		const source: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: borrowLocalObjects ? [objects, localObjects] : [objects],
			limits,
			signal,
		};
		const captureHead = borrowLocalObjects
			? await git(source, ["update-ref", "refs/review/head", headCommit])
			: await git(source, [
					"fetch",
					"--no-tags",
					"--no-write-fetch-head",
					"--force",
					"--update-shallow",
					resolve(root),
					"+HEAD:refs/review/head",
				]);
		if (!captureHead.ok) {
			return {
				error: {
					...commandFailure(
						borrowLocalObjects ? "git update-ref failed" : "git fetch from workspace failed",
						captureHead,
					),
					remoteError: "Could not capture the review branch endpoints.",
				},
			};
		}
		const capturedHead = await requireCanonicalCommit(source, "refs/review/head");
		if (capturedHead !== headCommit) {
			return {
				error: {
					error: "The branch head moved while Volt captured it. Retry the review.",
					remoteError: "The branch head moved while Volt captured it. Retry the review.",
				},
			};
		}
		const fetch = await fetchIsolatedRemote(
			source,
			root,
			fetchConfig,
			remote,
			fetchUrl,
			["--no-tags", "--no-write-fetch-head", "--force"],
			[`+${remoteRef}:refs/review/base`],
		);
		if (!fetch.ok) {
			return {
				error: {
					error: `git fetch failed: ${commandError(fetch)}`,
					remoteError: "Could not refresh the review base branch.",
				},
			};
		}
		const baseCommit = await requireCanonicalCommit(source, "refs/review/base");
		const pinnedHead = await requireCanonicalCommit(source, "refs/review/head");
		if (!baseCommit || pinnedHead !== headCommit) {
			return {
				error: {
					error: "Could not pin the fetched branch review endpoints.",
					remoteError: "Could not capture the review branch endpoints.",
				},
			};
		}
		retainTemporaryDirectory = true;
		return {
			source,
			baseCommit,
			temporaryDirectory,
			shallow: sourceIsShallow === true,
		};
	} catch (error) {
		if (error instanceof ReviewSnapshotResolutionCancelledError || signal?.aborted) throw error;
		return {
			error: {
				error: error instanceof Error ? error.message : String(error),
				remoteError: "Could not prepare the isolated review base.",
			},
		};
	} finally {
		if (!retainTemporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

async function createUncommittedSource(
	root: string,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{ source: GitSource; temporaryDirectory: string; originalIndex: string }> {
	const originalObjects = await repositoryObjectDirectory(root, limits, signal);
	if (!originalObjects) throw new Error("Could not resolve the Git object directory.");
	const originalIndex = await repositoryIndexFile(root, limits, signal);
	if (!originalIndex) throw new Error("Could not resolve the Git index file.");
	throwIfResolutionCancelled(signal);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-snapshot-"));
	const objects = join(temporaryDirectory, "objects");
	await mkdir(objects, { recursive: true });
	const source: GitSource = {
		cwd: root,
		env: {
			GIT_INDEX_FILE: join(temporaryDirectory, "index"),
			GIT_OBJECT_DIRECTORY: objects,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: originalObjects,
		},
		objectDirectories: [objects, originalObjects],
		limits,
		signal,
	};
	return { source, temporaryDirectory, originalIndex };
}

async function seedTemporaryIndex(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
): Promise<ReviewSnapshotResolutionError | undefined> {
	const temporaryIndex = source.env?.GIT_INDEX_FILE;
	if (!temporaryIndex) return { error: "Could not resolve the temporary Git index file." };
	try {
		await rm(temporaryIndex, { force: true });
		await copyFile(originalIndex, temporaryIndex);
		// A copied index receives a fresh filesystem timestamp while retaining
		// cached entry timestamps. Backdate it so Git treats every tracked entry
		// as potentially racily clean and re-hashes same-size worktree rewrites.
		// Use the earliest nonzero timestamp because Git treats zero as unset.
		await utimes(temporaryIndex, 1, 1);
		return undefined;
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code !== "ENOENT") {
			return {
				error: `Could not seed the temporary Git index: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
	const readTree = await git(source, ["read-tree", baseTree]);
	return readTree.ok ? undefined : commandFailure("git read-tree failed", readTree);
}

function untrackedWindowsNullDevicePathspecs(status: Buffer): string[] {
	if (process.platform !== "win32") return [];
	return status
		.toString("utf8")
		.split("\0")
		.filter((entry) => entry.startsWith("? "))
		.map((entry) => entry.slice(2))
		.filter((path) => path.split("/").some((segment) => /^nul(?:\..*)?$/i.test(segment)))
		.map((path) => `:(top,exclude,literal)${path}`);
}

async function stageWorktree(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
	status: Buffer,
): Promise<ReviewSnapshotResolutionError | undefined> {
	const seedError = await seedTemporaryIndex(source, originalIndex, baseTree);
	if (seedError) return seedError;
	// Git Bash can create a literal NUL file, but Git for Windows resolves that
	// name as the null device and cannot index it. Exclude only untracked NUL
	// paths; tracked entries remain preserved in Volt's copied index.
	const addArgs = ["add", "-A", "--", ...untrackedWindowsNullDevicePathspecs(status)];
	let add = await git(source, addArgs);
	if (add.ok) return undefined;
	if (!/fatal: will not add file alias .* already exists in index/i.test(add.stderr)) {
		return commandFailure("git add failed", add);
	}

	// A case-insensitive filesystem can check out case-only aliases from the
	// same tree, but Git refuses to refresh them with core.ignorecase enabled.
	// The retry only mutates Volt's temporary index, never the user's index.
	const retrySeedError = await seedTemporaryIndex(source, originalIndex, baseTree);
	if (retrySeedError) return retrySeedError;
	add = await git(source, ["-c", "core.ignorecase=false", ...addArgs]);
	return add.ok ? undefined : commandFailure("git add failed", add);
}

async function captureWorktreeTree(
	source: GitSource,
	originalIndex: string,
	baseTree: string,
): Promise<{ tree?: string; error?: ReviewSnapshotResolutionError }> {
	for (let attempt = 1; attempt <= MAX_STABLE_CAPTURE_ATTEMPTS; attempt++) {
		const before = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!before.ok) return { error: commandFailure("git status failed", before) };
		const firstStageError = await stageWorktree(source, originalIndex, baseTree, before.stdout);
		if (firstStageError) return { error: firstStageError };
		const firstTreeResult = await git(source, ["write-tree"]);
		if (!firstTreeResult.ok) return { error: commandFailure("git write-tree failed", firstTreeResult) };
		const after = await git(source, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
		if (!after.ok) return { error: commandFailure("git status failed", after) };
		const secondStageError = await stageWorktree(source, originalIndex, baseTree, after.stdout);
		if (secondStageError) return { error: secondStageError };
		const secondTreeResult = await git(source, ["write-tree"]);
		if (!secondTreeResult.ok) return { error: commandFailure("git write-tree failed", secondTreeResult) };
		const firstTree = text(firstTreeResult).trim();
		const secondTree = text(secondTreeResult).trim();
		if (
			before.stdout.equals(after.stdout) &&
			firstTree === secondTree &&
			CANONICAL_GIT_OBJECT_ID_PATTERN.test(secondTree)
		) {
			return { tree: secondTree };
		}
	}
	return { error: { error: "Working tree changed while Volt captured the review snapshot. Retry the review." } };
}

async function createPullRequestSource(
	root: string,
	pullRequest: ReviewPullRequestIdentity,
	fetchPlan: PullRequestFetchPlan,
	limits: ReviewSnapshotLimits,
	signal?: AbortSignal,
): Promise<{ source?: GitSource; temporaryDirectory?: string; error?: ReviewSnapshotResolutionError }> {
	throwIfResolutionCancelled(signal);
	const [localObjects, objectFormat, sourceIsShallow, fetchConfig] = await Promise.all([
		repositoryObjectDirectory(root, limits, signal),
		repositoryObjectFormat(root, limits, signal),
		repositoryIsShallow(root, limits, signal),
		repositoryFetchConfig(root, fetchPlan.remote, limits, signal),
	]);
	throwIfResolutionCancelled(signal);
	if (!localObjects) return { error: { error: "Could not resolve the Git object directory." } };
	if (!objectFormat) return { error: { error: "Could not resolve the Git object format." } };
	const fetchUrl = resolveRemoteFetchUrl(root, fetchPlan.remoteUrl);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "volt-review-pr-"));
	let retainTemporaryDirectory = false;
	try {
		const init = await runCommand(
			"git",
			["init", "--bare", `--object-format=${objectFormat}`],
			temporaryDirectory,
			commandOptions(limits, signal),
		);
		throwIfResolutionCancelled(signal);
		if (!init.ok) return { error: commandFailure("git init failed", init) };
		const objects = join(temporaryDirectory, "objects");
		const alternatesPath = join(objects, "info", "alternates");
		const borrowLocalObjects = sourceIsShallow === false && !fetchConfig.partialClone;
		if (borrowLocalObjects) {
			await mkdir(join(objects, "info"), { recursive: true });
			await writeFile(alternatesPath, `${resolve(localObjects)}\n`, "utf8");
		}
		throwIfResolutionCancelled(signal);
		const fetchSource: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: borrowLocalObjects ? [objects, localObjects] : [objects],
			limits,
			signal,
		};
		const fetch = await fetchIsolatedRemote(
			fetchSource,
			root,
			fetchConfig,
			fetchPlan.remote,
			fetchUrl,
			["--no-tags", "--force"],
			[
				`+${fetchPlan.base.remoteRef}:${fetchPlan.base.localRef}`,
				`+${fetchPlan.head.remoteRef}:${fetchPlan.head.localRef}`,
			],
		);
		if (!fetch.ok) {
			return {
				error: {
					error: `git fetch failed: ${commandError(fetch)}`,
					remoteError: "Could not fetch the exact pull request snapshot.",
				},
			};
		}
		const fetchedBase = await requireCanonicalCommit(fetchSource, fetchPlan.base.localRef);
		const fetchedHead = await requireCanonicalCommit(fetchSource, fetchPlan.head.localRef);
		const movedError = {
			error: "The pull request moved while Volt captured it. Retry the review.",
			remoteError: "The pull request changed while Volt captured it. Retry the review.",
		};
		if (fetchedHead !== pullRequest.headRefOid) return { error: movedError };
		if (fetchedBase !== pullRequest.baseRefOid) {
			const capturedBase = await requireCanonicalCommit(fetchSource, pullRequest.baseRefOid);
			if (!fetchedBase || capturedBase !== pullRequest.baseRefOid) return { error: movedError };
			const baseAdvanced = await git(fetchSource, [
				"merge-base",
				"--is-ancestor",
				pullRequest.baseRefOid,
				fetchedBase,
			]);
			if (!baseAdvanced.ok) {
				if (baseAdvanced.exitCode === 1 && baseAdvanced.failure === undefined) return { error: movedError };
				return {
					error: {
						error: `git merge-base --is-ancestor failed: ${commandError(baseAdvanced)}`,
						remoteError: "Could not verify the pull request base movement.",
					},
				};
			}
			const pinBase = await git(fetchSource, [
				"update-ref",
				fetchPlan.base.localRef,
				pullRequest.baseRefOid,
				fetchedBase,
			]);
			if (!pinBase.ok) {
				return {
					error: {
						error: `git update-ref failed: ${commandError(pinBase)}`,
						remoteError: "Could not pin the captured pull request base.",
					},
				};
			}
		}
		const repack = await git(fetchSource, ["repack", "-a", "-d"]);
		if (!repack.ok) {
			return {
				error: {
					error: `git repack failed: ${commandError(repack)}`,
					remoteError: "Could not make the pull request snapshot self-contained.",
				},
			};
		}
		await rm(alternatesPath, { force: true });
		throwIfResolutionCancelled(signal);
		const source: GitSource = {
			cwd: temporaryDirectory,
			objectDirectories: [objects],
			limits,
			signal,
		};
		const detachedBase = await requireCanonicalCommit(source, fetchPlan.base.localRef);
		const detachedHead = await requireCanonicalCommit(source, fetchPlan.head.localRef);
		if (detachedBase !== pullRequest.baseRefOid || detachedHead !== pullRequest.headRefOid) {
			return {
				error: {
					error: "The pull request snapshot remained dependent on local Git objects.",
					remoteError: "Could not make the pull request snapshot self-contained.",
				},
			};
		}
		retainTemporaryDirectory = true;
		return { source, temporaryDirectory };
	} finally {
		if (!retainTemporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
	}
}

function statusFromGit(value: string): ReviewChangedFileStatus {
	switch (value[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "C":
			return "copied";
		case "T":
			return "type-changed";
		default:
			return "modified";
	}
}

interface NameStatusEntry {
	path: string;
	previousPath?: string;
	status: ReviewChangedFileStatus;
}

function nulRecords(stdout: Buffer): Buffer[] {
	if (stdout.length > 0 && stdout.at(-1) !== 0) throw new Error("Git returned a truncated NUL-delimited record.");
	const records: Buffer[] = [];
	let start = 0;
	for (let index = 0; index < stdout.length; index++) {
		if (stdout[index] !== 0) continue;
		records.push(stdout.subarray(start, index));
		start = index + 1;
	}
	return records;
}

function parseNameStatus(stdout: Buffer): NameStatusEntry[] {
	const tokens = nulRecords(stdout);
	const entries: NameStatusEntry[] = [];
	const seen = new Set<string>();
	let index = 0;
	while (index < tokens.length) {
		const statusToken = tokens[index++]!.toString("ascii");
		if (!/^(?:[ADMT]|[RC][0-9]{1,3})$/.test(statusToken)) throw new Error("git diff returned an invalid status.");
		const first = tokens[index++];
		if (!first) throw new Error("git diff returned a missing path.");
		const previousPath = /^[RC]/.test(statusToken) ? reviewPathFromBytes(first) : undefined;
		const pathBytes = previousPath ? tokens[index++] : first;
		if (!pathBytes) throw new Error("git diff returned a missing rename path.");
		const path = reviewPathFromBytes(pathBytes);
		if (seen.has(path)) throw new Error("git diff returned a duplicate path.");
		seen.add(path);
		entries.push({ path, ...(previousPath ? { previousPath } : {}), status: statusFromGit(statusToken) });
	}
	return entries;
}

interface NumstatEntry {
	path: string;
	previousPath?: string;
	additions: number;
	deletions: number;
	binary: boolean;
}

function numstatKey(path: string, previousPath?: string): string {
	return `${previousPath ?? ""}\0${path}`;
}

function parseNumstat(stdout: Buffer): Map<string, NumstatEntry> {
	const tokens = nulRecords(stdout);
	const entries = new Map<string, NumstatEntry>();
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index++];
		if (!token) throw new Error("git diff --numstat returned a missing record.");
		const firstTab = token.indexOf(9);
		const secondTab = firstTab < 0 ? -1 : token.indexOf(9, firstTab + 1);
		if (firstTab < 0 || secondTab < 0) throw new Error("git diff --numstat returned malformed output.");
		const additionsText = token.subarray(0, firstTab).toString("ascii");
		const deletionsText = token.subarray(firstTab + 1, secondTab).toString("ascii");
		const binary = additionsText === "-" && deletionsText === "-";
		const additions = binary ? 0 : Number(additionsText);
		const deletions = binary ? 0 : Number(deletionsText);
		if (
			(!binary && (!/^[0-9]+$/.test(additionsText) || !/^[0-9]+$/.test(deletionsText))) ||
			!Number.isSafeInteger(additions) ||
			additions < 0 ||
			!Number.isSafeInteger(deletions) ||
			deletions < 0
		) {
			throw new Error("git diff --numstat returned invalid line counts.");
		}
		let pathBytes = token.subarray(secondTab + 1);
		let previousPath: string | undefined;
		if (pathBytes.length === 0) {
			const previous = tokens[index++];
			const current = tokens[index++];
			if (!previous || !current) throw new Error("git diff --numstat returned malformed rename paths.");
			previousPath = reviewPathFromBytes(previous);
			pathBytes = current;
		}
		const path = reviewPathFromBytes(pathBytes);
		const entry = {
			path,
			...(previousPath ? { previousPath } : {}),
			additions,
			deletions,
			binary,
		};
		const key = numstatKey(path, previousPath);
		if (entries.has(key)) throw new Error("git diff --numstat returned a duplicate path.");
		entries.set(key, entry);
	}
	return entries;
}

interface ParsedReviewSnapshotTree {
	entries: Map<string, ReviewSnapshotTreeEntry>;
	directories: Map<string, ReviewSnapshotTreeEntry>;
	pathspecUnsafeEntries: Set<ReviewSnapshotTreeEntry>;
}

function parseTree(stdout: Buffer): ParsedReviewSnapshotTree {
	const entries = new Map<string, ReviewSnapshotTreeEntry>();
	const pathspecUnsafeEntries = new Set<ReviewSnapshotTreeEntry>();
	const directories = new Map<string, ReviewSnapshotTreeEntry>();
	for (const token of nulRecords(stdout)) {
		const tab = token.indexOf(9);
		if (tab < 0) throw new Error("git ls-tree returned malformed metadata.");
		const metadata = token.subarray(0, tab).toString("utf8").split(/\s+/);
		const pathBytes = token.subarray(tab + 1);
		const path = reviewPathFromBytes(pathBytes);
		const [mode, type, oid, sizeText] = metadata;
		if (
			!mode ||
			(type !== "blob" && type !== "tree" && type !== "commit") ||
			!oid ||
			!CANONICAL_GIT_OBJECT_ID_PATTERN.test(oid)
		) {
			throw new Error("git ls-tree returned invalid object metadata.");
		}
		const size = sizeText && sizeText !== "-" ? Number(sizeText) : undefined;
		const entry: ReviewSnapshotTreeEntry = {
			path,
			mode,
			type,
			oid,
			...(Number.isSafeInteger(size) && size !== undefined && size >= 0 ? { size } : {}),
		};
		if (entries.has(path) || directories.has(path)) throw new Error("git ls-tree returned a duplicate path.");
		if (type === "tree") directories.set(path, entry);
		else entries.set(path, entry);
		if (reviewPathToUtf8(path) === undefined) pathspecUnsafeEntries.add(entry);
	}
	return { entries, directories, pathspecUnsafeEntries };
}

function collectLineRanges(lines: number[]): ReviewSnapshotLineRange[] {
	const ranges: ReviewSnapshotLineRange[] = [];
	for (const line of lines) {
		const previous = ranges.at(-1);
		if (previous && previous.endLine + 1 === line) previous.endLine = line;
		else ranges.push({ startLine: line, endLine: line });
	}
	return ranges;
}

function parseHunks(path: string, patch: string): ReviewSnapshotHunk[] {
	const lines = patch.split("\n");
	const hunks: ReviewSnapshotHunk[] = [];
	const headerPattern = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
	let index = 0;
	while (index < lines.length) {
		const match = headerPattern.exec(lines[index] ?? "");
		if (!match) {
			index++;
			continue;
		}
		const header = lines[index] ?? "";
		const oldStart = Number(match[1]);
		const oldCount = Number(match[2] ?? "1");
		const newStart = Number(match[3]);
		const newCount = Number(match[4] ?? "1");
		const hunkLines = [header];
		const baseLines: number[] = [];
		const headLines: number[] = [];
		let oldLine = oldStart;
		let newLine = newStart;
		index++;
		while (index < lines.length && !lines[index]?.startsWith("@@ ")) {
			const line = lines[index] ?? "";
			if (line.startsWith("diff --git ")) break;
			hunkLines.push(line);
			if (line === "" && index === lines.length - 1) {
				index++;
				break;
			}
			if (line.startsWith("-")) {
				baseLines.push(oldLine++);
			} else if (line.startsWith("+")) {
				headLines.push(newLine++);
			} else if (line.startsWith(" ") || line === "") {
				oldLine++;
				newLine++;
			} else if (!line.startsWith("\\")) {
				throw new Error("git diff returned malformed hunk content.");
			}
			index++;
		}
		if (oldLine - oldStart !== oldCount || newLine - newStart !== newCount) {
			throw new Error("git diff returned a truncated or malformed hunk.");
		}
		const patchText = hunkLines.join("\n");
		const id = createHash("sha256")
			.update(path)
			.update("\0")
			.update(header)
			.update("\0")
			.update(patchText)
			.digest("hex")
			.slice(0, 20);
		hunks.push({
			id,
			path,
			header,
			oldStart,
			oldCount,
			newStart,
			newCount,
			baseChangedLines: collectLineRanges(baseLines),
			headChangedLines: collectLineRanges(headLines),
			patch: patchText,
		});
	}
	return hunks;
}

function isBinary(content: Buffer): boolean {
	return content.subarray(0, Math.min(content.length, BINARY_PROBE_BYTES)).includes(0);
}

function countLines(content: Buffer): number {
	if (content.length === 0) return 0;
	let lines = 1;
	for (const byte of content) if (byte === 10) lines++;
	if (content.at(-1) === 10) lines--;
	return lines;
}

function searchAbortError(): Error {
	return new Error("Review snapshot search was aborted.");
}

function searchTree(identity: ReviewSnapshotIdentity, revision: ReviewSnapshotRevision): string {
	return revision === "base" ? identity.baseTree : identity.headTree;
}

/** Whether Git, run with `env`, reads text as UTF-8: the locale variable it consults names that encoding. */
function gitLocaleIsUtf8(env: NodeJS.ProcessEnv): boolean {
	return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "");
}

/**
 * Reads `git grep -z -n` output: records of `<name> NUL <line> NUL <text> LF`. A name may hold a line feed and a
 * text a NUL, so the fields are read in turn rather than split on either byte. Only the head of a text is kept, so
 * a line of any length costs a bounded amount of memory.
 */
class GrepRecordReader {
	private field: "name" | "line" | "text" = "name";
	private parts: Buffer[] = [];
	private partBytes = 0;
	private headerBytes = 0;
	private name: Buffer = Buffer.alloc(0);
	private line = 0;
	private readonly onRecord: (name: Buffer, line: number, text: Buffer) => boolean;

	/** `onRecord` returns `false` to stop reading. */
	constructor(onRecord: (name: Buffer, line: number, text: Buffer) => boolean) {
		this.onRecord = onRecord;
	}

	/** Whether the output read so far ends between two records. */
	get atRecordBoundary(): boolean {
		return this.field === "name" && this.headerBytes === 0;
	}

	/** Read more output. Returns `false` once `onRecord` has asked to stop. Throws on output that is not records. */
	push(chunk: Buffer): boolean {
		let start = 0;
		while (start < chunk.length) {
			const inText = this.field === "text";
			const end = chunk.indexOf(inText ? 10 : 0, start);
			let piece = chunk.subarray(start, end < 0 ? chunk.length : end);
			if (inText) {
				piece = piece.subarray(0, SEARCH_MATCH_TEXT_KEEP_BYTES - this.partBytes);
			} else {
				this.headerBytes += piece.length;
				if (this.headerBytes > SEARCH_MATCH_HEADER_MAX_BYTES) {
					throw new Error(
						`git grep returned a match whose path exceeds ${formatByteLimit(SEARCH_MATCH_HEADER_MAX_BYTES)}.`,
					);
				}
			}
			if (piece.length > 0) {
				this.parts.push(piece);
				this.partBytes += piece.length;
			}
			if (end < 0) return true;
			start = end + 1;
			const value = Buffer.concat(this.parts, this.partBytes);
			this.parts = [];
			this.partBytes = 0;
			if (this.field === "name") {
				this.name = value;
				this.field = "line";
			} else if (this.field === "line") {
				const digits = value.toString("latin1");
				if (!/^[1-9][0-9]{0,14}$/.test(digits)) {
					throw new Error("git grep returned a match without a line number.");
				}
				this.line = Number(digits);
				this.field = "text";
			} else {
				this.field = "name";
				this.headerBytes = 0;
				if (!this.onRecord(this.name, this.line, value)) return false;
			}
		}
		return true;
	}
}

/**
 * One page of the lines in the resolved tree/blob scope that contain `query`, in Git's order: one `git grep`
 * addressed by object ID, read as it prints and stopped once the page is full. Git decides what matches. It does not search a
 * binary file, one with a NUL among its first 8,000 bytes: for a tree object it never consults `.gitattributes`.
 * A page skips the `offset` matches before it, so a later page costs a scan of what precedes it.
 */
async function searchTreePage(
	source: GitSource,
	scope: { oid: string; path: string; type: "tree" | "blob" },
	options: { query: string; ignoreCase: boolean; offset: number; limit: number },
	signal: AbortSignal,
): Promise<ReviewSnapshotSearchResult> {
	if (signal.aborted) throw searchAbortError();
	const env: Record<string, string> = {
		...source.env,
		// Isolate Git's pathspec settings even though this search is addressed entirely by object ID.
		GIT_LITERAL_PATHSPECS: "0",
		GIT_GLOB_PATHSPECS: "0",
		GIT_NOGLOB_PATHSPECS: "0",
		GIT_ICASE_PATHSPECS: "0",
	};
	// Git folds the case of letters outside ASCII only in a UTF-8 locale.
	if (options.ignoreCase && !gitLocaleIsUtf8({ ...process.env, ...env })) env.LC_ALL = "C.UTF-8";
	const namePrefix = Buffer.from(scope.type === "tree" ? `${scope.oid}:` : scope.oid, "ascii");
	const page: ReviewSnapshotSearchResult = { matches: [], complete: true };
	let seen = 0;
	const reader = new GrepRecordReader((name, line, text) => {
		if (
			!name.subarray(0, namePrefix.length).equals(namePrefix) ||
			(scope.type === "blob" && name.length !== namePrefix.length)
		) {
			throw new Error("git grep returned a match outside the requested snapshot object.");
		}
		const relative = scope.type === "tree" ? reviewPathFromBytes(name.subarray(namePrefix.length)) : "";
		const path = relative ? (scope.path ? `${scope.path}/${relative}` : relative) : scope.path;
		if (seen++ < options.offset) return true;
		if (page.matches.length === options.limit) {
			page.complete = false;
			return false;
		}
		page.matches.push({
			path,
			line,
			text: text.toString("utf8").slice(0, SEARCH_MATCH_TEXT_MAX_CHARS),
		});
		return true;
	});
	const result = await streamCommand(
		"git",
		[
			"grep",
			// Whatever the repository or the user configures, the output keeps one shape.
			"--no-color",
			"--full-name",
			"--no-column",
			"--no-recurse-submodules",
			"--no-textconv",
			"-I",
			"-n",
			"-z",
			"-F",
			...(options.ignoreCase ? ["-i"] : []),
			"-e",
			options.query,
			scope.oid,
			"--",
		],
		source.cwd,
		{
			env,
			signal,
			maxStderrBytes: source.limits.maxStderrBytes,
			onStdout: (chunk) => reader.push(chunk),
		},
	);
	if (signal.aborted) throw searchAbortError();
	// Git exits 1 when nothing matched. A page that filled stopped Git itself, so its exit code says nothing.
	if (result.failure || (page.complete && result.exitCode !== 0 && result.exitCode !== 1)) {
		throw new Error(`git grep failed: ${commandError(result)}`);
	}
	if (page.complete && !reader.atRecordBoundary) throw new Error("git grep returned a truncated match.");
	return page;
}

/** Read raw file-pair identity first, then bounded patch sections in the same Git queue order. */
async function readTreePatches(
	source: GitSource,
	baseTree: string,
	headTree: string,
	files: ReviewChangedFile[],
): Promise<void> {
	if (files.length === 0) return;
	const byPath = new Map(files.map((file) => [file.path, file]));
	const seen = new Set<string>();
	const sections: ReviewChangedFile[] = [];
	let metadataBytes = 0;
	let raw = true;
	let header: RegExpMatchArray | undefined;
	let previousPath: string | undefined;
	let parts: Buffer[] = [];
	let keptBytes = 0;
	let lineBytes = 0;
	let sectionIndex = -1;
	let current: ReviewChangedFile | undefined;
	let patchParts: Buffer[] = [];
	let patchBytes = 0;
	let retainedBytes = 0;
	const finishFile = (): void => {
		if (!current?.reviewable) return;
		if (patchBytes > source.limits.maxPatchBytes) {
			current.unsupportedReason = `Text patch exceeds the ${formatByteLimit(source.limits.maxPatchBytes)} per-file review limit.`;
		} else {
			const hunks = parseHunks(current.path, Buffer.concat(patchParts).toString("utf8"));
			const bytes = hunks.reduce((total, hunk) => total + Buffer.byteLength(hunk.patch, "utf8"), 0);
			if (retainedBytes + bytes > source.limits.maxRetainedPatchBytes) {
				current.unsupportedReason = `Text patch exceeds the ${formatByteLimit(source.limits.maxRetainedPatchBytes)} aggregate review budget.`;
			} else if (hunks.length === 0) {
				current.unsupportedReason = "The change has no textual diff hunk (for example, a mode-only change).";
			} else {
				current.hunks = hunks;
				retainedBytes += bytes;
			}
		}
		current.reviewable = current.unsupportedReason === undefined;
	};
	const patchLine = (line: Buffer, bytes: number): void => {
		if (line.subarray(0, 11).equals(Buffer.from("diff --git "))) {
			const next = sections[++sectionIndex];
			if (!next) throw new Error("git diff returned an unexpected patch section.");
			if (next !== current) {
				finishFile();
				current = next;
				patchParts = [];
				patchBytes = 0;
			}
		}
		if (!current) throw new Error("git diff returned patch text without a file-pair record.");
		patchBytes += bytes;
		if (current.reviewable && patchBytes <= source.limits.maxPatchBytes) patchParts.push(line);
		else patchParts = [];
	};
	const rawRecord = (record: Buffer): void => {
		if (!header) {
			if (record.length === 0) {
				if (seen.size !== files.length) throw new Error("git diff omitted a raw file-pair record.");
				raw = false;
				return;
			}
			header =
				record
					.toString("utf8")
					.match(
						/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) ([ADMT]|[RC][0-9]{1,3})$/,
					) ?? undefined;
			if (!header) throw new Error("git diff returned malformed raw metadata.");
			return;
		}
		const path = reviewPathFromBytes(record);
		if (/^[RC]/.test(header[5]) && previousPath === undefined) {
			previousPath = path;
			return;
		}
		const file = byPath.get(path);
		if (
			!file ||
			seen.has(path) ||
			file.previousPath !== previousPath ||
			file.status !== statusFromGit(header[5]) ||
			header[1] !== (file.base?.mode ?? "000000") ||
			header[2] !== (file.head?.mode ?? "000000") ||
			(file.base ? header[3] !== file.base.oid : /[^0]/.test(header[3])) ||
			(file.head ? header[4] !== file.head.oid : /[^0]/.test(header[4]))
		) {
			throw new Error("git diff raw identity does not match the snapshot inventory.");
		}
		seen.add(path);
		sections.push(file);
		// Git emits a deletion and an addition for a change between file types.
		if (file.status === "type-changed") sections.push(file);
		header = undefined;
		previousPath = undefined;
	};
	const result = await streamCommand(
		"git",
		[
			"diff",
			"--raw",
			"-z",
			"--patch",
			"--no-abbrev",
			"--full-index",
			"--no-color",
			"--no-relative",
			"--no-textconv",
			"--no-ext-diff",
			"--submodule=short",
			"--src-prefix=a/",
			"--dst-prefix=b/",
			"--output-indicator-new=+",
			"--output-indicator-old=-",
			"--output-indicator-context= ",
			`--unified=${DEFAULT_DIFF_CONTEXT_LINES}`,
			"--find-renames",
			baseTree,
			headTree,
			"--",
		],
		source.cwd,
		{
			env: source.env,
			signal: source.signal,
			maxStderrBytes: source.limits.maxStderrBytes,
			onStdout: (chunk) => {
				let start = 0;
				while (start < chunk.length) {
					const end = chunk.indexOf(raw ? 0 : 10, start);
					const piece = chunk.subarray(start, end < 0 ? chunk.length : end + (raw ? 0 : 1));
					if (raw) {
						metadataBytes += piece.length + (end < 0 ? 0 : 1);
						if (metadataBytes > source.limits.maxMetadataBytes)
							throw new Error("git diff raw metadata exceeded its capture limit.");
					}
					lineBytes += piece.length;
					const keep = raw ? piece : piece.subarray(0, Math.max(64, source.limits.maxPatchBytes) - keptBytes);
					if (keep.length > 0) {
						parts.push(keep);
						keptBytes += keep.length;
					}
					if (end < 0) break;
					const value = Buffer.concat(parts, keptBytes);
					parts = [];
					keptBytes = 0;
					const bytes = lineBytes;
					lineBytes = 0;
					if (raw) rawRecord(value);
					else patchLine(value, bytes);
					start = end + 1;
				}
				return true;
			},
		},
	);
	throwIfResolutionCancelled(source.signal);
	if (result.failure || result.exitCode !== 0) throw new Error(`git diff failed: ${commandError(result)}`);
	if (raw || lineBytes !== 0 || sectionIndex + 1 !== sections.length)
		throw new Error("git diff returned a truncated patch stream.");
	finishFile();
}

async function buildChangedFiles(
	source: GitSource,
	baseTree: string,
	headTree: string,
	baseEntries: Map<string, ReviewSnapshotTreeEntry>,
	headEntries: Map<string, ReviewSnapshotTreeEntry>,
): Promise<ReviewChangedFile[]> {
	const statusResult = await git(source, ["diff", "--name-status", "-z", "--find-renames", baseTree, headTree]);
	if (!statusResult.ok) throw new Error(`git diff --name-status failed: ${commandError(statusResult)}`);
	const numstatResult = await git(source, ["diff", "--numstat", "-z", "--find-renames", baseTree, headTree]);
	if (!numstatResult.ok) throw new Error(`git diff --numstat failed: ${commandError(numstatResult)}`);
	const numstat = parseNumstat(numstatResult.stdout);
	const changed: ReviewChangedFile[] = [];
	for (const statusEntry of parseNameStatus(statusResult.stdout)) {
		const basePath = statusEntry.previousPath ?? statusEntry.path;
		const base = baseEntries.get(basePath);
		const head = headEntries.get(statusEntry.path);
		const statistics = numstat.get(numstatKey(statusEntry.path, statusEntry.previousPath));
		if (!statistics) throw new Error("git diff --numstat is missing a changed-file entry.");
		const { additions, deletions, binary } = statistics;
		const oversized = [base, head].some(
			(entry) => entry?.type === "blob" && (entry.size === undefined || entry.size > source.limits.maxBlobBytes),
		);
		let unsupportedReason: string | undefined;
		if (base?.type === "commit" || head?.type === "commit") {
			unsupportedReason = "Submodule changes require review in the submodule repository.";
		} else if (binary) {
			unsupportedReason = "Binary content has no reviewable text hunks.";
		} else if (oversized) {
			unsupportedReason = `File content exceeds the ${formatByteLimit(source.limits.maxBlobBytes)} snapshot blob limit.`;
		}
		changed.push({
			...statusEntry,
			...(base ? { base } : {}),
			...(head ? { head } : {}),
			hunks: [],
			additions,
			deletions,
			binary,
			reviewable: unsupportedReason === undefined,
			...(unsupportedReason ? { unsupportedReason } : {}),
		});
	}
	await readTreePatches(source, baseTree, headTree, changed);
	return changed;
}

class GitReviewSnapshot implements ReviewSnapshot {
	readonly description: string;
	readonly workflowDescription?: string;
	readonly diffCommand: string;
	readonly extraContext?: string;
	readonly codeHostContext?: ReviewCodeHostContext;
	readonly identity: ReviewSnapshotIdentity;
	readonly branchBase?: ReviewBranchBase;
	readonly root: string;
	readonly commonDirectory: string;
	readonly changedFiles: ReviewChangedFile[];
	private readonly source: GitSource;
	private readonly limits: ReviewSnapshotLimits;
	private readonly temporaryDirectories: string[];
	private readonly materializedDirectories: string[] = [];
	/** The commit each materialized checkout was made at, by directory: what {@link resetHead} returns it to. */
	private readonly materializedCommits = new Map<string, string>();
	private readonly treeEntries = new Map<ReviewSnapshotRevision, Map<string, ReviewSnapshotTreeEntry>>();
	private readonly pathspecUnsafeEntries = new Map<ReviewSnapshotRevision, ReadonlySet<ReviewSnapshotTreeEntry>>();
	private readonly directoryEntries = new Map<ReviewSnapshotRevision, Map<string, ReviewSnapshotTreeEntry>>();
	/** The searches still running. */
	private readonly activeSearchWork = new Set<Promise<unknown>>();
	/** Aborts when the snapshot is disposed, which stops those searches. */
	private readonly disposalController = new AbortController();
	private disposed = false;

	private constructor(
		init: SnapshotInit,
		commonDirectory: string,
		changedFiles: ReviewChangedFile[],
		baseInventory: ParsedReviewSnapshotTree,
		headInventory: ParsedReviewSnapshotTree,
	) {
		this.description = init.description;
		this.workflowDescription = init.workflowDescription;
		this.diffCommand = init.diffCommand;
		this.extraContext = init.extraContext;
		this.codeHostContext = init.codeHostContext;
		this.identity = init.identity;
		this.branchBase = init.branchBase;
		this.root = init.root;
		this.commonDirectory = commonDirectory;
		this.source = init.source;
		this.limits = init.limits;
		this.temporaryDirectories = init.temporaryDirectories;
		this.changedFiles = changedFiles;
		this.treeEntries.set("base", baseInventory.entries);
		this.treeEntries.set("head", headInventory.entries);
		this.directoryEntries.set("base", baseInventory.directories);
		this.directoryEntries.set("head", headInventory.directories);
		this.pathspecUnsafeEntries.set("base", baseInventory.pathspecUnsafeEntries);
		this.pathspecUnsafeEntries.set("head", headInventory.pathspecUnsafeEntries);
	}

	static async create(init: SnapshotInit): Promise<GitReviewSnapshot> {
		const commonDirectory = await repositoryCommonDirectory(init.root, init.limits, init.source.signal);
		if (!commonDirectory) throw new Error("Could not resolve the Git common directory.");
		const baseTreeResult = await git(init.source, ["ls-tree", "-r", "-t", "-z", "-l", init.identity.baseTree]);
		const headTreeResult = await git(init.source, ["ls-tree", "-r", "-t", "-z", "-l", init.identity.headTree]);
		if (!baseTreeResult.ok || !headTreeResult.ok) {
			throw new Error(
				`Could not inventory review snapshot trees: ${commandError(baseTreeResult.ok ? headTreeResult : baseTreeResult)}`,
			);
		}
		const baseInventory = parseTree(baseTreeResult.stdout);
		const headInventory = parseTree(headTreeResult.stdout);
		const changedFiles = await buildChangedFiles(
			init.source,
			init.identity.baseTree,
			init.identity.headTree,
			baseInventory.entries,
			headInventory.entries,
		);
		return new GitReviewSnapshot(init, commonDirectory, changedFiles, baseInventory, headInventory);
	}

	async readFile(revision: ReviewSnapshotRevision, path: string): Promise<ReviewSnapshotFile | undefined> {
		this.assertActive();
		const normalized = normalizeReviewPath(path);
		const entry = this.treeEntries.get(revision)?.get(normalized);
		if (!entry || entry.type !== "blob") return undefined;
		if (entry.size === undefined) {
			return {
				available: false,
				entry,
				reason: "read-failed",
				message: "Git did not report a blob size, so the file was not read.",
			};
		}
		if (entry.size > this.limits.maxBlobBytes) {
			return {
				available: false,
				entry,
				reason: "oversized",
				message: `Blob size ${entry.size} bytes exceeds the ${formatByteLimit(this.limits.maxBlobBytes)} snapshot read limit.`,
			};
		}
		const result = await git(this.source, ["cat-file", "blob", entry.oid], undefined, this.limits.maxBlobBytes);
		if (result.failure) {
			return {
				available: false,
				entry,
				reason: "output-limit",
				message:
					result.failure.stream === "stdout"
						? `Blob output exceeded the ${formatByteLimit(result.failure.limit)} snapshot read limit.`
						: `Blob read stderr exceeded the ${formatByteLimit(result.failure.limit)} capture limit.`,
			};
		}
		if (!result.ok) {
			return {
				available: false,
				entry,
				reason: "read-failed",
				message: `Could not read the snapshot blob: ${commandError(result)}.`,
			};
		}
		const content = result.stdout;
		const binary = isBinary(content);
		return {
			available: true,
			entry,
			content,
			binary,
			...(binary ? {} : { lineCount: countLines(content) }),
		};
	}

	async listFiles(options: ReviewSnapshotListOptions = {}): Promise<ReviewSnapshotTreeEntry[]> {
		this.assertActive();
		const revision = options.revision ?? "head";
		const prefix = options.prefix === undefined || options.prefix === "" ? "" : normalizeReviewPath(options.prefix);
		return [...(this.treeEntries.get(revision)?.values() ?? [])]
			.filter((entry) => !prefix || entry.path === prefix || entry.path.startsWith(`${prefix}/`))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	async search(options: ReviewSnapshotSearchOptions): Promise<ReviewSnapshotSearchResult> {
		this.assertActive();
		if (!options.query) throw new Error("Review snapshot search query must not be empty.");
		if (options.query.includes("\0")) throw new Error("Review snapshot search query must not contain a NUL.");
		const offset = options.offset ?? 0;
		for (const [name, value, minimum] of [
			["offset", offset, 0],
			["limit", options.limit, 1],
		] as const) {
			if (!Number.isSafeInteger(value) || value < minimum) {
				throw new Error(`Review snapshot search ${name} is outside its supported range.`);
			}
		}
		if (options.signal?.aborted) throw searchAbortError();
		const prefix = options.prefix === undefined || options.prefix === "" ? "" : normalizeReviewPath(options.prefix);
		// No line contains a line feed, and `git grep -F` would read one as the boundary between two patterns.
		if (options.query.includes("\n")) return { matches: [], complete: true };
		const entry = prefix
			? (this.treeEntries.get(options.revision)?.get(prefix) ??
				this.directoryEntries.get(options.revision)?.get(prefix))
			: undefined;
		if (prefix && (!entry || (entry.type !== "tree" && !entry.mode.startsWith("100")))) {
			return { matches: [], complete: true };
		}
		const scope: { oid: string; path: string; type: "tree" | "blob" } = entry
			? { oid: entry.oid, path: prefix, type: entry.type === "tree" ? "tree" : "blob" }
			: { oid: searchTree(this.identity, options.revision), path: "", type: "tree" };
		const disposal = this.disposalController.signal;
		const page = searchTreePage(
			this.source,
			scope,
			{ query: options.query, ignoreCase: options.ignoreCase === true, offset, limit: options.limit },
			options.signal ? AbortSignal.any([options.signal, disposal]) : disposal,
		);
		this.trackSearchWork(page);
		return page;
	}

	/** Remember a running search, so {@link dispose} can wait for its Git process to end. */
	private trackSearchWork(promise: Promise<unknown>): void {
		this.activeSearchWork.add(promise);
		void promise.then(
			() => this.activeSearchWork.delete(promise),
			() => this.activeSearchWork.delete(promise),
		);
	}

	async materializeHead(): Promise<string> {
		this.assertActive();
		if (process.platform === "win32") {
			const names = new Set<string>();
			for (const entry of [
				...(this.directoryEntries.get("head")?.values() ?? []),
				...(this.treeEntries.get("head")?.values() ?? []),
			]) {
				const native = nativeReviewCheckoutPath(entry.path);
				const folded = native.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
				if (names.has(folded))
					throw new Error(
						`The Windows checkout cannot represent distinct snapshot paths at ${JSON.stringify(entry.path)}.`,
					);
				names.add(folded);
			}
		}
		const directory = await mkdtemp(join(tmpdir(), "volt-review-checkout-"));
		this.materializedDirectories.push(directory);
		const init = await runCommand("git", ["init"], directory, commandOptions(this.limits, this.source.signal));
		if (!init.ok) throw new Error(`Could not initialize review checkout: ${commandError(init)}`);
		const alternatesPath = join(directory, ".git", "objects", "info", "alternates");
		await mkdir(join(directory, ".git", "objects", "info"), { recursive: true });
		await writeFile(
			alternatesPath,
			`${this.source.objectDirectories.map((path) => resolve(path)).join("\n")}\n`,
			"utf8",
		);
		const commit = await runCommand(
			"git",
			["commit-tree", this.identity.headTree, "-m", "Volt review snapshot"],
			directory,
			{
				...commandOptions(this.limits, this.source.signal),
				env: {
					GIT_AUTHOR_NAME: "Volt Review",
					GIT_AUTHOR_EMAIL: "review@localhost",
					GIT_COMMITTER_NAME: "Volt Review",
					GIT_COMMITTER_EMAIL: "review@localhost",
				},
			},
		);
		const commitOid = text(commit).trim();
		if (!commit.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(commitOid)) {
			throw new Error(`Could not create review checkout commit: ${commandError(commit)}`);
		}
		const reset = await runCommand(
			"git",
			["reset", "--hard", commitOid],
			directory,
			commandOptions(this.limits, this.source.signal),
		);
		if (!reset.ok) throw new Error(`Could not materialize review checkout: ${commandError(reset)}`);
		this.materializedCommits.set(directory, commitOid);
		return directory;
	}

	async resetHead(directory: string, signal?: AbortSignal): Promise<void> {
		this.assertActive();
		const commit = this.materializedCommits.get(directory);
		if (commit === undefined) throw new Error("Not a checkout of this review snapshot.");
		// Commands run in the checkout can replace it or its Git directory with a link to another repository, which the
		// reset would then move: both must still be directories of their own.
		const gitDirectory = join(directory, ".git");
		if (!(await lstat(directory)).isDirectory() || !(await lstat(gitDirectory)).isDirectory()) {
			throw new Error("The review checkout or its Git directory is no longer a directory.");
		}
		const root = await realpath(directory);
		const usedGitDirectories = new Set([await realpath(gitDirectory)]);
		const pathspecUnsafe = this.pathspecUnsafeEntries.get("head");
		const gitlinks = [...(this.treeEntries.get("head")?.values() ?? [])].filter((entry) => entry.type === "commit");
		const unaddressable = gitlinks.find((gitlink) => pathspecUnsafe?.has(gitlink));
		if (unaddressable)
			throw new Error(`The submodule path ${JSON.stringify(unaddressable.path)} is not valid UTF-8.`);
		const sourceSignal = this.source.signal;
		const options = commandOptions(
			this.limits,
			sourceSignal && signal ? AbortSignal.any([sourceSignal, signal]) : (sourceSignal ?? signal),
		);
		// Initialized submodules are reset too, to the commits the head records.
		const reset = await runCommand(
			"git",
			["reset", "--hard", "--quiet", "--recurse-submodules", commit],
			directory,
			options,
		);
		if (!reset.ok) throw new Error(`Could not reset review checkout: ${commandError(reset)}`);
		// Forced twice, so it also removes untracked directories that hold a repository of their own.
		const clean = await runCommand("git", ["clean", "-d", "--force", "--force", "--quiet"], directory, options);
		if (!clean.ok) throw new Error(`Could not clean review checkout: ${commandError(clean)}`);
		for (const gitlink of gitlinks) {
			await this.resetGitlink(
				root,
				join(directory, nativeReviewCheckoutPath(gitlink.path)),
				gitlink.oid,
				usedGitDirectories,
				options,
			);
		}
	}

	/**
	 * Return the repository populating the gitlink at `workTree`, if one does, to `oid` and clean it the way
	 * {@link resetHead} cleans the checkout, then each gitlink of its own. Git's submodule commands would not do: they
	 * stop at a gitlink with no `.gitmodules` entry, and pass over a repository a setup cloned there rather than
	 * initialized. Only a repository whose Git directory and work tree are inside `root`, the checkout, is touched, and
	 * none may share a Git directory with one in `used`, those reset already.
	 */
	private async resetGitlink(
		root: string,
		workTree: string,
		oid: string,
		used: Set<string>,
		options: ReturnType<typeof commandOptions>,
	): Promise<void> {
		const dotGit = join(workTree, ".git");
		const dotGitStats = await lstatIfPresent(dotGit);
		if (dotGitStats === undefined) return;
		let gitDirectory: string;
		if (dotGitStats.isDirectory()) {
			gitDirectory = dotGit;
		} else if (dotGitStats.isFile()) {
			const gitFile = (await readFile(dotGit, "utf8")).trimEnd();
			if (!gitFile.startsWith("gitdir: ")) throw new Error(`${dotGit} does not name a Git directory.`);
			gitDirectory = resolve(workTree, gitFile.slice("gitdir: ".length));
		} else {
			throw new Error(`${dotGit} is neither a directory nor a file.`);
		}
		const realGitDirectory = await realpath(gitDirectory);
		const realWorkTree = await realpath(workTree);
		if (!pathWithinRoot(root, realGitDirectory) || !pathWithinRoot(root, realWorkTree)) {
			throw new Error(`The repository at ${workTree} is outside the review checkout.`);
		}
		// A worktree's Git directory keeps its refs in another repository's, which the reset would move.
		if ((await lstatIfPresent(join(realGitDirectory, "commondir"))) !== undefined) {
			throw new Error(`The repository at ${workTree} is a worktree of another.`);
		}
		if (used.has(realGitDirectory)) throw new Error(`The repository at ${workTree} shares its Git directory.`);
		used.add(realGitDirectory);
		const inRepository = (args: string[]): Promise<CommandResult> =>
			runCommand(
				"git",
				[`--git-dir=${realGitDirectory}`, `--work-tree=${realWorkTree}`, ...args],
				realWorkTree,
				options,
			);
		const reset = await inRepository(["reset", "--hard", "--quiet", oid]);
		if (!reset.ok) throw new Error(`Could not reset the repository at ${workTree}: ${commandError(reset)}`);
		const clean = await inRepository(["clean", "-d", "--force", "--force", "--quiet"]);
		if (!clean.ok) throw new Error(`Could not clean the repository at ${workTree}: ${commandError(clean)}`);
		const index = await inRepository(["ls-files", "--stage", "-z"]);
		if (!index.ok) throw new Error(`Could not list the repository at ${workTree}: ${commandError(index)}`);
		const records = index.stdout;
		let start = 0;
		while (start < records.length) {
			const nul = records.indexOf(0, start);
			const record = records.subarray(start, nul < 0 ? records.length : nul);
			start = nul < 0 ? records.length : nul + 1;
			const tab = record.indexOf(9);
			if (tab < 0) continue;
			const [mode, nestedOid] = record.subarray(0, tab).toString("utf8").split(" ");
			if (mode !== "160000") continue;
			const pathBytes = record.subarray(tab + 1);
			const path = reviewPathFromBytes(pathBytes);
			const nativePath = nativeReviewCheckoutPath(path);
			if (nestedOid === undefined || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(nestedOid)) {
				throw new Error(`The repository at ${workTree} records submodule ${path} at no valid commit.`);
			}
			await this.resetGitlink(root, join(realWorkTree, nativePath), nestedOid, used, options);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.disposalController.abort();
		// A search's Git process reads objects from these directories, so each has ended before they are removed.
		while (this.activeSearchWork.size > 0) {
			await Promise.allSettled([...this.activeSearchWork]);
		}
		for (const directory of [...this.materializedDirectories, ...this.temporaryDirectories].reverse()) {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("Review snapshot is no longer available.");
	}
}

export function pageUtf8(textValue: string, offset: number, maxBytes: number): ReviewSnapshotPage {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Page offset must be a non-negative integer.");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Page size must be a positive integer.");
	const buffer = Buffer.from(textValue, "utf8");
	if (offset > buffer.length) throw new Error("Page offset exceeds the content length.");
	let end = Math.min(buffer.length, offset + maxBytes);
	while (end > offset && end < buffer.length && (buffer[end] & 0xc0) === 0x80) end--;
	if (end === offset && end < buffer.length) {
		end = Math.min(buffer.length, offset + maxBytes);
		while (end < buffer.length && (buffer[end] & 0xc0) === 0x80) end++;
	}
	return {
		text: buffer.subarray(offset, end).toString("utf8"),
		startByte: offset,
		endByte: end,
		totalBytes: buffer.length,
		...(end < buffer.length ? { nextOffset: end } : {}),
	};
}

/** A path for a string-based checkout operation, never a lossy replacement or a Windows path alias. */
function nativeReviewCheckoutPath(path: string): string {
	const native = reviewPathToUtf8(path);
	if (native === undefined)
		throw new Error(`Snapshot path ${JSON.stringify(path)} is not valid UTF-8 for this checkout operation.`);
	if (
		process.platform === "win32" &&
		native
			.split("/")
			.some(
				(component) =>
					/[\\:*?"<>|\u0000-\u001f]/.test(component) ||
					/[. ]$/.test(component) ||
					/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component),
			)
	) {
		throw new Error(`Snapshot path ${JSON.stringify(path)} cannot be represented in this Windows checkout.`);
	}
	return native;
}

/** What is at `path`, a final symbolic link not followed, or `undefined` when nothing is. */
async function lstatIfPresent(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

export function pathWithinRoot(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
	);
}

/** `source`, also seeing the objects in `directories`: Git alternates, so a tree of another repository resolves here. */
function withAlternateObjects(source: GitSource, directories: readonly string[]): GitSource {
	const extra = directories.filter((directory) => !source.objectDirectories.includes(directory));
	if (extra.length === 0) return source;
	const alternates = [source.env?.GIT_ALTERNATE_OBJECT_DIRECTORIES, ...extra].filter(Boolean).join(delimiter);
	return {
		...source,
		env: { ...source.env, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates },
		objectDirectories: [...source.objectDirectories, ...extra],
	};
}

/** A branch compared with its base: what a `branch` and a `branch_uncommitted` review share. */
interface BranchComparison {
	/** Sees the base, the HEAD commit, and their merge base. */
	source: GitSource;
	resolvedBase: ResolvedBranchBase;
	/** How a rerun finds the same base again. */
	branchBase: ReviewBranchBase;
	baseCommit: string;
	mergeBaseCommit: string;
	headCommit: string;
	/** The merge base's tree. */
	baseTree: string;
	/** The HEAD commit's tree. */
	headCommitTree: string;
	/** The temporary directories `source` holds: the snapshot keeps them until it is disposed. */
	temporaryDirectories: string[];
	/** Remove those directories, for a review that fails before its snapshot exists. */
	release(): Promise<void>;
}

/** Resolve the branch's base and merge base, refreshing a remote base into an isolated repository. */
async function resolveBranchComparison(
	target: Extract<ReviewTarget, { kind: "branch" | "branch_uncommitted" }>,
	root: string,
	limits: ReviewSnapshotLimits,
	options: ResolveReviewSnapshotOptions,
	pendingTemporaryDirectories: Set<string>,
): Promise<BranchComparison | ReviewSnapshotResolutionError> {
	const localSource = await createLocalSource(root, limits, options.signal);
	const headCommit = await requireCanonicalCommit(localSource, "HEAD");
	if (!headCommit) return { error: "Could not resolve the branch head." };
	let resolvedBase: ResolvedBranchBase | undefined;
	if ("branchBase" in target) {
		resolvedBase = target.branchBase
			? await resolveStoredBranchBase(target.branchBase, root, limits, options.signal)
			: undefined;
		if (!resolvedBase) return { error: "Stored branch review base is no longer valid." };
	} else {
		const requestedBase = target.base ?? (await detectBaseBranch(root, limits, options.signal));
		if (!requestedBase) return { error: "Could not detect a base branch. Use /review branch <base>." };
		resolvedBase = await resolveBranchBase(requestedBase, root, limits, options.signal);
		if (!resolvedBase) return { error: `Base branch "${requestedBase}" not found.` };
	}

	let source = localSource;
	let baseCommit: string | undefined;
	let remoteSourceIsShallow = false;
	const temporaryDirectories: string[] = [];
	if (resolvedBase.kind === "remote") {
		options.onProgress?.(`Refreshing ${resolvedBase.displayRef}…`);
		const fetched = await createRemoteBranchSource(
			root,
			resolvedBase.remote,
			resolvedBase.remoteRef,
			headCommit,
			limits,
			options.signal,
		);
		if (!fetched.source || !fetched.baseCommit || !fetched.temporaryDirectory) {
			return fetched.error ?? { error: "Could not refresh the review base branch." };
		}
		source = fetched.source;
		baseCommit = fetched.baseCommit;
		remoteSourceIsShallow = fetched.shallow === true;
		temporaryDirectories.push(fetched.temporaryDirectory);
		pendingTemporaryDirectories.add(fetched.temporaryDirectory);
	} else {
		baseCommit = await requireCanonicalCommit(source, resolvedBase.ref);
	}
	if (!baseCommit) return { error: "Could not resolve the branch base." };
	const release = async (): Promise<void> => {
		for (const directory of temporaryDirectories) {
			pendingTemporaryDirectories.delete(directory);
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
	};
	const mergeBaseResult = await git(source, ["merge-base", baseCommit, headCommit]);
	const mergeBaseCommit = text(mergeBaseResult).trim();
	if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
		await release();
		if (
			remoteSourceIsShallow &&
			mergeBaseResult.exitCode === 1 &&
			mergeBaseResult.failure === undefined &&
			mergeBaseResult.stdout.length === 0 &&
			!mergeBaseResult.stderr.trim()
		) {
			const error =
				"Could not resolve the branch merge base from the available shallow history. Deepen or unshallow the repository and retry.";
			return { error, remoteError: error };
		}
		return {
			error: `git merge-base failed: ${commandError(mergeBaseResult)}`,
			remoteError: "Could not resolve the branch merge base.",
		};
	}
	const baseTree = await requireCanonicalTree(source, mergeBaseCommit);
	const headCommitTree = await requireCanonicalTree(source, headCommit);
	if (!baseTree || !headCommitTree) {
		await release();
		return { error: "Could not resolve the branch trees." };
	}
	return {
		source,
		resolvedBase,
		branchBase:
			resolvedBase.kind === "local"
				? { kind: "local", ref: resolvedBase.ref }
				: { kind: "remote", remote: resolvedBase.remote, remoteRef: resolvedBase.remoteRef },
		baseCommit,
		mergeBaseCommit,
		headCommit,
		baseTree,
		headCommitTree,
		temporaryDirectories,
		release,
	};
}

export async function resolveReviewSnapshot(
	target: ReviewTarget,
	cwd: string,
	options: ResolveReviewSnapshotOptions,
): Promise<ReviewSnapshot | ReviewSnapshotResolutionError> {
	let init: SnapshotInit | undefined;
	const pendingTemporaryDirectories = new Set<string>();
	try {
		throwIfResolutionCancelled(options.signal);
		const limits = normalizeSnapshotLimits(options.limits);
		options.onProgress?.("Resolving repository…");
		const root = await repositoryRoot(cwd, limits, options.signal);
		if (!root) return { error: "Not inside a git repository." };
		switch (target.kind) {
			case "uncommitted": {
				options.onProgress?.("Capturing uncommitted changes…");
				const { source, temporaryDirectory, originalIndex } = await createUncommittedSource(
					root,
					limits,
					options.signal,
				);
				pendingTemporaryDirectories.add(temporaryDirectory);
				const headCommit = await requireCanonicalCommit(source, "HEAD");
				const baseTree = headCommit
					? await requireCanonicalTree(source, headCommit)
					: await createEmptyTree(source);
				if (!baseTree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return { error: "Could not resolve the base tree for uncommitted changes." };
				}
				const captured = await captureWorktreeTree(source, originalIndex, baseTree);
				if (!captured.tree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return {
						...captured.error,
						remoteError: "Could not capture the uncommitted changes snapshot.",
					} as ReviewSnapshotResolutionError;
				}
				if (captured.tree === baseTree) {
					await rm(temporaryDirectory, { recursive: true, force: true });
					return { error: "No uncommitted changes to review." };
				}
				init = {
					description: "uncommitted changes",
					diffCommand: "git diff --no-textconv --no-ext-diff HEAD",
					identity: {
						kind: target.kind,
						baseTree,
						headTree: captured.tree,
						...(headCommit ? { baseCommit: headCommit } : {}),
					},
					root,
					source,
					temporaryDirectories: [temporaryDirectory],
					limits,
				};
				break;
			}
			case "branch": {
				options.onProgress?.("Resolving branch history…");
				const comparison = await resolveBranchComparison(
					target,
					root,
					limits,
					options,
					pendingTemporaryDirectories,
				);
				if ("error" in comparison) return comparison;
				const { source, resolvedBase, branchBase, baseCommit, mergeBaseCommit, headCommit, baseTree } = comparison;
				const headTree = comparison.headCommitTree;
				if (baseTree === headTree) {
					await comparison.release();
					return { error: `No changes between ${resolvedBase.displayRef} and HEAD.` };
				}
				const logResult = await git(source, ["log", "--oneline", `${mergeBaseCommit}..${headCommit}`]);
				init = {
					description: `branch changes vs ${resolvedBase.displayRef}`,
					diffCommand: `git diff --no-textconv --no-ext-diff ${resolvedBase.displayRef}...HEAD`,
					extraContext: logResult.ok && text(logResult).trim() ? `Commits:\n${text(logResult).trim()}` : undefined,
					identity: { kind: target.kind, baseCommit, mergeBaseCommit, headCommit, baseTree, headTree },
					branchBase,
					root,
					source,
					temporaryDirectories: comparison.temporaryDirectories,
					limits,
				};
				break;
			}
			case "branch_uncommitted": {
				options.onProgress?.("Resolving branch history…");
				const comparison = await resolveBranchComparison(
					target,
					root,
					limits,
					options,
					pendingTemporaryDirectories,
				);
				if ("error" in comparison) return comparison;
				const { resolvedBase, branchBase, baseCommit, mergeBaseCommit, headCommit, baseTree } = comparison;
				options.onProgress?.("Capturing uncommitted changes…");
				const worktree = await createUncommittedSource(root, limits, options.signal);
				pendingTemporaryDirectories.add(worktree.temporaryDirectory);
				const release = async (): Promise<void> => {
					await comparison.release();
					pendingTemporaryDirectories.delete(worktree.temporaryDirectory);
					await rm(worktree.temporaryDirectory, { recursive: true, force: true }).catch(() => {});
				};
				// The copied index is seeded from the HEAD commit's tree, as for uncommitted changes, not from the merge base's.
				const captured = await captureWorktreeTree(
					worktree.source,
					worktree.originalIndex,
					comparison.headCommitTree,
				);
				if (!captured.tree) {
					await release();
					return {
						...captured.error,
						remoteError: "Could not capture the uncommitted changes snapshot.",
					} as ReviewSnapshotResolutionError;
				}
				if ((await requireCanonicalCommit(worktree.source, "HEAD")) !== headCommit) {
					await release();
					return { error: "HEAD changed while the review was captured. Retry the review." };
				}
				if (captured.tree === baseTree) {
					await release();
					return { error: `No changes between ${resolvedBase.displayRef} and the working tree.` };
				}
				const logResult = await git(comparison.source, ["log", "--oneline", `${mergeBaseCommit}..${headCommit}`]);
				init = {
					description: `branch and uncommitted changes vs ${resolvedBase.displayRef}`,
					diffCommand: `git diff --no-textconv --no-ext-diff $(git merge-base ${resolvedBase.displayRef} HEAD)`,
					extraContext: logResult.ok && text(logResult).trim() ? `Commits:\n${text(logResult).trim()}` : undefined,
					identity: {
						kind: target.kind,
						baseCommit,
						mergeBaseCommit,
						headCommit,
						baseTree,
						headTree: captured.tree,
					},
					branchBase,
					root,
					// A refreshed remote base lives in its own repository: the merge base's tree resolves here through it.
					source: withAlternateObjects(worktree.source, comparison.source.objectDirectories),
					temporaryDirectories: [worktree.temporaryDirectory, ...comparison.temporaryDirectories],
					limits,
				};
				break;
			}
			case "commit": {
				options.onProgress?.("Resolving commit…");
				const ref = target.sha?.trim();
				if (!ref) return { error: "Missing commit ref." };
				if (Buffer.byteLength(ref, "utf8") > options.maxCommitRefBytes) {
					return { error: `Commit ref exceeds ${options.maxCommitRefBytes} UTF-8 bytes.` };
				}
				const source = await createLocalSource(root, limits, options.signal);
				const headCommit = await requireCanonicalCommit(source, ref);
				if (!headCommit) return { error: "Commit ref was not found or does not resolve to a commit." };
				const headTree = await requireCanonicalTree(source, headCommit);
				if (!headTree) return { error: "Could not resolve the commit tree." };
				const parentCommit = await requireCanonicalCommit(source, `${headCommit}^1`);
				const baseTree = parentCommit
					? await requireCanonicalTree(source, parentCommit)
					: await createEmptyTree(source);
				if (!baseTree) return { error: "Could not resolve the commit base tree." };
				const showResult = await git(source, ["show", "-s", "--format=%h %s", headCommit]);
				init = {
					description: `commit ${headCommit}`,
					workflowDescription: `commit ${headCommit}`,
					diffCommand: `git show --stat --patch --diff-merges=first-parent --no-textconv --no-ext-diff ${headCommit}`,
					extraContext: showResult.ok ? `Commit: ${text(showResult).trim()}` : undefined,
					identity: {
						kind: target.kind,
						...(parentCommit ? { baseCommit: parentCommit } : {}),
						headCommit,
						baseTree,
						headTree,
					},
					root,
					source,
					temporaryDirectories: [],
					limits,
				};
				break;
			}
			case "pr": {
				const normalized = normalizePullRequestNumber(target.number, options.maxPullRequestNumber);
				if (target.number?.trim() && !normalized) {
					return {
						error: `PR number must be a canonical positive decimal no greater than ${options.maxPullRequestNumber}.`,
					};
				}
				let codeHostProvider = options.codeHostProvider;
				if (!codeHostProvider) {
					const resolved = await resolveCodeHostProvider({
						cwd: root,
						...(normalized ? { number: normalized } : {}),
						signal: options.signal,
					});
					if (!resolved.ok) return resolved;
					codeHostProvider = resolved.provider;
				}
				const capture = {
					cwd: root,
					...(normalized ? { number: normalized } : {}),
					...(target.expectedUrl === undefined ? {} : { expectedUrl: target.expectedUrl }),
					maxPullRequestNumber: options.maxPullRequestNumber,
					signal: options.signal,
					onProgress: options.onProgress,
				};
				const captured =
					options.pullRequestContext === false
						? await codeHostProvider.capturePullRequestIdentity(capture)
						: await codeHostProvider.capturePullRequestContext(capture);
				if (!captured.ok) return captured;
				const { pullRequest, fetchPlan } = captured;
				if (pullRequest.providerId !== codeHostProvider.id) {
					return { error: "The code-host provider returned a pull request for a different provider." };
				}
				options.onProgress?.("Fetching pull request history…");
				const fetched = await createPullRequestSource(root, pullRequest, fetchPlan, limits, options.signal);
				if (!fetched.source || !fetched.temporaryDirectory)
					return fetched.error ?? { error: "Could not fetch pull request snapshot." };
				pendingTemporaryDirectories.add(fetched.temporaryDirectory);
				const source = fetched.source;
				const mergeBaseResult = await git(source, ["merge-base", pullRequest.baseRefOid, pullRequest.headRefOid]);
				const mergeBaseCommit = text(mergeBaseResult).trim();
				if (!mergeBaseResult.ok || !CANONICAL_GIT_OBJECT_ID_PATTERN.test(mergeBaseCommit)) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return {
						error: "Could not resolve the pull request merge base.",
						remoteError: "Could not resolve the pull request merge base.",
					};
				}
				const baseTree = await requireCanonicalTree(source, mergeBaseCommit);
				const headTree = await requireCanonicalTree(source, pullRequest.headRefOid);
				if (!baseTree || !headTree) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return { error: "Could not resolve pull request trees." };
				}
				if (baseTree === headTree) {
					await rm(fetched.temporaryDirectory, { recursive: true, force: true });
					return { error: `PR #${pullRequest.number} has an empty diff.` };
				}
				init = {
					description: `PR #${pullRequest.number} (${pullRequest.title})`,
					workflowDescription: `PR #${pullRequest.number}`,
					diffCommand: fetchPlan.diffCommand,
					codeHostContext: captured.context,
					identity: {
						kind: target.kind,
						baseCommit: pullRequest.baseRefOid,
						mergeBaseCommit,
						headCommit: pullRequest.headRefOid,
						baseTree,
						headTree,
						pullRequest,
					},
					root,
					source,
					temporaryDirectories: [fetched.temporaryDirectory],
					limits,
				};
				break;
			}
		}
		if (!init) return { error: "Could not initialize the review snapshot." };
		options.onProgress?.("Building review snapshot…");
		const snapshot = await GitReviewSnapshot.create(init);
		if (options.signal?.aborted) {
			await snapshot.dispose();
			throw new ReviewSnapshotResolutionCancelledError();
		}
		return snapshot;
	} catch (error) {
		for (const directory of pendingTemporaryDirectories) {
			await rm(directory, { recursive: true, force: true }).catch(() => {});
		}
		if (error instanceof ReviewSnapshotResolutionCancelledError || options.signal?.aborted) {
			return { error: "Review cancelled.", cancelled: true };
		}
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export async function readReviewPolicyFile(
	snapshot: ReviewSnapshot,
	revision: ReviewSnapshotRevision,
	path: string,
): Promise<string | undefined> {
	const file = await snapshot.readFile(revision, path);
	if (!file) return undefined;
	if (!file.available) throw new Error(`Could not load snapshot policy ${path}: ${file.message}`);
	if (file.binary) throw new Error(`Could not load snapshot policy ${path}: policy content is binary.`);
	return file.content.toString("utf8");
}

export async function readUserReviewPolicy(agentDir: string): Promise<string | undefined> {
	try {
		return await readFile(join(agentDir, "REVIEW.md"), "utf8");
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		if (code === "ENOENT") return undefined;
		throw error;
	}
}
