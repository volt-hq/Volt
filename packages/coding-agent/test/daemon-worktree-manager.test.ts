import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteWorkspace } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import {
	getWorkspaceWorktreesDir,
	getWorktreeCheckoutPath,
	getWorktreesRoot,
	isValidGitRefSyntax,
	WORKTREE_ID_PATTERN,
	type WorktreeGitRunner,
	WorktreeManager,
	WorktreeRetentionSweeper,
} from "../src/daemon/worktree-manager.ts";

interface RecordedGitCall {
	args: string[];
	cwd: string;
}

function createFakeGit(
	handler: (args: string[], cwd: string) => { ok: boolean; code?: number | null; stdout?: string; stderr?: string },
): { runGit: WorktreeGitRunner; calls: RecordedGitCall[] } {
	const calls: RecordedGitCall[] = [];
	const runGit: WorktreeGitRunner = async (args, cwd) => {
		calls.push({ args, cwd });
		const result = handler(args, cwd);
		const defaultStdout =
			result.ok &&
			(result.stdout === undefined || result.stdout.length === 0) &&
			args[0] === "-C" &&
			args[2] === "rev-parse" &&
			args[3] === "--show-toplevel" &&
			typeof args[1] === "string"
				? `${args[1]}\n`
				: "";
		return {
			ok: result.ok,
			code: result.code ?? (result.ok ? 0 : 1),
			stdout: result.stdout === undefined || result.stdout.length === 0 ? defaultStdout : result.stdout,
			stderr: result.stderr ?? "",
		};
	};
	return { runGit, calls };
}

const okGit = () => createFakeGit(() => ({ ok: true }));

describe("worktree manager (fake git)", () => {
	let agentDir: string;
	let workspaceDir: string;
	let workspace: IrohRemoteWorkspace;
	let stateManager: IrohRemoteHostStateManager;
	let flushState: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "volt-worktree-mgr-"));
		workspaceDir = join(agentDir, "repo");
		mkdirSync(workspaceDir, { recursive: true });
		workspace = { name: "repo", path: workspaceDir };
		stateManager = new IrohRemoteHostStateManager({
			initialState: {
				workspaces: [workspace],
				worktrees: [],
				clients: [],
			},
		});
		flushState = vi.fn(async () => {});
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	function createManager(
		runGit: WorktreeGitRunner,
		extra: Partial<ConstructorParameters<typeof WorktreeManager>[0]> = {},
	) {
		return new WorktreeManager({
			agentDir,
			stateManager,
			auditLogger: new IrohRemoteAuditLogger(),
			runGit,
			flushState,
			now: () => 1_751_900_000_000,
			...extra,
		});
	}

	it("creates a worktree, persists the record durably, and never shells out", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		const result = await manager.create(workspace, { id: "fix-login", baseRef: "main" });
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}
		expect(result.worktree).toMatchObject({
			id: "fix-login",
			workspaceName: "repo",
			branch: "volt/fix-login",
			baseRef: "main",
			createdAt: 1_751_900_000_000,
			sessionIds: [],
		});
		const expectedCheckout = getWorktreeCheckoutPath(agentDir, workspaceDir, "fix-login");
		const realWorkspaceDir = realpathSync(workspaceDir);
		expect(result.worktree.path).toBe(expectedCheckout);
		expect(expectedCheckout.startsWith(`${resolve(getWorktreesRoot(agentDir))}${sep}`)).toBe(true);
		// Exact argv: source resolution, repo validation, then worktree add, all from the source checkout.
		expect(git.calls).toEqual([
			{ args: ["-C", realWorkspaceDir, "rev-parse", "--show-toplevel"], cwd: workspaceDir },
			{ args: ["rev-parse", "--git-common-dir"], cwd: realWorkspaceDir },
			{ args: ["worktree", "add", expectedCheckout, "-b", "volt/fix-login", "main"], cwd: realWorkspaceDir },
		]);
		expect(flushState).toHaveBeenCalledTimes(1);
		const records = await stateManager.listWorktrees("repo");
		expect(records).toHaveLength(1);
		expect(records[0]?.id).toBe("fix-login");
	});

	it("adopts an existing git worktree without creating a checkout", async () => {
		const externalCheckout = join(agentDir, "manual-worktree");
		mkdirSync(externalCheckout, { recursive: true });
		const realWorkspaceDir = realpathSync(workspaceDir);
		const realExternalCheckout = realpathSync(externalCheckout);
		const git = createFakeGit((args, cwd) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				expect(cwd).toBe(resolve(externalCheckout));
				return { ok: true, stdout: `${realExternalCheckout}\n` };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					ok: true,
					stdout:
						`worktree ${realWorkspaceDir}\nHEAD abc123\nbranch refs/heads/main\n\n` +
						`worktree ${realExternalCheckout}\nHEAD def456\nbranch refs/heads/feature/manual\n`,
				};
			}
			if (args[0] === "symbolic-ref") {
				return { ok: true, stdout: "main\n" };
			}
			return { ok: true };
		});
		const manager = createManager(git.runGit);

		const adopted = await manager.adopt(workspace, { path: externalCheckout, id: "manual" });

		expect(adopted.ok).toBe(true);
		if (!adopted.ok) {
			return;
		}
		expect(adopted.worktree).toMatchObject({
			id: "manual",
			workspaceName: "repo",
			path: realExternalCheckout,
			branch: "feature/manual",
			baseRef: "main",
			sessionIds: [],
		});
		expect(git.calls.map((call) => call.args[0])).toEqual(["rev-parse", "worktree", "symbolic-ref"]);
		expect(flushState).toHaveBeenCalledTimes(1);
		expect(await stateManager.listWorktrees("repo")).toHaveLength(1);
	});

	it("rejects adopt when the worktree source checkout is not registered", async () => {
		const externalCheckout = join(agentDir, "manual-worktree");
		const sourceCheckout = join(agentDir, "other-source");
		mkdirSync(externalCheckout, { recursive: true });
		mkdirSync(sourceCheckout, { recursive: true });
		const realExternalCheckout = realpathSync(externalCheckout);
		const realSourceCheckout = realpathSync(sourceCheckout);
		const git = createFakeGit((args) => {
			if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
				return { ok: true, stdout: `${realExternalCheckout}\n` };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return {
					ok: true,
					stdout:
						`worktree ${realSourceCheckout}\nHEAD abc123\nbranch refs/heads/main\n\n` +
						`worktree ${realExternalCheckout}\nHEAD def456\nbranch refs/heads/feature/manual\n`,
				};
			}
			return { ok: true };
		});

		expect(await createManager(git.runGit).adopt(workspace, { path: externalCheckout, id: "manual" })).toMatchObject({
			ok: false,
			error: "worktree_source_unregistered",
		});
		expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
	});

	it("validates selected working directories and creates from nested git repositories", async () => {
		const selected = join(workspaceDir, "packages", "app");
		mkdirSync(selected, { recursive: true });
		const nestedGit = createFakeGit((args) => {
			if (args[0] === "-C") {
				return { ok: true, stdout: `${selected}\n` };
			}
			return { ok: true };
		});

		const nested = await createManager(nestedGit.runGit).create(workspace, {
			id: "nested",
			baseRef: "main",
			workingDirectory: "packages/app",
		});
		expect(nested.ok).toBe(true);
		if (nested.ok) {
			expect(nested.worktree.sourceRootRelativePath).toBe("packages/app");
		}
		const nestedCheckout = getWorktreeCheckoutPath(agentDir, workspaceDir, "nested");
		expect(nestedGit.calls).toContainEqual({
			args: ["worktree", "add", nestedCheckout, "-b", "volt/nested", "main"],
			cwd: realpathSync(selected),
		});

		const sameRepo = createFakeGit((args) => {
			if (args[0] === "-C") {
				return { ok: true, stdout: `${workspaceDir}\n` };
			}
			return { ok: true };
		});
		const ok = await createManager(sameRepo.runGit).create(workspace, {
			id: "subdir",
			baseRef: "main",
			workingDirectory: "packages/app",
		});
		expect(ok.ok).toBe(true);
		if (ok.ok) {
			expect(ok.worktree.sourceRootRelativePath).toBeUndefined();
		}
		expect(
			sameRepo.calls.some((call) => call.args[0] === "worktree" && call.cwd === realpathSync(workspaceDir)),
		).toBe(true);
	});

	it("creates nested repo worktrees before any parent workspace git check", async () => {
		const selected = join(workspaceDir, "Volt");
		mkdirSync(selected, { recursive: true });
		const git = createFakeGit((args, cwd) => {
			if (args[0] === "-C") {
				return { ok: true, stdout: `${selected}\n` };
			}
			if (args[0] === "rev-parse" && args[1] === "--git-common-dir" && cwd === workspaceDir) {
				return { ok: false, stderr: "fatal: parent should not be checked" };
			}
			return { ok: true };
		});

		const result = await createManager(git.runGit).create(workspace, {
			id: "nested",
			baseRef: "main",
			workingDirectory: "Volt",
		});

		expect(result.ok).toBe(true);
		expect(git.calls).not.toContainEqual({ args: ["rev-parse", "--git-common-dir"], cwd: workspaceDir });
		expect(git.calls).toContainEqual({
			args: [
				"worktree",
				"add",
				getWorktreeCheckoutPath(agentDir, workspaceDir, "nested"),
				"-b",
				"volt/nested",
				"main",
			],
			cwd: realpathSync(selected),
		});
	});

	it("rejects duplicate ids from state before touching git", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		expect((await manager.create(workspace, { id: "dup" })).ok).toBe(true);
		git.calls.length = 0;
		const second = await manager.create(workspace, { id: "dup" });
		expect(second).toEqual({ ok: false, error: "worktree_exists" });
		expect(git.calls).toEqual([]);
	});

	it("enforces the per-workspace limit", async () => {
		const manager = createManager(okGit().runGit, { maxWorktreesPerWorkspace: 1 });
		expect((await manager.create(workspace, { id: "one" })).ok).toBe(true);
		expect(await manager.create(workspace, { id: "two" })).toEqual({ ok: false, error: "worktree_limit_reached" });
	});

	it("maps branch conflicts and non-git repositories", async () => {
		const branchConflict = createFakeGit((args) =>
			args[0] === "worktree" ? { ok: false, stderr: "fatal: a branch named 'volt/x' already exists" } : { ok: true },
		);
		const conflict = await createManager(branchConflict.runGit).create(workspace, { id: "x" });
		expect(conflict).toMatchObject({ ok: false, error: "worktree_branch_conflict" });

		const notGit = createFakeGit(() => ({
			ok: false,
			stderr: `fatal: not a git repository (or any of the parent directories): .git`,
		}));
		const nonRepo = await createManager(notGit.runGit).create(workspace, { id: "y" });
		expect(nonRepo).toMatchObject({ ok: false, error: "not_a_git_repository" });
	});

	it("redacts host paths from git stderr details", async () => {
		const leaky = createFakeGit((args) =>
			args[0] === "worktree"
				? { ok: false, stderr: `fatal: cannot create ${getWorktreesRoot(agentDir)}/x: boom in ${workspaceDir}` }
				: { ok: true },
		);
		const result = await createManager(leaky.runGit).create(workspace, { id: "x" });
		expect(result.ok).toBe(false);
		if (result.ok) {
			return;
		}
		expect(result.detail).not.toContain(agentDir);
		expect(result.detail).not.toContain(workspaceDir);
	});

	it("rejects invalid worktree ids and option-injection/invalid refs before any git call", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		expect(await manager.create(workspace, { id: "UPPER" })).toEqual({ ok: false, error: "invalid_worktree_id" });
		expect(await manager.create(workspace, { id: "../evil" })).toEqual({ ok: false, error: "invalid_worktree_id" });
		expect(await manager.create(workspace, { id: "ok", branch: "-D" })).toMatchObject({
			ok: false,
			error: "git_failed",
		});
		expect(await manager.create(workspace, { id: "ok", branch: "a..b" })).toMatchObject({
			ok: false,
			error: "git_failed",
		});
		expect(await manager.create(workspace, { id: "ok", baseRef: "ref with space" })).toMatchObject({
			ok: false,
			error: "git_failed",
		});
		expect(git.calls).toEqual([]);
	});

	it("pins the checkout-path containment invariant", () => {
		expect(() => getWorktreeCheckoutPath(agentDir, workspaceDir, "../escape")).toThrow("invalid worktree id");
		expect(() => getWorktreeCheckoutPath(agentDir, workspaceDir, "..")).toThrow("invalid worktree id");
		expect(() => getWorktreeCheckoutPath(agentDir, workspaceDir, "a/b")).toThrow("invalid worktree id");
		expect(() => getWorktreeCheckoutPath(agentDir, workspaceDir, "")).toThrow("invalid worktree id");
		expect(WORKTREE_ID_PATTERN.test("fix-login")).toBe(true);
		expect(WORKTREE_ID_PATTERN.test("-leading")).toBe(false);
		const path = getWorktreeCheckoutPath(agentDir, workspaceDir, "fine.1_a-b");
		expect(path.startsWith(`${resolve(getWorktreesRoot(agentDir))}${sep}`)).toBe(true);
	});

	it("validates git ref syntax", () => {
		expect(isValidGitRefSyntax("main")).toBe(true);
		expect(isValidGitRefSyntax("volt/fix-login")).toBe(true);
		expect(isValidGitRefSyntax("-D")).toBe(false);
		expect(isValidGitRefSyntax("a..b")).toBe(false);
		expect(isValidGitRefSyntax("a b")).toBe(false);
		expect(isValidGitRefSyntax("a~1")).toBe(false);
		expect(isValidGitRefSyntax("a:b")).toBe(false);
		expect(isValidGitRefSyntax("branch.lock")).toBe(false);
		expect(isValidGitRefSyntax("")).toBe(false);
	});

	it("refuses to remove a dirty worktree without force and force-removes with --force", async () => {
		const git = createFakeGit((args) =>
			args.includes("status") ? { ok: true, stdout: " M file.ts\n" } : { ok: true },
		);
		const manager = createManager(git.runGit);
		const created = await manager.create(workspace, { id: "dirty" });
		expect(created.ok).toBe(true);
		const checkout = getWorktreeCheckoutPath(agentDir, workspaceDir, "dirty");
		mkdirSync(checkout, { recursive: true });

		expect(await manager.remove(workspace, "dirty")).toEqual({ ok: false, error: "worktree_dirty", detail: "dirty" });
		expect(await stateManager.listWorktrees("repo")).toHaveLength(1);

		git.calls.length = 0;
		expect(await manager.remove(workspace, "dirty", { force: true })).toEqual({ ok: true });
		expect(git.calls).toEqual([
			{ args: ["worktree", "remove", "--force", checkout], cwd: realpathSync(workspaceDir) },
		]);
		expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
	});

	it("refuses to remove a busy worktree unless forced", async () => {
		const git = okGit();
		const busySessions = new Set(["s-live"]);
		const manager = createManager(git.runGit, {
			hasActiveRuntimeForSession: (_workspaceName, sessionId) => busySessions.has(sessionId),
		});
		const created = await manager.create(workspace, { id: "busy" });
		expect(created.ok).toBe(true);
		await manager.bindSession("repo", "busy", "s-live");
		mkdirSync(getWorktreeCheckoutPath(agentDir, workspaceDir, "busy"), { recursive: true });

		expect(await manager.remove(workspace, "busy")).toEqual({ ok: false, error: "worktree_busy" });
		expect(await manager.remove(workspace, "busy", { force: true })).toEqual({ ok: true });
	});

	it("returns worktree_not_found for unknown ids", async () => {
		const manager = createManager(okGit().runGit);
		expect(await manager.remove(workspace, "ghost")).toEqual({ ok: false, error: "worktree_not_found" });
	});

	it("prune drops records without checkouts and quarantines checkouts without records", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		// Record without a checkout on disk.
		expect((await manager.create(workspace, { id: "gone" })).ok).toBe(true);
		// Checkout without a record.
		const workspaceWorktreesDir = getWorkspaceWorktreesDir(agentDir, workspaceDir);
		const strayDir = join(workspaceWorktreesDir, "stray");
		mkdirSync(strayDir, { recursive: true });
		writeFileSync(join(strayDir, "keep.txt"), "uncommitted work\n");

		const pruned = await manager.prune(workspace);
		expect(pruned.removedRecords).toEqual(["gone"]);
		expect(pruned.orphanCheckouts).toEqual(["stray"]);
		expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
		// Quarantine renames; it never deletes unrecognized content.
		expect(existsSync(strayDir)).toBe(false);
		const quarantined = readdirSync(workspaceWorktreesDir).filter((name) => name.startsWith("stray.orphan-"));
		expect(quarantined).toHaveLength(1);
		expect(existsSync(join(workspaceWorktreesDir, quarantined[0] ?? "", "keep.txt"))).toBe(true);
		expect(git.calls.at(-1)).toEqual({ args: ["worktree", "prune"], cwd: realpathSync(workspaceDir) });
	});

	it("cleanupUnregisteredWorkspace force-removes checkouts via git and deletes the workspace worktrees dir", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		expect((await manager.create(workspace, { id: "leftover" })).ok).toBe(true);
		const checkout = getWorktreeCheckoutPath(agentDir, workspaceDir, "leftover");
		mkdirSync(checkout, { recursive: true });
		git.calls.length = 0;

		await manager.cleanupUnregisteredWorkspace(workspace);
		// Main checkout exists: git worktree remove --force runs before the rm fallback.
		expect(git.calls).toEqual([{ args: ["worktree", "remove", "--force", checkout], cwd: workspaceDir }]);
		expect(existsSync(getWorkspaceWorktreesDir(agentDir, workspaceDir))).toBe(false);
	});

	it("cleanupUnregisteredWorkspace skips git when the main checkout is gone", async () => {
		const git = okGit();
		const manager = createManager(git.runGit);
		const missingWorkspace: IrohRemoteWorkspace = { name: "gone", path: join(agentDir, "missing-repo") };
		const checkout = getWorktreeCheckoutPath(agentDir, missingWorkspace.path, "orphan");
		mkdirSync(checkout, { recursive: true });
		git.calls.length = 0;

		await manager.cleanupUnregisteredWorkspace(missingWorkspace);
		expect(git.calls).toEqual([]);
		expect(existsSync(getWorkspaceWorktreesDir(agentDir, missingWorkspace.path))).toBe(false);
	});

	it("resolves and persists a concrete base ref for defaulted creates (§5.3 merge-back)", async () => {
		const git = createFakeGit((args) => (args[0] === "symbolic-ref" ? { ok: true, stdout: "main\n" } : { ok: true }));
		const manager = createManager(git.runGit);
		const created = await manager.create(workspace, { id: "defaulted" });
		expect(created.ok).toBe(true);
		if (!created.ok) {
			return;
		}
		expect(created.worktree.baseRef).toBe("main");
		// The add itself still targets HEAD (the same commit); only the RECORD
		// stores the resolved base for later guidance.
		expect(git.calls.map((call) => call.args[0])).toEqual(["-C", "rev-parse", "symbolic-ref", "worktree"]);

		// Detached HEAD: falls back to the commit sha.
		const detached = createFakeGit((args) =>
			args[0] === "symbolic-ref"
				? { ok: false }
				: args[0] === "rev-parse" && args[1] === "HEAD"
					? { ok: true, stdout: "abc1234def\n" }
					: { ok: true },
		);
		const detachedCreate = await createManager(detached.runGit).create(workspace, { id: "detached" });
		expect(detachedCreate.ok).toBe(true);
		if (detachedCreate.ok) {
			expect(detachedCreate.worktree.baseRef).toBe("abc1234def");
		}
	});

	it("list reports aheadBehind from rev-list alongside dirty (§5.3)", async () => {
		const countedCheckout = getWorktreeCheckoutPath(agentDir, workspaceDir, "counted");
		const git = createFakeGit((args) => {
			if (args[0] === "rev-list") {
				return { ok: true, stdout: "2\t5\n" };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { ok: true, stdout: `worktree ${countedCheckout}\n` };
			}
			return { ok: true, stdout: "" };
		});
		const manager = createManager(git.runGit);
		expect((await manager.create(workspace, { id: "counted", baseRef: "main" })).ok).toBe(true);
		mkdirSync(getWorktreeCheckoutPath(agentDir, workspaceDir, "counted"), { recursive: true });

		const listed = await manager.list(workspace);
		expect(listed[0]).toMatchObject({ id: "counted", available: true, dirty: false });
		// left...right with left = base: left count is behind, right is ahead.
		expect(listed[0]?.aheadBehind).toEqual({ ahead: 5, behind: 2 });
		expect(git.calls).toContainEqual({
			args: ["rev-list", "--left-right", "--count", "main...volt/counted"],
			cwd: realpathSync(workspaceDir),
		});

		// A failing rev-list degrades to "no aheadBehind", never an error.
		const checkout = getWorktreeCheckoutPath(agentDir, workspaceDir, "counted");
		const broken = createFakeGit((args) => {
			if (args[0] === "rev-list") {
				return { ok: false };
			}
			if (args[0] === "worktree" && args[1] === "list") {
				return { ok: true, stdout: `worktree ${checkout}\n` };
			}
			return { ok: true, stdout: "" };
		});
		const degraded = await createManager(broken.runGit).list(workspace);
		expect(degraded[0]).toMatchObject({ id: "counted", available: true });
		expect(degraded[0]?.aheadBehind).toBeUndefined();
	});

	it("removeIfCleanAndMerged removes only clean, fully merged worktrees (§5.3 retention)", async () => {
		const behaviors = { dirty: false, merged: true };
		const git = createFakeGit((args) => {
			if (args.includes("status")) {
				return { ok: true, stdout: behaviors.dirty ? " M file.ts\n" : "" };
			}
			if (args[0] === "merge-base") {
				return { ok: behaviors.merged };
			}
			return { ok: true };
		});
		const busySessions = new Set<string>();
		const manager = createManager(git.runGit, {
			hasActiveRuntimeForSession: (_workspaceName, sessionId) => busySessions.has(sessionId),
		});
		expect((await manager.create(workspace, { id: "ttl", baseRef: "main" })).ok).toBe(true);
		await manager.bindSession("repo", "ttl", "s-ttl");

		// Missing checkout: never touched.
		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({
			removed: false,
			reason: "checkout_missing",
		});
		mkdirSync(getWorktreeCheckoutPath(agentDir, workspaceDir, "ttl"), { recursive: true });

		// Busy: an active runtime pins the worktree.
		busySessions.add("s-ttl");
		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({ removed: false, reason: "busy" });
		busySessions.clear();

		// Dirty: uncommitted work is never deleted.
		behaviors.dirty = true;
		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({ removed: false, reason: "dirty" });
		behaviors.dirty = false;

		// Unmerged: the branch still has unlanded commits.
		behaviors.merged = false;
		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({ removed: false, reason: "unmerged" });
		behaviors.merged = true;

		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({ removed: true });
		expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
		expect(await manager.removeIfCleanAndMerged(workspace, "ttl")).toEqual({
			removed: false,
			reason: "worktree_not_found",
		});
	});

	it("WorktreeRetentionSweeper removes on TTL expiry and audits skips (§5.3)", async () => {
		const behaviors = { dirty: false };
		const git = createFakeGit((args) => {
			if (args.includes("status")) {
				return { ok: true, stdout: behaviors.dirty ? " M file.ts\n" : "" };
			}
			return { ok: true };
		});
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const auditLogger = new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } });
		const manager = createManager(git.runGit, { auditLogger });
		const timers: Array<{ callback: () => void; ttlMs: number }> = [];
		let policy: { enabled: boolean; ttlMs: number } | undefined = { enabled: true, ttlMs: 60_000 };
		const sweeper = new WorktreeRetentionSweeper({
			manager,
			stateManager,
			auditLogger,
			getRetentionPolicy: () => policy,
			setTimer: (callback, ttlMs) => {
				timers.push({ callback, ttlMs });
				return { unref() {} } as unknown as NodeJS.Timeout;
			},
			clearTimer: () => {},
		});

		expect((await manager.create(workspace, { id: "sweep", baseRef: "main" })).ok).toBe(true);
		mkdirSync(getWorktreeCheckoutPath(agentDir, workspaceDir, "sweep"), { recursive: true });

		// Disabled policy: no timer scheduled.
		policy = undefined;
		sweeper.onRuntimeDisposed("repo", "sweep");
		expect(timers).toHaveLength(0);

		// Dirty at expiry: skip + audit, checkout untouched.
		policy = { enabled: true, ttlMs: 60_000 };
		behaviors.dirty = true;
		sweeper.onRuntimeDisposed("repo", "sweep");
		expect(timers).toHaveLength(1);
		expect(timers[0]?.ttlMs).toBe(60_000);
		timers[0]?.callback();
		await vi.waitFor(() => {
			expect(auditEvents.some((event) => event.type === "worktree_retention_skipped_dirty")).toBe(true);
		});
		expect(auditEvents.at(-1)?.details).toMatchObject({ worktreeId: "sweep", reason: "dirty" });
		expect(await stateManager.listWorktrees("repo")).toHaveLength(1);

		// Clean + merged at expiry: removed + audit.
		behaviors.dirty = false;
		sweeper.onRuntimeDisposed("repo", "sweep");
		timers.at(-1)?.callback();
		await vi.waitFor(() => {
			expect(auditEvents.some((event) => event.type === "worktree_retention_removed")).toBe(true);
		});
		expect(await stateManager.listWorktrees("repo")).toHaveLength(0);

		sweeper.dispose();
		timers.length = 0;
		sweeper.onRuntimeDisposed("repo", "sweep");
		expect(timers).toHaveLength(0);
	});

	it("binds sessions durably and resolves them", async () => {
		const manager = createManager(okGit().runGit);
		expect((await manager.create(workspace, { id: "bind" })).ok).toBe(true);
		flushState.mockClear();
		await manager.bindSession("repo", "bind", "s-abc");
		expect(flushState).toHaveBeenCalledTimes(1);
		expect((await manager.resolveSessionWorktree("repo", "s-abc"))?.id).toBe("bind");
		expect(await manager.resolveSessionWorktree("repo", "s-unknown")).toBeUndefined();
	});
});

describe("worktree manager (real git integration)", () => {
	it("create -> list agreement -> dirty detection -> remove against a temp repo", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-git-")));
		const repoDir = join(agentDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		try {
			const git = (args: string[], cwd: string = repoDir) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
				});
			git(["init", "--initial-branch=main"]);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "Test"]);
			writeFileSync(join(repoDir, "readme.md"), "hello\n");
			git(["add", "readme.md"]);
			git(["commit", "-m", "init"]);

			const stateManager = new IrohRemoteHostStateManager({
				initialState: { workspaces: [{ name: "repo", path: repoDir }], worktrees: [], clients: [] },
			});
			const workspace: IrohRemoteWorkspace = { name: "repo", path: repoDir };
			const manager = new WorktreeManager({
				agentDir,
				stateManager,
				auditLogger: new IrohRemoteAuditLogger(),
			});

			const created = await manager.create(workspace, { id: "feature-x" });
			expect(created.ok).toBe(true);
			if (!created.ok) {
				return;
			}
			expect(existsSync(created.worktree.path)).toBe(true);
			expect(git(["worktree", "list", "--porcelain"])).toContain(realpathSync(created.worktree.path));
			expect(git(["rev-parse", "--abbrev-ref", "HEAD"], created.worktree.path).trim()).toBe("volt/feature-x");

			let listed = await manager.list(workspace);
			expect(listed).toHaveLength(1);
			expect(listed[0]).toMatchObject({ id: "feature-x", available: true, dirty: false });

			writeFileSync(join(created.worktree.path, "scratch.txt"), "dirty\n");
			listed = await manager.list(workspace);
			expect(listed[0]?.dirty).toBe(true);

			expect(await manager.remove(workspace, "feature-x")).toEqual({
				ok: false,
				error: "worktree_dirty",
				detail: "dirty",
			});
			expect(await manager.remove(workspace, "feature-x", { force: true })).toEqual({ ok: true });
			expect(existsSync(created.worktree.path)).toBe(false);
			expect(git(["worktree", "list", "--porcelain"])).not.toContain("feature-x");
			expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("creates a worktree for the workspace root when a tracked subfolder is selected", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-git-subdir-")));
		const repoDir = join(agentDir, "repo");
		mkdirSync(join(repoDir, "packages", "app"), { recursive: true });
		try {
			const git = (args: string[], cwd: string = repoDir) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
				});
			git(["init", "--initial-branch=main"]);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "Test"]);
			writeFileSync(join(repoDir, "packages", "app", "readme.md"), "hello\n");
			git(["add", "packages/app/readme.md"]);
			git(["commit", "-m", "init"]);

			const stateManager = new IrohRemoteHostStateManager({
				initialState: { workspaces: [{ name: "repo", path: repoDir }], worktrees: [], clients: [] },
			});
			const workspace: IrohRemoteWorkspace = { name: "repo", path: repoDir };
			const manager = new WorktreeManager({
				agentDir,
				stateManager,
				auditLogger: new IrohRemoteAuditLogger(),
			});

			const created = await manager.create(workspace, { id: "subdir", workingDirectory: "packages/app" });
			expect(created.ok).toBe(true);
			if (!created.ok) {
				return;
			}
			expect(existsSync(join(created.worktree.path, "packages", "app"))).toBe(true);
			expect(git(["rev-parse", "--show-toplevel"], created.worktree.path).trim()).toBe(
				realpathSync(created.worktree.path),
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("creates a worktree from a nested repo under a registered parent workspace", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-git-nested-")));
		const workspaceDir = join(agentDir, "workspace");
		const nestedRepoDir = join(workspaceDir, "Volt");
		mkdirSync(join(nestedRepoDir, "packages", "coding-agent"), { recursive: true });
		try {
			const git = (args: string[], cwd: string = nestedRepoDir) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
				});
			git(["init", "--initial-branch=main"]);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "Test"]);
			writeFileSync(join(nestedRepoDir, "packages", "coding-agent", "readme.md"), "hello\n");
			git(["add", "packages/coding-agent/readme.md"]);
			git(["commit", "-m", "init"]);

			const stateManager = new IrohRemoteHostStateManager({
				initialState: { workspaces: [{ name: "workspace", path: workspaceDir }], worktrees: [], clients: [] },
			});
			const workspace: IrohRemoteWorkspace = { name: "workspace", path: workspaceDir };
			const manager = new WorktreeManager({
				agentDir,
				stateManager,
				auditLogger: new IrohRemoteAuditLogger(),
			});

			const created = await manager.create(workspace, {
				id: "nested",
				workingDirectory: "Volt/packages/coding-agent",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) {
				return;
			}
			expect(created.worktree.sourceRootRelativePath).toBe("Volt");
			expect(existsSync(join(created.worktree.path, "packages", "coding-agent"))).toBe(true);
			expect(git(["rev-parse", "--show-toplevel"], created.worktree.path).trim()).toBe(
				realpathSync(created.worktree.path),
			);
			expect(git(["worktree", "list", "--porcelain"], nestedRepoDir)).toContain(realpathSync(created.worktree.path));
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);

	it("tracks aheadBehind and retention-removes only after merge-back (§5.3)", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-git3-")));
		const repoDir = join(agentDir, "repo");
		mkdirSync(repoDir, { recursive: true });
		try {
			const git = (args: string[], cwd: string = repoDir) =>
				execFileSync("git", args, {
					cwd,
					encoding: "utf8",
					env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
				});
			git(["init", "--initial-branch=main"]);
			git(["config", "user.email", "test@example.com"]);
			git(["config", "user.name", "Test"]);
			writeFileSync(join(repoDir, "readme.md"), "hello\n");
			git(["add", "readme.md"]);
			git(["commit", "-m", "init"]);

			const stateManager = new IrohRemoteHostStateManager({
				initialState: { workspaces: [{ name: "repo", path: repoDir }], worktrees: [], clients: [] },
			});
			const workspace: IrohRemoteWorkspace = { name: "repo", path: repoDir };
			const manager = new WorktreeManager({
				agentDir,
				stateManager,
				auditLogger: new IrohRemoteAuditLogger(),
			});

			// Defaulted base resolves to the concrete branch name.
			const created = await manager.create(workspace, { id: "merge-me" });
			expect(created.ok).toBe(true);
			if (!created.ok) {
				return;
			}
			expect(created.worktree.baseRef).toBe("main");

			// One commit on the worktree branch: ahead 1, behind 0.
			writeFileSync(join(created.worktree.path, "feature.txt"), "work\n");
			git(["add", "feature.txt"], created.worktree.path);
			git(["commit", "-m", "feature"], created.worktree.path);
			const listed = await manager.list(workspace);
			expect(listed[0]?.aheadBehind).toEqual({ ahead: 1, behind: 0 });
			expect(listed[0]?.dirty).toBe(false);

			// Unmerged branches are never retention-removed.
			expect(await manager.removeIfCleanAndMerged(workspace, "merge-me")).toEqual({
				removed: false,
				reason: "unmerged",
			});

			// After the user merges back, retention may remove the worktree.
			git(["merge", "volt/merge-me"]);
			expect(await manager.removeIfCleanAndMerged(workspace, "merge-me")).toEqual({ removed: true });
			expect(existsSync(created.worktree.path)).toBe(false);
			expect(await stateManager.listWorktrees("repo")).toHaveLength(0);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 30_000);
});
