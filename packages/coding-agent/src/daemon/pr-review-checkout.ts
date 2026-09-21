import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	type CodeHostProvider,
	githubCliCodeHostProvider,
	type ResolvedPullRequestCheckout,
} from "../core/code-host/index.ts";
import type { PrReviewLaunch, PrReviewPlacement } from "../core/pr-review-placement.ts";
import { hasIrohRemoteRpcCapability } from "../core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import type { IrohRemoteHello } from "../core/remote/iroh/handshake.ts";
import { PrReviewPreparationError, type PrReviewPreparationErrorCode } from "../core/remote/iroh/pr-review-rpc.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../core/session-manager.ts";
import { isPrReviewCheckoutClean } from "../utils/pr-review-clean-checkout.ts";
import { readPrReviewOperationPaths, readPrReviewRepositoryPaths } from "../utils/pr-review-git-paths.ts";
import { getResolvedTargetSessionId } from "./integrated-runtimes.ts";
import { runPrReviewGit } from "./pr-review-git.ts";
import {
	getWorktreeCheckoutPath,
	WorktreeCapacityError,
	type WorktreeGitRunner,
	type WorktreeManager,
} from "./worktree-manager.ts";

export interface PrReviewSource {
	workingDirectory?: string;
	sourceWorktreeId?: string;
	number?: string;
}
export interface PrReviewPreparationRequest extends PrReviewSource {
	sessionId: string;
	expectedPullRequest: { url: string; headRefOid: string };
}
export interface PrReviewPreparationAuthority {
	workspaceGeneration: number;
	assertCurrent(): void;
	signal?: AbortSignal;
}
export interface PreparedPrReview {
	workspaceName: string;
	sessionId: string;
	worktreeId: string;
	workingDirectory?: string;
	pullRequest: ResolvedPullRequestCheckout["pullRequest"];
	disposition: "created" | "reused";
}

/** Safe codes only; utility routing translates these without exposing Git stderr. */
export class PrReviewCheckoutError extends Error {
	readonly code: PrReviewPreparationErrorCode;
	constructor(code: PrReviewCheckoutError["code"] = "review_preparation_failed") {
		super(code);
		this.code = code;
	}
}

interface Source {
	cwd: string;
	root: string;
	rootRelativePath?: string;
	commonDirectory: string;
}

export class PrReviewCheckoutManager {
	private readonly options: {
		agentDir: string;
		stateManager: IrohRemoteHostStateManager;
		worktrees: WorktreeManager;
		hasActiveSession(workspaceName: string, sessionId: string): boolean;
		provider?: CodeHostProvider;
		runGit?: WorktreeGitRunner;
	};
	private readonly lanes = new Map<string, Promise<unknown>>();
	constructor(options: PrReviewCheckoutManager["options"]) {
		this.options = options;
	}

	private async git(args: string[], cwd: string, signal?: AbortSignal, trimOutput = true): Promise<string> {
		const result = await (this.options.runGit ?? runPrReviewGit)(args, cwd, { signal });
		signal?.throwIfAborted();
		if (!result.ok) throw new PrReviewCheckoutError();
		return trimOutput ? result.stdout.trim() : result.stdout;
	}

	private async source(
		workspace: IrohRemoteWorkspace,
		request: PrReviewSource,
		signal?: AbortSignal,
	): Promise<Source> {
		if (request.workingDirectory !== undefined && request.sourceWorktreeId !== undefined)
			throw new PrReviewCheckoutError();
		const worktree =
			request.sourceWorktreeId === undefined
				? undefined
				: await this.options.worktrees.findWorktree(workspace.name, request.sourceWorktreeId);
		if (request.sourceWorktreeId !== undefined && !worktree) throw new PrReviewCheckoutError();
		const selected = await this.options.worktrees.validateWorkingDirectory(
			workspace,
			worktree?.sourceRootRelativePath ?? request.workingDirectory,
		);
		if (!selected.ok) throw new PrReviewCheckoutError();
		const paths = await readPrReviewRepositoryPaths((args) =>
			this.git(args, selected.directory.absolutePath, signal, false),
		);
		const root = await realpath(paths.root);
		const workspaceRoot = await realpath(workspace.path);
		const rootRelative = relative(workspaceRoot, root);
		if (isAbsolute(rootRelative) || rootRelative === ".." || rootRelative.startsWith(`..${sep}`))
			throw new PrReviewCheckoutError();
		const commonDirectory = await realpath(paths.commonDirectory);
		const cwd = worktree ? await realpath(worktree.path) : root;
		if (
			(await realpath(resolve(cwd, await this.git(["rev-parse", "--git-common-dir"], cwd, signal)))) !==
			commonDirectory
		)
			throw new PrReviewCheckoutError();
		return {
			cwd,
			root,
			commonDirectory,
			...(rootRelative ? { rootRelativePath: rootRelative.split(sep).join("/") } : {}),
		};
	}

	private async target(
		source: Source,
		request: PrReviewSource,
		signal?: AbortSignal,
	): Promise<ResolvedPullRequestCheckout> {
		const result = await (this.options.provider ?? githubCliCodeHostProvider).resolvePullRequestCheckout({
			cwd: source.cwd,
			number: request.number,
			maxPullRequestNumber: 2147483647,
			signal,
		});
		if (!result.ok) throw new PrReviewCheckoutError();
		return result.target;
	}

	async resolve(workspace: IrohRemoteWorkspace, request: PrReviewSource, authority: PrReviewPreparationAuthority) {
		authority.assertCurrent();
		const source = await this.source(workspace, request, authority.signal);
		const target = await this.target(source, request, authority.signal);
		authority.assertCurrent();
		return { workspaceName: workspace.name, pullRequest: target.pullRequest };
	}

	async prepare(
		workspace: IrohRemoteWorkspace,
		request: PrReviewPreparationRequest,
		authority: PrReviewPreparationAuthority,
	): Promise<PreparedPrReview> {
		const operation = (this.lanes.get(workspace.name) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.prepareExclusive(workspace, request, authority));
		this.lanes.set(workspace.name, operation);
		try {
			return await operation;
		} catch (error) {
			if (error instanceof WorktreeCapacityError) throw new PrReviewCheckoutError(error.code);
			throw error;
		} finally {
			if (this.lanes.get(workspace.name) === operation) this.lanes.delete(workspace.name);
		}
	}

	private response(launch: PrReviewLaunch): PreparedPrReview {
		return {
			workspaceName: launch.placement.workspaceName,
			sessionId: launch.sessionId,
			worktreeId: launch.placement.worktreeId,
			...(launch.placement.sourceRootRelativePath === undefined
				? {}
				: { workingDirectory: launch.placement.sourceRootRelativePath }),
			pullRequest: structuredClone(launch.placement.pullRequest),
			disposition: launch.disposition,
		};
	}

	private async cleanHead(
		path: string,
		commonDirectory: string,
		head: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		try {
			const paths = await readPrReviewRepositoryPaths((args) => this.git(args, path, signal, false));
			if ((await realpath(path)) !== (await realpath(paths.root))) return false;
			if ((await realpath(paths.commonDirectory)) !== commonDirectory) return false;
			if ((await this.git(["rev-parse", "--verify", "HEAD"], path, signal)) !== head) return false;
			if (!(await isPrReviewCheckoutClean(path, (cwd, args) => this.git(args, cwd, signal), signal))) return false;
			const listed = await this.git(["worktree", "list", "--porcelain", "-z"], path, signal);
			const roots = listed
				.split("\0")
				.filter((field) => field.startsWith("worktree "))
				.map((field) => field.slice(9));
			if (!(await Promise.all(roots.map((root) => realpath(root).catch(() => "")))).includes(await realpath(path)))
				return false;
			const operationPaths = await readPrReviewOperationPaths((args) => this.git(args, path, signal, false));
			if (operationPaths.some((operationPath) => existsSync(operationPath))) return false;
			return true;
		} catch {
			signal?.throwIfAborted();
			return false;
		}
	}

	private busy(worktree: IrohRemoteWorkspaceWorktree, allowedSessionId?: string): boolean {
		return (
			this.options.worktrees.isRuntimePreparing(worktree.workspaceName, worktree.id) ||
			worktree.sessionIds.some(
				(id) => id !== allowedSessionId && this.options.hasActiveSession(worktree.workspaceName, id),
			) ||
			(worktree.prReviewLaunches ?? []).some(
				(launch) => launch.sessionGeneration === undefined && launch.sessionId !== allowedSessionId,
			)
		);
	}

	private async prepareExclusive(
		workspace: IrohRemoteWorkspace,
		request: PrReviewPreparationRequest,
		authority: PrReviewPreparationAuthority,
	): Promise<PreparedPrReview> {
		authority.assertCurrent();
		if (!/^[a-z0-9_-]{1,128}$/.test(request.sessionId)) throw new PrReviewCheckoutError();
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					workspace: workspace.name,
					generation: authority.workspaceGeneration,
					workingDirectory: request.workingDirectory ?? null,
					sourceWorktreeId: request.sourceWorktreeId ?? null,
					number: request.number ?? null,
					expected: request.expectedPullRequest,
				}),
			)
			.digest("hex");
		const records = await this.options.stateManager.listWorktrees(workspace.name);
		const matches = records
			.flatMap((record) => record.prReviewLaunches ?? [])
			.filter((launch) => launch.sessionId === request.sessionId);
		if (matches.length > 1) throw new PrReviewCheckoutError("review_preparation_conflict");
		const prior = matches[0];
		if (prior) {
			if (prior.requestFingerprint !== fingerprint) throw new PrReviewCheckoutError("review_preparation_conflict");
			const worktree =
				prior.sessionGeneration === undefined
					? records.find((record) => record.id === prior.placement.worktreeId)
					: await this.options.worktrees.resolveSessionWorktree(workspace.name, prior.sessionId);
			if (!worktree || (await realpath(worktree.path).catch(() => "")) !== prior.placement.cwd)
				throw new PrReviewCheckoutError("review_preparation_stale");
			if (!prior.sessionGeneration) await this.validatePlacement(workspace, prior.placement, authority);
			authority.assertCurrent();
			return this.response(prior);
		}
		if (
			await SessionManager.findForResume(
				getDefaultSessionDirPath(workspace.path, this.options.agentDir),
				request.sessionId,
			)
		)
			throw new PrReviewCheckoutError("review_preparation_conflict");
		const releaseSource =
			request.sourceWorktreeId === undefined
				? undefined
				: await this.options.worktrees.reserveReviewSource(workspace.name, request.sourceWorktreeId);
		if (request.sourceWorktreeId !== undefined && !releaseSource) throw new PrReviewCheckoutError();
		try {
			return await this.prepareFromSource(workspace, request, authority, fingerprint);
		} finally {
			// Persisted launches take over source protection; failures must not leak the reservation.
			releaseSource?.();
		}
	}

	private async prepareFromSource(
		workspace: IrohRemoteWorkspace,
		request: PrReviewPreparationRequest,
		authority: PrReviewPreparationAuthority,
		fingerprint: string,
	): Promise<PreparedPrReview> {
		const source = await this.source(workspace, request, authority.signal);
		const target = await this.target(source, request, authority.signal);
		if (
			target.pullRequest.url !== request.expectedPullRequest.url ||
			target.pullRequest.headRefOid !== request.expectedPullRequest.headRefOid
		)
			throw new PrReviewCheckoutError("review_preparation_stale");
		authority.assertCurrent();
		const placement = (worktree: IrohRemoteWorkspaceWorktree): PrReviewPlacement => ({
			workspaceName: workspace.name,
			workspaceGeneration: authority.workspaceGeneration,
			worktreeId: worktree.id,
			cwd: worktree.path,
			sourceCwd: source.cwd,
			...(source.rootRelativePath === undefined ? {} : { sourceRootRelativePath: source.rootRelativePath }),
			commonDirectory: source.commonDirectory,
			pullRequest: target.pullRequest,
			repositoryId: target.repository.canonicalId,
			headRepositoryId: target.headRepository.canonicalId,
			remote: target.remote,
		});
		const reused = await this.options.stateManager.runWorkspaceWorktreeLifecycle(workspace.name, async (current) => {
			authority.assertCurrent();
			for (const candidate of [...current.worktrees].sort((a, b) => a.id.localeCompare(b.id))) {
				if (
					candidate.sourceRootRelativePath !== source.rootRelativePath ||
					(candidate.prReviewLaunches?.length ?? 0) >= 64 ||
					this.busy(candidate)
				)
					continue;
				if (
					!(await this.cleanHead(
						candidate.path,
						source.commonDirectory,
						target.pullRequest.headRefOid,
						authority.signal,
					))
				)
					continue;
				const branch = await this.git(["symbolic-ref", "--short", "HEAD"], candidate.path, authority.signal).catch(
					() => "",
				);
				const previous = candidate.prReviewLaunches ?? [];
				if (previous.some((entry) => entry.placement.pullRequest.url !== target.pullRequest.url)) continue;
				if (
					branch !== target.pullRequest.headRefName &&
					!previous.some((entry) => entry.placement.pullRequest.url === target.pullRequest.url)
				)
					continue;
				authority.assertCurrent();
				if (this.busy(candidate)) continue;
				const launch: PrReviewLaunch = {
					sessionId: request.sessionId,
					requestFingerprint: fingerprint,
					placement: placement(candidate),
					disposition: "reused",
				};
				return { result: launch, worktree: { ...candidate, prReviewLaunches: [...previous, launch] } };
			}
			return { result: undefined as PrReviewLaunch | undefined };
		});
		if (reused) return this.response(reused);
		const id = `review-${createHash("sha256").update(request.sessionId).digest("hex").slice(0, 24)}`;
		const headRef = `refs/volt/reviews/${id}/head`;
		authority.assertCurrent();
		await this.git(
			[
				"fetch",
				"--no-tags",
				"--no-write-fetch-head",
				"--no-recurse-submodules",
				target.remoteUrl,
				`+${target.headRef}:${headRef}`,
			],
			source.root,
			authority.signal,
		);
		if (
			(await this.git(["rev-parse", "--verify", `${headRef}^{commit}`], source.root, authority.signal)) !==
			target.pullRequest.headRefOid
		)
			throw new PrReviewCheckoutError("review_preparation_stale");
		authority.assertCurrent();
		const candidate: IrohRemoteWorkspaceWorktree = {
			id,
			workspaceName: workspace.name,
			path: getWorktreeCheckoutPath(this.options.agentDir, workspace.path, id),
			branch: `volt/${id}`,
			createdAt: Date.now(),
			sessionIds: [],
			sourceRootRelativePath: source.rootRelativePath,
		};
		const launch: PrReviewLaunch = {
			sessionId: request.sessionId,
			requestFingerprint: fingerprint,
			placement: placement(candidate),
			disposition: "created",
		};
		const created = await this.options.worktrees.create(workspace, {
			id,
			branch: candidate.branch,
			baseRef: target.pullRequest.headRefOid,
			workingDirectory: source.rootRelativePath,
			signal: authority.signal,
			prReviewLaunch: launch,
			assertCurrent: authority.assertCurrent,
		});
		if (!created.ok)
			throw new PrReviewCheckoutError(
				created.error === "worktree_limit_reached" ? created.error : "review_preparation_failed",
			);
		authority.assertCurrent();
		await this.validatePlacement(workspace, launch.placement, authority);
		return this.response(launch);
	}

	async validatePlacement(
		workspace: IrohRemoteWorkspace,
		placement: PrReviewPlacement,
		authority: PrReviewPreparationAuthority,
	): Promise<void> {
		authority.assertCurrent();
		if (
			placement.workspaceName !== workspace.name ||
			placement.workspaceGeneration !== authority.workspaceGeneration ||
			!(await this.cleanHead(
				placement.cwd,
				placement.commonDirectory,
				placement.pullRequest.headRefOid,
				authority.signal,
			))
		)
			throw new PrReviewCheckoutError("review_preparation_stale");
		const root = await this.source(
			workspace,
			{ workingDirectory: placement.sourceRootRelativePath },
			authority.signal,
		);
		if (root.commonDirectory !== placement.commonDirectory)
			throw new PrReviewCheckoutError("review_preparation_stale");
		const current = await this.target(
			{ ...root, cwd: placement.sourceCwd },
			{ number: String(placement.pullRequest.number) },
			authority.signal,
		);
		if (
			current.repository.canonicalId !== placement.repositoryId ||
			current.headRepository.canonicalId !== placement.headRepositoryId ||
			current.remote !== placement.remote ||
			current.pullRequest.url !== placement.pullRequest.url ||
			current.pullRequest.headRefOid !== placement.pullRequest.headRefOid
		)
			throw new PrReviewCheckoutError("review_preparation_stale");
		authority.assertCurrent();
	}

	/** Recover interrupted launches on resume, with the same pre-publication binding as a new attach. */
	async prepareSession(
		authorization: IrohRemoteClientAuthorizationSuccess,
		hello: IrohRemoteHello,
		authority: PrReviewPreparationAuthority,
	): Promise<((manager: SessionManager) => Promise<void>) | undefined> {
		if (hello.mode !== "conversation") return undefined;
		const sessionId = getResolvedTargetSessionId(hello, authorization);
		if (sessionId === undefined) return undefined;
		let target: { worktreeId?: string; workingDirectory?: string };
		if (hello.conversation.target === "new") {
			target = hello.conversation;
		} else {
			const records = await this.options.stateManager.listWorktrees(authorization.workspace.name);
			const launch = records
				.flatMap((record) => record.prReviewLaunches ?? [])
				.find((entry) => entry.sessionId === sessionId);
			// Completed launches may contain intentional fixes. Only pending admission
			// needs recovery; ordinary resumes must not revalidate checkout cleanliness.
			if (!launch || launch.sessionGeneration !== undefined) return undefined;
			target = {
				worktreeId: launch.placement.worktreeId,
				workingDirectory: launch.placement.sourceRootRelativePath,
			};
		}
		const placement = await this.admit(
			authorization.workspace,
			sessionId,
			target.worktreeId,
			target.workingDirectory,
			authority,
		);
		if (!placement) return undefined;
		for (const capability of ["conversation.control.v1", "worktrees.manage.v1"] as const) {
			if (!hasIrohRemoteRpcCapability(authorization.client.rpcGrant, capability))
				throw new PrReviewPreparationError("review_preparation_failed");
		}
		return (manager) => this.bind(authorization.workspace, manager, placement, authority);
	}

	async admit(
		workspace: IrohRemoteWorkspace,
		sessionId: string,
		worktreeId: string | undefined,
		workingDirectory: string | undefined,
		authority: PrReviewPreparationAuthority,
	): Promise<PrReviewPlacement | undefined> {
		const records = await this.options.stateManager.listWorktrees(workspace.name);
		const launch = records
			.flatMap((record) => record.prReviewLaunches ?? [])
			.find((entry) => entry.sessionId === sessionId);
		if (!launch) return undefined;
		const placement = launch.placement;
		if (
			placement.workspaceName !== workspace.name ||
			placement.worktreeId !== worktreeId ||
			placement.sourceRootRelativePath !== workingDirectory ||
			placement.workspaceGeneration !== authority.workspaceGeneration
		)
			throw new PrReviewCheckoutError("review_preparation_conflict");
		if (!launch.sessionGeneration) await this.validatePlacement(workspace, placement, authority);
		authority.assertCurrent();
		return structuredClone(placement);
	}

	async bind(
		workspace: IrohRemoteWorkspace,
		manager: SessionManager,
		placement: PrReviewPlacement,
		authority: PrReviewPreparationAuthority,
	): Promise<void> {
		authority.assertCurrent();
		const ref = manager.getSessionRef();
		if (!ref || manager.getCwd() !== placement.cwd) throw new PrReviewCheckoutError("review_preparation_conflict");
		await this.options.stateManager.runWorkspaceWorktreeLifecycle(workspace.name, async ({ worktrees }) => {
			const record = worktrees.find((entry) => entry.id === placement.worktreeId);
			const launch = record?.prReviewLaunches?.find((entry) => entry.sessionId === ref.sessionId);
			if (
				!record ||
				!launch ||
				!isDeepStrictEqual(launch.placement, placement) ||
				(launch.sessionGeneration !== undefined &&
					(launch.sessionGeneration !== ref.sessionGeneration || launch.storeId !== ref.storeId))
			)
				throw new PrReviewCheckoutError("review_preparation_conflict");
			if (launch.sessionGeneration === undefined) await this.validatePlacement(workspace, placement, authority);
			authority.assertCurrent();
			if (!isDeepStrictEqual(manager.getSessionRef(), ref))
				throw new PrReviewCheckoutError("review_preparation_conflict");
			manager.recordPrReviewBinding(placement);
			await manager.flush();
			authority.assertCurrent();
			return {
				result: undefined,
				worktree: {
					...record,
					sessionIds: [...new Set([...record.sessionIds, ref.sessionId])],
					prReviewLaunches: record.prReviewLaunches!.map((entry) =>
						entry === launch
							? { ...entry, sessionGeneration: ref.sessionGeneration, storeId: ref.storeId }
							: entry,
					),
				},
			};
		});
	}
}
