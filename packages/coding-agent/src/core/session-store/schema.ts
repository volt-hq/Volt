export const SESSION_STORE_SCHEMA_ID = "volt-session-store-v5";

export const SESSION_STORE_TABLE_NAMES = [
	"store_metadata",
	"sessions",
	"entries",
	"client_inputs",
	"search_chunks",
	"transaction_commits",
	"review_run_index",
	"review_discussion_index",
] as const;

export const SESSION_STORE_INDEX_NAMES = [
	"sessions_visible_updated_idx",
	"entries_parent_idx",
	"entries_type_idx",
	"client_inputs_state_idx",
	"search_chunks_entry_idx",
	"transaction_commits_session_ordinal_idx",
	"review_run_index_session_idx",
	"review_discussion_index_finding_idx",
	"review_discussion_index_session_idx",
] as const;

/** Commit evidence fenced on the session's last entry ordinal. Every commit appends at least one entry. */
export const SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL = `
CREATE TABLE transaction_commits (
	commit_id TEXT PRIMARY KEY NOT NULL CHECK (length(commit_id) BETWEEN 1 AND 512),
	session_id TEXT NOT NULL,
	session_generation TEXT NOT NULL CHECK (length(session_generation) BETWEEN 1 AND 512),
	digest TEXT NOT NULL CHECK (
		length(digest) = 71 AND
		substr(digest, 1, 7) = 'sha256:' AND
		substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
	),
	before_ordinal INTEGER NOT NULL CHECK (before_ordinal >= 0),
	after_ordinal INTEGER NOT NULL CHECK (after_ordinal > before_ordinal),
	committed_at TEXT NOT NULL,
	FOREIGN KEY (session_id, session_generation) REFERENCES sessions(id, session_generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX transaction_commits_session_ordinal_idx
	ON transaction_commits (session_id, session_generation, after_ordinal DESC);
`;

/**
 * One row per client input receipt, updated as the input moves through its
 * lifecycle. `origin` is the receipt's; a withdrawn input is terminal.
 */
export const SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL = `
CREATE TABLE client_inputs (
	session_id TEXT NOT NULL,
	client_message_id TEXT NOT NULL CHECK (length(client_message_id) BETWEEN 1 AND 512),
	receipt_entry_id TEXT NOT NULL,
	command TEXT NOT NULL CHECK (command IN ('prompt', 'steer', 'follow_up')),
	origin TEXT CHECK (origin IS NULL OR origin = 'host'),
	semantic_digest TEXT NOT NULL CHECK (length(semantic_digest) >= 1),
	input_json TEXT NOT NULL CHECK (json_valid(input_json) = 1),
	queued_entry_id TEXT,
	queued_input_json TEXT CHECK (queued_input_json IS NULL OR json_valid(queued_input_json) = 1),
	state TEXT NOT NULL CHECK (state IN ('accepted', 'started', 'completed', 'failed', 'withdrawn')),
	error TEXT,
	canonical_entry_id TEXT,
	PRIMARY KEY (session_id, client_message_id),
	CHECK ((queued_entry_id IS NULL) = (queued_input_json IS NULL)),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, receipt_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (session_id, queued_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED,
	FOREIGN KEY (session_id, canonical_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX client_inputs_state_idx ON client_inputs (session_id, state, client_message_id);
`;

/**
 * Derived indexes of the review records in the logs (RFC §14 Q7), maintained
 * by the store as it commits them: the conversation that anchors each review
 * run (its `work_started` of review work) and the run's current General (the
 * source until its latest `review_general`), and each discussion child a
 * source records (`review_discussion` and `review_discussion_reset`). They answer
 * lookups across sessions and enforce how logs may relate; they grant no
 * write authority, and a row leaves with the log it derives from.
 */
export const SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL = `
CREATE TABLE review_run_index (
	run_id TEXT PRIMARY KEY NOT NULL CHECK (length(run_id) BETWEEN 1 AND 512),
	session_id TEXT NOT NULL,
	session_generation TEXT NOT NULL,
	general_session_id TEXT NOT NULL CHECK (length(general_session_id) BETWEEN 1 AND 512),
	general_session_generation TEXT NOT NULL CHECK (length(general_session_generation) BETWEEN 1 AND 512),
	FOREIGN KEY (session_id, session_generation) REFERENCES sessions(id, session_generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE INDEX review_run_index_session_idx ON review_run_index (session_id, session_generation);

CREATE TABLE review_discussion_index (
	discussion_id TEXT NOT NULL CHECK (length(discussion_id) BETWEEN 1 AND 512),
	ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
	run_id TEXT NOT NULL,
	finding_id TEXT NOT NULL CHECK (length(finding_id) BETWEEN 1 AND 512),
	session_id TEXT NOT NULL,
	session_generation TEXT NOT NULL,
	child_session_id TEXT NOT NULL CHECK (length(child_session_id) BETWEEN 1 AND 512),
	child_session_generation TEXT NOT NULL CHECK (length(child_session_generation) BETWEEN 1 AND 512),
	request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 512),
	PRIMARY KEY (discussion_id, ordinal),
	UNIQUE (child_session_id, child_session_generation),
	UNIQUE (discussion_id, request_id),
	FOREIGN KEY (run_id) REFERENCES review_run_index(run_id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, session_generation) REFERENCES sessions(id, session_generation) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX review_discussion_index_finding_idx ON review_discussion_index (run_id, finding_id) WHERE ordinal = 1;
CREATE INDEX review_discussion_index_session_idx ON review_discussion_index (session_id, session_generation);
`;

/** Every table but the review indexes: unchanged since v4. */
export const SESSION_STORE_BASE_SCHEMA_SQL = `
CREATE TABLE store_metadata (
	key TEXT PRIMARY KEY NOT NULL,
	value_json TEXT NOT NULL CHECK (json_valid(value_json) = 1)
) STRICT, WITHOUT ROWID;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 512),
	session_generation TEXT NOT NULL CHECK (length(session_generation) BETWEEN 1 AND 512),
	format_version INTEGER NOT NULL CHECK (format_version >= 1),
	cwd TEXT NOT NULL CHECK (length(cwd) >= 1),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	parent_session_directory TEXT CHECK (parent_session_directory IS NULL OR length(parent_session_directory) >= 1),
	parent_store_id TEXT CHECK (parent_store_id IS NULL OR length(parent_store_id) BETWEEN 1 AND 512),
	parent_session_id TEXT CHECK (parent_session_id IS NULL OR length(parent_session_id) BETWEEN 1 AND 512),
	parent_session_generation TEXT CHECK (
		parent_session_generation IS NULL OR length(parent_session_generation) BETWEEN 1 AND 512
	),
	origin TEXT CHECK (origin IS NULL OR origin = 'subagent'),
	starting_git_context_recorded INTEGER NOT NULL DEFAULT 0 CHECK (starting_git_context_recorded IN (0, 1)),
	starting_git_context_json TEXT CHECK (
		starting_git_context_json IS NULL OR json_valid(starting_git_context_json) = 1
	),
	name TEXT,
	visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
	leaf_entry_id TEXT,
	message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
	first_message TEXT NOT NULL DEFAULT '',
	UNIQUE (id, session_generation),
	CHECK (
		(parent_session_directory IS NULL AND parent_store_id IS NULL AND parent_session_id IS NULL AND parent_session_generation IS NULL)
		OR
		(parent_session_directory IS NOT NULL AND parent_store_id IS NOT NULL AND parent_session_id IS NOT NULL AND parent_session_generation IS NOT NULL)
	),
	CHECK (starting_git_context_recorded = 1 OR starting_git_context_json IS NULL)
) STRICT;

CREATE TRIGGER sessions_generation_immutable
	BEFORE UPDATE OF session_generation ON sessions
	WHEN OLD.session_generation <> NEW.session_generation
BEGIN
	SELECT RAISE(ABORT, 'session_generation is immutable');
END;

CREATE INDEX sessions_visible_updated_idx ON sessions (visible, updated_at DESC, id);

CREATE TABLE entries (
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL CHECK (length(entry_id) BETWEEN 1 AND 512),
	ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
	parent_entry_id TEXT,
	entry_type TEXT NOT NULL CHECK (length(entry_type) >= 1),
	timestamp TEXT NOT NULL,
	is_host_only INTEGER NOT NULL CHECK (is_host_only IN (0, 1)),
	payload_json TEXT NOT NULL CHECK (json_valid(payload_json) = 1),
	PRIMARY KEY (session_id, entry_id),
	UNIQUE (session_id, ordinal),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, parent_entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX entries_parent_idx ON entries (session_id, parent_entry_id);
CREATE INDEX entries_type_idx ON entries (session_id, entry_type, ordinal);

${SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL}
CREATE TABLE search_chunks (
	session_id TEXT NOT NULL,
	chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
	entry_id TEXT,
	text TEXT NOT NULL,
	PRIMARY KEY (session_id, chunk_index),
	FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
	FOREIGN KEY (session_id, entry_id) REFERENCES entries(session_id, entry_id)
		DEFERRABLE INITIALLY DEFERRED
) STRICT, WITHOUT ROWID;

CREATE INDEX search_chunks_entry_idx ON search_chunks (session_id, entry_id);

${SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL}`;

export const SESSION_STORE_SCHEMA_SQL = `${SESSION_STORE_BASE_SCHEMA_SQL}${SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL}`;
