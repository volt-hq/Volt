import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@hansjm10/volt-coding-agent";

const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Global and above-repository context files come from disk. In-repository AGENTS/CLAUDE/REVIEW files come from the
 * base of the change, as in the built-in /review, so the change under review cannot rewrite its own instructions.
 */
export async function loadContextFiles(
	repoRoot: string,
	readBase: (path: string, signal: AbortSignal) => Promise<string | undefined>,
	cwd: string,
	signal: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
	const resolvedCwd = realpathSync(cwd);
	const files = loadProjectContextFiles({ cwd: resolvedCwd, agentDir: getAgentDir() }).filter(
		(file) => !insideRoot(repoRoot, file.path),
	);
	const userReviewPolicy = join(getAgentDir(), "REVIEW.md");
	if (existsSync(userReviewPolicy)) {
		files.push({ path: userReviewPolicy, content: readFileSync(userReviewPolicy, "utf8") });
	}
	const relativeCwd = relative(repoRoot, resolvedCwd);
	const segments = insideRoot(repoRoot, resolvedCwd) ? relativeCwd.split(sep).filter(Boolean) : [];
	const directories = ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
	for (const directory of directories) {
		for (const name of CONTEXT_FILE_NAMES) {
			const path = directory ? `${directory}/${name}` : name;
			const content = await readBase(path, signal);
			if (content !== undefined) {
				files.push({ path: `base:${path}`, content });
				break;
			}
		}
		const reviewPath = directory ? `${directory}/REVIEW.md` : "REVIEW.md";
		const review = await readBase(reviewPath, signal);
		if (review !== undefined) files.push({ path: `base:${reviewPath}`, content: review });
	}
	return files;
}
