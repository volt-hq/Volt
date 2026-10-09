import { SESSION_STORE_BASE_SCHEMA_SQL, SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL } from "./schema.ts";

// Exact v5 DDL: the v6 tables without the session cwd index v6 added.
// Used only to validate the supported upgrade.
export const SESSION_STORE_V5_SCHEMA_ID = "volt-session-store-v5";

export const SESSION_STORE_V5_SCHEMA_SQL = `${SESSION_STORE_BASE_SCHEMA_SQL}${SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL}`;
