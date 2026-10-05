import { SESSION_STORE_BASE_SCHEMA_SQL } from "./schema.ts";
import { SESSION_STORE_V2_REVIEW_SCHEMA_SQL } from "./schema-v2.ts";

// Exact v4 DDL: the v5 tables with the review tables v5 dropped in place of its review indexes.
// Used only to validate the supported upgrade.
export const SESSION_STORE_V4_SCHEMA_ID = "volt-session-store-v4";

export const SESSION_STORE_V4_SCHEMA_SQL = `${SESSION_STORE_BASE_SCHEMA_SQL}${SESSION_STORE_V2_REVIEW_SCHEMA_SQL}`;
