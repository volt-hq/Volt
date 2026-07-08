import { Buffer } from "node:buffer";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

export type WorkspaceDirectoryError =
	| "invalid_working_directory"
	| "workspace_directory_not_found"
	| "workspace_directory_not_directory"
	| "workspace_directory_escape"
	| "workspace_directory_unavailable";

export interface WorkspaceDirectoryResolution {
	absolutePath: string;
	/** POSIX-style path relative to the workspace root. Undefined means the root. */
	relativePath?: string;
}

export interface WorkspaceDirectoryEntry {
	name: string;
	/** POSIX-style path relative to the workspace root. */
	path: string;
}

export function normalizeWorkspaceRelativeDirectory(
	value: string | undefined,
): { ok: true; relativePath?: string } | { ok: false; error: WorkspaceDirectoryError } {
	if (value === undefined) {
		return { ok: true };
	}
	if (value.length === 0 || value === ".") {
		return { ok: false, error: "invalid_working_directory" };
	}
	if (
		value.length > 4096 ||
		Buffer.byteLength(value, "utf8") > 8192 ||
		value.includes("\0") ||
		hasAsciiControlCharacter(value) ||
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/.test(value) ||
		value.startsWith("//")
	) {
		return { ok: false, error: "invalid_working_directory" };
	}
	for (const segment of value.split("/")) {
		if (segment === "" || segment === "." || segment === ".." || segment === ".git") {
			return { ok: false, error: "invalid_working_directory" };
		}
	}
	const normalized = posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
		return { ok: false, error: "invalid_working_directory" };
	}
	return { ok: true, relativePath: normalized };
}

export async function resolveWorkspaceDirectory(
	workspaceRoot: string,
	workingDirectory?: string,
): Promise<{ ok: true; value: WorkspaceDirectoryResolution } | { ok: false; error: WorkspaceDirectoryError }> {
	const normalized = normalizeWorkspaceRelativeDirectory(workingDirectory);
	if (!normalized.ok) {
		return normalized;
	}
	let rootReal: string;
	let candidateReal: string;
	try {
		rootReal = await realpath(workspaceRoot);
	} catch {
		return { ok: false, error: "workspace_directory_unavailable" };
	}
	const candidatePath = normalized.relativePath ? resolve(rootReal, normalized.relativePath) : rootReal;
	try {
		candidateReal = await realpath(candidatePath);
	} catch {
		return { ok: false, error: "workspace_directory_not_found" };
	}
	if (!isPathInside(rootReal, candidateReal)) {
		return { ok: false, error: "workspace_directory_escape" };
	}
	try {
		const info = await stat(candidateReal);
		if (!info.isDirectory()) {
			return { ok: false, error: "workspace_directory_not_directory" };
		}
	} catch {
		return { ok: false, error: "workspace_directory_unavailable" };
	}
	return {
		ok: true,
		value: {
			absolutePath: candidateReal,
			relativePath: normalized.relativePath,
		},
	};
}

export async function listWorkspaceDirectories(
	workspaceRoot: string,
	path?: string,
): Promise<
	| { ok: true; currentPath?: string; directories: WorkspaceDirectoryEntry[] }
	| { ok: false; error: WorkspaceDirectoryError }
> {
	const resolved = await resolveWorkspaceDirectory(workspaceRoot, path);
	if (!resolved.ok) {
		return resolved;
	}
	try {
		const entries = await readdir(resolved.value.absolutePath, { withFileTypes: true });
		const directories = entries
			.filter((entry) => entry.isDirectory() && entry.name !== ".git")
			.map((entry) => ({
				name: entry.name,
				path: resolved.value.relativePath ? posix.join(resolved.value.relativePath, entry.name) : entry.name,
			}))
			.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
		return { ok: true, currentPath: resolved.value.relativePath, directories };
	} catch {
		return { ok: false, error: "workspace_directory_unavailable" };
	}
}

function hasAsciiControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

export function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
