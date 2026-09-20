import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import { createEmptyIrohRemoteHostState, writeIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import { PrReviewCheckoutManager } from "../../../src/daemon/pr-review-checkout.ts";
import { runPrReviewGit } from "../../../src/daemon/pr-review-git.ts";
import { resolveWorktreeCleanupPolicy } from "../../../src/daemon/state.ts";
import { WorktreeLifecycle } from "../../../src/daemon/worktree-lifecycle.ts";
import {
	getWorktreeCheckoutPath,
	type WorktreeGitRunner,
	WorktreeManager,
	WorktreeRetentionSweeper,
} from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let seed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	seed = createPrReviewGitSeed("base\n", "PR head");
});
afterAll(() => seed.dispose());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function fixture(maxWorktreesPerWorkspace = 16) {
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
	const events: IrohRemoteAuditEvent[] = [];
	const auditLogger = new IrohRemoteAuditLogger({
		sink: {
			write: (event) => {
				events.push(event);
			},
		},
	});
	const active = new Set<string>();
	const reserved = new Set<string>();
	let now = Date.now();
	const open = () => {
		const state = new IrohRemoteHostStateManager({ statePath });
		const manager = new WorktreeManager({
			agentDir,
			stateManager: state,
			auditLogger,
			maxWorktreesPerWorkspace,
			now: () => now,
			hasActiveRuntimeForSession: (_workspace, id) => active.has(id),
			reserveSessionsForRemoval: (_workspace, ids) => {
				if (ids.some((id) => active.has(id) || reserved.has(id))) return undefined;
				for (const id of ids) reserved.add(id);
				return () => {
					for (const id of ids) reserved.delete(id);
				};
			},
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
	return {
		harness,
		root,
		source,
		remote,
		head,
		base,
		workspace,
		agentDir,
		statePath,
		state,
		manager,
		auditLogger,
		events,
		active,
		reserved,
		open,
		create,
		advance: (ms: number) => {
			now += ms;
		},
		now: () => now,
	};
}

function reviewManager(f: Awaited<ReturnType<typeof fixture>>) {
	let number = 1;
	const repository: ResolvedPullRequestCheckout["repository"] = {
		providerId: "github",
		host: "github.com",
		owner: "owner",
		name: "project",
		canonicalId: "github:github.com/owner/project",
	};
	const target = (): ResolvedPullRequestCheckout => ({
		pullRequest: {
			provider: "github",
			url: `https://github.com/owner/project/pull/${number}`,
			number,
			title: "Review",
			repository: "owner/project",
			headRefName: "topic",
			headRefOid: f.head,
		},
		repository,
		headRepository: repository,
		remote: "origin",
		remoteUrl: f.remote,
		headRef: "refs/pull/414/head",
	});
	const reviews = new PrReviewCheckoutManager({
		agentDir: f.agentDir,
		stateManager: f.state,
		worktrees: f.manager,
		hasActiveSession: (_workspace, id) => f.active.has(id),
		provider: {
			...githubCliCodeHostProvider,
			resolvePullRequestCheckout: async () => ({ ok: true, target: target() }),
		},
	});
	const authority = { workspaceGeneration: 1, assertCurrent: () => {} };
	return {
		reviews,
		authority,
		request: (n: number) => {
			number = n;
			return {
				sessionId: `review-${n}`,
				number: String(n),
				expectedPullRequest: { url: target().pullRequest.url, headRefOid: f.head },
			};
		},
	};
}

function lifecycle(f: Awaited<ReturnType<typeof fixture>>, runGit: WorktreeGitRunner) {
	return new WorktreeLifecycle({
		stateManager: f.state,
		auditLogger: f.auditLogger,
		checkoutPath: (workspace, id) => getWorktreeCheckoutPath(f.agentDir, workspace.path, id),
		sourcePath: async () => f.source,
		isPreparing: () => false,
		hasActiveSession: () => false,
		reserveSessions: () => () => {},
		storedSessionIds: async () => [],
		runGit,
	});
}

describe("#426 disposable checkout lifecycle", () => {
	it("preserves ignored writes racing detachment, including across restart and prune", async () => {
		const f = await fixture();
		const record = await f.create("raced");
		writeFileSync(join(f.source, ".git", "info", "exclude"), ".env\n");
		const cleaner = lifecycle(f, async (args, cwd, options) => {
			if (args[0] === "worktree" && args[1] === "move") writeFileSync(join(record.path, ".env"), "irreplaceable\n");
			return runPrReviewGit(args, cwd, options);
		});
		expect(await cleaner.archive(f.workspace.name, record.id)).toEqual({
			removed: false,
			reason: "recovery_required",
		});
		const archived = (await f.state.listWorktrees())[0];
		expect(readFileSync(join(archived.checkoutArchive!.quarantinePath, ".env"), "utf8")).toBe("irreplaceable\n");
		const restarted = f.open();
		await restarted.manager.prune(f.workspace);
		await restarted.manager.resolveSessionWorktree(f.workspace.name, "session-raced");
		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("irreplaceable\n");
	});

	it("does not delete ignored writes to the original path at removal dispatch", async () => {
		const f = await fixture();
		const record = await f.create("late-write");
		writeFileSync(join(f.source, ".git", "info", "exclude"), ".env\n");
		const cleaner = lifecycle(f, async (args, cwd, options) => {
			if (args[0] === "worktree" && args[1] === "remove") {
				mkdirSync(record.path, { recursive: true });
				writeFileSync(join(record.path, ".env"), "late user write\n");
			}
			return runPrReviewGit(args, cwd, options);
		});
		await cleaner.archive(f.workspace.name, record.id);
		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("late user write\n");
		await expect(f.manager.resolveSessionWorktree(f.workspace.name, "session-late-write")).rejects.toThrow();
		expect(readFileSync(join(record.path, ".env"), "utf8")).toBe("late user write\n");
	});

	it.each(["empty", "partial", "user-edit"])(
		"recovers interrupted %s restoration without overwriting user files",
		async (phase) => {
			const f = await fixture();
			const record = await f.create("interrupted");
			await f.manager.archiveDisposable(f.workspace.name, record.id);
			const archived = (await f.state.listWorktrees())[0];
			await f.state.upsertWorktree({
				...archived,
				checkoutArchive: { ...archived.checkoutArchive!, restoring: true },
			});
			git(f.source, "worktree", "add", "--no-checkout", record.path, record.branch);
			if (phase !== "empty") {
				git(record.path, "read-tree", "HEAD");
				git(record.path, "checkout-index", "--", "value.txt");
			}
			if (phase === "user-edit") writeFileSync(join(record.path, "value.txt"), "user edits during restart\n");
			const restarted = f.open();
			if (phase === "user-edit") {
				await expect(
					restarted.manager.resolveSessionWorktree(f.workspace.name, "session-interrupted"),
				).rejects.toThrow();
				expect(readFileSync(join(record.path, "value.txt"), "utf8")).toBe("user edits during restart\n");
			} else {
				await restarted.manager.resolveSessionWorktree(f.workspace.name, "session-interrupted");
				expect(git(record.path, "status", "--porcelain")).toBe("");
				expect((await restarted.state.listWorktrees())[0].checkoutArchive).toBeUndefined();
			}
		},
	);

	it("rejects TUI lease publication if archival wins after lookup", async () => {
		const f = await fixture();
		const record = await f.create("binding");
		expect(await f.manager.findWorktree(f.workspace.name, record.id)).toBeDefined();
		await f.manager.archiveDisposable(f.workspace.name, record.id);
		let leasePublished = false;
		await expect(
			f.manager.bindSession(f.workspace.name, record.id, "tui", async () => {
				leasePublished = true;
			}),
		).rejects.toThrow("unavailable");
		expect(leasePublished).toBe(false);
		expect((await f.state.listWorktrees())[0].sessionIds).not.toContain("tui");
	});

	it("runs more than 16 completed reviews under defaults, preserving history and restoring exact placement after restart", async () => {
		const f = await fixture();
		const r = reviewManager(f);
		const sessionDir = getDefaultSessionDirPath(f.source, f.agentDir);
		for (let n = 1; n <= 18; n++) {
			const request = r.request(n);
			const prepared = await r.reviews.prepare(f.workspace, request, r.authority);
			const record = (await f.state.listWorktrees()).find((entry) => entry.id === prepared.worktreeId)!;
			const sessionManager = await SessionManager.create(record.path, sessionDir, { id: request.sessionId });
			await r.reviews.bind(f.workspace, sessionManager, record.prReviewLaunches![0].placement, r.authority);
			const runtime = await createHarness({ sessionManager, settings: { lsp: { enabled: false } } });
			try {
				runtime.setResponses([fauxAssistantMessage("Review complete: no findings.")]);
				await runtime.session.prompt("Review this change.");
			} finally {
				await runtime.cleanupAsync();
			}
			await f.manager.markWorktreeInactive(f.workspace.name, record.id);
		}
		const records = await f.state.listWorktrees();
		expect(records).toHaveLength(18);
		expect(records.filter((record) => existsSync(record.path))).toHaveLength(16);
		expect(records.filter((record) => record.checkoutArchive)).toHaveLength(2);
		expect(await f.manager.listRecoveryCheckouts()).toEqual([]);
		expect(await SessionManager.list(f.source, sessionDir)).toHaveLength(18);
		const archived = records.find((record) => record.sessionIds.includes("review-1"))!;
		expect(archived.prReviewLaunches?.[0].sessionGeneration).toBeTruthy();
		expect(git(f.source, "rev-parse", archived.branch)).toBe(f.head);
		const restarted = f.open();
		await restarted.manager.prune(f.workspace);
		const restored = await restarted.manager.resolveSessionWorktree(f.workspace.name, "review-1");
		expect(restored?.path).toBe(archived.path);
		expect(restored?.checkoutArchive).toBeUndefined();
		expect(git(archived.path, "rev-parse", "HEAD")).toBe(f.head);
		expect((await restarted.state.listWorktrees()).filter((record) => existsSync(record.path))).toHaveLength(16);
		expect(JSON.stringify(f.events)).not.toContain(f.root);
	}, 120_000);

	it.each([
		"dirty",
		"untracked",
		"ignored",
		"unmerged",
		"locked",
		"assume-unchanged",
		"active",
		"pending-attach",
		"preparing",
		"wrong-branch",
		"unknown-directory",
		"adopted",
	])("protects %s checkouts under capacity pressure", async (kind) => {
		const f = await fixture(1);
		const record = await f.create("protected");
		let release: (() => Promise<void>) | undefined;
		if (kind === "dirty") writeFileSync(join(record.path, "value.txt"), "user edits\n");
		if (kind === "untracked") writeFileSync(join(record.path, "notes.txt"), "user notes\n");
		if (kind === "ignored") {
			writeFileSync(join(f.source, ".git", "info", "exclude"), ".env\n");
			writeFileSync(join(record.path, ".env"), "secret\n");
		}
		if (kind === "unmerged") {
			writeFileSync(join(record.path, "value.txt"), "unique work\n");
			git(record.path, "commit", "-am", "unpublished");
		}
		if (kind === "locked") git(f.source, "worktree", "lock", record.path);
		if (kind === "assume-unchanged") {
			git(record.path, "update-index", "--assume-unchanged", "value.txt");
			writeFileSync(join(record.path, "value.txt"), "hidden edits\n");
		}
		if (kind === "active") f.active.add("session-protected");
		if (kind === "pending-attach") f.reserved.add("session-protected");
		if (kind === "preparing")
			release = (await f.manager.beginRuntimePreparation(f.workspace.name, record.id)).release;
		if (kind === "wrong-branch") git(record.path, "checkout", "-b", "user-branch");
		if (kind === "unknown-directory") {
			renameSync(record.path, `${record.path}-saved`);
			mkdirSync(record.path);
			writeFileSync(join(record.path, "notes.txt"), "unknown work\n");
		}
		if (kind === "adopted") await f.state.upsertWorktree({ ...record, disposable: false });
		try {
			expect(await f.manager.create(f.workspace, { id: "next" })).toEqual({
				ok: false,
				error: "worktree_limit_reached",
			});
			expect(existsSync(record.path)).toBe(true);
			expect((await f.state.listWorktrees())[0].checkoutArchive).toBeUndefined();
			expect(JSON.stringify(f.events)).not.toContain(f.root);
		} finally {
			await release?.();
		}
	});

	it("protects pending PR launches, then reclaims admitted inactive snapshots", async () => {
		const f = await fixture(1);
		const r = reviewManager(f);
		const request = r.request(1);
		const prepared = await r.reviews.prepare(f.workspace, request, r.authority);
		f.advance(7_200_000);
		expect(await f.manager.archiveDisposable(f.workspace.name, prepared.worktreeId)).toEqual({
			removed: false,
			reason: "busy",
		});
		const record = (await f.state.listWorktrees())[0];
		const session = await SessionManager.create(record.path, getDefaultSessionDirPath(f.source, f.agentDir), {
			id: request.sessionId,
		});
		await r.reviews.bind(f.workspace, session, record.prReviewLaunches![0].placement, r.authority);
		await session.closePersistence();
		expect(await f.manager.archiveDisposable(f.workspace.name, record.id)).toEqual({ removed: true });
		expect(await r.reviews.prepare(f.workspace, request, r.authority)).toEqual(prepared);
		expect(existsSync(record.path)).toBe(true);
	});

	it("reconstructs overdue retention from durable state after restart without another disposal", async () => {
		const f = await fixture();
		const record = await f.create("old");
		await f.manager.markWorktreeInactive(f.workspace.name, record.id);
		f.advance(3_600_001);
		const restarted = f.open();
		let finish = () => {};
		const archived = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const auditLogger = new IrohRemoteAuditLogger({
			sink: {
				write: (event) => {
					if (event.type === "worktree_retention_removed") finish();
				},
			},
		});
		const sweeper = new WorktreeRetentionSweeper({
			manager: restarted.manager,
			stateManager: restarted.state,
			auditLogger,
			getRetentionPolicy: () => resolveWorktreeCleanupPolicy({}).retention,
			now: f.now,
		});
		try {
			await archived;
			expect(existsSync(record.path)).toBe(false);
			expect((await restarted.state.listWorktrees())[0]).toMatchObject({
				sessionIds: ["session-old"],
				checkoutArchive: { head: f.base },
			});
		} finally {
			sweeper.dispose();
		}
	});

	it("serializes concurrent creates and resume preparations without losing bindings or exceeding capacity", async () => {
		const f = await fixture(2);
		const old = await f.create("old");
		await f.create("other");
		expect(await f.manager.archiveDisposable(f.workspace.name, old.id)).toEqual({ removed: true });
		const [preparation, created] = await Promise.all([
			f.manager.beginRuntimePreparation(f.workspace.name, old.id, "session-old"),
			f.manager.create(f.workspace, { id: "new" }),
		]);
		try {
			expect(created.ok).toBe(true);
			expect(existsSync(old.path)).toBe(true);
			expect(await f.manager.archiveDisposable(f.workspace.name, old.id)).toEqual({
				removed: false,
				reason: "busy",
			});
			expect((await f.state.listWorktrees()).filter((record) => existsSync(record.path))).toHaveLength(2);
		} finally {
			await preparation.release();
		}
	});

	it("refuses resume if an archived branch moved and never resets user work", async () => {
		const f = await fixture();
		const record = await f.create("moved");
		await f.manager.archiveDisposable(f.workspace.name, record.id);
		git(f.source, "branch", "-f", record.branch, f.head);
		await expect(f.manager.resolveSessionWorktree(f.workspace.name, "session-moved")).rejects.toThrow(
			"branch changed",
		);
		expect(existsSync(record.path)).toBe(false);
		expect(git(f.source, "rev-parse", record.branch)).toBe(f.head);
	});

	it("protects a live descendant found through stored cwd even when its binding is missing", async () => {
		const f = await fixture();
		const record = await f.create("descendant");
		const session = await SessionManager.create(record.path, getDefaultSessionDirPath(f.source, f.agentDir), {
			id: "unbound-child",
		});
		await session.closePersistence();
		f.active.add("unbound-child");
		expect(await f.manager.archiveDisposable(f.workspace.name, record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		expect(readFileSync(join(record.path, "value.txt"), "utf8")).toBe("base\n");
	});
});
