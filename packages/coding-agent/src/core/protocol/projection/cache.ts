/**
 * The projection cache: the projected entries of one conversation's log, by
 * projection and entry id. A projected entry is a pure function of the log
 * before it, the projection, and the presenter set (RFC §4.3), so it is kept
 * while the presenter set's generation and the entry's presenter stay the
 * same, and every subscriber of a projection (every phone that redacts
 * alike) reads the same one. Each projection keeps at most
 * {@link PROJECTION_CACHE_MAX_ENTRIES} entries and
 * {@link PROJECTION_CACHE_MAX_BYTES} of what projecting made, the least
 * recently used evicted first.
 */

import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { serializedBytes } from "../../ui/presentation.ts";
import type { Projection } from "../profiles.ts";

/** Most projected entries one projection keeps cached in one conversation. */
const PROJECTION_CACHE_MAX_ENTRIES = 4_096;
/** Most bytes of projected entries one projection keeps cached in one conversation. */
const PROJECTION_CACHE_MAX_BYTES = 8 * 1024 * 1024;

interface Cached {
	readonly generation: number;
	readonly presenter: unknown;
	readonly value: ProjectedEntry;
	readonly bytes: number;
}

interface ProjectionEntries {
	readonly entries: Map<string, Cached>;
	bytes: number;
}

/**
 * The serialized bytes a projected entry holds of its own: on a full
 * projection only its view, as its payload is the log's, held by reference.
 */
function retainedBytes(entry: ProjectedEntry, projection: Projection): number {
	if (projection.fidelity !== "full") return serializedBytes(entry);
	return "view" in entry && entry.view !== undefined ? serializedBytes(entry.view) : 0;
}

/** Projected entries by projection and entry id, the least recently used evicted first. */
export class ProjectionCache {
	private readonly byProjection = new WeakMap<Projection, ProjectionEntries>();

	/**
	 * The projection of entry `id` for `projection`: the cached one while the
	 * presenter set's `generation` and the entry's `presenter` are the same,
	 * else `compute()`'s.
	 */
	resolve(
		projection: Projection,
		id: string,
		generation: number,
		presenter: unknown,
		compute: () => ProjectedEntry,
	): ProjectedEntry {
		let cache = this.byProjection.get(projection);
		const cached = cache?.entries.get(id);
		if (cache && cached && cached.generation === generation && cached.presenter === presenter) {
			cache.entries.delete(id);
			cache.entries.set(id, cached);
			return cached.value;
		}
		const value = compute();
		if (!cache) {
			cache = { entries: new Map(), bytes: 0 };
			this.byProjection.set(projection, cache);
		}
		if (cached) {
			cache.bytes -= cached.bytes;
			cache.entries.delete(id);
		}
		const bytes = retainedBytes(value, projection);
		cache.entries.set(id, { generation, presenter, value, bytes });
		cache.bytes += bytes;
		for (const [oldest, entry] of cache.entries) {
			if (cache.entries.size <= PROJECTION_CACHE_MAX_ENTRIES && cache.bytes <= PROJECTION_CACHE_MAX_BYTES) break;
			cache.entries.delete(oldest);
			cache.bytes -= entry.bytes;
		}
		return value;
	}
}
