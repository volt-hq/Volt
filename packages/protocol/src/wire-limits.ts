/**
 * The numeric bounds and grammars of the wire contract, in one
 * dependency-free module.
 *
 * Everything here is contract, not tuning: clients (volt-app mirrors these in
 * VoltRPCConversationInputLimits / VoltRPCConversationProjectionLimits and its
 * JSONL codec) and the exported JSON Schema artifact both derive from these
 * values. Behavioral knobs that clients never observe stay in their own
 * modules.
 */

// ============================================================================
// Identifiers
// ============================================================================

/** UTF-8 budget for client- and host-chosen identifiers (subscription, intent, query, job, workflow, request ids). */
export const RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES = 256;

/**
 * Grammar for durable client-supplied message identities (`clientMessageId`).
 * The pattern is anchored by consumers; it admits 1–256 ASCII characters and
 * already excludes whitespace, so byte and character budgets coincide.
 */
export const RPC_CLIENT_MESSAGE_ID_MAX_CHARS = 256;
export const RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE = "[A-Za-z0-9][A-Za-z0-9._:-]{0,255}";
/** Runtime-only queue identities use this reserved namespace; it is never valid at client ingress. */
export const RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX = "local-queue:";
/**
 * Self-contained JSON Schema `pattern` for `clientMessageId`: the grammar plus
 * the reserved-prefix exclusion. Kept equivalent to `isValidClientMessageId`.
 */
export const RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN = `^(?!${RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX})${RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE}$`;

// ============================================================================
// Conversation input (prompt / steer / follow_up)
// ============================================================================

export const RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES = 512 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_IMAGES = 8;
export const RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES = 256;
export const RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES = 1024 * 1024;
export const RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES = 1536 * 1024;
export const RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;

/** The host-side recoverable client-input queue depth (`CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES`). */
export const RPC_SESSION_QUEUE_MAX_ITEMS = 128;

// ============================================================================
// Git context
// ============================================================================

export const RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS = 256;
export const RPC_GIT_CONTEXT_REF_MAX_CHARS = 1024;
export const RPC_GIT_CONTEXT_OID_MAX_CHARS = 64;
export const RPC_GIT_CONTEXT_OID_PATTERN = "^(?:[0-9a-f]{40}|[0-9a-f]{64})$";
export const RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS = 32;

// ============================================================================
// Change association
// ============================================================================

export const RPC_CHANGE_ID_MAX_CHARS = 128;
export const RPC_CHANGE_REPOSITORY_MAX_CHARS = 256;
export const RPC_CHANGE_BRANCH_MAX_CHARS = 1024;
export const RPC_CHANGE_PROVIDER_MAX_CHARS = 64;
export const RPC_CHANGE_PULL_REQUEST_TITLE_MAX_CHARS = 512;

// ============================================================================
// Remote profile bounds
// ============================================================================

/** Live-lane bytes a remote connection may queue before the host drops them and resets the lane. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
/** Assistant text and thinking bytes one streamed message carries on the remote profile. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES = 256 * 1024;
/** Bytes of a streaming assistant message a remote live reset carries. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES = 384 * 1024;
/** Serialized bytes of a tool call's arguments on the remote profile. */
export const RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES = 12 * 1024;
/**
 * Scalar cap on one remote transcript item's text and on one `content` chunk.
 * Clients page a truncated entry's text in chunks of this size.
 */
export const IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS = 12_000;

// ============================================================================
// JSONL framing
// ============================================================================

/** Mirrored by volt-app's JSONLLineDecoder.maximumEncodedLineBytes. */
export const DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES = 4 * 1024 * 1024;
/** JSON content bytes before the required LF framing byte. */
export const DEFAULT_IROH_RPC_MAX_LINE_BYTES = DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES - 1;

// ============================================================================
// Numeric wire domain
// ============================================================================

/** Every integral wire field fits the JSON/JavaScript safe-integer domain shared with native clients. */
export const RPC_WIRE_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * Upper bound of the `retryAfterMs` domain clients honor before treating a
 * backoff hint as invalid. Enforced client-side; the host currently emits
 * 500/1000 ms hints well inside it.
 */
export const RPC_RETRY_AFTER_MS_MAX = 30_000;
