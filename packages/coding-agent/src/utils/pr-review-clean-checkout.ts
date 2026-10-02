import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

type GitReader = (cwd: string, args: string[]) => Promise<string>;

async function statIfPresent(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * The reader must disable executable configuration discovered at its supplied cwd.
 * Never let status enter a submodule implicitly: its configuration has not yet
 * been sanitized. Gitlinks, including nested ones, are checked explicitly instead.
 */
export async function isPrReviewCheckoutClean(cwd: string, readGit: GitReader, signal?: AbortSignal): Promise<boolean> {
	const pending = [{ path: await realpath(cwd), depth: 0, head: undefined as string | undefined }];
	const visited = new Set<string>();
	while (pending.length > 0) {
		signal?.throwIfAborted();
		const current = pending.pop()!;
		// Bound traversal and fail closed rather than silently skipping any child.
		if (current.depth > 64 || visited.size >= 1024 || visited.has(current.path)) return false;
		visited.add(current.path);
		if (current.head !== undefined) {
			if (
				(await realpath((await readGit(current.path, ["rev-parse", "--show-toplevel"])).trim())) !== current.path ||
				(await readGit(current.path, ["rev-parse", "--verify", "HEAD"])).trim() !== current.head
			)
				return false;
		}
		if (
			await readGit(current.path, [
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--ignore-submodules=all",
			])
		)
			return false;
		// Ignoring submodules also hides staged gitlink changes. This index-only
		// comparison never reads child worktrees or invokes their filters.
		if (
			await readGit(current.path, [
				"diff",
				"--cached",
				"--raw",
				"-z",
				"--no-ext-diff",
				"--no-textconv",
				"--no-renames",
				"--ignore-submodules=none",
				"HEAD",
				"--",
			])
		)
			return false;
		const index = await readGit(current.path, ["ls-files", "--stage", "-z"]);
		if (index !== "" && !index.endsWith("\0")) return false;
		for (const entry of index.split("\0").slice(0, -1)) {
			const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([^\0]+)$/s.exec(entry);
			if (!match || match[3] !== "0") return false;
			if (match[1] !== "160000") continue;
			const name = match[4];
			if (
				isAbsolute(name) ||
				name
					.split(/[\\/]/)
					.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")
			)
				return false;
			const path = resolve(current.path, name);
			if (!path.startsWith(`${current.path}${sep}`)) return false;
			const directory = await statIfPresent(path);
			if (!directory) continue; // Uninitialized submodules need not be populated.
			if (!directory.isDirectory() || (await realpath(path)) !== path) return false;
			const gitEntry = await statIfPresent(join(path, ".git"));
			if (!gitEntry) continue;
			if (!gitEntry.isFile() && !gitEntry.isDirectory()) return false;
			if (visited.size + pending.length >= 1024) return false;
			pending.push({ path, depth: current.depth + 1, head: match[2] });
		}
	}
	return true;
}
