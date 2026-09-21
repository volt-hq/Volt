import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import { readPrReviewOperationPaths, readPrReviewRepositoryPaths } from "../utils/pr-review-git-paths.ts";
import { runPrReviewGit } from "./pr-review-git.ts";
import type { WorktreeGitRunner } from "./worktree-manager.ts";

export function hasRetainedWorktreeCheckout(record: IrohRemoteWorkspaceWorktree): boolean {
	return (
		!record.checkoutArchive ||
		record.checkoutArchive.restoring === true ||
		existsSync(record.path) ||
		existsSync(record.checkoutArchive.quarantinePath)
	);
}

export interface WorktreeLifecycleOptions {
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	checkoutPath(workspace: IrohRemoteWorkspace, id: string): string;
	sourcePath(workspace: IrohRemoteWorkspace, record: IrohRemoteWorkspaceWorktree): Promise<string | undefined>;
	isPreparing(workspaceName: string, id: string): boolean;
	hasActiveSession?: (workspaceName: string, sessionId: string) => boolean;
	reserveSessions?: (workspaceName: string, sessionIds: string[]) => (() => void) | undefined;
	storedSessionIds(workspace: IrohRemoteWorkspace, record: IrohRemoteWorkspaceWorktree): Promise<string[]>;
	runGit?: WorktreeGitRunner;
	now?: () => number;
}

/** Restoration rejected before any checkout mutation was attempted. */
export class WorktreeRestorePreflightError extends Error {}

/** A checkout is expendable; its binding, branch and exact commit are not. */
export class WorktreeLifecycle {
	private readonly options: WorktreeLifecycleOptions;
	private readonly runGit: WorktreeGitRunner;
	private readonly now: () => number;

	constructor(options: WorktreeLifecycleOptions) {
		this.options = options;
		this.runGit = options.runGit ?? runPrReviewGit;
		this.now = options.now ?? Date.now;
	}

	private async git(args: string[], cwd: string): Promise<string> {
		const result = await this.runGit(args, cwd);
		if (!result.ok) throw new Error("git_failed");
		return result.stdout;
	}

	private quarantinePath(workspace: IrohRemoteWorkspace, record: IrohRemoteWorkspaceWorktree): string {
		const expected = this.options.checkoutPath(workspace, record.id);
		const path = record.checkoutArchive?.quarantinePath;
		if (
			!path ||
			dirname(path) !== dirname(expected) ||
			!basename(path).startsWith(`.${record.id}.reclaim-`) ||
			!/^[0-9a-f-]{36}$/.test(basename(path).slice(`.${record.id}.reclaim-`.length))
		)
			throw new Error("ownership_changed");
		return path;
	}

	private async identity(workspace: IrohRemoteWorkspace, record: IrohRemoteWorkspaceWorktree, path = record.path) {
		const expected = this.options.checkoutPath(workspace, record.id);
		if (
			record.path !== expected ||
			(path !== expected && path !== this.quarantinePath(workspace, record)) ||
			(await realpath(path)) !== path
		)
			throw new Error("ownership_changed");
		if (!(await lstat(path)).isDirectory() || !(await lstat(join(path, ".git"))).isFile())
			throw new Error("ownership_changed");
		const source = await this.options.sourcePath(workspace, record);
		if (!source) throw new Error("source_unavailable");
		const sourcePaths = await readPrReviewRepositoryPaths((args) => this.git(args, source));
		const paths = await readPrReviewRepositoryPaths((args) => this.git(args, path));
		const commonDirectory = await realpath(sourcePaths.commonDirectory);
		if ((await realpath(paths.root)) !== path || (await realpath(paths.commonDirectory)) !== commonDirectory)
			throw new Error("ownership_changed");
		const head = (await this.git(["rev-parse", "--verify", "HEAD"], path)).trim();
		if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) throw new Error("ownership_changed");
		const branch = (await this.git(["symbolic-ref", "HEAD"], path)).trim();
		if (branch !== `refs/heads/${record.branch}`) throw new Error("ownership_changed");
		const listed = await this.git(["worktree", "list", "--porcelain", "-z"], source);
		const entries = listed.split("\0\0").filter((entry) => {
			const field = entry.split("\0")[0];
			return field.startsWith("worktree ") && resolve(field.slice("worktree ".length)) === path;
		});
		if (entries.length !== 1 || !entries[0].split("\0").includes(`branch ${branch}`))
			throw new Error("ownership_changed");
		if (entries[0].split("\0").some((field) => field === "locked" || field.startsWith("locked ")))
			throw new Error("locked");
		const operationPaths = await readPrReviewOperationPaths((args) => this.git(args, path));
		if (operationPaths.some((operationPath) => existsSync(operationPath))) throw new Error("operation_in_progress");
		return { source, commonDirectory, head };
	}

	private async clean(path: string): Promise<void> {
		// Explicit flags defeat status.showUntrackedFiles and ignored-file hiding.
		if (
			await this.git(
				[
					"status",
					"--porcelain=v1",
					"-z",
					"--untracked-files=all",
					"--ignored=matching",
					"--ignore-submodules=all",
				],
				path,
			)
		)
			throw new Error("dirty");
		// Conservatively retain sparse/assume-unchanged files and all submodules.
		const flags = await this.git(["ls-files", "-v", "-z"], path);
		if (flags.split("\0").some((entry) => entry && !entry.startsWith("H "))) throw new Error("index_flags");
		const index = await this.git(["ls-files", "--stage", "-z"], path);
		if (index.split("\0").some((entry) => entry.startsWith("160000 "))) throw new Error("submodule");
	}

	async archive(workspaceName: string, id: string): Promise<{ removed: true } | { removed: false; reason: string }> {
		let release: (() => void) | undefined;
		let preserved = false;
		try {
			await this.options.stateManager.runWorkspaceWorktreeLifecycle(workspaceName, async (current) => {
				const record = current.worktrees.find((entry) => entry.id === id);
				if (!record) throw new Error("worktree_not_found");
				if (record.checkoutArchive)
					throw new Error(hasRetainedWorktreeCheckout(record) ? "recovery_required" : "already_archived");
				if (
					record.disposable !== true &&
					!(
						record.disposable === undefined &&
						record.branch === `volt/${record.id}` &&
						record.prReviewLaunches?.some(
							(launch) => launch.disposition === "created" && launch.placement.worktreeId === record.id,
						)
					)
				)
					throw new Error("not_disposable");
				if (
					this.options.isPreparing(workspaceName, id) ||
					record.prReviewLaunches?.some((launch) => launch.sessionGeneration === undefined) ||
					current.allWorktrees.some((entry) =>
						entry.prReviewLaunches?.some((launch) => {
							// Pending and bound reviews still validate and resolve the PR from this source,
							// even when their own checkout is archived for later resume.
							const source = relative(record.path, launch.placement.sourceCwd);
							return source !== ".." && !source.startsWith(`..${sep}`) && !isAbsolute(source);
						}),
					)
				)
					throw new Error("busy");
				const sessionIds = [
					...new Set([...record.sessionIds, ...(await this.options.storedSessionIds(current.workspace, record))]),
				];
				if (sessionIds.some((sessionId) => this.options.hasActiveSession?.(workspaceName, sessionId)))
					throw new Error("busy");
				// An unbound checkout can still be awaiting its first agent attach.
				if (sessionIds.length === 0) throw new Error("pending_launch");
				release = this.options.reserveSessions?.(workspaceName, sessionIds);
				if (!release) throw new Error("busy");
				if (
					current.allWorktrees.some(
						(entry) =>
							(entry.workspaceName !== workspaceName || entry.id !== id) &&
							(resolve(entry.path) === resolve(record.path) ||
								resolve(entry.path).startsWith(`${resolve(record.path)}${sep}`) ||
								resolve(record.path).startsWith(`${resolve(entry.path)}${sep}`)),
					)
				)
					throw new Error("ownership_changed");
				const identity = await this.identity(current.workspace, record);
				await this.clean(record.path);
				const snapshot = record.prReviewLaunches?.some(
					(launch) =>
						launch.placement.cwd === record.path &&
						launch.placement.commonDirectory === identity.commonDirectory &&
						launch.placement.pullRequest.headRefOid === identity.head,
				);
				if (!snapshot) {
					if (!record.baseRef) throw new Error("unmerged");
					const merged = await this.runGit(
						["merge-base", "--is-ancestor", identity.head, record.baseRef],
						identity.source,
					);
					if (!merged.ok) throw new Error("unmerged");
				}
				await this.git(
					[
						"update-ref",
						`refs/volt/archives/${createHash("sha256").update(record.path).digest("hex")}/${identity.head}`,
						identity.head,
					],
					identity.source,
				);
				const quarantinePath = join(dirname(record.path), `.${record.id}.reclaim-${randomUUID()}`);
				const archived = {
					...record,
					sessionIds,
					checkoutArchive: {
						head: identity.head,
						commonDirectory: identity.commonDirectory,
						archivedAt: this.now(),
						quarantinePath,
					},
				};
				return {
					result: undefined,
					worktree: archived,
					afterPersistWhileLocked: async () => {
						// Detach the advertised path BEFORE the final inspection. Writes through
						// that old path cannot introduce ignored data into the deletion target.
						try {
							await this.git(["worktree", "move", record.path, quarantinePath], identity.source);
							const final = await this.identity(current.workspace, archived, quarantinePath);
							if (
								final.head !== identity.head ||
								final.commonDirectory !== identity.commonDirectory ||
								final.source !== identity.source
							)
								throw new Error("ownership_changed");
							await this.clean(quarantinePath);
							await this.git(["worktree", "remove", quarantinePath], identity.source);
						} catch {
							// Keep the intent even if Git lost its exit status or a raced edit
							// prevents deletion. Resume moves this exact checkout back, never resets it.
						} finally {
							preserved = existsSync(record.path) || existsSync(quarantinePath);
						}
					},
				};
			});
			if (preserved) {
				await this.audit(workspaceName, id, false, "recovery_required");
				return { removed: false, reason: "recovery_required" };
			}
			await this.audit(workspaceName, id, true);
			return { removed: true };
		} catch (error) {
			const allowed = new Set([
				"worktree_not_found",
				"already_archived",
				"recovery_required",
				"not_disposable",
				"busy",
				"pending_launch",
				"ownership_changed",
				"source_unavailable",
				"locked",
				"operation_in_progress",
				"dirty",
				"index_flags",
				"submodule",
				"unmerged",
				"git_failed",
			]);
			const reason = error instanceof Error && allowed.has(error.message) ? error.message : "inspection_failed";
			await this.audit(workspaceName, id, false, reason);
			return { removed: false, reason };
		} finally {
			release?.();
		}
	}

	/** Called only under the lifecycle lock. Never overwrite an unexpected checkout or move a branch. */
	async restore(
		workspace: IrohRemoteWorkspace,
		record: IrohRemoteWorkspaceWorktree,
	): Promise<IrohRemoteWorkspaceWorktree> {
		const archive = record.checkoutArchive;
		if (!archive) return record;
		let source: string;
		let quarantinePath: string;
		try {
			const expected = this.options.checkoutPath(workspace, record.id);
			quarantinePath = this.quarantinePath(workspace, record);
			const selectedSource = await this.options.sourcePath(workspace, record);
			if (!selectedSource || record.path !== expected || (await realpath(dirname(expected))) !== dirname(expected))
				throw new Error("Archived worktree ownership changed; inspect the checkout before resuming.");
			source = selectedSource;
			const paths = await readPrReviewRepositoryPaths((args) => this.git(args, source));
			if ((await realpath(paths.commonDirectory)) !== archive.commonDirectory)
				throw new Error("Archived worktree repository changed; inspect the checkout before resuming.");
			const head = (
				await this.git(["rev-parse", "--verify", `refs/heads/${record.branch}^{commit}`], source)
			).trim();
			if (head !== archive.head)
				throw new Error("Archived worktree branch changed; restore its recorded commit before resuming.");
		} catch (error) {
			throw new WorktreeRestorePreflightError(
				error instanceof Error ? error.message : "Restoration preflight failed.",
				{
					cause: error,
				},
			);
		}
		if (existsSync(quarantinePath)) {
			if (existsSync(record.path))
				throw new Error("Archived worktree path is occupied; recover the preserved checkout before resuming.");
			const identity = await this.identity(workspace, record, quarantinePath);
			if (identity.head !== archive.head) throw new Error("Preserved checkout changed; inspect it before resuming.");
			await this.git(["worktree", "move", quarantinePath, record.path], source);
		} else if (!existsSync(record.path)) {
			if (!archive.restoring) throw new Error("Checkout restoration requires durable preparation.");
			await this.git(["worktree", "add", "--no-checkout", record.path, record.branch], source);
		}
		const identity = await this.identity(workspace, record);
		if (identity.head !== archive.head)
			throw new Error("Archived worktree checkout changed; inspect it before resuming.");
		if (archive.restoring) {
			// --no-checkout creates no index. Initialize it only once, then fill missing
			// tracked files WITHOUT --force. A crash at any point is retryable; existing
			// user files and staged edits are never replaced by reset --hard.
			if (await this.git(["ls-files", "--others", "-z"], record.path))
				throw new Error("Restoring checkout contains user files; inspect it before resuming.");
			const indexPath = (
				await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"], record.path)
			).trim();
			if (!existsSync(indexPath)) await this.git(["read-tree", "HEAD"], record.path);
			if (await this.git(["diff", "--cached", "--raw", "--no-ext-diff", "--no-textconv", "HEAD", "--"], record.path))
				throw new Error("Restoring checkout index changed; inspect it before resuming.");
			await this.runGit(["update-index", "--refresh"], record.path);
			if (await this.git(["diff-files", "--name-only", "--diff-filter=ACMRTUXB", "-z", "--"], record.path))
				throw new Error("Restoring checkout contains edits; inspect it before resuming.");
			// Existing tracked files yield a nonzero exit; the final clean check is authoritative.
			await this.runGit(["checkout-index", "--all"], record.path);
			await this.clean(record.path);
		}
		const { checkoutArchive: _archive, ...restored } = record;
		return restored;
	}

	private async audit(workspace: string, worktreeId: string, success: boolean, reason?: string): Promise<void> {
		await this.options.auditLogger
			.log({
				type: success ? "worktree_retention_removed" : "worktree_retention_skipped_dirty",
				workspace,
				success,
				details: { worktreeId, ...(reason ? { reason } : {}) },
			})
			.catch(() => undefined);
	}
}
