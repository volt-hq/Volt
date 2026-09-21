import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { assertPrReviewCheckout } from "../../../src/core/pr-review-binding.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import { createEmptyIrohRemoteHostState, writeIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import { PrReviewCheckoutError, PrReviewCheckoutManager } from "../../../src/daemon/pr-review-checkout.ts";
import { runPrReviewGit } from "../../../src/daemon/pr-review-git.ts";
import { WorktreeLifecycle } from "../../../src/daemon/worktree-lifecycle.ts";
import { getWorktreeCheckoutPath, WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let seed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	seed = createPrReviewGitSeed("base\n", "PR head");
});
afterAll(() => seed?.dispose());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function fixture(maxWorktreesPerWorkspace = 1) {
	const harness = await createHarness({ settings: { lsp: { enabled: false } } });
	cleanups.push(() => harness.cleanupAsync());
	const root = realpathSync(harness.tempDir);
	const source = join(root, "workspace");
	const remote = join(root, "remote.git");
	const { head, base } = seed.copyTo(source, remote);
	const workspace = { name: "project", path: source };
	const agentDir = join(root, "agent");
	const statePath = join(root, "state.json");
	await writeIrohRemoteHostState(statePath, { ...createEmptyIrohRemoteHostState(), workspaces: [workspace] });
	const auditLogger = new IrohRemoteAuditLogger({ sink: { write: () => {} } });
	const open = () => {
		const state = new IrohRemoteHostStateManager({ statePath });
		const manager = new WorktreeManager({
			agentDir,
			stateManager: state,
			auditLogger,
			maxWorktreesPerWorkspace,
			hasActiveRuntimeForSession: () => false,
			reserveSessionsForRemoval: () => () => {},
		});
		return { state, manager };
	};
	const { state, manager } = open();
	const create = async (id: string) => {
		const result = await manager.create(workspace, { id });
		if (!result.ok) throw new Error(result.error);
		await manager.bindSession(workspace.name, id, `session-${id}`);
		return result.worktree;
	};
	const repository: ResolvedPullRequestCheckout["repository"] = {
		providerId: "github",
		host: "github.com",
		owner: "owner",
		name: "project",
		canonicalId: "github:github.com/owner/project",
	};
	const target: ResolvedPullRequestCheckout = {
		pullRequest: {
			provider: "github",
			url: "https://github.com/owner/project/pull/414",
			number: 414,
			title: "PR",
			repository: "owner/project",
			headRefName: "topic",
			headRefOid: head,
		},
		repository,
		headRepository: repository,
		remote: "origin",
		remoteUrl: remote,
		headRef: "refs/pull/414/head",
	};
	const reviews = new PrReviewCheckoutManager({
		agentDir,
		stateManager: state,
		worktrees: manager,
		hasActiveSession: () => false,
		provider: {
			...githubCliCodeHostProvider,
			resolvePullRequestCheckout: async ({ cwd }) => {
				// Preserve the real provider's dependency on the selected checkout, without network access.
				git(cwd, "rev-parse", "--git-common-dir");
				return { ok: true, target };
			},
		},
	});
	const request = {
		sessionId: "review-414",
		number: "414",
		expectedPullRequest: { url: target.pullRequest.url, headRefOid: head },
	};
	const authority = { workspaceGeneration: 1, assertCurrent: () => {} };
	const bindReview = async (worktreeId: string) => {
		const record = (await state.listWorktrees()).find((entry) => entry.id === worktreeId)!;
		const session = await SessionManager.create(record.path, getDefaultSessionDirPath(source, agentDir), {
			id: request.sessionId,
		});
		try {
			await reviews.bind(workspace, session, record.prReviewLaunches![0].placement, authority);
		} finally {
			await session.closePersistence();
		}
	};
	return {
		root,
		source,
		head,
		base,
		workspace,
		agentDir,
		state,
		manager,
		auditLogger,
		open,
		create,
		reviews,
		request,
		authority,
		bindReview,
	};
}

describe("#442 worktree reclamation", () => {
	it.each(["normalized", "duplicate", "different-checkout"])(
		"handles %s porcelain paths without weakening checkout identity",
		async (kind) => {
			const f = await fixture();
			const record = await f.create("paths");
			const lifecycle = new WorktreeLifecycle({
				stateManager: f.state,
				auditLogger: f.auditLogger,
				checkoutPath: (workspace, id) => getWorktreeCheckoutPath(f.agentDir, workspace.path, id),
				sourcePath: async () => f.source,
				isPreparing: () => false,
				reserveSessions: () => () => {},
				storedSessionIds: async () => [],
				runGit: async (args, cwd, options) => {
					const result = await runPrReviewGit(args, cwd, options);
					if (args[0] !== "worktree" || args[1] !== "list") return result;
					const entries = result.stdout
						.split("\0\0")
						.filter(Boolean)
						.map((entry) => {
							const fields = entry.split("\0");
							// Git emits forward slashes on Windows; /./ also exercises normalization on POSIX.
							fields[0] = `${fields[0].replaceAll("\\", "/")}/.`;
							if (kind === "different-checkout") fields[0] += "/other";
							return fields.join("\0");
						});
					return {
						...result,
						stdout: [...entries, ...(kind === "duplicate" ? entries : [])].join("\0\0") + "\0\0",
					};
				},
			});
			if (kind === "normalized") {
				expect(await lifecycle.archive(f.workspace.name, record.id)).toEqual({ removed: true });
				expect(existsSync(record.path)).toBe(false);
			} else {
				expect(await lifecycle.archive(f.workspace.name, record.id)).toEqual({
					removed: false,
					reason: "ownership_changed",
				});
				expect(existsSync(record.path)).toBe(true);
			}
		},
	);

	it.each(["branch", "repository"])("releases capacity durably when %s preflight fails", async (kind) => {
		const f = await fixture();
		const record = await f.create("moved");
		expect(await f.manager.archiveDisposable(f.workspace.name, record.id)).toEqual({ removed: true });
		if (kind === "branch") {
			git(f.source, "branch", "-f", record.branch, f.head);
		} else {
			const relocated = join(f.root, "relocated.git");
			renameSync(join(f.source, ".git"), relocated);
			writeFileSync(join(f.source, ".git"), `gitdir: ${relocated}\n`);
		}
		await expect(f.manager.resolveSessionWorktree(f.workspace.name, "session-moved")).rejects.toThrow(
			`${kind} changed`,
		);
		const restarted = f.open();
		const archived = (await restarted.state.listWorktrees())[0];
		expect(existsSync(record.path)).toBe(false);
		expect(existsSync(archived.checkoutArchive!.quarantinePath)).toBe(false);
		expect(archived.checkoutArchive).toMatchObject({ head: f.base });
		expect(archived.checkoutArchive?.restoring).toBeUndefined();
		expect(archived.sessionIds).toContain("session-moved");
		expect(await restarted.manager.archiveDisposable(f.workspace.name, record.id)).toEqual({
			removed: false,
			reason: "already_archived",
		});
		expect(await restarted.manager.create(f.workspace, { id: "next" })).toMatchObject({ ok: true });
	});

	it("retains capacity and recovery intent for a partial checkout when preflight fails", async () => {
		const f = await fixture();
		const record = await f.create("partial");
		expect(await f.manager.archiveDisposable(f.workspace.name, record.id)).toEqual({ removed: true });
		const archived = (await f.state.listWorktrees())[0];
		await f.state.upsertWorktree({ ...archived, checkoutArchive: { ...archived.checkoutArchive!, restoring: true } });
		git(f.source, "worktree", "add", "--no-checkout", record.path, record.branch);
		git(f.source, "update-ref", `refs/heads/${record.branch}`, f.head);
		await expect(f.manager.resolveSessionWorktree(f.workspace.name, "session-partial")).rejects.toThrow(
			"branch changed",
		);
		const restarted = f.open();
		expect((await restarted.state.listWorktrees())[0].checkoutArchive?.restoring).toBe(true);
		expect(existsSync(record.path)).toBe(true);
		expect(await restarted.manager.create(f.workspace, { id: "next" })).toEqual({
			ok: false,
			error: "worktree_limit_reached",
		});
	});

	it("protects a pending review's source across restart, retention and unrelated capacity pressure", async () => {
		const f = await fixture(2);
		const source = await f.create("review-source");
		const request = { ...f.request, sourceWorktreeId: source.id };
		const prepared = await f.reviews.prepare(f.workspace, request, f.authority);
		expect(prepared.worktreeId).not.toBe(source.id);
		const restarted = f.open();
		expect(await restarted.manager.archiveDisposable(f.workspace.name, source.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		expect(await restarted.manager.create(f.workspace, { id: "unrelated" })).toEqual({
			ok: false,
			error: "worktree_limit_reached",
		});
		expect(existsSync(source.path)).toBe(true);
		expect(await f.reviews.prepare(f.workspace, request, f.authority)).toEqual(prepared);
		expect(
			await f.reviews.admit(
				f.workspace,
				request.sessionId,
				prepared.worktreeId,
				prepared.workingDirectory,
				f.authority,
			),
		).toMatchObject({ sourceCwd: source.path });
	});

	it.each(["retention", "capacity"])("preserves a bound review's source through %s and resume", async (pressure) => {
		const f = await fixture(2);
		const source = await f.create("review-source");
		const prepared = await f.reviews.prepare(f.workspace, { ...f.request, sourceWorktreeId: source.id }, f.authority);
		await f.bindReview(prepared.worktreeId);
		const restarted = f.open();
		if (pressure === "retention") {
			expect(await restarted.manager.archiveDisposable(f.workspace.name, source.id)).toEqual({
				removed: false,
				reason: "busy",
			});
			expect(await restarted.manager.archiveDisposable(f.workspace.name, prepared.worktreeId)).toEqual({
				removed: true,
			});
		} else {
			expect(await restarted.manager.create(f.workspace, { id: "unrelated" })).toMatchObject({ ok: true });
			await restarted.manager.bindSession(f.workspace.name, "unrelated", "session-unrelated");
		}
		const archived = (await restarted.state.listWorktrees()).find((entry) => entry.id === prepared.worktreeId)!;
		expect(archived.checkoutArchive).toBeDefined();
		expect(existsSync(archived.path)).toBe(false);
		expect(existsSync(source.path)).toBe(true);
		// The source remains a dependency even while the review's own checkout is archived.
		expect(await restarted.manager.archiveDisposable(f.workspace.name, source.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		const resumed = f.open();
		const restored = await resumed.manager.resolveSessionWorktree(f.workspace.name, f.request.sessionId);
		expect(restored?.path).toBe(archived.path);
		expect(restored?.checkoutArchive).toBeUndefined();
		const ref = await SessionManager.findForResume(
			getDefaultSessionDirPath(f.source, f.agentDir),
			f.request.sessionId,
		);
		const session = await SessionManager.open(ref!);
		try {
			const binding = session.getPrReviewBinding()!;
			expect(binding.sourceCwd).toBe(source.path);
			await expect(assertPrReviewCheckout(binding, session.getCwd())).resolves.toBeUndefined();
			await expect(f.reviews.validatePlacement(f.workspace, binding, f.authority)).resolves.toBeUndefined();
		} finally {
			await session.closePersistence();
		}
	});

	it("reports the same typed capacity error for fresh and archived review preparation", async () => {
		const f = await fixture();
		const prepared = await f.reviews.prepare(f.workspace, f.request, f.authority);
		await f.bindReview(prepared.worktreeId);
		expect(await f.manager.archiveDisposable(f.workspace.name, prepared.worktreeId)).toEqual({ removed: true });
		// An unbound checkout is protected while waiting for its first session attach.
		expect(await f.manager.create(f.workspace, { id: "protected" })).toMatchObject({ ok: true });
		for (const sessionId of [f.request.sessionId, "fresh-review"]) {
			const preparation = f.reviews.prepare(f.workspace, { ...f.request, sessionId }, f.authority);
			await expect(preparation).rejects.toBeInstanceOf(PrReviewCheckoutError);
			await expect(preparation).rejects.toMatchObject({
				code: "worktree_limit_reached",
				message: "worktree_limit_reached",
			});
		}
		const archived = (await f.state.listWorktrees()).find((entry) => entry.id === prepared.worktreeId)!;
		expect(archived.checkoutArchive?.restoring).toBeUndefined();
		expect(existsSync(archived.path)).toBe(false);
	});
});
