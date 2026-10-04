/**
 * The host's queries (RFC §6.1): catalogs and reads of what is not in a
 * conversation log. Every wire that reads one goes through {@link queryRegistry}.
 */

import { BUILTIN_QUERIES } from "./definitions.ts";
import { QueryRegistry } from "./registry.ts";

export { BUILTIN_QUERIES, projectReviewRun, projectSubscriptionUsageReport } from "./definitions.ts";
export type { BuiltinQueryDefinitions } from "./registry.ts";
export { QueryRegistry } from "./registry.ts";
export * from "./types.ts";

/** The registry of queries every host serves. */
export const queryRegistry = new QueryRegistry(() => BUILTIN_QUERIES);
