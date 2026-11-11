/**
 * A conversation's project (#1041): where it loads its project resources
 * from, and the path its project trust is decided for. A plain directory is
 * its own project. A daemon-managed worktree checkout takes its trust, and
 * for a pull request review its project, from the repository in its
 * workspace as the daemon's state file records it, never from the checkout's
 * `.git` pointer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrReviewLaunch } from "../src/core/pr-review-placement.ts";
import { projectTrustPath, resolveConversationProject } from "../src/core/project-trust.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import {
	getWorktreeCheckoutPath,
	getWorktreesRoot,
	resolveWorktreeParentCheckout,
} from "../src/daemon/worktree-manager.ts";
import { writeDaemonStateFile } from "./utilities/iroh-host-state.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Make `directory` a Git repository on `main` with one commit. */
function commitRepository(directory: string): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "README.md"), "repository\n");
	git(directory, "init", "--initial-branch=main");
	git(directory, "add", ".");
	git(
		directory,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"base",
	);
}

describe("a conversation's project", () => {
	let root: string;
	let agentDir: string;
	let workspace: IrohRemoteWorkspace;

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-project-resolver-")));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		workspace = { name: "ws", path: join(root, "repo") };
		mkdirSync(workspace.path, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A managed checkout of the workspace, with the directories `inside` it. */
	function checkoutOf(id: string, ...inside: string[]): string {
		const checkout = getWorktreeCheckoutPath(agentDir, workspace.path, id);
		mkdirSync(join(checkout, ...inside), { recursive: true });
		return checkout;
	}

	function record(
		id: string,
		path: string,
		overrides: Partial<IrohRemoteWorkspaceWorktree> = {},
	): IrohRemoteWorkspaceWorktree {
		return {
			id,
			workspaceName: workspace.name,
			path,
			branch: `volt/${id}`,
			createdAt: 1,
			sessionIds: [],
			...overrides,
		};
	}

	/** The receipt of a pull request review prepared in the checkout `worktreeId` at `cwd`. */
	function reviewLaunch(worktreeId: string, cwd: string): PrReviewLaunch {
		return {
			sessionId: "review-session",
			requestFingerprint: "a".repeat(64),
			disposition: "created",
			sessionGeneration: "generation-1",
			storeId: "store-1",
			placement: {
				workspaceName: workspace.name,
				workspaceGeneration: 1,
				worktreeId,
				cwd,
				sourceCwd: workspace.path,
				commonDirectory: join(workspace.path, ".git"),
				pullRequest: {
					provider: "github",
					url: "https://github.com/owner/repo/pull/7",
					number: 7,
					title: "Fork change",
					repository: "owner/repo",
					headRefName: "topic",
					headRefOid: "b".repeat(40),
				},
				repositoryId: "github:github.com/owner/repo",
				headRepositoryId: "github:github.com/contributor/repo",
				remote: "origin",
			},
		};
	}

	it("is a plain directory itself, without the daemon's state", () => {
		const plain = join(root, "plain", "src");
		mkdirSync(plain, { recursive: true });
		// No state file at all: an ordinary start reads none.
		expect(resolveConversationProject(agentDir, plain)).toEqual({ projectCwd: plain, trustPath: plain });
		expect(projectTrustPath(agentDir, plain)).toBe(plain);

		// Nor one it could not read: the workspace's own directories are plain too.
		mkdirSync(getDaemonPaths(agentDir).daemonDir, { recursive: true });
		writeFileSync(getDaemonPaths(agentDir).statePath, "{ not json");
		expect(resolveConversationProject(agentDir, plain)).toEqual({ projectCwd: plain, trustPath: plain });
		expect(resolveConversationProject(agentDir, workspace.path)).toEqual({
			projectCwd: workspace.path,
			trustPath: workspace.path,
		});
	});

	it("keeps a plain directory's spelling as its project, and decides trust for its canonical path", () => {
		const plain = join(root, "plain");
		mkdirSync(plain);
		const spelled = `${plain}${sep}..${sep}plain`;
		expect(resolveConversationProject(agentDir, spelled)).toEqual({ projectCwd: spelled, trustPath: plain });
	});

	it("loads an ordinary worktree from its checkout, trusted as its workspace is", async () => {
		const checkout = checkoutOf("fix", "src", "deep");
		await writeDaemonStateFile(agentDir, { workspaces: [workspace], worktrees: [record("fix", checkout)] });

		expect(resolveConversationProject(agentDir, checkout)).toEqual({
			projectCwd: checkout,
			trustPath: workspace.path,
		});
		const inside = join(checkout, "src", "deep");
		expect(resolveConversationProject(agentDir, inside)).toEqual({ projectCwd: inside, trustPath: workspace.path });
		expect(projectTrustPath(agentDir, inside)).toBe(workspace.path);
	});

	it("loads a pull request review from the same place in its workspace's repository", async () => {
		const checkout = checkoutOf("review", "packages", "app");
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace],
			worktrees: [record("review", checkout, { prReviewLaunches: [reviewLaunch("review", checkout)] })],
		});

		expect(resolveConversationProject(agentDir, checkout)).toEqual({
			projectCwd: workspace.path,
			trustPath: workspace.path,
		});
		expect(resolveConversationProject(agentDir, join(checkout, "packages", "app"))).toEqual({
			projectCwd: join(workspace.path, "packages", "app"),
			trustPath: workspace.path,
		});
	});

	it("knows a managed checkout when the agent directory is reached through a link", async () => {
		const checkout = checkoutOf("review", "packages", "app");
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace],
			worktrees: [record("review", checkout, { prReviewLaunches: [reviewLaunch("review", checkout)] })],
		});
		const linkedAgentDir = join(root, "agent-link");
		try {
			symlinkSync(agentDir, linkedAgentDir, "dir");
		} catch {
			// Links need a privilege this host does not grant.
			return;
		}

		// The daemon opens a conversation in the checkout's real path, whatever the agent directory is spelled as.
		expect(resolveConversationProject(linkedAgentDir, checkout)).toEqual({
			projectCwd: workspace.path,
			trustPath: workspace.path,
		});
		expect(resolveConversationProject(linkedAgentDir, join(checkout, "packages", "app"))).toEqual({
			projectCwd: join(workspace.path, "packages", "app"),
			trustPath: workspace.path,
		});
	});

	it("takes a nested repository's worktree from that repository in the workspace", async () => {
		const ordinary = checkoutOf("nested", "src");
		const review = checkoutOf("nested-review", "src");
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace],
			worktrees: [
				record("nested", ordinary, { sourceRootRelativePath: "apps/web" }),
				record("nested-review", review, {
					sourceRootRelativePath: "apps/web",
					prReviewLaunches: [reviewLaunch("nested-review", review)],
				}),
			],
		});
		const repository = join(workspace.path, "apps", "web");

		expect(resolveConversationProject(agentDir, join(ordinary, "src"))).toEqual({
			projectCwd: join(ordinary, "src"),
			trustPath: repository,
		});
		expect(resolveConversationProject(agentDir, review)).toEqual({ projectCwd: repository, trustPath: repository });
		expect(resolveConversationProject(agentDir, join(review, "src"))).toEqual({
			projectCwd: join(repository, "src"),
			trustPath: repository,
		});
	});

	it("takes the innermost checkout's record, and the workspace that record names", async () => {
		const other: IrohRemoteWorkspace = { name: "other", path: join(root, "other") };
		mkdirSync(other.path);
		const outer = checkoutOf("outer", "vendor", "inner", "src");
		const inner = join(outer, "vendor", "inner");
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace, other],
			worktrees: [record("outer", outer), { ...record("inner", inner), workspaceName: other.name }],
		});

		expect(resolveConversationProject(agentDir, join(outer, "vendor")).trustPath).toBe(workspace.path);
		expect(resolveConversationProject(agentDir, join(inner, "src")).trustPath).toBe(other.path);
	});

	it("trusts as the workspace that is itself a linked Git worktree, not as the repository's main checkout", async () => {
		// The registered workspace is a linked worktree of `main`; the daemon creates the checkout from it.
		const main = join(root, "main");
		commitRepository(main);
		git(main, "worktree", "add", workspace.path, "-b", "workspace");
		const checkout = getWorktreeCheckoutPath(agentDir, workspace.path, "fix");
		mkdirSync(dirname(checkout), { recursive: true });
		git(workspace.path, "worktree", "add", checkout, "-b", "volt/fix");
		// Git points the checkout at the main checkout's metadata, whichever worktree created it.
		expect(resolveWorktreeParentCheckout(agentDir, checkout)).toBe(main);
		await writeDaemonStateFile(agentDir, { workspaces: [workspace], worktrees: [record("fix", checkout)] });

		expect(resolveConversationProject(agentDir, checkout)).toEqual({
			projectCwd: checkout,
			trustPath: workspace.path,
		});
		expect(projectTrustPath(agentDir, checkout)).toBe(workspace.path);
	});

	it("has no trust path in a managed checkout the daemon's state does not record", async () => {
		const checkout = checkoutOf("fix", "src");
		// As `git worktree add` leaves it: the pointer names a parent, and decides nothing.
		writeFileSync(join(checkout, ".git"), `gitdir: ${join(workspace.path, ".git", "worktrees", "fix")}\n`);
		const unknown = { projectCwd: checkout, trustPath: undefined };

		// No state file.
		expect(resolveConversationProject(agentDir, checkout)).toEqual(unknown);
		expect(projectTrustPath(agentDir, checkout)).toBeUndefined();

		// A state file that does not parse, or is not the daemon's state.
		mkdirSync(getDaemonPaths(agentDir).daemonDir, { recursive: true });
		for (const content of ["{ not json", "[]", JSON.stringify({ version: 2 })]) {
			writeFileSync(getDaemonPaths(agentDir).statePath, content);
			expect(resolveConversationProject(agentDir, checkout)).toEqual(unknown);
		}

		// No record of the checkout.
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace],
			worktrees: [record("other", checkoutOf("other"))],
		});
		expect(resolveConversationProject(agentDir, checkout)).toEqual(unknown);
		expect(resolveConversationProject(agentDir, join(checkout, "src"))).toEqual({
			projectCwd: join(checkout, "src"),
			trustPath: undefined,
		});

		// A record whose workspace is not registered.
		await writeDaemonStateFile(agentDir, {
			workspaces: [],
			worktrees: [record("fix", checkout, { prReviewLaunches: [reviewLaunch("fix", checkout)] })],
		});
		expect(resolveConversationProject(agentDir, checkout)).toEqual(unknown);

		// The worktrees root's own directories are no checkout.
		expect(
			resolveConversationProject(agentDir, join(getWorktreesRoot(agentDir), "--elsewhere--")).trustPath,
		).toBeUndefined();
	});
});
