import { isAbsolute } from "node:path";

type GitPathReader = (args: string[]) => Promise<string>;

function parsePaths(output: string, count: number): string[] {
	const paths = output.split("\n");
	// rev-parse emits one LF-terminated path per option. Never trim path bytes or
	// accept ambiguous output (including paths containing LF, CR or NUL bytes).
	if (
		paths.pop() !== "" ||
		paths.length !== count ||
		paths.some((path) => !isAbsolute(path) || /[\0\r\n]/.test(path))
	) {
		throw new Error("Invalid PR checkout Git paths.");
	}
	return paths;
}

/** Use the caller's sanitized Git reader; retain fresh configuration reads per command. */
export async function readPrReviewRepositoryPaths(readGit: GitPathReader) {
	const [root, commonDirectory] = parsePaths(
		await readGit(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]),
		2,
	);
	return { root, commonDirectory };
}

/** Keep this observation separate from identity/cleanliness checks; do not cache it. */
export async function readPrReviewOperationPaths(readGit: GitPathReader): Promise<string[]> {
	const markers = [
		"MERGE_HEAD",
		"CHERRY_PICK_HEAD",
		"REVERT_HEAD",
		"BISECT_LOG",
		"rebase-merge",
		"rebase-apply",
		"sequencer",
	];
	return parsePaths(
		await readGit(["rev-parse", "--path-format=absolute", ...markers.flatMap((marker) => ["--git-path", marker])]),
		markers.length,
	);
}
