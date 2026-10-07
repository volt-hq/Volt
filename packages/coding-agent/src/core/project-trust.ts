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

/** A project trust decision a TUI made at startup (Phase 6 D4): for the project of `cwd`. */
export interface DecidedProjectTrust {
	readonly cwd: string;
	readonly trusted: boolean;
}

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
 * The project trust of a conversation in `cwd`: the decision a TUI made for
 * the project it opened in, `decided`, applies to that project only;
 * elsewhere, and without one, a project without resources that need trust is
 * trusted, and one with them is trusted only by its saved decision. A worker
 * builds the conversations a TUI opened with it, and the TUI reads its own
 * display settings with it. Read again whenever it matters: a project that
 * had nothing to trust may gain it.
 */
export function resolveConversationProjectTrust(
	agentDir: string,
	cwd: string,
	decided: DecidedProjectTrust | undefined,
): boolean {
	const trustPath = projectTrustPath(agentDir, cwd);
	if (decided !== undefined && trustPath !== undefined && trustPath === projectTrustPath(agentDir, decided.cwd)) {
		return decided.trusted;
	}
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return trustPath !== undefined && new ProjectTrustStore(agentDir).get(trustPath) === true;
}

export interface ResolveProjectTrustedOptions {
	cwd: string;
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
	const options = getProjectTrustOptions(cwd, { includeSessionOnly: true });
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

export async function resolveProjectTrusted(options: ResolveProjectTrustedOptions): Promise<boolean> {
	if (options.trustOverride !== undefined) {
		return options.trustOverride;
	}
	if (!hasTrustRequiringProjectResources(options.cwd)) {
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
		return false;
	}

	const selected = await selectProjectTrustOption(options.cwd, options.projectTrustContext);
	if (selected !== undefined) {
		saveProjectTrustPromptResult(options.trustStore, selected);
		return selected.trusted;
	}
	return false;
}
