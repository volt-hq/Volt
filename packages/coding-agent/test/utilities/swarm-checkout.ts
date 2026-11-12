import { join } from "node:path";
import type { Checkout } from "../../../../.volt/extensions/swarm-review/types.ts";
import { normalizeReviewPath, reviewPathToUtf8 } from "../../src/core/review-path.ts";

/**
 * A checkout handle over a plain directory, for tests of the swarm's tools that need no snapshot. A reference is
 * served at the file its name decodes to. Those in `unrepresented` are not: they stand for what a real checkout
 * cannot serve, such as the second of two names that differ only in case.
 */
export function directoryCheckout(path: string, unrepresented: readonly string[] = []): Checkout {
	return {
		path,
		unrepresented,
		nativePath: (reference) => {
			const normalized = normalizeReviewPath(reference);
			const native = reviewPathToUtf8(normalized);
			return native === undefined || unrepresented.includes(normalized)
				? undefined
				: join(path, ...native.split("/"));
		},
	};
}
