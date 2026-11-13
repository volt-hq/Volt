import type { ReviewEngineChangedFile, ReviewEngineContext } from "@hansjm10/volt-coding-agent";
import { createBaseReader } from "./base.ts";
import type { ReviewTarget } from "./types.ts";

/** The most patch text, in bytes, of the whole files every worker's prompt carries; workers page the rest. */
export const MAX_INLINE_BYTES = 200_000;
/** What a hunk adds to its patch when the host delivers it: its file's first line and a blank line. */
const HUNK_OVERHEAD_BYTES = 512;
/** The budget the inline diff's delivery gets: its packing budget plus the room the estimate above may fall short by. */
export const INLINE_DELIVERY_BYTES = MAX_INLINE_BYTES + 64 * 1024;
/** The largest page review_diff returns, which workers are told to page with. */
export const DIFF_PAGE_BYTES = 64 * 1024;

function statLine(file: ReviewEngineChangedFile): string {
	const name = file.previousPath === undefined ? file.path : `${file.previousPath} -> ${file.path}`;
	const counts = ` | +${file.additions ?? 0} -${file.deletions ?? 0}`;
	return file.reviewable ? ` ${name}${counts}` : ` ${name}${counts} (diff not shown: ${file.unsupportedReason ?? "not reviewable"})`;
}

/** How the change reaches each worker: the hunks of every file, those carried in the prompt, and the files paged. */
export type DiffLayout = Pick<ReviewTarget, "hunkIds" | "inlineHunkIds" | "pagedFiles" | "fileHunks" | "hunkBytes">;

/**
 * Lays out the reviewable files for one review of the whole change: in order, each file whose hunks still fit
 * within {@link MAX_INLINE_BYTES} has its diff text in the prompt, and every other file is paged with review_diff.
 * A file goes whole one way or the other, because review_diff pages a file's diff from its start.
 */
export function layoutDiff(files: readonly ReviewEngineChangedFile[]): DiffLayout {
	const hunkIds: string[] = [];
	const inlineHunkIds: string[] = [];
	const pagedFiles: string[] = [];
	const fileHunks = new Map<string, string[]>();
	const hunkBytes = new Map<string, number>();
	let inlineBytes = 0;
	for (const file of files) {
		const ids = file.hunks.map((hunk) => hunk.id);
		for (const hunk of file.hunks) hunkBytes.set(hunk.id, hunk.patchBytes);
		fileHunks.set(file.path, ids);
		hunkIds.push(...ids);
		const bytes = file.hunks.reduce((sum, hunk) => sum + hunk.patchBytes + HUNK_OVERHEAD_BYTES, 0);
		if (inlineBytes + bytes <= MAX_INLINE_BYTES) {
			inlineHunkIds.push(...ids);
			inlineBytes += bytes;
		} else {
			pagedFiles.push(file.path);
		}
	}
	return { hunkIds, inlineHunkIds, pagedFiles, fileHunks, hunkBytes };
}

/** The review_diff pages of {@link DIFF_PAGE_BYTES} it takes to read `files` whole: each file's diff pages on its own. */
export function pageCount(target: Pick<ReviewTarget, "fileHunks" | "hunkBytes">, files: readonly string[]): number {
	return files.reduce((pages, file) => {
		const bytes = (target.fileHunks.get(file) ?? []).reduce(
			(sum, id) => sum + (target.hunkBytes.get(id) ?? 0) + HUNK_OVERHEAD_BYTES,
			0,
		);
		return pages + Math.max(1, Math.ceil(bytes / DIFF_PAGE_BYTES));
	}, 0);
}

/**
 * Swarm's view of the change the host resolved: how its hunks reach each worker, a checkout of the reviewed head to
 * work in, and the base-file reader. Returns a user-facing message when there is nothing to review.
 */
export async function buildTarget(engine: ReviewEngineContext): Promise<ReviewTarget | string> {
	const files = engine.changedFiles().filter((file) => file.inScope);
	const reviewable = files.filter((file) => file.reviewable && file.hunks.length > 0);
	if (reviewable.length === 0) {
		return `No reviewable changes in ${engine.target.description}${engine.target.controls.scope.length > 0 ? " match the scope" : ""}.`;
	}
	return {
		repoRoot: engine.target.root,
		// Held for the whole review: every pass reads it, and none changes it.
		checkout: (await engine.checkout()).path,
		description: engine.target.description,
		stat: files.map(statLine).join("\n"),
		scope: engine.target.controls.scope,
		...layoutDiff(reviewable),
		submodules: files.some((file) => file.unsupportedReason?.startsWith("Submodule") === true),
		commonDir: engine.target.commonDirectory,
		readBase: createBaseReader(engine),
	};
}
