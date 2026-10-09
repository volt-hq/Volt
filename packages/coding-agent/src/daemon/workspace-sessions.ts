/**
 * Which registered workspace owns a stored session (#722). Every working
 * directory's sessions are in the default store, each indexed by its
 * canonical cwd (`SessionLocation.cwdKey`). The workspace a session belongs
 * to is where that directory runs, by the rule a TUI's open places its
 * working directory with: the innermost managed worktree containing it (its
 * parent workspace, the checkout as its root), else the innermost registered
 * workspace containing it. So a workspace owns the sessions started anywhere
 * under its root and in its worktrees' checkouts, except under a registered
 * workspace nested inside it (local-only ones included) or another
 * workspace's worktree; a session of a worktree whose record is gone, of no
 * workspace, or of a custom store is no workspace's.
 *
 * Every daemon lookup of a workspace's sessions goes through here: a
 * phone's listing and open, change observation, session contexts, worker
 * claims, and a TUI's placement.
 */

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import {
	findSessionLocation,
	getDefaultSessionDirPath,
	listSessionLocations,
	type SessionListOptions,
	type SessionLocation,
} from "../core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../core/session-store/index.ts";
import { isPathInside } from "./workspace-directory.ts";

/** Where a directory runs: its workspace, and the root it stays inside. */
export interface SessionPlacement {
	readonly workspace: IrohRemoteWorkspace;
	/** The canonical workspace root, or the canonical checkout of the managed worktree the directory is in. */
	readonly root: string;
	readonly worktree?: IrohRemoteWorkspaceWorktree;
}

/** A stored session a workspace owns, with where it runs. */
export interface WorkspaceSession extends SessionLocation {
	readonly placement: SessionPlacement;
}

export interface WorkspaceSessionsOptions {
	readonly agentDir: string;
	/** The registered workspaces now. */
	workspaces(): readonly IrohRemoteWorkspace[];
	/** The daemon-managed worktrees now. */
	worktrees(): Promise<readonly IrohRemoteWorkspaceWorktree[]>;
}

/** A path's real path; the resolved path when it cannot be read (an archived checkout, a moved workspace). */
async function canonicalPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
}

/** The session `sessionId` of the store in `directory`, without creating a store there. */
export async function findStoredSessionLocation(
	directory: string,
	sessionId: string,
): Promise<SessionLocation | undefined> {
	return existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME))
		? findSessionLocation(directory, sessionId)
		: undefined;
}

/** The registered workspaces and managed worktrees at one moment, by canonical path. */
export class WorkspacePlacementIndex {
	private readonly workspaces: readonly SessionPlacement[];
	/** The worktrees of registered workspaces, with their workspace. */
	private readonly worktrees: readonly Required<SessionPlacement>[];

	constructor(workspaces: readonly SessionPlacement[], worktrees: readonly Required<SessionPlacement>[]) {
		this.workspaces = workspaces;
		this.worktrees = worktrees;
	}

	static async build(
		workspaces: readonly IrohRemoteWorkspace[],
		worktrees: readonly IrohRemoteWorkspaceWorktree[],
	): Promise<WorkspacePlacementIndex> {
		const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
		return new WorkspacePlacementIndex(
			await Promise.all(
				workspaces.map(async (workspace) => ({ workspace, root: await canonicalPath(workspace.path) })),
			),
			await Promise.all(
				worktrees.flatMap((worktree) => {
					const workspace = byName.get(worktree.workspaceName);
					return workspace === undefined
						? []
						: [canonicalPath(worktree.path).then((root) => ({ workspace, root, worktree }))];
				}),
			),
		);
	}

	/**
	 * Where the canonical directory `directory` runs: the innermost managed
	 * worktree containing it, else the innermost registered workspace
	 * containing it; undefined when none does.
	 */
	place(directory: string): SessionPlacement | undefined {
		return innermost(this.worktrees, directory) ?? this.workspaceContaining(directory);
	}

	/** The innermost registered workspace containing the canonical directory `directory`. */
	workspaceContaining(directory: string): SessionPlacement | undefined {
		return innermost(this.workspaces, directory);
	}

	/** The canonical directories `workspaceName`'s sessions can be in: its root and its worktrees' checkouts. */
	roots(workspaceName: string): string[] {
		return [...this.workspaces, ...this.worktrees]
			.filter((placement) => placement.workspace.name === workspaceName)
			.map((placement) => placement.root);
	}
}

function innermost<P extends SessionPlacement>(placements: readonly P[], directory: string): P | undefined {
	let match: P | undefined;
	for (const placement of placements) {
		if (!isPathInside(placement.root, directory)) continue;
		if (match === undefined || placement.root.length > match.root.length) match = placement;
	}
	return match;
}

export class WorkspaceSessions {
	private readonly options: WorkspaceSessionsOptions;
	/** The default store's directory: every working directory's sessions. */
	readonly sessionDir: string;

	constructor(options: WorkspaceSessionsOptions) {
		this.options = options;
		this.sessionDir = getDefaultSessionDirPath(options.agentDir);
	}

	/** The placements of what is registered now. */
	async placements(): Promise<WorkspacePlacementIndex> {
		return WorkspacePlacementIndex.build(this.options.workspaces(), await this.options.worktrees());
	}

	/** The sessions of the default store `workspaceName` owns, most recently modified first. */
	async list(workspaceName: string, options?: SessionListOptions): Promise<WorkspaceSession[]> {
		const placements = await this.placements();
		const roots = placements.roots(workspaceName);
		if (roots.length === 0 || !existsSync(join(this.sessionDir, SESSION_STORE_DATABASE_FILENAME))) return [];
		const owned: WorkspaceSession[] = [];
		for (const location of await listSessionLocations(this.sessionDir, roots, options)) {
			const placement = placements.place(location.cwdKey);
			if (placement?.workspace.name === workspaceName) owned.push({ ...location, placement });
		}
		return owned;
	}

	/**
	 * The session `sessionId` when `workspaceName` owns it: stored in
	 * `sessionDirectory` (a custom store a conversation of the workspace
	 * runs from) or the default store.
	 */
	async find(
		workspaceName: string,
		sessionId: string,
		sessionDirectory?: string,
	): Promise<WorkspaceSession | undefined> {
		const placements = await this.placements();
		const directories = new Set([sessionDirectory, this.sessionDir].flatMap((dir) => (dir ? [resolve(dir)] : [])));
		for (const directory of directories) {
			const location = await findStoredSessionLocation(directory, sessionId);
			const placement = location === undefined ? undefined : placements.place(location.cwdKey);
			if (location !== undefined && placement?.workspace.name === workspaceName) return { ...location, placement };
		}
		return undefined;
	}

	/** The session `sessionId` of the default store, whatever owns it, with where it runs when anything does. */
	async locate(
		sessionId: string,
	): Promise<{ readonly location: SessionLocation; readonly placement?: SessionPlacement } | undefined> {
		const location = await findStoredSessionLocation(this.sessionDir, sessionId);
		if (location === undefined) return undefined;
		const placement = (await this.placements()).place(location.cwdKey);
		return placement === undefined ? { location } : { location, placement };
	}

	/** Which of `sessionIds` `workspaceName` owns in the default store. */
	async owned(workspaceName: string, sessionIds: readonly string[]): Promise<Set<string>> {
		const placements = await this.placements();
		const owned = new Set<string>();
		for (const sessionId of sessionIds) {
			const location = await findStoredSessionLocation(this.sessionDir, sessionId);
			if (location !== undefined && placements.place(location.cwdKey)?.workspace.name === workspaceName) {
				owned.add(sessionId);
			}
		}
		return owned;
	}
}
