import { join } from "node:path";
import type { Checkout } from "../../../../.volt/extensions/swarm-review/types.ts";
import { reviewPathToUtf8 } from "../../src/core/review-path.ts";

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
			// As the host's does, this throws for a string that is not a canonical reference.
			const native = reviewPathToUtf8(reference);
			return native === undefined || unrepresented.includes(reference)
				? undefined
				: join(path, ...native.split("/"));
		},
	};
}
