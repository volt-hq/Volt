/**
 * Directories the daemon never registers as a workspace without asking
 * (D17, refined by the maintainer on 2026-10-06): a filesystem root, the
 * user's home directory (or a directory containing it), any directory
 * containing Volt's agent directory, and any directory inside it (its
 * credentials, the daemon's state and control token, every transcript). A
 * paired device with access to all workspaces would reach everything under
 * one of them. Any other subdirectory of the home directory is not
 * sensitive.
 *
 * Paths are compared as given (the caller passes real paths, and both the
 * configured and the real path of the agent directory), and
 * case-insensitively where the platform's default filesystems are (Windows,
 * macOS).
 */

import { parse, resolve } from "node:path";
import type { SensitiveDirectoryReason } from "./control-protocol.ts";
import { isPathInside } from "./workspace-directory.ts";

const CASE_INSENSITIVE_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["win32", "darwin"]);

/** Why `directory` is sensitive, or undefined when it may be registered without asking. */
export function sensitiveDirectoryReason(
	directory: string,
	context: {
		/** The user's home directories (the daemon's and the TUI's). */
		readonly homes: readonly string[];
		/** Volt's agent directory, as configured and as its real path. */
		readonly agentDirs: readonly string[];
		/** Compare without case; the platform's default otherwise. */
		readonly caseInsensitive?: boolean;
	},
): SensitiveDirectoryReason | undefined {
	const caseInsensitive = context.caseInsensitive ?? CASE_INSENSITIVE_PLATFORMS.has(process.platform);
	const key = (path: string): string => {
		const resolved = resolve(path);
		return caseInsensitive ? resolved.toLowerCase() : resolved;
	};
	const candidate = key(directory);
	if (parse(candidate).root === candidate) return "root";
	const agentDirs = context.agentDirs.map(key);
	if (agentDirs.some((agentDir) => isPathInside(candidate, agentDir))) return "contains_agent_dir";
	if (agentDirs.some((agentDir) => isPathInside(agentDir, candidate))) return "inside_agent_dir";
	if (context.homes.some((home) => isPathInside(candidate, key(home)))) return "home";
	return undefined;
}
