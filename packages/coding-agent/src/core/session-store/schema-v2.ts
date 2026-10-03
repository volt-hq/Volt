import { REVIEW_DISCUSSION_SCHEMA_SQL } from "./discussion-schema.ts";
import { SESSION_STORE_V1_SCHEMA_SQL } from "./schema-v1.ts";

// Exact v2 DDL: v1 plus the review discussion tables. Used only to validate the supported upgrade.
export const SESSION_STORE_V2_SCHEMA_ID = "volt-session-store-v2";

export const SESSION_STORE_V2_SCHEMA_SQL = `${SESSION_STORE_V1_SCHEMA_SQL}${REVIEW_DISCUSSION_SCHEMA_SQL}`;
