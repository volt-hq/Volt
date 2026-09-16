import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import {
	assertPrReviewCheckout,
	PR_CHECKOUT_CHANGED,
	PR_CHECKOUT_UNAVAILABLE,
} from "../../../src/core/pr-review-binding.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import {
	createEmptyIrohRemoteHostState,
	readIrohRemoteHostState,
	writeIrohRemoteHostState,
} from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { PrReviewCheckoutManager, type PrReviewPreparationRequest } from "../../../src/daemon/pr-review-checkout.ts";
import { runPrReviewGit } from "../../../src/daemon/pr-review-git.ts";
import {
	createDefaultWorktreeGitRunner,
	getWorktreeCheckoutPath,
	WorktreeManager,
} from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}
function isolateGitHome(root: string): string {
	const home = join(root, "home");
	mkdirSync(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
	vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
	return home;
}

async function fixture(nested = false, fileBacked = true, workspaceName = "project") {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-414-checkout-")));
	const source = join(root, "workspace", ...(nested ? ["nested"] : []));
	mkdirSync(source, { recursive: true });
	git(source, "init", "--initial-branch=main");
	git(source, "config", "user.name", "Test");
	git(source, "config", "user.email", "test@example.test");
	git(source, "config", "commit.gpgsign", "false");
	// Keep byte assertions stable in worktrees and clones, even with core.autocrlf=true.
	writeFileSync(join(source, ".gitattributes"), "value.txt text eol=lf\n");
	writeFileSync(join(source, "value.txt"), "base\n");
	git(source, "add", ".");
	git(source, "commit", "-m", "base");
	const base = git(source, "rev-parse", "HEAD");
	git(source, "checkout", "-b", "topic");
	writeFileSync(join(source, "value.txt"), "PR head\n");
	git(source, "commit", "-am", "head");
	const head = git(source, "rev-parse", "HEAD");
	const remote = join(root, "remote.git");
	git(root, "init", "--bare", remote);
	git(source, "push", remote, "HEAD:refs/pull/414/head");
	git(source, "checkout", "main");
	const workspace = { name: workspaceName, path: nested ? join(root, "workspace") : source };
	const statePath = join(root, "state.json");
	await writeIrohRemoteHostState(statePath, {
		...createEmptyIrohRemoteHostState(),
		workspaces: [workspace],
		workspaceGenerationCounter: 1,
		workspaceGenerations: [{ workspaceName: workspace.name, generation: 1 }],
	});
	const state = new IrohRemoteHostStateManager(
		fileBacked ? { statePath } : { initialState: await readIrohRemoteHostState(statePath) },
	);
	const audit = new IrohRemoteAuditLogger({ path: join(root, "audit.jsonl") });
	const agentDir = join(root, "agent");
	const worktrees = new WorktreeManager({ agentDir, stateManager: state, auditLogger: audit });
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
		repository: {
			providerId: "github",
			host: "github.com",
			owner: "owner",
			name: "project",
			canonicalId: "github:github.com/owner/project",
		},
		headRepository: {
			providerId: "github",
			host: "github.com",
			owner: "contributor",
			name: "fork",
			canonicalId: "github:github.com/contributor/fork",
		},
		remote: "origin",
		remoteUrl: remote,
		headRef: "refs/pull/414/head",
	};
	const provider = {
		...githubCliCodeHostProvider,
		resolvePullRequestCheckout: vi.fn(async () => ({ ok: true as const, target: structuredClone(target) })),
	};
	const busySessions = new Set<string>();
	const options = {
		agentDir,
		stateManager: state,
		worktrees,
		provider,
		hasActiveSession: (_workspace: string, id: string) => busySessions.has(id),
	};
	const manager = new PrReviewCheckoutManager(options);
	let active = true;
	const authority = {
		workspaceGeneration: 1,
		assertCurrent: () => {
			if (!active) throw new Error("revoked");
		},
	};
	const request: PrReviewPreparationRequest = {
		sessionId: "review-intent",
		number: "414",
		...(nested ? { workingDirectory: "nested" } : {}),
		expectedPullRequest: { url: target.pullRequest.url, headRefOid: head },
	};
	const sessions: SessionManager[] = [];
	const sessionDir = join(root, "sessions");
	cleanups.push(async () => {
		for (const session of sessions) await session.closePersistence();
		await audit.flush();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		root,
		source,
		base,
		head,
		workspace,
		state,
		audit,
		statePath,
		worktrees,
		manager,
		options,
		target,
		provider,
		authority,
		request,
		sessions,
		sessionDir,
		busySessions,
		revoke: () => {
			active = false;
		},
	};
}

async function submoduleFixture(nested = false) {
	const f = await fixture();
	isolateGitHome(f.root);
	const leaf = join(f.root, "leaf");
	mkdirSync(leaf);
	git(leaf, "init");
	git(leaf, "config", "user.name", "Test");
	git(leaf, "config", "user.email", "test@example.test");
	git(leaf, "config", "commit.gpgsign", "false");
	writeFileSync(join(leaf, "value.txt"), "base\n");
	writeFileSync(join(leaf, ".gitattributes"), "value.txt text eol=lf filter=prSub\n");
	git(leaf, "add", ".");
	git(leaf, "commit", "-m", "submodule base");
	const leafHead = git(leaf, "rev-parse", "HEAD");
	git(leaf, "commit", "--allow-empty", "-m", "submodule next");
	const nextHead = git(leaf, "rev-parse", "HEAD");
	git(leaf, "checkout", "--detach", leafHead);
	let remote = leaf;
	if (nested) {
		remote = join(f.root, "middle");
		git(f.root, "clone", leaf, remote);
		git(remote, "config", "user.name", "Test");
		git(remote, "config", "user.email", "test@example.test");
		git(remote, "config", "commit.gpgsign", "false");
		git(remote, "-c", "protocol.file.allow=always", "submodule", "add", leaf, "inner");
		git(remote, "commit", "-am", "nested submodule");
	}
	const name = "sub module";
	git(f.source, "checkout", "topic");
	git(f.source, "-c", "protocol.file.allow=always", "submodule", "add", remote, name);
	git(f.source, "commit", "-am", "add submodule");
	f.head = git(f.source, "rev-parse", "HEAD");
	f.target.pullRequest.headRefOid = f.head;
	f.request.expectedPullRequest.headRefOid = f.head;
	git(f.source, "checkout", "main");
	const path = join(f.root, "existing");
	git(f.source, "worktree", "add", path, "topic");
	git(path, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive");
	expect((await f.worktrees.adopt(f.workspace, { path, id: "existing" })).ok).toBe(true);
	const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
	expect(prepared.disposition).toBe("reused");
	const placement = (await f.state.listWorktrees())[0].prReviewLaunches![0].placement;
	const child = join(path, name, ...(nested ? ["inner"] : []));
	return { ...f, path, child, placement, prepared, nextHead, name };
}

describe("#414 prepared PR checkouts", () => {
	it.each([false, true])(
		"creates the exact fork PR head without changing the %s nested parent checkout",
		async (nested) => {
			const f = await fixture(nested);
			writeFileSync(join(f.source, "dirty.txt"), "unrelated work");
			const before = git(f.source, "status", "--porcelain");
			const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
			expect(prepared.disposition).toBe("created");
			const record = (await f.state.listWorktrees())[0];
			expect(git(record.path, "rev-parse", "HEAD")).toBe(f.head);
			expect(readFileSync(join(record.path, "value.txt"), "utf8")).toBe("PR head\n");
			expect(git(f.source, "rev-parse", "HEAD")).toBe(f.base);
			expect(git(f.source, "branch", "--show-current")).toBe("main");
			expect(git(f.source, "status", "--porcelain")).toBe(before);
			expect(prepared.workingDirectory).toBe(nested ? "nested" : undefined);
			expect(JSON.stringify(prepared)).not.toContain(f.root);
			await expect(
				assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path),
			).resolves.toBeUndefined();
			expect(await SessionManager.list(f.source, f.sessionDir)).toEqual([]);
		},
	);

	it("reuses a matching registered checkout and converges concurrent/restarted retries", async () => {
		const f = await fixture();
		const candidatePath = join(f.root, "existing");
		git(f.source, "worktree", "add", candidatePath, "topic");
		expect((await f.worktrees.adopt(f.workspace, { path: candidatePath, id: "existing" })).ok).toBe(true);
		const [first, second] = await Promise.all([
			f.manager.prepare(f.workspace, f.request, f.authority),
			f.manager.prepare(f.workspace, f.request, f.authority),
		]);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ disposition: "reused", worktreeId: "existing" });
		const restartedState = new IrohRemoteHostStateManager({ statePath: f.statePath });
		const restarted = new PrReviewCheckoutManager({ ...f.options, stateManager: restartedState });
		expect(await restarted.prepare(f.workspace, f.request, f.authority)).toEqual(first);
		expect(await f.state.listWorktrees()).toHaveLength(1);
		await expect(
			restarted.prepare(
				f.workspace,
				{ ...f.request, expectedPullRequest: { ...f.request.expectedPullRequest, headRefOid: f.base } },
				f.authority,
			),
		).rejects.toMatchObject({ code: "review_preparation_conflict" });
	});

	it.each(["before", "during"] as const)(
		"protects a reused pending launch prepared %s the retention sweep",
		async (timing) => {
			const f = await fixture();
			const first = await f.manager.prepare(f.workspace, f.request, f.authority);
			const firstRecord = (await f.state.listWorktrees())[0];
			const firstSession = await SessionManager.create(firstRecord.path, f.sessionDir, { id: f.request.sessionId });
			f.sessions.push(firstSession);
			await f.manager.bind(f.workspace, firstSession, firstRecord.prReviewLaunches![0].placement, f.authority);
			expect(firstRecord.baseRef).toBe(f.head);
			expect(git(f.source, "rev-parse", "main")).toBe(f.base);

			// The previous runtime is disposed: its old session can be reserved for removal.
			const reserveSessionsForRemoval = vi.fn(() => () => {});
			const runGit = createDefaultWorktreeGitRunner();
			let beforeRemoval: (() => Promise<void>) | undefined;
			const worktrees = new WorktreeManager({
				agentDir: f.options.agentDir,
				stateManager: f.state,
				auditLogger: f.audit,
				hasActiveRuntimeForSession: () => false,
				reserveSessionsForRemoval,
				runGit: async (args, cwd, options) => {
					const result = await runGit(args, cwd, options);
					if (args[0] === "merge-base") await beforeRemoval?.();
					return result;
				},
			});
			const manager = new PrReviewCheckoutManager({ ...f.options, worktrees });
			const request = { ...f.request, sessionId: "next-review" };
			const prepare = async () => {
				expect(await manager.prepare(f.workspace, request, f.authority)).toMatchObject({
					disposition: "reused",
					worktreeId: first.worktreeId,
				});
			};
			if (timing === "before") await prepare();
			else beforeRemoval = prepare;

			// This is the operation invoked when the previous runtime's retention timer fires.
			expect(await worktrees.removeIfCleanAndMerged(f.workspace, first.worktreeId)).toEqual({
				removed: false,
				reason: "worktree_busy",
			});
			beforeRemoval = undefined;
			expect(await worktrees.remove(f.workspace, first.worktreeId)).toEqual({ ok: false, error: "worktree_busy" });
			expect(reserveSessionsForRemoval).not.toHaveBeenCalled();
			expect(git(firstRecord.path, "rev-parse", "HEAD")).toBe(f.head);
			const persisted = await new IrohRemoteHostStateManager({ statePath: f.statePath }).listWorktrees();
			expect(persisted[0].sessionIds).toEqual([f.request.sessionId]);
			expect(persisted[0].prReviewLaunches).toHaveLength(2);
			expect(persisted[0].prReviewLaunches![1]).toMatchObject({ sessionId: request.sessionId });
			expect(persisted[0].prReviewLaunches![1].sessionGeneration).toBeUndefined();

			const placement = await manager.admit(
				f.workspace,
				request.sessionId,
				first.worktreeId,
				undefined,
				f.authority,
			);
			if (!placement) throw new Error("missing placement");
			const reservation = await worktrees.beginRuntimePreparation(
				f.workspace.name,
				first.worktreeId,
				request.sessionId,
			);
			try {
				const session = await SessionManager.create(placement.cwd, f.sessionDir, { id: request.sessionId });
				f.sessions.push(session);
				await manager.bind(f.workspace, session, placement, f.authority);
				expect(session.getPrReviewBinding()).toEqual(placement);
			} finally {
				await reservation.release();
			}
			// Completed, idle launches must not pin a checkout forever.
			expect(await worktrees.removeIfCleanAndMerged(f.workspace, first.worktreeId)).toEqual({ removed: true });
			expect(await f.state.listWorktrees()).toEqual([]);
		},
	);

	it("allows explicit forced cancellation of a pending launch but not an in-flight runtime preparation", async () => {
		const f = await fixture();
		const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
		const record = (await f.state.listWorktrees())[0];
		const placement = record.prReviewLaunches![0].placement;
		expect(await f.worktrees.remove(f.workspace, prepared.worktreeId)).toEqual({ ok: false, error: "worktree_busy" });
		const reservation = await f.worktrees.beginRuntimePreparation(
			f.workspace.name,
			prepared.worktreeId,
			f.request.sessionId,
		);
		try {
			expect(await f.worktrees.remove(f.workspace, prepared.worktreeId, { force: true })).toEqual({
				ok: false,
				error: "worktree_busy",
			});
		} finally {
			await reservation.release();
		}
		const session = await SessionManager.create(placement.cwd, f.sessionDir, { id: f.request.sessionId });
		f.sessions.push(session);
		expect(await f.worktrees.remove(f.workspace, prepared.worktreeId, { force: true })).toEqual({ ok: true });
		expect(existsSync(record.path)).toBe(false);
		expect(await f.state.listWorktrees()).toEqual([]);
		await expect(
			f.worktrees.beginRuntimePreparation(f.workspace.name, prepared.worktreeId, f.request.sessionId),
		).rejects.toThrow("unavailable");
		await expect(f.manager.bind(f.workspace, session, placement, f.authority)).rejects.toMatchObject({
			code: "review_preparation_conflict",
		});
	});

	it("prepares and retries the same session ID independently in two workspaces", async () => {
		const a = await fixture();
		const b = await fixture(false, true, "other");
		await a.state.upsertWorkspace(b.workspace);
		const worktrees = new WorktreeManager({
			agentDir: a.options.agentDir,
			stateManager: a.state,
			auditLogger: a.audit,
		});
		const manager = new PrReviewCheckoutManager({
			...b.options,
			agentDir: a.options.agentDir,
			stateManager: a.state,
			worktrees,
		});
		const first = await a.manager.prepare(a.workspace, a.request, a.authority);
		const second = await manager.prepare(b.workspace, b.request, b.authority);
		expect(first.sessionId).toBe(second.sessionId);
		expect(first.workspaceName).toBe(a.workspace.name);
		expect(second.workspaceName).toBe(b.workspace.name);
		expect(await a.state.listWorktrees(a.workspace.name)).toHaveLength(1);
		expect(await a.state.listWorktrees(b.workspace.name)).toHaveLength(1);
		expect(await a.manager.prepare(a.workspace, a.request, a.authority)).toEqual(first);
		expect(await manager.prepare(b.workspace, b.request, b.authority)).toEqual(second);
	});

	it.each(["home", "xdg"])("validates reused checkouts with %s global ignore configuration", async (location) => {
		const f = await fixture();
		const home = isolateGitHome(f.root);
		const ignore = join(home, "ignore");
		writeFileSync(ignore, "scratch.tmp\n");
		const config = location === "home" ? join(home, ".gitconfig") : join(home, ".config", "git", "config");
		if (location === "xdg") mkdirSync(join(home, ".config", "git"), { recursive: true });
		git(f.source, "config", "--file", config, "core.excludesFile", ignore);
		const path = join(f.root, "existing");
		git(f.source, "worktree", "add", path, "topic");
		expect((await f.worktrees.adopt(f.workspace, { path, id: "existing" })).ok).toBe(true);
		writeFileSync(join(path, "scratch.tmp"), "ignored before preparation\n");
		const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
		expect(prepared).toMatchObject({ disposition: "reused", worktreeId: "existing" });
		const placement = (await f.state.listWorktrees())[0].prReviewLaunches![0].placement;
		for (const _ of [1, 2]) {
			await expect(assertPrReviewCheckout(placement, path)).resolves.toBeUndefined();
			expect(await f.manager.prepare(f.workspace, f.request, f.authority)).toEqual(prepared);
		}
		writeFileSync(join(path, "not-ignored.txt"), "real change\n");
		await expect(assertPrReviewCheckout(placement, path)).rejects.toThrow(PR_CHECKOUT_CHANGED);
	});

	it.skipIf(process.platform === "win32")(
		"honors explicit global repository trust without bypassing ownership checks",
		async () => {
			const f = await fixture();
			isolateGitHome(f.root);
			// Hosted runners may trust every repository in their system Git config.
			git(f.root, "config", "--global", "--add", "safe.directory", "");
			const path = join(f.root, "existing");
			git(f.source, "worktree", "add", path, "topic");
			expect((await f.worktrees.adopt(f.workspace, { path, id: "existing" })).ok).toBe(true);
			const executable = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
			const bin = join(f.root, "bin");
			mkdirSync(bin);
			// Exercise Git's actual ownership checks without requiring chown/root.
			writeFileSync(
				join(bin, "git"),
				`#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec '${executable.replaceAll("'", "'\\''")}' "$@"\n`,
				{ mode: 0o755 },
			);
			vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
			await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
				code: "review_preparation_failed",
			});
			git(f.root, "config", "--global", "--add", "safe.directory", f.source);
			git(f.root, "config", "--global", "--add", "safe.directory", path);
			const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
			expect(prepared).toMatchObject({ disposition: "reused", worktreeId: "existing" });
			const placement = (await f.state.listWorktrees())[0].prReviewLaunches![0].placement;
			await expect(assertPrReviewCheckout(placement, path)).resolves.toBeUndefined();
			// Keep the reset entry so revoking explicit trust does not restore a system wildcard.
			git(f.root, "config", "--global", "--replace-all", "safe.directory", "");
			await expect(assertPrReviewCheckout(placement, path)).rejects.toThrow(PR_CHECKOUT_UNAVAILABLE);
		},
	);

	it("ignores injected configuration and repository selectors in both Git runners", async () => {
		const f = await fixture();
		await f.manager.prepare(f.workspace, f.request, f.authority);
		const record = (await f.state.listWorktrees())[0];
		const injected = join(f.root, "injected.gitconfig");
		git(f.root, "config", "--file", injected, "core.bare", "true");
		vi.stubEnv("GIT_CONFIG_GLOBAL", injected);
		vi.stubEnv("GIT_CONFIG_COUNT", "1");
		vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
		vi.stubEnv("GIT_CONFIG_VALUE_0", "true");
		vi.stubEnv("GIT_DIR", join(f.source, ".git"));
		vi.stubEnv("GIT_WORK_TREE", f.source);
		vi.stubEnv("GIT_INDEX_FILE", join(f.root, "missing-index"));
		await expect(runPrReviewGit(["rev-parse", "HEAD"], record.path)).resolves.toMatchObject({
			ok: true,
			stdout: `${f.head}\n`,
		});
		await expect(assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path)).resolves.toBeUndefined();
	});

	it("reports configuration read failures separately from checkout changes", async () => {
		const f = await fixture();
		const home = isolateGitHome(f.root);
		await f.manager.prepare(f.workspace, f.request, f.authority);
		const record = (await f.state.listWorktrees())[0];
		writeFileSync(join(home, ".gitconfig"), "[invalid configuration\n");
		await expect(assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path)).rejects.toThrow(
			PR_CHECKOUT_UNAVAILABLE,
		);
		writeFileSync(join(home, ".gitconfig"), "");
		await expect(assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path)).resolves.toBeUndefined();
	});

	it.each(["dirty", "busy", "head", "operation", "unreadable"])("does not reuse a %s candidate", async (kind) => {
		const f = await fixture();
		const path = join(f.root, "existing");
		git(f.source, "worktree", "add", path, "topic");
		await f.worktrees.adopt(f.workspace, { path, id: "existing" });
		if (kind === "dirty") writeFileSync(join(path, "untracked"), "work");
		if (kind === "busy") {
			await f.worktrees.bindSession(f.workspace.name, "existing", "unrelated");
			f.busySessions.add("unrelated");
		}
		if (kind === "head") git(path, "checkout", "--detach", f.base);
		if (kind === "operation")
			writeFileSync(git(path, "rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"), `${f.base}\n`);
		if (kind === "unreadable") rmSync(join(path, ".git"));
		expect((await f.manager.prepare(f.workspace, f.request, f.authority)).disposition).toBe("created");
		expect(await f.state.listWorktrees()).toHaveLength(2);
	});

	it("rejects moved heads and revoked preparation without creating a checkout or session", async () => {
		const f = await fixture();
		f.target.pullRequest.headRefOid = f.base;
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_stale",
		});
		f.target.pullRequest.headRefOid = f.head;
		f.revoke();
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toThrow("revoked");
		expect(await f.state.listWorktrees()).toEqual([]);
		expect(await SessionManager.list(f.source, f.sessionDir)).toEqual([]);
	});

	it("resolves current PR from a registered source worktree, not the parent branch", async () => {
		const f = await fixture();
		const path = join(f.root, "source-worktree");
		git(f.source, "worktree", "add", path, "topic");
		await f.worktrees.adopt(f.workspace, { path, id: "source" });
		await f.manager.resolve(f.workspace, { sourceWorktreeId: "source" }, f.authority);
		expect(f.provider.resolvePullRequestCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: path, number: undefined }),
		);
		expect(git(f.source, "branch", "--show-current")).toBe("main");
	});

	it("does not reuse the same branch and commit from a replaced, unrelated repository", async () => {
		const f = await fixture();
		const path = join(f.root, "existing");
		git(f.source, "worktree", "add", path, "topic");
		await f.worktrees.adopt(f.workspace, { path, id: "existing" });
		rmSync(path, { recursive: true });
		git(f.root, "clone", "--branch", "topic", f.source, path);
		expect(git(path, "rev-parse", "HEAD")).toBe(f.head);
		expect((await f.manager.prepare(f.workspace, f.request, f.authority)).disposition).toBe("created");
		expect(readFileSync(join(path, "value.txt"), "utf8")).toBe("PR head\n");
	});

	it("preserves unowned deterministic path collisions instead of adopting or deleting them", async () => {
		const f = await fixture();
		const id = `review-${createHash("sha256").update(f.request.sessionId).digest("hex").slice(0, 24)}`;
		const path = getWorktreeCheckoutPath(f.options.agentDir, f.workspace.path, id);
		mkdirSync(path, { recursive: true });
		writeFileSync(join(path, "owned-by-user"), "keep");
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_failed",
		});
		expect(readFileSync(join(path, "owned-by-user"), "utf8")).toBe("keep");
		expect(await f.state.listWorktrees()).toEqual([]);
	});

	it.each(["local", "global"])("runs neither hooks, fsmonitor nor filters from %s configuration", async (scope) => {
		const f = await fixture();
		isolateGitHome(f.root);
		const marker = join(f.root, "executed");
		const hooks = join(f.root, "hooks");
		mkdirSync(hooks);
		writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
		git(f.source, "config", `--${scope}`, "core.hooksPath", hooks);
		git(f.source, "config", `--${scope}`, "core.fsmonitor", `touch '${marker}'`);
		git(f.source, "config", `--${scope}`, "filter.test.clean", `touch '${marker}'; cat`);
		git(f.source, "config", `--${scope}`, "filter.test.smudge", `touch '${marker}'; cat`);
		git(f.source, "config", `--${scope}`, "filter.test.process", `touch '${marker}'; exit 1`);
		git(f.source, "config", `--${scope}`, "filter.test.required", "true");
		writeFileSync(join(f.source, ".git", "info", "attributes"), "value.txt filter=test\n");
		await f.manager.prepare(f.workspace, f.request, f.authority);
		const record = (await f.state.listWorktrees())[0];
		await assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path);
		writeFileSync(join(record.path, "value.txt"), "dirty file forces clean-filter evaluation\n");
		await expect(assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path)).rejects.toThrow(
			PR_CHECKOUT_CHANGED,
		);
		expect(existsSync(marker)).toBe(false);
	});

	it.each([
		[false, "local", "clean"],
		[false, "local", "process"],
		[false, "conditional", "clean"],
		[false, "conditional", "process"],
		[true, "local", "clean"],
		[true, "local", "process"],
		[true, "conditional", "clean"],
		[true, "conditional", "process"],
	] as const)("sanitizes nested=%s submodule %s %s filters in both validators", async (nested, scope, driver) => {
		const f = await submoduleFixture(nested);
		const marker = join(f.root, "submodule-filter-executed");
		const command = `touch '${marker}'; ${driver === "clean" ? "cat" : "exit 1"}`;
		if (scope === "local") {
			git(f.child, "config", `filter.prSub.${driver}`, command);
			git(f.child, "config", "filter.prSub.required", "true");
		} else {
			const include = join(f.root, "submodule-filters.gitconfig");
			git(f.child, "config", "--file", include, `filter.prSub.${driver}`, command);
			git(f.child, "config", "--file", include, "filter.prSub.required", "true");
			const gitDirectory = git(f.child, "rev-parse", "--absolute-git-dir");
			git(f.child, "config", "--global", `includeIf.gitdir:${gitDirectory}.path`, include);
		}
		expect(git(f.path, "config", "--list", "--name-only")).not.toContain(`filter.prSub.${driver}`);
		await expect(assertPrReviewCheckout(f.placement, f.path)).resolves.toBeUndefined();
		expect(await f.manager.prepare(f.workspace, f.request, f.authority)).toEqual(f.prepared);
		expect(existsSync(marker)).toBe(false);
		// Same size forces content comparison instead of Git's size-only dirty shortcut.
		writeFileSync(join(f.child, "value.txt"), "edit\n");
		await expect(assertPrReviewCheckout(f.placement, f.path)).rejects.toThrow(PR_CHECKOUT_CHANGED);
		expect(existsSync(marker)).toBe(false);
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_stale",
		});
		expect(existsSync(marker)).toBe(false);
	});

	it.each([false, true])("preserves nested=%s submodule cleanliness and gitlink checks", async (nested) => {
		const f = await submoduleFixture(nested);
		const parent = nested ? join(f.path, f.name) : f.path;
		const name = nested ? "inner" : f.name;
		const assertRejected = async () => {
			await expect(assertPrReviewCheckout(f.placement, f.path)).rejects.toThrow(PR_CHECKOUT_CHANGED);
			await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
				code: "review_preparation_stale",
			});
		};
		await expect(assertPrReviewCheckout(f.placement, f.path)).resolves.toBeUndefined();
		writeFileSync(join(f.child, "untracked.txt"), "untracked\n");
		await assertRejected();
		rmSync(join(f.child, "untracked.txt"));
		git(f.child, "checkout", "--detach", f.nextHead);
		await assertRejected();
		git(parent, "add", "--", name);
		await assertRejected(); // HEAD now matches the index, but the gitlink is staged.
		git(parent, "reset", "HEAD", "--", name);
		git(parent, "-c", "protocol.file.allow=always", "submodule", "update", "--", name);
		await expect(assertPrReviewCheckout(f.placement, f.path)).resolves.toBeUndefined();
		git(parent, "submodule", "deinit", "-f", "--", name);
		await expect(assertPrReviewCheckout(f.placement, f.path)).resolves.toBeUndefined();
		expect(await f.manager.prepare(f.workspace, f.request, f.authority)).toEqual(f.prepared);
	});

	it("fails closed on unreadable submodule configuration without executing filters", async () => {
		const f = await submoduleFixture(true);
		const config = git(f.child, "rev-parse", "--path-format=absolute", "--git-path", "config");
		writeFileSync(config, "[invalid configuration\n");
		await expect(assertPrReviewCheckout(f.placement, f.path)).rejects.toThrow(PR_CHECKOUT_UNAVAILABLE);
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_stale",
		});
	});

	it.skipIf(process.platform === "win32")(
		"rejects a symlinked submodule instead of inspecting its target",
		async () => {
			const f = await submoduleFixture();
			rmSync(f.child, { recursive: true });
			symlinkSync(f.source, f.child, "dir");
			await expect(assertPrReviewCheckout(f.placement, f.path)).rejects.toThrow(PR_CHECKOUT_CHANGED);
			await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
				code: "review_preparation_stale",
			});
		},
	);

	it.each([
		["local", "onbranch", "smudge"],
		["local", "onbranch", "process"],
		["local", "gitdir", "smudge"],
		["local", "gitdir", "process"],
		["global", "onbranch", "smudge"],
		["global", "onbranch", "process"],
		["global", "gitdir", "smudge"],
		["global", "gitdir", "process"],
	])("disables destination-only %s %s %s filters before checkout", async (scope, condition, driver) => {
		const f = await fixture();
		isolateGitHome(f.root);
		const marker = join(f.root, "executed");
		const include = join(f.root, "filters.gitconfig");
		const match =
			condition === "onbranch" ? "onbranch:volt/**" : `gitdir:${f.source.replaceAll("\\", "/")}/.git/worktrees/**`;
		git(f.source, "config", "--file", include, `filter.test.${driver}`, `touch '${marker}'; exit 1`);
		git(f.source, "config", "--file", include, "filter.test.clean", `touch '${marker}'; cat`);
		git(f.source, "config", "--file", include, "filter.test.required", "true");
		git(f.source, "config", `--${scope}`, `includeIf.${match}.path`, include);
		writeFileSync(join(f.source, ".git", "info", "attributes"), "value.txt filter=test\n");
		expect(git(f.source, "config", "--list", "--name-only")).not.toContain(`filter.test.${driver}`);

		const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
		const record = (await f.state.listWorktrees())[0];
		expect(prepared.disposition).toBe("created");
		expect(git(record.path, "config", "--list", "--name-only")).toContain(`filter.test.${driver}`);
		expect(git(record.path, "rev-parse", "HEAD")).toBe(f.head);
		expect(readFileSync(join(record.path, "value.txt"), "utf8")).toBe("PR head\n");
		expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("base\n");
		expect(git(f.source, "branch", "--show-current")).toBe("main");
		await assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path);
		writeFileSync(join(record.path, "value.txt"), "dirty file forces clean-filter evaluation\n");
		await expect(assertPrReviewCheckout(record.prReviewLaunches![0].placement, record.path)).rejects.toThrow(
			PR_CHECKOUT_CHANGED,
		);
		expect(existsSync(marker)).toBe(false);
	});

	it("does not publish a checkout when destination filter configuration cannot be disabled", async () => {
		const f = await fixture();
		isolateGitHome(f.root);
		const include = join(f.root, "filters.gitconfig");
		const marker = join(f.root, "executed");
		git(f.source, "config", "--file", include, "filter.invalid name.smudge", `touch '${marker}'; cat`);
		git(f.source, "config", "--file", include, "filter.test.smudge", `touch '${marker}'; cat`);
		git(f.source, "config", "includeIf.onbranch:volt/**.path", include);
		writeFileSync(join(f.source, ".git", "info", "attributes"), "value.txt filter=test\n");
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_failed",
		});
		const id = `review-${createHash("sha256").update(f.request.sessionId).digest("hex").slice(0, 24)}`;
		const path = getWorktreeCheckoutPath(f.options.agentDir, f.workspace.path, id);
		expect(existsSync(join(path, ".git"))).toBe(true);
		expect(existsSync(join(path, "value.txt"))).toBe(false);
		expect(existsSync(marker)).toBe(false);
		expect(await f.state.listWorktrees()).toEqual([]);
		expect(await SessionManager.list(f.source, f.sessionDir)).toEqual([]);
	});

	it.each(["cancelled", "revoked"])("does not populate or publish a checkout %s between stages", async (kind) => {
		const f = await fixture();
		const controller = new AbortController();
		const id = `review-${createHash("sha256").update(f.request.sessionId).digest("hex").slice(0, 24)}`;
		const path = getWorktreeCheckoutPath(f.options.agentDir, f.workspace.path, id);
		await expect(
			f.manager.prepare(f.workspace, f.request, {
				...f.authority,
				signal: controller.signal,
				assertCurrent: () => {
					if (existsSync(join(path, ".git"))) {
						writeFileSync(join(path, "unrelated.txt"), "preserve\n");
						if (kind === "cancelled") controller.abort();
						else f.revoke();
					}
					controller.signal.throwIfAborted();
					f.authority.assertCurrent();
				},
			}),
		).rejects.toThrow();
		expect(existsSync(join(path, ".git"))).toBe(true);
		expect(existsSync(join(path, "value.txt"))).toBe(false);
		expect(readFileSync(join(path, "unrelated.txt"), "utf8")).toBe("preserve\n");
		expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("base\n");
		expect(await f.state.listWorktrees()).toEqual([]);
		expect(await SessionManager.list(f.source, f.sessionDir)).toEqual([]);
	});

	it("retains a successfully created checkout when cancelled before returning its receipt", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const create = f.worktrees.create.bind(f.worktrees);
		vi.spyOn(f.worktrees, "create").mockImplementation(async (...args) => {
			const result = await create(...args);
			controller.abort();
			return result;
		});
		await expect(
			f.manager.prepare(f.workspace, f.request, {
				...f.authority,
				signal: controller.signal,
				assertCurrent: () => controller.signal.throwIfAborted(),
			}),
		).rejects.toThrow();
		const records = await f.state.listWorktrees();
		expect(records).toHaveLength(1);
		expect(git(records[0].path, "rev-parse", "HEAD")).toBe(f.head);
		expect((await f.manager.prepare(f.workspace, f.request, f.authority)).worktreeId).toBe(records[0].id);
	});

	it("retains checkout files but does not launch when durable worktree persistence fails", async () => {
		const f = await fixture();
		const initial = await f.state.getState();
		const state = new IrohRemoteHostStateManager({
			store: {
				read: () => initial,
				write: (snapshot) => {
					if ((snapshot.worktrees?.length ?? 0) > 0) throw new Error("disk unavailable");
				},
			},
		});
		const worktrees = new WorktreeManager({
			agentDir: f.options.agentDir,
			stateManager: state,
			auditLogger: f.audit,
		});
		const manager = new PrReviewCheckoutManager({ ...f.options, stateManager: state, worktrees });
		await expect(manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_failed",
		});
		const id = `review-${createHash("sha256").update(f.request.sessionId).digest("hex").slice(0, 24)}`;
		const path = getWorktreeCheckoutPath(f.options.agentDir, f.workspace.path, id);
		expect(readFileSync(join(path, "value.txt"), "utf8")).toBe("PR head\n");
		expect(await SessionManager.list(f.source, f.sessionDir)).toEqual([]);
	});

	it.each([true, false])(
		"guards first attach and preserves edits after resume (file-backed state: %s)",
		async (fileBacked) => {
			const f = await fixture(false, fileBacked);
			const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
			await expect(
				f.manager.admit(f.workspace, f.request.sessionId, undefined, undefined, f.authority),
			).rejects.toMatchObject({ code: "review_preparation_conflict" });
			const placement = await f.manager.admit(
				f.workspace,
				f.request.sessionId,
				prepared.worktreeId,
				undefined,
				f.authority,
			);
			if (!placement) throw new Error("missing placement");
			const reservation = await f.worktrees.beginRuntimePreparation(
				f.workspace.name,
				prepared.worktreeId,
				f.request.sessionId,
			);
			const session = await SessionManager.create(placement.cwd, f.sessionDir, { id: f.request.sessionId });
			f.sessions.push(session);
			await f.manager.bind(f.workspace, session, placement, f.authority);
			await reservation.release();
			const reopened = await SessionManager.open(session.getSessionRef()!);
			f.sessions.push(reopened);
			expect(reopened.getPrReviewBinding()).toEqual(placement);
			writeFileSync(join(placement.cwd, "value.txt"), "requested fix\n");
			expect(
				await f.manager.admit(f.workspace, f.request.sessionId, prepared.worktreeId, undefined, f.authority),
			).toEqual(placement);
			expect(await f.manager.prepare(f.workspace, f.request, f.authority)).toEqual(prepared);
			expect(readFileSync(join(f.source, "value.txt"), "utf8")).toBe("base\n");
			const harness = await createHarness({ sessionManager: reopened, settings: { lsp: { enabled: false } } });
			await harness.cleanupAsync();
		},
	);

	it("retains a prepared checkout on late failure and prevents another runtime from claiming its reservation", async () => {
		const f = await fixture();
		const prepared = await f.manager.prepare(f.workspace, f.request, f.authority);
		await expect(f.worktrees.beginRuntimePreparation(f.workspace.name, prepared.worktreeId, "other")).rejects.toThrow(
			"unavailable",
		);
		await expect(f.worktrees.bindSession(f.workspace.name, prepared.worktreeId, "other")).rejects.toThrow(
			"unavailable",
		);
		const record = (await f.state.listWorktrees())[0];
		writeFileSync(join(record.path, "dirty"), "late edit");
		await expect(
			f.manager.admit(f.workspace, f.request.sessionId, prepared.worktreeId, undefined, f.authority),
		).rejects.toMatchObject({ code: "review_preparation_stale" });
		expect(await f.state.listWorktrees()).toHaveLength(1);
		expect(readFileSync(join(record.path, "dirty"), "utf8")).toBe("late edit");
	});
});
