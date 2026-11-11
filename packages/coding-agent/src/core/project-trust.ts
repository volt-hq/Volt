import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDaemonDir } from "../daemon/paths.ts";
import { parseVoltdState } from "../daemon/state.ts";
import { isPathInside } from "../daemon/workspace-directory.ts";
import { getConversationProject, isPathUnderWorktreesRoot } from "../daemon/worktree-manager.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { IrohRemoteWorkspaceWorktree } from "./remote/iroh/state.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

/** The project of a conversation: where its project resources load from, and whose trust decision applies. */
export interface ConversationProject {
	/** Where its settings, extensions, skills, prompts, MCP config, and context files load from. */
	readonly projectCwd: string;
	/**
	 * The canonical path its project trust is read, asked, and saved for; none
	 * in a managed worktree the daemon has no usable record of, which is
	 * trusted only while nothing in it needs trust.
	 */
	readonly trustPath: string | undefined;
}

/**
 * The project of a conversation in `cwd` (worktrees-design §5.2.1). A
 * directory outside the daemon's worktrees root is its own project. A managed
 * worktree checkout takes its trust, and for a pull request review its
 * project, from the repository in its workspace, as the daemon's state file
 * records the checkout (`getConversationProject`): never from the checkout's
 * `.git` pointer, which names the repository's main checkout. The state file
 * is read on each call, for a managed checkout only; one that is missing,
 * unreadable, or without a record of the checkout or its workspace leaves the
 * conversation its own directory and no trust path. Never throws.
 */
export function resolveConversationProject(agentDir: string, cwd: string): ConversationProject {
	const directory = canonicalizePath(resolvePath(cwd));
	if (!isPathUnderWorktreesRoot(agentDir, cwd) && !isPathUnderWorktreesRoot(agentDir, directory)) {
		return { projectCwd: cwd, trustPath: directory };
	}
	try {
		const state = parseVoltdState(JSON.parse(readFileSync(join(getDaemonDir(agentDir), "state.json"), "utf8")));
		// The innermost checkout holding the directory, on canonical paths.
		let checkout: IrohRemoteWorkspaceWorktree | undefined;
		for (const worktree of state.worktrees) {
			const path = canonicalizePath(resolvePath(worktree.path));
			if (isPathInside(path, directory) && path.length > (checkout?.path.length ?? -1)) {
				checkout = { ...worktree, path };
			}
		}
		const workspaceName = checkout?.workspaceName;
		const workspace = state.workspaces.find((entry) => entry.name === workspaceName);
		if (checkout !== undefined && workspace !== undefined) {
			const project = getConversationProject(workspace, checkout, directory);
			return {
				// As spelled where the project is the conversation's own directory.
				projectCwd: project.projectCwd === directory ? cwd : project.projectCwd,
				trustPath: canonicalizePath(resolvePath(project.trustPath)),
			};
		}
	} catch {
		// No usable record: the state file is missing, unreadable, or not the daemon's state.
	}
	return { projectCwd: cwd, trustPath: undefined };
}

/** The path a conversation in `cwd` takes its project trust from (`resolveConversationProject`). */
export function projectTrustPath(agentDir: string, cwd: string): string | undefined {
	return resolveConversationProject(agentDir, cwd).trustPath;
}

/**
 * The project trust of a conversation in `cwd` now: the decision made for its
 * project (`decisions`, by trust path), else trusted when the project holds
 * nothing that needs trust, else its saved decision. Read again whenever it
 * matters: a project that had nothing to trust may gain it.
 */
export function resolveConversationProjectTrust(
	agentDir: string,
	cwd: string,
	decisions: ReadonlyMap<string, boolean>,
): boolean {
	const { projectCwd, trustPath } = resolveConversationProject(agentDir, cwd);
	const decided = trustPath === undefined ? undefined : decisions.get(trustPath);
	if (decided !== undefined) return decided;
	if (!hasTrustRequiringProjectResources(projectCwd)) return true;
	return trustPath !== undefined && new ProjectTrustStore(agentDir).get(trustPath) === true;
}

export interface ResolveProjectTrustedOptions {
	/** The project the decision is for (a `ConversationProject`'s trust path): hooks are asked, and decisions saved, for it. */
	cwd: string;
	/**
	 * Where the resources that need trust are looked for: the directory the
	 * conversation loads its project from, such as a managed worktree checkout
	 * whose trust is its workspace's. `cwd` by default.
	 */
	resourcesCwd?: string;
	trustStore: ProjectTrustStore;
	trustOverride?: boolean;
	defaultProjectTrust?: DefaultProjectTrust;
	extensionsResult?: LoadExtensionsResult;
	projectTrustContext: ProjectTrustContext;
	onExtensionError?: (message: string) => void;
}

function formatProjectTrustPrompt(cwd: string): string {
	return `Trust project folder?\n${cwd}\n\nThis allows volt to load .volt settings and resources, install missing project packages, and execute project extensions.`;
}

async function selectProjectTrustOption(
	cwd: string,
	ctx: ProjectTrustContext,
): Promise<ProjectTrustOption | undefined> {
	const listed = getProjectTrustOptions(cwd, { includeSessionOnly: true });
	// The answers that do not trust come first, the one that saves nothing first of all: the prompt can show
	// in a running TUI, where a keystroke meant for the editor must not trust the project.
	const untrusting = listed.filter((option) => !option.trusted).sort((a, b) => a.updates.length - b.updates.length);
	const options = [...untrusting, ...listed.filter((option) => option.trusted)];
	const selected = await ctx.ui.select(
		formatProjectTrustPrompt(cwd),
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === selected);
}

function saveProjectTrustPromptResult(trustStore: ProjectTrustStore, result: ProjectTrustOption): void {
	if (result.updates.length > 0) {
		trustStore.setMany(result.updates);
	}
}

/** `decideProjectTrust`, untrusted when nothing decided. */
export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	return (await decideProjectTrust(options)) ?? false;
}

/**
 * Decide the trust of the project in `cwd`: the override; trusted when
 * nothing in it needs trust; else the first yes/no of the `project_trust`
 * hooks (saved with `remember`), the saved decision, `defaultProjectTrust`,
 * or the user's answer to the trust prompt (saved unless it is for this
 * session only). Undefined when nothing decided: the prompt could not be
 * asked, or closed without an answer (a dismissal).
 */
export async function decideProjectTrust(options: ResolveProjectTrustedOptions): Promise<boolean | undefined> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.resourcesCwd ?? options.cwd)) {
		return true;
	}

	if (options.extensionsResult) {
		const { result, errors } = await emitProjectTrustEvent(
			options.extensionsResult,
			{ type: "project_trust", cwd: options.cwd },
			options.projectTrustContext,
		);
		for (const error of errors) {
			options.onExtensionError?.(`Extension "${error.extensionId}" project_trust error: ${error.error}`);
		}
		if (result) {
			const trusted = result.trusted === "yes";
			if (result.remember === true) {
				options.trustStore.set(options.cwd, trusted);
			}
			return trusted;
		}
	}

	const decision = options.trustStore.get(options.cwd);
	if (decision !== null) {
		return decision;
	}

	switch (options.defaultProjectTrust ?? "ask") {
		case "always":
			return true;
		case "never":
			return false;
		case "ask":
			break;
	}

	if (!options.projectTrustContext.hasUI) {
		return undefined;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return undefined;
}
