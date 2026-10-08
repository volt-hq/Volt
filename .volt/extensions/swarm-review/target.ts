import type { ReviewEngineChangedFile, ReviewEngineContext } from "@hansjm10/volt-coding-agent";
import { createBaseReader } from "./base.ts";
import { linkDependencies, repositoryOf } from "./git.ts";
import type { DiffShard, ReviewTarget } from "./types.ts";

/** What one worker's part of the diff holds at most, in bytes of patch text. */
export const MAX_SHARD_BYTES = 200_000;
/** What a hunk adds to its patch when the host delivers it: its file's first line and a blank line. */
const HUNK_OVERHEAD_BYTES = 512;
/** The budget a shard's delivery gets: its packing budget plus the room the estimate above may fall short by. */
export const SHARD_DELIVERY_BYTES = MAX_SHARD_BYTES + 64 * 1024;

/** A shard still being filled. */
interface OpenShard extends DiffShard {
	bytes: number;
}

function statLine(file: ReviewEngineChangedFile): string {
	const name = file.previousPath === undefined ? file.path : `${file.previousPath} -> ${file.path}`;
	const counts = ` | +${file.additions ?? 0} -${file.deletions ?? 0}`;
	return file.reviewable ? ` ${name}${counts}` : ` ${name}${counts} (diff not shown: ${file.unsupportedReason ?? "not reviewable"})`;
}

/**
 * Packs the hunks of the reviewable files in order into shards, each of at most {@link MAX_SHARD_BYTES} of patch.
 * The host delivers a hunk whole or not at all, so a hunk larger than a shard gets a shard of its own and its file
 * is marked partial: its diff text is not in the prompt, and reviewers page it.
 */
export function packShards(
	files: readonly ReviewEngineChangedFile[],
): { shards: DiffShard[]; fileHunks: Map<string, string[]>; hunkBytes: Map<string, number> } {
	const shards: OpenShard[] = [];
	const fileHunks = new Map<string, string[]>();
	const hunkBytes = new Map<string, number>();
	let current: OpenShard | undefined;
	for (const file of files) {
		const ids: string[] = [];
		for (const hunk of file.hunks) {
			const size = hunk.patchBytes + HUNK_OVERHEAD_BYTES;
			if (!current || (current.bytes > 0 && current.bytes + size > MAX_SHARD_BYTES)) {
				current = { index: shards.length, files: [], hunkIds: [], partialFiles: [], bytes: 0 };
				shards.push(current);
			}
			if (!current.files.includes(file.path)) current.files.push(file.path);
			if (size > MAX_SHARD_BYTES && !current.partialFiles.includes(file.path)) current.partialFiles.push(file.path);
			current.hunkIds.push(hunk.id);
			current.bytes += size;
			ids.push(hunk.id);
			hunkBytes.set(hunk.id, hunk.patchBytes);
		}
		fileHunks.set(file.path, ids);
	}
	return { shards: shards.map(({ bytes: _bytes, ...shard }) => shard), fileHunks, hunkBytes };
}

/**
 * Swarm's view of the change the host resolved: its shards of hunks, a checkout of the reviewed head to work in, and
 * the base-file reader. Returns a user-facing message when there is nothing to review.
 */
export async function buildTarget(engine: ReviewEngineContext, signal: AbortSignal): Promise<ReviewTarget | string> {
	const repository = await repositoryOf(engine.cwd, signal);
	if (!repository) return "Swarm review needs a Git repository.";
	const files = engine.changedFiles().filter((file) => file.inScope);
	const reviewable = files.filter((file) => file.reviewable && file.hunks.length > 0);
	if (reviewable.length === 0) {
		return `No reviewable changes in ${engine.target.description}${engine.target.controls.scope.length > 0 ? " match the scope" : ""}.`;
	}
	const { shards, fileHunks, hunkBytes } = packShards(reviewable);
	const createCheckout = async (): Promise<string> => {
		const checkout = await engine.checkout();
		await linkDependencies(checkout, repository.repoRoot, signal);
		return checkout;
	};
	return {
		repoRoot: repository.repoRoot,
		checkout: await createCheckout(),
		description: engine.target.description,
		stat: files.map(statLine).join("\n"),
		scope: engine.target.controls.scope,
		shards,
		fileHunks,
		hunkBytes,
		complete: shards.length === 1 && shards[0]?.partialFiles.length === 0,
		submodules: files.some((file) => file.unsupportedReason?.startsWith("Submodule") === true),
		commonDir: repository.commonDir,
		readBase: createBaseReader(engine),
		createCheckout,
	};
}
