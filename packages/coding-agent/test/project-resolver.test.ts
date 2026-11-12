/**
 * A conversation's project (#1041): where it loads its project resources
 * from, and the path its project trust is decided for. A plain directory is
 * its own project. A daemon-managed worktree checkout takes its trust, and
 * for a pull request review its project, from the repository in its
 * workspace as the daemon's state file records it, never from the checkout's
 * `.git` pointer.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrReviewLaunch } from "../src/core/pr-review-placement.ts";
import { projectTrustPath, resolveConversationProject } from "../src/core/project-trust.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { readVoltdWorktreeRecords } from "../src/daemon/state.ts";
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
		mkdirSync(join(workspace.path, "packages", "app"), { recursive: true });
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

	it("loads a review's directory that only the pull request has from the nearest one in the repository", async () => {
		const checkout = checkoutOf("review", "packages", "added", "deep");
		await writeDaemonStateFile(agentDir, {
			workspaces: [workspace],
			worktrees: [record("review", checkout, { prReviewLaunches: [reviewLaunch("review", checkout)] })],
		});
		const added = join(checkout, "packages", "added", "deep");

		// The repository has no `packages` at all: its root.
		expect(resolveConversationProject(agentDir, added)).toEqual({
			projectCwd: workspace.path,
			trustPath: workspace.path,
		});

		// It has `packages`, and a file where the pull request has a directory.
		mkdirSync(join(workspace.path, "packages"));
		writeFileSync(join(workspace.path, "packages", "added"), "a file\n");
		expect(resolveConversationProject(agentDir, added)).toEqual({
			projectCwd: join(workspace.path, "packages"),
			trustPath: workspace.path,
		});
	});

	it("knows a managed checkout when the agent directory is reached through a link", async () => {
		const checkout = checkoutOf("review", "packages", "app");
		mkdirSync(join(workspace.path, "packages", "app"), { recursive: true });
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
		mkdirSync(join(workspace.path, "apps", "web", "src"), { recursive: true });
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

	describe("read from a state file the daemon's store would not write", () => {
		/** Rewrite the state file as JSON: the store writes only state that parses. */
		function editStateFile(edit: (state: Record<string, unknown>) => void): void {
			const statePath = getDaemonPaths(agentDir).statePath;
			const state = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
			edit(state);
			writeFileSync(statePath, JSON.stringify(state));
		}

		it("resolves a recorded worktree whatever the file's other sections hold", async () => {
			const checkout = checkoutOf("fix");
			await writeDaemonStateFile(agentDir, {
				hostSecretKey: [1, 2, 3],
				workspaces: [workspace],
				worktrees: [record("fix", checkout)],
			});
			editStateFile((state) => {
				state.irohSecretKey = "not bytes";
				state.clients = [{ nodeId: 7 }];
				state.revokedClients = "none";
				state.pendingPairingTickets = [null];
				state.pairingSecretTombstones = [{ outcome: "unknown" }];
				state.workspaceGenerations = [];
				state.settings = { relayCredential: "not a credential" };
			});

			expect(resolveConversationProject(agentDir, checkout)).toEqual({
				projectCwd: checkout,
				trustPath: workspace.path,
			});
		});

		it("leaves only the checkout of a record that does not parse unrecorded", async () => {
			const other: IrohRemoteWorkspace = { name: "other", path: join(root, "other") };
			mkdirSync(other.path);
			const broken = checkoutOf("broken");
			const intact = checkoutOf("intact");
			const orphan = checkoutOf("orphan");
			await writeDaemonStateFile(agentDir, {
				workspaces: [workspace, other],
				worktrees: [
					record("broken", broken),
					record("intact", intact),
					{ ...record("orphan", orphan), workspaceName: other.name },
				],
			});
			editStateFile((state) => {
				(state.worktrees as Array<Record<string, unknown>>)[0].createdAt = "yesterday";
				(state.worktrees as unknown[]).push(null, "a string");
				// A workspace record that does not parse registers no workspace.
				delete (state.workspaces as Array<Record<string, unknown>>)[1].path;
			});

			expect(resolveConversationProject(agentDir, intact)).toEqual({
				projectCwd: intact,
				trustPath: workspace.path,
			});
			expect(resolveConversationProject(agentDir, broken)).toEqual({ projectCwd: broken, trustPath: undefined });
			expect(resolveConversationProject(agentDir, orphan)).toEqual({ projectCwd: orphan, trustPath: undefined });
		});

		it.each([
			[
				"a launch with a field the reader does not know",
				(launch: Record<string, unknown>) => ({ ...launch, added: 1 }),
			],
			["a launch without its placement", (launch: Record<string, unknown>) => ({ ...launch, placement: undefined })],
			["launches that are not a list", () => undefined],
		])("does not take a pull request review checkout for an ordinary one over %s", async (_name, corrupt) => {
			const review = checkoutOf("review");
			const ordinary = checkoutOf("ordinary");
			await writeDaemonStateFile(agentDir, {
				workspaces: [workspace],
				worktrees: [
					record("review", review, { prReviewLaunches: [reviewLaunch("review", review)] }),
					record("ordinary", ordinary),
				],
			});
			editStateFile((state) => {
				const worktree = (state.worktrees as Array<Record<string, unknown>>)[0];
				const launch = corrupt((worktree.prReviewLaunches as Array<Record<string, unknown>>)[0]);
				worktree.prReviewLaunches = launch === undefined ? "none" : [launch];
			});

			// Unrecorded: neither the workspace's project, nor the checkout's under the workspace's trust.
			expect(resolveConversationProject(agentDir, review)).toEqual({ projectCwd: review, trustPath: undefined });
			expect(resolveConversationProject(agentDir, ordinary)).toEqual({
				projectCwd: ordinary,
				trustPath: workspace.path,
			});
		});

		it("records no managed checkout in a state file of a version it does not know", async () => {
			const ordinary = checkoutOf("ordinary");
			const review = checkoutOf("review");
			await writeDaemonStateFile(agentDir, {
				workspaces: [workspace],
				worktrees: [
					record("ordinary", ordinary),
					record("review", review, { prReviewLaunches: [reviewLaunch("review", review)] }),
				],
			});
			editStateFile((state) => {
				state.version = 2;
			});

			expect(resolveConversationProject(agentDir, ordinary)).toEqual({ projectCwd: ordinary, trustPath: undefined });
			expect(resolveConversationProject(agentDir, review)).toEqual({ projectCwd: review, trustPath: undefined });
		});
	});
});

describe("the worktree records of the daemon's state file", () => {
	let root: string;
	let agentDir: string;
	let statePath: string;
	const workspace: IrohRemoteWorkspace = { name: "ws", path: "/repo" };
	const worktree: IrohRemoteWorkspaceWorktree = {
		id: "fix",
		workspaceName: "ws",
		path: "/worktrees/fix",
		branch: "volt/fix",
		createdAt: 1,
		sessionIds: ["session-1"],
	};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "volt-worktree-records-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		statePath = getDaemonPaths(agentDir).statePath;
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("are the registered workspaces and the worktrees, and nothing else of the file", async () => {
		await writeDaemonStateFile(agentDir, {
			hostSecretKey: [1, 2, 3],
			workspaces: [workspace],
			worktrees: [worktree],
			pairingSecretTombstones: [
				{ secretHash: "hash", workspace: "ws", outcome: "pairing_secret_expired", retainUntil: 2, expiredAt: 1 },
			],
		});
		const written = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		expect(written.irohSecretKey).toEqual([1, 2, 3]);

		const records = readVoltdWorktreeRecords(statePath);

		expect(Object.keys(records).sort()).toEqual(["workspaces", "worktrees"]);
		expect(records).toEqual({ workspaces: [workspace], worktrees: [worktree] });
	});

	it("are none in a file that is missing, unreadable, or not the daemon's state of this version", async () => {
		const none = { workspaces: [], worktrees: [] };
		expect(readVoltdWorktreeRecords(statePath)).toEqual(none);

		await writeDaemonStateFile(agentDir, { workspaces: [workspace], worktrees: [worktree] });
		const valid = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		for (const content of [
			"{ not json",
			"null",
			"[]",
			'"state"',
			JSON.stringify({ ...valid, version: 2 }),
			JSON.stringify({ ...valid, version: "1" }),
			JSON.stringify({ ...valid, version: undefined }),
		]) {
			writeFileSync(statePath, content);
			expect(readVoltdWorktreeRecords(statePath)).toEqual(none);
		}

		// A directory where the file should be.
		rmSync(statePath);
		mkdirSync(statePath);
		expect(readVoltdWorktreeRecords(statePath)).toEqual(none);
	});

	it("leave out each record that does not parse, and a section that is not a list", async () => {
		await writeDaemonStateFile(agentDir, { workspaces: [workspace], worktrees: [worktree] });
		const valid = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;

		writeFileSync(
			statePath,
			JSON.stringify({
				...valid,
				workspaces: [{ name: "nameless" }, workspace, 7],
				worktrees: [{ ...worktree, id: "Not An Id" }, worktree, { ...worktree, prReviewLaunches: [{}] }, null],
			}),
		);
		expect(readVoltdWorktreeRecords(statePath)).toEqual({ workspaces: [workspace], worktrees: [worktree] });

		writeFileSync(statePath, JSON.stringify({ ...valid, workspaces: { ws: workspace }, worktrees: "none" }));
		expect(readVoltdWorktreeRecords(statePath)).toEqual({ workspaces: [], worktrees: [] });

		writeFileSync(statePath, JSON.stringify({ version: 1 }));
		expect(readVoltdWorktreeRecords(statePath)).toEqual({ workspaces: [], worktrees: [] });
	});
});
