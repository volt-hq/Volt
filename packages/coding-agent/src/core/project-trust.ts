import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "../daemon/worktree-manager.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { emitProjectTrustEvent } from "./extensions/runner.ts";
import type { LoadExtensionsResult, ProjectTrustContext } from "./extensions/types.ts";
import type { DefaultProjectTrust } from "./settings-manager.ts";
import {
	getProjectTrustOptions,
	hasTrustRequiringProjectResources,
	type ProjectTrustOption,
	ProjectTrustStore,
} from "./trust-manager.ts";

export type AppMode = "interactive" | "print" | "json" | "rpc";

/**
 * Where a conversation in `cwd` takes its project trust from: the parent
 * checkout of a managed worktree, and none for one whose parent is unknown
 * (worktrees-design §5.2.1).
 */
export function projectTrustPath(agentDir: string, cwd: string): string | undefined {
	const path =
		resolveWorktreeParentCheckout(agentDir, cwd) ?? (isPathUnderWorktreesRoot(agentDir, cwd) ? undefined : cwd);
	return path === undefined ? undefined : canonicalizePath(resolvePath(path));
}

/**
 * The project trust of a conversation in `cwd` now: the decision made for its
 * project (`decisions`, by `projectTrustPath`), else trusted when the project
 * holds nothing that needs trust, else its saved decision. Read again
 * whenever it matters: a project that had nothing to trust may gain it.
 */
export function resolveConversationProjectTrust(
	agentDir: string,
	cwd: string,
	decisions: ReadonlyMap<string, boolean>,
): boolean {
	const trustPath = projectTrustPath(agentDir, cwd);
	const decided = trustPath === undefined ? undefined : decisions.get(trustPath);
	if (decided !== undefined) return decided;
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return trustPath !== undefined && new ProjectTrustStore(agentDir).get(trustPath) === true;
}

export interface ResolveProjectTrustedOptions {
	/** The project the decision is for (`projectTrustPath`): hooks are asked, and decisions saved, for it. */
	cwd: string;
	/**
	 * Where the resources that need trust are looked for: the conversation's
	 * own directory, such as a managed worktree checkout whose project is its
	 * parent checkout. `cwd` by default.
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
