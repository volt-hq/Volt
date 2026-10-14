/**
 * The extension inventory of a workspace root, evaluated without a
 * conversation: what a phone conversation opened there would load. Its
 * settings are read in the root with the daemon's trust decision and profile
 * (`conversation-settings.ts`), and its resources load as the conversation's
 * resource loader loads them, so the same extensions run, with the same
 * enabled flags; their factories run, which is what registers their review
 * engines. Nothing more of a conversation starts: no session, no prompt, no
 * `project_trust` hook, no migration, and a configured package that is not
 * installed is left out rather than installed (the result then says it may
 * not be kept, since a conversation would install it).
 *
 * It runs in a process of its own (`extension-inventory-process.ts`): the
 * daemon itself runs no extension code.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { type ExtensionInventory, reviewEngineView } from "../../core/extensions/inventory.ts";
import { ExtensionPermissionStore } from "../../core/extensions/permissions.ts";
import { loadedExtensionSummaries } from "../../core/extensions/registry.ts";
import { DefaultResourceLoader } from "../../core/resource-loader.ts";
import { ReviewEngineRegistry } from "../../core/review-engine.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { createConversationSettings } from "./conversation-settings.ts";

/** Most paths an evaluation reports as its inputs; one with more is not kept. */
export const EXTENSION_INVENTORY_MAX_INPUTS = 512;

export interface ExtensionInventoryRequest {
	/** The root a conversation there loads its project resources from: the workspace, or a worktree checkout. */
	readonly root: string;
	readonly agentDir: string;
	/** The daemon's trust decision for the workspace. */
	readonly projectTrusted: boolean;
	readonly profile?: string;
}

/** An evaluated inventory, and what decides whether it may be kept. */
export interface ExtensionInventoryEvaluation extends ExtensionInventory {
	/**
	 * The files and directories whose change can change the inventory: settings, permission acknowledgments,
	 * the extension directories, and each extension's source.
	 */
	readonly inputs: readonly string[];
	/** False when it may not be kept: configured packages were left out, or it has more inputs than are watched. */
	readonly cacheable: boolean;
}

/** Evaluate what a phone conversation in `request.root` would load. */
export async function evaluateExtensionInventory(
	request: ExtensionInventoryRequest,
): Promise<ExtensionInventoryEvaluation> {
	const root = resolvePath(request.root);
	const agentDir = resolvePath(request.agentDir);
	const settingsManager = createConversationSettings(root, agentDir, {
		profile: request.profile,
		projectTrusted: request.projectTrusted,
	});
	// Only extensions are read: skills, prompts, themes, and context files decide nothing here.
	const loader = new DefaultResourceLoader({
		cwd: canonicalizePath(root),
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		skipMissingPackages: true,
	});
	await loader.reload();
	const result = loader.getExtensions();
	try {
		const extensions = loadedExtensionSummaries(
			result,
			(id) => result.runtime.settings.enabled(id),
			new ExtensionPermissionStore(agentDir),
		);
		// As a conversation takes them: each active extension's engines in load order, a refused one left out.
		const engines = new ReviewEngineRegistry();
		for (const extension of result.extensions) {
			for (const engine of extension.reviewEngines.values()) {
				try {
					engines.register(engine);
				} catch {
					// A conversation refuses it too.
				}
			}
		}
		const inputs = new Set([
			join(agentDir, "settings.json"),
			join(root, CONFIG_DIR_NAME, "settings.json"),
			join(agentDir, "extension-permissions.json"),
			join(root, CONFIG_DIR_NAME, "extensions"),
			join(agentDir, "extensions"),
		]);
		for (const declaration of result.declarations ?? []) {
			if (declaration.resolvedPath.startsWith("<")) continue;
			inputs.add(declaration.resolvedPath);
			if (isDirectory(declaration.resolvedPath)) inputs.add(join(declaration.resolvedPath, "package.json"));
		}
		return {
			projectTrusted: request.projectTrusted,
			extensions,
			reviewEngines: engines.list().map(reviewEngineView),
			inputs: [...inputs].slice(0, EXTENSION_INVENTORY_MAX_INPUTS),
			cacheable: loader.getSkippedPackages().length === 0 && inputs.size <= EXTENSION_INVENTORY_MAX_INPUTS,
		};
	} finally {
		for (const extension of result.extensions) extension.lifetime.retire("The extension inventory was taken");
	}
}

function isDirectory(path: string): boolean {
	try {
		return existsSync(path) && statSync(path).isDirectory();
	} catch {
		return false;
	}
}
