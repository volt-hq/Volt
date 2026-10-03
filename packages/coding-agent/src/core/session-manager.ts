import {
	type AgentMessage,
	CONVERSATION_LOG_READ_LIMIT_MAX,
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogEntryDraft,
	type ConversationLogLossReason,
	ConversationLogLostError,
	type ConversationState,
	fold,
	InMemoryConversationLog,
	uuidv7,
} from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import {
	type BranchSummaryEntryPayload,
	type ClientInputQueuedEntryPayload,
	type ClientInputReceiptEntryPayload,
	type ClientInputStateEntryPayload,
	type CompactionEntryPayload,
	type CustomEntryPayload,
	type CustomMessageEntryPayload,
	type FastModeChangeEntryPayload,
	type LabelEntryPayload,
	type LeafEntryPayload,
	type ModelChangeEntryPayload,
	type PlanningStateChangeEntryPayload,
	type ClientInputCommand as ProtocolClientInputCommand,
	type ClientInputPayload as ProtocolClientInputPayload,
	type ClientInputQueuedDelivery as ProtocolClientInputQueuedDelivery,
	type ClientInputQueuedPayload as ProtocolClientInputQueuedPayload,
	type ClientInputState as ProtocolClientInputState,
	RpcGitContextSchema,
	type SessionInfoEntryPayload,
	type SubagentSpawnEntryPayload,
	type ThinkingLevelChangeEntryPayload,
} from "@hansjm10/volt-protocol";
import { randomUUID } from "crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "fs";
import { readdir } from "fs/promises";
import { basename, join } from "path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { TextDecoder } from "util";
import { getAgentDir as getDefaultAgentDir, getSessionsDir } from "../config.ts";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-write.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	ensurePrivateDirectorySync,
	hardenPrivateRegularFileSync,
	PRIVATE_DIRECTORY_MODE,
	PRIVATE_FILE_MODE,
} from "../utils/private-files.ts";
import { cloneCanonicalData } from "./canonical-data.ts";
import { ConversationLock } from "./conversation-log/conversation-lock.ts";
import { toLogEntry, toLogEntryDraft, toSessionEntry } from "./conversation-log/entry-codec.ts";
import { SqliteConversationLog } from "./conversation-log/sqlite-conversation-log.ts";
import type { PrReviewPlacement } from "./pr-review-placement.ts";
import type { RpcGitContext } from "./rpc/types.ts";
import {
	decodeStoredSessionEntry,
	digestClientInputPayload,
	isHostOnlySessionEntryType,
	isValidClientMessageId,
	isValidSessionId,
	normalizeClientInputPayload,
	parseSessionEntryForAdmission,
	parseSessionReference,
	parseSessionSnapshotHeader,
	SESSION_ID_MAX_CHARACTERS,
	validatePersistedSessionEntrySequence,
	validateSessionEntryAdmissionReferences,
} from "./session-entry-codec.ts";
import type { PRODUCT_SESSION_ENTRY_TYPES } from "./session-entry-types.ts";
import {
	acquireSharedSQLiteSessionStore,
	SESSION_STORE_DATABASE_FILENAME,
	SESSION_STORE_READ_ENTRIES_MAX,
	type SessionStoreReviewDiscussionLookup,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "./session-store/index.ts";
import {
	applySessionEntry,
	CLIENT_INPUT_MAX_OUTSTANDING_BYTES,
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	cloneClientInputRecord,
	cloneSessionDerivedState,
	summarizeSessionEntries as reduceSessionEntries,
	replaySessionEntries,
	requireStartedClientInputReceipt,
	type SessionDerivedState,
	sessionEntrySummary,
	verifySessionStoreProjections,
} from "./session-store/projection.ts";
import { LogWriter } from "./session-writer.ts";

function deepFreezeCanonicalData<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value as Record<string, unknown>)) deepFreezeCanonicalData(nested);
		Object.freeze(value);
	}
	return value;
}

export const CURRENT_SESSION_VERSION = 5;
export const CURRENT_SESSION_SNAPSHOT_VERSION = 1;

export interface SessionReference {
	readonly sessionDirectory: string;
	readonly storeId: string;
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: SessionReference;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
}

export interface SessionSnapshotHeader {
	type: "session";
	version: number;
	snapshotVersion: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSessionDirectory?: string;
	parentStoreId?: string;
	parentSessionId?: string;
	parentSessionGeneration?: string;
	origin?: SessionOrigin;
}

/** How a session came to exist. Absent means a user-initiated session. */
export type SessionOrigin = "subagent";

export type SessionAtomicAppendEffect = "rolled_back";

/**
 * A commit that definitely did not happen: the log rolled it back, or an atomic
 * batch failed validation. The log and the manager are unchanged and the
 * manager stays writable. A commit that cannot be confirmed instead loses the
 * log and throws `ConversationLogLostError`.
 */
export class SessionAtomicAppendError extends Error {
	readonly effect: SessionAtomicAppendEffect;

	constructor(message: string, effect: SessionAtomicAppendEffect, options?: ErrorOptions) {
		super(message, options);
		this.name = "SessionAtomicAppendError";
		this.effect = effect;
	}
}

export interface NewSessionOptions {
	id?: string;
	parentSession?: SessionReference;
	origin?: SessionOrigin;
}

/**
 * The stored form of a protocol log entry (@hansjm10/volt-protocol): the
 * envelope fields flattened beside the payload fields. `visibility` is not
 * stored; it is fixed per entry type.
 */
export interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	/** Contiguous log position assigned at append; listeners and readers always receive it. */
	ordinal?: number;
}

export interface SessionMessageEntry extends SessionEntryBase {
	type: "message";
	/**
	 * The stored message. Typed as the runtime's open message union; the log
	 * stores the protocol's message roles. A user message never carries its
	 * client input identity here.
	 */
	message: AgentMessage;
	/** Client input identity of a client-submitted user message, stored beside the message. */
	clientMessageId?: string;
}

export type ClientInputCommand = ProtocolClientInputCommand;
export type ClientInputState = ProtocolClientInputState;
export type ClientInputStreamingBehavior = NonNullable<ProtocolClientInputPayload["streamingBehavior"]>;
export type ClientInputQueuedDelivery = ProtocolClientInputQueuedDelivery;
export type ClientInputPayload = ProtocolClientInputPayload;

export interface ClientInputPayloadInput {
	message: string;
	images?: readonly ImageContent[];
	streamingBehavior?: ClientInputStreamingBehavior;
}

export type ClientInputQueuedPayload = ProtocolClientInputQueuedPayload;

/**
 * Durable idempotency reservation for one client-originated conversation input.
 * This is host metadata only: it never enters model context or transcript projection.
 *
 * An accepted receipt retains the exact retryable input. Queued delivery is
 * persisted separately after abortable transforms and before the in-memory
 * queue is mutated. A `started` receipt with no terminal record is deliberately
 * ambiguous and must never be replayed automatically. Canonical identified
 * user-message commits imply `completed`; handled non-message inputs append an
 * explicit terminal.
 */
export interface ClientInputReceiptEntry extends SessionEntryBase, ClientInputReceiptEntryPayload {
	type: "client_input_receipt";
}

/** Exact post-preflight queue intent, durable before queue admission is acknowledged. */
export interface ClientInputQueuedEntry extends SessionEntryBase, ClientInputQueuedEntryPayload {
	type: "client_input_queued";
}

/** Append-only state transition for a client input receipt. */
export interface ClientInputStateEntry extends SessionEntryBase, ClientInputStateEntryPayload {
	type: "client_input_state";
}

export interface ClientInputRecord {
	receiptId: string;
	clientMessageId: string;
	command: ClientInputCommand;
	/** `host` on input the host submitted itself; client input has no origin. */
	origin?: "host";
	semanticDigest: string;
	input: ClientInputPayload;
	queuedEntryId?: string;
	queuedInput?: ClientInputQueuedPayload;
	state: ClientInputState;
	error?: string;
	/** Canonical identified user entry that completed this input, when applicable. */
	canonicalEntryId?: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase, ThinkingLevelChangeEntryPayload {
	type: "thinking_level_change";
}

export interface FastModeChangeEntry extends SessionEntryBase, FastModeChangeEntryPayload {
	type: "fast_mode_change";
}

export interface ModelChangeEntry extends SessionEntryBase, ModelChangeEntryPayload {
	type: "model_change";
}

/** Complete branch-local Plan mode snapshot. */
export interface PlanningStateChangeEntry extends SessionEntryBase, PlanningStateChangeEntryPayload {
	type: "planning_state_change";
}

/** `details` is extension-specific JSON (e.g. structured-compaction markers); `fromHook` marks extension summaries. */
export interface CompactionEntry extends SessionEntryBase, CompactionEntryPayload {
	type: "compaction";
}

/** `details` is extension-specific JSON that never reaches the model; `fromHook` marks extension summaries. */
export interface BranchSummaryEntry extends SessionEntryBase, BranchSummaryEntryPayload {
	type: "branch_summary";
}

/**
 * Custom entry for extensions to store extension-specific data in the session.
 * Use customType to identify your extension's entries.
 *
 * Purpose: Persist extension state across session reloads. On reload, extensions can
 * scan entries for their customType and reconstruct internal state.
 *
 * Does NOT participate in LLM context.
 * For injecting content into context, see CustomMessageEntry.
 */
export interface CustomEntry extends SessionEntryBase, CustomEntryPayload {
	type: "custom";
}

/** Label entry for user-defined bookmarks/markers on entries. */
export interface LabelEntry extends SessionEntryBase, LabelEntryPayload {
	type: "label";
}

/** Session metadata entry (e.g., user-defined display name). */
export interface SessionInfoEntry extends SessionEntryBase, SessionInfoEntryPayload {
	type: "session_info";
}

/**
 * First path-free Git observation for a newly created session. Host metadata
 * only: it never advances the conversation branch or enters model context.
 */
export interface SessionStartGitContextEntry
	extends SessionEntryBase,
		Static<typeof PRODUCT_SESSION_ENTRY_TYPES.session_start_git_context.payload> {
	type: "session_start_git_context";
}

/** Immutable host-owned PR checkout identity. Never imported, exported, or sent to the model. */
export interface PrReviewBindingEntry extends SessionEntryBase {
	type: "pr_review_binding";
	placement: PrReviewPlacement;
}

/** Durable host-only active-branch pointer. Never projected into conversation history. */
export interface LeafEntry extends SessionEntryBase, LeafEntryPayload {
	type: "leaf";
}

/**
 * Custom message entry for extensions to inject messages into LLM context.
 * Use customType to identify your extension's entries.
 *
 * Unlike CustomEntry, this DOES participate in LLM context: the conversation
 * fold turns it into a custom message of the branch context.
 * Use details for extension-specific metadata (not sent to LLM).
 *
 * display controls TUI rendering:
 * - false: hidden entirely
 * - true: rendered with distinct styling (different from user messages)
 */
export interface CustomMessageEntry extends SessionEntryBase, CustomMessageEntryPayload {
	type: "custom_message";
}

/**
 * Durable spawn edge for one subagent child started by a `subagent` tool call.
 * Host metadata only: never part of model context, branch navigation, forks, or
 * transcript projection. Appended at the two-phase publish commit point, so a
 * recorded edge always refers to a child whose first prompt was accepted.
 *
 * Edge state is derived, not stored: an edge is settled when its toolCallId
 * has a persisted toolResult produced by the tool itself. A missing result or
 * a dispose-time synthesized aborted result leaves the edge recoverable —
 * see docs/design/subagent-durable-spawn-graph.md §4. Registry hydration
 * reads these entries together with the named child transcripts to recover
 * results after a crash or runtime disposal (issue #129).
 */
export interface SubagentSpawnEntry extends SessionEntryBase, SubagentSpawnEntryPayload {
	type: "subagent_spawn";
}

/** Session entry - has id/parentId for tree structure (returned by "read" methods in SessionManager) */
export type SessionEntry =
	| SessionMessageEntry
	| ClientInputReceiptEntry
	| ClientInputQueuedEntry
	| ClientInputStateEntry
	| ThinkingLevelChangeEntry
	| FastModeChangeEntry
	| ModelChangeEntry
	| PlanningStateChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| SessionStartGitContextEntry
	| PrReviewBindingEntry
	| LeafEntry
	| SubagentSpawnEntry;

/** Host-only input admission WAL records. These never participate in the conversation branch or projection. */
export function isClientInputWalEntry(
	entry: FileEntry,
): entry is ClientInputReceiptEntry | ClientInputQueuedEntry | ClientInputStateEntry {
	return (
		entry.type === "client_input_receipt" ||
		entry.type === "client_input_queued" ||
		entry.type === "client_input_state"
	);
}

/**
 * Host-only sidecar records sharing the JSONL for crash recovery. They never
 * advance the branch leaf, never enter model context or transcript projection,
 * and never copy into forks.
 */
export function isHostOnlySessionEntry(entry: FileEntry): boolean {
	return isHostOnlySessionEntryType(entry.type);
}

export {
	CLIENT_INPUT_MAX_OUTSTANDING_BYTES,
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	isValidClientMessageId,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createClientInputSemanticDigest(command: ClientInputCommand, input: ClientInputPayloadInput): string {
	return digestClientInputPayload(command, normalizeClientInputPayload(command, input));
}

/** An entry with its log position, as delivered to listeners and returned by readEntries(). */
export type CommittedSessionEntry = SessionEntry & { ordinal: number };

export type SessionEntryListener = (entry: CommittedSessionEntry) => void;

/** One ordinal-ordered page of committed entries, host-only records included. */
export interface SessionEntryPage {
	readonly entries: CommittedSessionEntry[];
	/** Ordinal of the newest committed entry in this session's log. */
	readonly lastOrdinal: number;
}

export interface SessionBranchChange {
	previousLeafId: string | null;
	nextLeafId: string | null;
}

export interface SessionBranchWindowOptions {
	/** Exclude this entry and begin at its parent; omit to begin at the active leaf. */
	beforeEntryId?: string;
	/** Newest branch entries returned in chronological order. */
	maxEntries: number;
	/** Older context returned separately for bounded correlation lookups. */
	lookbackEntries?: number;
}

export interface SessionBranchWindow {
	entries: SessionEntry[];
	lookback: SessionEntry[];
	hasEarlier: boolean;
	/** Number of branch entries visited, excluding the one bounded earlier-existence probe. */
	visitedEntries: number;
}

export type SessionBranchListener = (change: SessionBranchChange) => void;

/** Raw file entry (includes header) */
export type FileEntry = SessionHeader | SessionEntry;

/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
	/** Timestamp of the latest label change for this entry, if any */
	labelTimestamp?: string;
}

export interface SessionInfo {
	ref: SessionReference;
	id: string;
	/** Working directory where the session was started. Empty string for old sessions. */
	cwd: string;
	/** User-defined display name from session_info entries. */
	name?: string;
	parentSessionRef?: SessionReference;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: SessionOrigin;
	/** First host-observed path-free Git state for this session. */
	startingGitContext?: RpcGitContext | null;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
}

function sessionReference(
	sessionDirectory: string,
	storeId: string,
	sessionId: string,
	sessionGeneration: string,
): SessionReference {
	return Object.freeze({ sessionDirectory, storeId, sessionId, sessionGeneration });
}

function sessionInfoFromStoreSummary(
	sessionDirectory: string,
	storeId: string,
	summary: SessionStoreSessionSummary,
): SessionInfo {
	let startingGitContext: RpcGitContext | null | undefined;
	if (summary.startingGitContextRecorded) {
		if (!Check(Type.Union([RpcGitContextSchema, Type.Null()]), summary.startingGitContext)) {
			throw new Error(`Session ${summary.id} has invalid starting Git context metadata`);
		}
		startingGitContext = summary.startingGitContext;
	}
	return {
		ref: sessionReference(sessionDirectory, storeId, summary.id, summary.sessionGeneration),
		id: summary.id,
		cwd: summary.cwd,
		...(summary.name === null ? {} : { name: summary.name }),
		...(summary.parentSessionId === null || summary.parentStoreId === null
			? {}
			: {
					parentSessionRef: sessionReference(
						summary.parentSessionDirectory!,
						summary.parentStoreId,
						summary.parentSessionId,
						summary.parentSessionGeneration!,
					),
				}),
		...(summary.origin === null ? {} : { origin: summary.origin }),
		...(startingGitContext === undefined ? {} : { startingGitContext }),
		created: new Date(summary.createdAt),
		modified: new Date(summary.updatedAt),
		messageCount: summary.messageCount,
		firstMessage: summary.firstMessage || "(no messages)",
	};
}

interface SessionSummaryLookupResult {
	directory: string;
	storeId: string;
	summary: SessionStoreSessionSummary;
}

async function findSessionSummaryById(
	sessionDir: string,
	sessionId: string,
): Promise<SessionSummaryLookupResult | undefined> {
	assertValidSessionId(sessionId);
	const directory = resolvePath(sessionDir);
	const lease = await acquireSharedSQLiteSessionStore(normalizePath(directory));
	let result: SessionSummaryLookupResult | undefined;
	try {
		const summary = await lease.client.findSessionSummaryById(sessionId);
		if (summary) result = { directory, storeId: lease.client.info.storeId, summary };
	} catch (error) {
		try {
			await lease.release();
		} catch (releaseError) {
			throw new AggregateError(
				[error, releaseError],
				"Exact session summary lookup failed and its store lease could not be released",
			);
		}
		throw error;
	}
	await lease.release();
	return result;
}

/** @internal Indexed summary lookup for CLI/runtime owners; not exported from the package entry point. */
export async function findSessionInfoById(sessionDir: string, sessionId: string): Promise<SessionInfo | undefined> {
	const result = await findSessionSummaryById(sessionDir, sessionId);
	return result ? sessionInfoFromStoreSummary(result.directory, result.storeId, result.summary) : undefined;
}

function storedEntryToSessionEntry(stored: SessionStoreSnapshot["entries"][number]): SessionEntry {
	return decodeStoredSessionEntry(stored);
}

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionRef"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "getBranchWindow"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!isValidSessionId(id)) {
		throw new Error(
			`Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', start and end with an alphanumeric character, and contain at most ${SESSION_ID_MAX_CHARACTERS} characters`,
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}

function withoutClientInputIdentity(entry: SessionEntry): SessionEntry {
	if (entry.type !== "message" || entry.clientMessageId === undefined) {
		return entry;
	}
	const { clientMessageId: _clientMessageId, ...withoutIdentity } = entry;
	return withoutIdentity;
}

export function createSessionSnapshotHeader(header: SessionHeader): SessionSnapshotHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
		id: header.id,
		timestamp: header.timestamp,
		cwd: header.cwd,
		...(header.parentSession === undefined
			? {}
			: {
					parentSessionDirectory: header.parentSession.sessionDirectory,
					parentStoreId: header.parentSession.storeId,
					parentSessionId: header.parentSession.sessionId,
					parentSessionGeneration: header.parentSession.sessionGeneration,
				}),
		...(header.origin === undefined ? {} : { origin: header.origin }),
	};
}

export function serializeSessionJsonlSnapshot(
	header: SessionHeader,
	entries: readonly SessionEntry[],
	leafId: string | null,
): string {
	const snapshotEntries = entries.map((entry, index) => ({
		...withoutClientInputIdentity(entry),
		ordinal: index + 1,
	}));
	const leaf: LeafEntry = {
		type: "leaf",
		id: generateId(new Set(snapshotEntries.map((entry) => entry.id))),
		parentId: snapshotEntries.at(-1)?.id ?? null,
		timestamp: new Date().toISOString(),
		targetId: leafId,
		ordinal: snapshotEntries.length + 1,
	};
	const snapshotHeader = parseSessionSnapshotHeader(
		createSessionSnapshotHeader(header),
		CURRENT_SESSION_VERSION,
		CURRENT_SESSION_SNAPSHOT_VERSION,
	);
	const validatedEntries = validatePersistedSessionEntrySequence([...snapshotEntries, leaf], { snapshot: true });
	return `${[snapshotHeader, ...validatedEntries].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** Exported for compaction tests and snapshot consumers. */
export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	return entries;
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/** Encode a cwd into the safe `--…--` session-directory name. */
function encodeSessionDirName(cwd: string): string {
	const resolvedCwd = resolvePath(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * True when a session directory is the default-shaped directory for a cwd
 * (under ANY agent dir). Such directories hold every session of that
 * workspace — including worktree-bound sessions whose header cwd differs —
 * so cwd filtering must not apply to them.
 */
function isDefaultShapedSessionDir(dir: string, cwd: string): boolean {
	return basename(dir) === encodeSessionDirName(cwd);
}

/**
 * Compute the default session directory for a cwd.
 * Encodes cwd into a safe directory name under ~/.volt/agent/sessions/.
 * Pure path computation; `getDefaultSessionDir` also creates and hardens the
 * directory. Exported for read-only daemon lookups that must not mutate it.
 */
export function getDefaultSessionDirPath(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	return join(resolvePath(agentDir), "sessions", encodeSessionDirName(cwd));
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const sessionDir = getDefaultSessionDirPath(cwd, agentDir);
	ensurePrivateDirectorySync(sessionDir);
	return sessionDir;
}

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? (parsed as unknown as FileEntry) : null;
	} catch {
		return null;
	}
}

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseSessionEntryBytes(bytes: Uint8Array): { entry: FileEntry | null; malformed: boolean } {
	let line: string;
	try {
		line = fatalUtf8Decoder.decode(bytes);
	} catch {
		return { entry: null, malformed: bytes.length > 0 };
	}
	// A newline commits the preceding record; an ordinary final line terminator
	// does not create an additional record in the byte reader.
	if (!line.trim()) return { entry: null, malformed: true };
	const entry = parseSessionEntryLine(line);
	return { entry, malformed: entry === null };
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	hardenPrivateRegularFileSync(resolvedFilePath);
	const entries: FileEntry[] = [];
	let malformedCompleteLine: number | undefined;
	let lineNumber = 0;
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const fd = openSync(resolvedFilePath, constants.O_RDONLY | noFollow);
	try {
		const fileStat = fstatSync(fd);
		if (!fileStat.isFile() || fileStat.nlink !== 1)
			throw new Error(`Session JSONL is not a private regular file: ${filePath}`);
		if (noFollow === 0) {
			const pathStat = lstatSync(resolvedFilePath);
			if (
				pathStat.isSymbolicLink() ||
				!pathStat.isFile() ||
				pathStat.dev !== fileStat.dev ||
				pathStat.ino !== fileStat.ino
			) {
				throw new Error(`Session JSONL path changed while opening: ${filePath}`);
			}
		}
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		const pendingChunks: Buffer[] = [];
		let pendingBytes = 0;
		const parseLine = (tail: Buffer): void => {
			const line = pendingBytes === 0 ? tail : Buffer.concat([...pendingChunks, tail], pendingBytes + tail.length);
			pendingChunks.splice(0);
			pendingBytes = 0;
			const parsed = parseSessionEntryBytes(line);
			if (parsed.entry) entries.push(parsed.entry);
			else if (parsed.malformed && malformedCompleteLine === undefined) malformedCompleteLine = lineNumber;
		};

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			let lineStart = 0;
			let newlineIndex = buffer.indexOf(0x0a, lineStart);
			while (newlineIndex !== -1 && newlineIndex < bytesRead) {
				lineNumber++;
				parseLine(buffer.subarray(lineStart, newlineIndex));
				lineStart = newlineIndex + 1;
				newlineIndex = buffer.indexOf(0x0a, lineStart);
			}
			if (lineStart < bytesRead) {
				const tail = Buffer.from(buffer.subarray(lineStart, bytesRead));
				pendingChunks.push(tail);
				pendingBytes += tail.length;
			}
		}

		// JSONL is explicit interchange, not a live append log. A non-empty
		// malformed final fragment is a truncated snapshot and must fail closed.
		if (pendingBytes > 0) {
			const finalLine = Buffer.concat(pendingChunks, pendingBytes);
			const parsed = parseSessionEntryBytes(finalLine);
			if (parsed.entry) entries.push(parsed.entry);
			else if (parsed.malformed && malformedCompleteLine === undefined) {
				malformedCompleteLine = lineNumber + 1;
			}
		}
	} finally {
		closeSync(fd);
	}

	if (malformedCompleteLine !== undefined) {
		throw new Error(`Session snapshot JSONL is malformed at committed line ${malformedCompleteLine}`);
	}
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {
		return [];
	}

	return entries;
}

export function assertCurrentSessionSnapshot(entries: FileEntry[]): SessionSnapshotHeader {
	const headerValue = entries[0];
	if (!headerValue || headerValue.type !== "session") {
		throw new Error("Session snapshot has no valid header");
	}
	if (entries.slice(1).some((entry) => entry.type === "session")) {
		throw new Error("Session snapshot contains more than one header");
	}
	if (headerValue.version !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session snapshot entry version must be ${CURRENT_SESSION_VERSION}`);
	}
	if (
		(headerValue as SessionHeader & { snapshotVersion?: number }).snapshotVersion !== CURRENT_SESSION_SNAPSHOT_VERSION
	) {
		throw new Error(`Session snapshot version must be ${CURRENT_SESSION_SNAPSHOT_VERSION}`);
	}
	for (const entry of entries.slice(1)) {
		if (entry.type !== "leaf" && isHostOnlySessionEntry(entry)) {
			throw new Error(`Session snapshot contains unsupported host-only entry: ${entry.type}`);
		}
	}
	const header = parseSessionSnapshotHeader(headerValue, CURRENT_SESSION_VERSION, CURRENT_SESSION_SNAPSHOT_VERSION);
	const sessionEntries = validatePersistedSessionEntrySequence(entries.slice(1), { snapshot: true });
	entries.splice(0, entries.length, header, ...sessionEntries);
	return header;
}

export interface SessionEntrySummary {
	messageCount: number;
	firstMessage: string;
	lastActivityTime?: number;
}

export function summarizeSessionEntries(entries: Iterable<SessionEntry>): SessionEntrySummary {
	return reduceSessionEntries(entries);
}

export type SessionListProgress = (loaded: number, total: number) => void;

export interface SessionListOptions {
	includeMessageFreeDurable?: boolean;
}

let importSessionFromJsonlInMemoryImpl: (inputPath: string, targetCwd?: string) => Promise<SessionManager>;

/** Entries by id: the committed index, or a write's staged entries over it. */
interface SessionEntryLookup {
	get(id: string): SessionEntry | undefined;
	has(id: string): boolean;
}

/**
 * Walk from `startId` to the root, returning the public entries in path order
 * and passing transparently across host-only parents.
 */
function branchPath(lookup: SessionEntryLookup, startId: string | null): SessionEntry[] {
	const path: SessionEntry[] = [];
	const visited = new Set<string>();
	const start = startId ? lookup.get(startId) : undefined;
	let current = start && !isHostOnlySessionEntry(start) ? start : undefined;
	while (current) {
		if (visited.has(current.id)) throw new Error("Session branch contains a parent cycle");
		visited.add(current.id);
		if (!isHostOnlySessionEntry(current)) path.push(current);
		current = current.parentId ? lookup.get(current.parentId) : undefined;
	}
	return path.reverse();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseNewSessionOptions(options: NewSessionOptions | undefined): NewSessionOptions {
	if (options?.id !== undefined) assertValidSessionId(options.id);
	if (options?.origin !== undefined && options.origin !== "subagent") {
		throw new Error("Session origin is invalid");
	}
	return {
		...(options?.id === undefined ? {} : { id: options.id }),
		...(options?.parentSession === undefined
			? {}
			: { parentSession: parseSessionReference(options.parentSession, "Parent session reference") }),
		...(options?.origin === undefined ? {} : { origin: options.origin }),
	};
}

/**
 * One batch of entries built against the committed state. Each entry is
 * admitted and applied to a clone of the derived state, so a batch that fails
 * validation or does not commit leaves its manager unchanged. A manager builds
 * one for each commit of its log writer and checks each batch of the
 * conversation that holds its log with one.
 */
export class SessionWrite implements SessionEntryLookup {
	readonly entries: CommittedSessionEntry[] = [];
	readonly state: SessionDerivedState;
	private readonly committed: SessionEntryLookup;
	private readonly staged = new Map<string, CommittedSessionEntry>();

	constructor(committed: SessionEntryLookup, state: SessionDerivedState) {
		this.committed = committed;
		this.state = cloneSessionDerivedState(state);
	}

	get(id: string): SessionEntry | undefined {
		return this.staged.get(id) ?? this.committed.get(id);
	}

	has(id: string): boolean {
		return this.staged.has(id) || this.committed.has(id);
	}

	get leafId(): string | null {
		return this.state.leafId;
	}

	/** A public entry, staged or committed. */
	getEntry(id: string): SessionEntry | undefined {
		const entry = this.get(id);
		return entry && !isHostOnlySessionEntry(entry) ? entry : undefined;
	}

	/** Admit one entry at the next ordinal and apply it to the staged state. Returns its id. */
	append(entry: SessionEntry): string {
		const canonical = parseSessionEntryForAdmission(entry, `Session ${entry.type} entry`);
		validateSessionEntryAdmissionReferences(canonical, this, this.state.nextOrdinal);
		canonical.ordinal = this.state.nextOrdinal;
		const staged = canonical as CommittedSessionEntry;
		applySessionEntry(this.state, staged);
		this.staged.set(staged.id, staged);
		this.entries.push(staged);
		return staged.id;
	}

	/** Append an admitted entry with a new id, as a child of `parentId` (the staged leaf by default). */
	place(entry: SessionEntry, parentId: string | null = this.leafId): string {
		return this.append({ ...entry, id: generateId(this), parentId });
	}

	/** Envelope fields for a new child of the staged leaf. */
	private child(): { id: string; parentId: string | null; timestamp: string } {
		return { id: generateId(this), parentId: this.leafId, timestamp: new Date().toISOString() };
	}

	message(entry: SessionMessageEntry): string {
		if (entry.clientMessageId !== undefined) {
			requireStartedClientInputReceipt(this.state.clientInputsById, entry.clientMessageId);
		}
		return this.place(entry);
	}

	label(entry: LabelEntry): string {
		if (!this.getEntry(entry.targetId)) throw new Error(`Entry ${entry.targetId} not found`);
		return this.place(entry);
	}

	/** Move the active leaf; a leaf entry is a child of the leaf it replaces. */
	leaf(nextLeafId: string | null): void {
		if (this.leafId === nextLeafId) return;
		this.append({ type: "leaf", ...this.child(), targetId: nextLeafId });
	}

	branch(branchFromId: string): void {
		if (!this.getEntry(branchFromId)) throw new Error(`Entry ${branchFromId} not found`);
		this.leaf(branchFromId);
	}

	/** Move the leaf to `branchFromId` and append the summary of the branch left behind as its child. */
	branchWithSummary(branchFromId: string | null, entry: BranchSummaryEntry): string {
		if (branchFromId !== null && !this.getEntry(branchFromId)) {
			throw new Error(`Entry ${branchFromId} not found`);
		}
		this.leaf(branchFromId);
		return this.place(entry, branchFromId);
	}
}

/**
 * Manages conversation sessions as append-only trees stored in a conversation
 * log: SQLite for persisted sessions, memory for in-memory ones.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * A manager is the catalog of stored sessions (its static methods) and the
 * read view of one session's log: the conversation fold of its entries
 * (`getConversationState()`: the branch context and plan state), and the
 * store's projection of them (leaf, labels, name, client inputs, product
 * metadata, listing summary). The view advances when an entry commits, before
 * the entry reaches any listener; reads always return committed state.
 *
 * The manager does not write. Its log is written by `logWriter` until a live
 * session's conversation takes it (`takeLog()`), then through that session.
 */
export class SessionManager {
	private sessionId: string = "";
	private sessionGeneration: string = "";
	/** Host-owned exact-identity binding, never reconstructed from transcript data. */
	private reviewDiscussion: SessionStoreReviewDiscussionLookup | null = null;
	private sessionDir: string;
	private cwd: string;
	private persist: boolean;
	/**
	 * The log this manager writes. A persisted log holds the session's writer
	 * lock until it closes. A read-only manager has none.
	 */
	private log: ConversationLog | undefined;
	/** Opened by openReadOnly: the loaded session is never written and its lock is not taken. */
	private readOnly = false;
	private storeId: string | undefined;
	private fileEntries: FileEntry[] = [];
	private byId: Map<string, SessionEntry> = new Map();
	/**
	 * Store projection state: leaf, labels, name, client inputs, the session's
	 * product metadata, and its listing summary. Each write is checked against it.
	 */
	private derivedState!: SessionDerivedState;
	private get labelsById(): Map<string, string> {
		return this.derivedState.labelsById;
	}
	private get labelTimestampsById(): Map<string, string> {
		return this.derivedState.labelTimestampsById;
	}
	private get clientInputsById(): Map<string, ClientInputRecord> {
		return this.derivedState.clientInputsById;
	}
	private get leafId(): string | null {
		return this.derivedState.leafId;
	}
	/** The fold of the committed entries through `foldedOrdinal`; `getConversationState()` advances it. */
	private conversationState: ConversationState = fold([]);
	private foldedOrdinal = 0;
	/** The first loss of this manager's log. The manager accepts no writes after it. */
	private lostError: ConversationLogLostError | undefined;
	private readonly lostSignal = Promise.withResolvers<ConversationLogLostError>();
	/**
	 * Resolves once, when this manager loses its log: a commit it could not
	 * confirm (a fence conflict, a missing session, or an outcome that could not
	 * be resolved). The manager may no longer be the log's only writer, so it
	 * accepts no further writes; its runtime ends. Never rejects.
	 */
	readonly lost: Promise<ConversationLogLostError> = this.lostSignal.promise;
	/** Set when a persisted manager starts closing; later writes are refused. */
	private closed = false;
	private closing: Promise<void> | undefined;
	/** Only a session created by this manager may capture its first Git observation. */
	private createdSession = false;
	/** Log writer commits and close run here one at a time, in call order. Never rejects. */
	private lane: Promise<void> = Promise.resolve();
	private readonly entryListeners = new Set<SessionEntryListener>();
	private readonly branchListeners = new Set<SessionBranchListener>();
	/** The log was handed to a live session's conversation (`takeLog`); only that conversation appends to it. */
	private logTaken = false;
	/**
	 * The writer of this session's log while no conversation holds it. Its
	 * writes are refused while a live session holds the log, after a persisted
	 * manager closes, on a read-only manager, and after the log is lost.
	 */
	readonly logWriter: LogWriter;

	private constructor(cwd: string, sessionDir: string, persist: boolean) {
		this.cwd = resolvePath(cwd);
		this.sessionDir = sessionDir;
		this.persist = persist;
		if (persist && this.sessionDir) ensurePrivateDirectorySync(this.sessionDir);
		this.logWriter = new LogWriter(this, { commit: (build, atomic) => this._commit(build, atomic) });
	}

	private _loadStoreSnapshot(snapshot: SessionStoreSnapshot, cwdOverride?: string): void {
		const summary = snapshot.session;
		if (summary.formatVersion !== CURRENT_SESSION_VERSION) {
			throw new Error(`Session entry version must be ${CURRENT_SESSION_VERSION}`);
		}
		const parentSession =
			summary.parentSessionId === null ||
			summary.parentStoreId === null ||
			summary.parentSessionDirectory === null ||
			summary.parentSessionGeneration === null
				? undefined
				: sessionReference(
						summary.parentSessionDirectory,
						summary.parentStoreId,
						summary.parentSessionId,
						summary.parentSessionGeneration,
					);
		const header: SessionHeader = {
			type: "session",
			version: summary.formatVersion,
			id: summary.id,
			timestamp: summary.createdAt,
			cwd: cwdOverride ?? summary.cwd,
			...(parentSession === undefined ? {} : { parentSession }),
			...(summary.origin === null ? {} : { origin: summary.origin }),
		};
		this.cwd = resolvePath(cwdOverride ?? summary.cwd);
		this.sessionId = summary.id;
		this.sessionGeneration = summary.sessionGeneration;
		this.fileEntries = [header, ...snapshot.entries.map(storedEntryToSessionEntry)];
		this._buildIndex();
		this._verifyStoreProjections(snapshot);
	}

	/** Make `log` this manager's log; its loss, other than closing it, is the manager's loss. */
	private _attachLog(log: ConversationLog): void {
		this.log = log;
		this.logTaken = false;
		void log.lost.then((error) => {
			if (this.log === log && error.reason !== "closed") this._lose(error);
		});
	}

	/** Start this manager's empty in-memory session; in-memory sessions have no store. */
	private _startInMemorySession(options: NewSessionOptions): void {
		const sessionId = options.id ?? createSessionId();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp: new Date().toISOString(),
			cwd: this.cwd,
			...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
			...(options.origin === undefined ? {} : { origin: options.origin }),
		};
		this._attachLog(new InMemoryConversationLog(sessionId));
		this.sessionId = sessionId;
		this.sessionGeneration = randomUUID();
		this.fileEntries = [header];
		this._buildIndex();
		this.createdSession = true;
	}

	/** Create this manager's persisted session; its log takes the session's lock. */
	private async _createSession(options: NewSessionOptions | undefined): Promise<void> {
		const parsed = parseNewSessionOptions(options);
		const log = await SqliteConversationLog.create({ sessionDirectory: this.sessionDir, cwd: this.cwd, ...parsed });
		try {
			this._loadStoreSnapshot(log.takeOpenedSnapshot(), this.cwd);
		} catch (error) {
			await log.close().catch(() => {});
			throw error;
		}
		this._attachLog(log);
		this.storeId = log.ref.storeId;
		this.createdSession = true;
	}

	private _verifyStoreProjections(snapshot: SessionStoreSnapshot): void {
		verifySessionStoreProjections(this.derivedState, snapshot);
	}

	private _buildIndex(): void {
		const header = this.fileEntries[0];
		if (!header || header.type !== "session") throw new Error("Current session header is unavailable");
		const validatedEntries = validatePersistedSessionEntrySequence(this.fileEntries.slice(1));
		this.fileEntries = [header, ...validatedEntries];
		this.derivedState = replaySessionEntries(header, validatedEntries);
		this.conversationState = fold([]);
		this.foldedOrdinal = 0;
		this.byId = new Map(validatedEntries.map((entry) => [entry.id, entry]));
	}

	isPersisted(): boolean {
		return this.persist;
	}

	getCwd(): string {
		return this.cwd;
	}

	getSessionDir(): string {
		return this.sessionDir;
	}

	usesDefaultSessionDir(): boolean {
		return this.sessionDir === getDefaultSessionDirPath(this.cwd);
	}

	getSessionId(): string {
		return this.sessionId;
	}

	/** Binding loaded before a persisted manager is published; historical children remain source-linked. */
	getReviewDiscussion(): SessionStoreReviewDiscussionLookup | null {
		return this.reviewDiscussion;
	}

	getSessionRef(): SessionReference | undefined {
		if (!this.persist || !this.storeId) return undefined;
		return sessionReference(this.sessionDir, this.storeId, this.sessionId, this.sessionGeneration);
	}

	/**
	 * Record the first loss of this manager's log and resolve `lost`; later
	 * calls return that first loss.
	 */
	private _lose(error: unknown, reason: ConversationLogLossReason = "storage"): ConversationLogLostError {
		if (!this.lostError) {
			this.lostError =
				error instanceof ConversationLogLostError
					? error
					: new ConversationLogLostError(reason, errorMessage(error), error);
			this.lostSignal.resolve(this.lostError);
		}
		return this.lostError;
	}

	private _assertNotLost(): void {
		if (this.lostError) throw this.lostError;
	}

	private _assertWritable(): void {
		this._assertNotLost();
		if (this.readOnly) {
			throw new Error(`Session ${this.sessionId} was opened read-only`);
		}
		if (this.closed) {
			throw new Error("Session persistence is closed");
		}
	}

	/** Run `task` on the lane after every earlier task settles. */
	private _enqueue<T>(task: () => T | Promise<T>): Promise<T> {
		const run = this.lane.then(task);
		this.lane = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * Build one batch against the committed state, commit it, then install and
	 * publish it. Resolves with what `build` returned once the batch commits.
	 */
	private _commit<T>(build: (write: SessionWrite) => T, atomic = false): Promise<T> {
		this._assertWritable();
		this._assertLogNotTaken();
		return this._enqueue(() => this._commitNow(build, atomic));
	}

	private _assertLogNotTaken(): void {
		if (this.logTaken) {
			throw new Error(`Session ${this.sessionId} is written by its live session; change it through the session`);
		}
	}

	/**
	 * Hand this manager's log to the conversation of a live session, which
	 * becomes its only writer. Each batch the returned log commits is validated
	 * and installed in this manager's view, and reaches its listeners, before
	 * the append resolves; a batch the manager cannot admit rolls back. Closing
	 * the returned log closes a persisted session's log, which seals the
	 * manager; an in-memory manager gets its log back and `logWriter` writes it
	 * again. Until then, writes through `logWriter` are refused.
	 */
	takeLog(): ConversationLog {
		this._assertWritable();
		this._assertLogNotTaken();
		const log = this.log;
		if (!log) throw new Error(`Session ${this.sessionId} has no writable log`);
		this.logTaken = true;
		const released = Promise.withResolvers<ConversationLogLostError>();
		let closing: Promise<void> | undefined;
		return {
			conversationId: log.conversationId,
			lost: Promise.race([log.lost, released.promise]),
			head: () => log.head(),
			read: (afterOrdinal, limit) => log.read(afterOrdinal, limit),
			append: (batch) => this._appendTaken(log, batch),
			close: () => {
				closing ??= (async () => {
					if (this.log === log) {
						this.logTaken = false;
						if (this.persist) this.closed = true;
					}
					if (this.persist) await log.close();
					released.resolve(new ConversationLogLostError("closed", "The conversation log was closed"));
				})();
				return closing;
			},
		};
	}

	/** One batch of the conversation that took the log: admitted against this view, committed, then installed. */
	private async _appendTaken(
		log: ConversationLog,
		batch: ConversationLogAppend,
	): Promise<ConversationLogAppendResult> {
		this._assertNotLost();
		if (this.log !== log || !this.logTaken) {
			throw new ConversationLogLostError("closed", `Session ${this.sessionId} no longer writes this log`);
		}
		if (batch.expectedOrdinal !== this.getOrdinal()) {
			throw this._lose(
				new ConversationLogLostError(
					"fence_conflict",
					`Session commit expected ordinal ${batch.expectedOrdinal}, but the session is at ${this.getOrdinal()}`,
				),
			);
		}
		const write = new SessionWrite(this.byId, this.derivedState);
		try {
			for (const [index, draft] of batch.entries.entries()) {
				const { ordinal: _ordinal, ...entry } = toSessionEntry(draft, batch.expectedOrdinal + index + 1);
				write.append(entry);
			}
		} catch (error) {
			return { status: "rolled_back", error: error instanceof Error ? error : new Error(errorMessage(error)) };
		}
		let outcome: ConversationLogAppendResult;
		try {
			outcome = await log.append(batch);
		} catch (error) {
			throw this._lose(error);
		}
		if (outcome.status === "rolled_back") return outcome;
		if (
			outcome.first !== batch.expectedOrdinal + 1 ||
			outcome.last !== batch.expectedOrdinal + batch.entries.length
		) {
			throw this._lose(
				new ConversationLogLostError(
					"fence_conflict",
					`Session commit after ordinal ${batch.expectedOrdinal} was assigned ordinals ${outcome.first}-${outcome.last}`,
				),
			);
		}
		this._install(write);
		return outcome;
	}

	/**
	 * The commit itself; runs on the lane. A batch that fails validation, or
	 * that the log rolls back, leaves the manager unchanged and writable; a
	 * failure that leaves its outcome unknown loses the log. An atomic batch
	 * reports a validation failure as a rolled-back `SessionAtomicAppendError`.
	 */
	private async _commitNow<T>(build: (write: SessionWrite) => T, atomic: boolean): Promise<T> {
		this._assertNotLost();
		// A conversation may have taken the log while this write waited on the lane.
		this._assertLogNotTaken();
		const log = this.log;
		if (!log) throw new Error(`Session ${this.sessionId} has no writable log`);
		const write = new SessionWrite(this.byId, this.derivedState);
		let result: T;
		let drafts: ConversationLogEntryDraft[];
		try {
			result = build(write);
			drafts = write.entries.map(toLogEntryDraft);
		} catch (error) {
			if (!atomic || error instanceof SessionAtomicAppendError) throw error;
			throw new SessionAtomicAppendError(errorMessage(error), "rolled_back", { cause: error });
		}
		if (drafts.length === 0) return result;
		const expectedOrdinal = this.getOrdinal();
		let outcome: ConversationLogAppendResult;
		try {
			outcome = await log.append({ expectedOrdinal, commitId: randomUUID(), entries: drafts });
		} catch (error) {
			throw this._lose(error);
		}
		if (outcome.status === "rolled_back") {
			throw new SessionAtomicAppendError(`Session commit was rolled back: ${outcome.error.message}`, "rolled_back", {
				cause: outcome.error,
			});
		}
		if (outcome.first !== expectedOrdinal + 1 || outcome.last !== expectedOrdinal + drafts.length) {
			throw this._lose(
				new ConversationLogLostError(
					"fence_conflict",
					`Session commit after ordinal ${expectedOrdinal} was assigned ordinals ${outcome.first}-${outcome.last}`,
				),
			);
		}
		this._install(write);
		return result;
	}

	/** Make a committed batch part of this manager's view, then publish it to listeners in ordinal order. */
	private _install(write: SessionWrite): void {
		for (const entry of write.entries) {
			this.fileEntries.push(entry);
			this.byId.set(entry.id, entry);
		}
		this.derivedState = write.state;
		for (const entry of write.entries) {
			// A leaf entry is a child of the leaf it replaces.
			if (entry.type === "leaf") this._notifyBranchListeners(entry.parentId, entry.targetId);
			else this._notifyEntryListeners(entry);
		}
	}

	private _notifyEntryListeners(entry: CommittedSessionEntry): void {
		if (isHostOnlySessionEntry(entry)) return;
		for (const listener of this.entryListeners) {
			try {
				listener(cloneCanonicalData(entry, `Session ${entry.type} observer entry`));
			} catch {
				// The log is authoritative. A projection observer cannot make a
				// committed entry appear to have failed.
			}
		}
	}

	/**
	 * Seal a persisted manager against later writes, wait for every write
	 * called before this, and close its log, which releases the store lease and
	 * the session's lock. Each write reports its own failure, so this rejects
	 * only when the log cannot be closed. An in-memory manager stays writable.
	 */
	closePersistence(): Promise<void> {
		if (this.closing) return this.closing;
		if (this.persist) this.closed = true;
		this.closing = this._enqueue(async () => {
			if (this.persist) await this.log?.close();
		});
		return this.closing;
	}

	/**
	 * The fold of the committed entries: the leaf, the branch context (messages,
	 * model, thinking level, Fast mode), the plan state, labels, the name, and
	 * client inputs, the durable queue among them (`clientInputRecovery` of it
	 * is the recovery plan). An immutable value; a later commit replaces it.
	 * Folded on read, so a run of writes folds once.
	 */
	getConversationState(): ConversationState {
		const ordinal = this.getOrdinal();
		if (this.foldedOrdinal < ordinal) {
			// fileEntries[0] is the header; entry ordinals are their contiguous indexes.
			const entries = this.fileEntries.slice(this.foldedOrdinal + 1, ordinal + 1) as CommittedSessionEntry[];
			this.conversationState = fold(entries.map(toLogEntry), this.conversationState);
			this.foldedOrdinal = ordinal;
		}
		return this.conversationState;
	}

	getClientInput(clientMessageId: string): ClientInputRecord | undefined {
		const record = this.clientInputsById.get(clientMessageId);
		return record ? cloneClientInputRecord(record) : undefined;
	}

	/** The log position: ordinal of the newest committed entry. */
	getOrdinal(): number {
		return this.derivedState.nextOrdinal - 1;
	}

	/** Read committed entries with ordinal > afterOrdinal in ordinal order, at most `limit` of them. */
	async readEntries(afterOrdinal: number, limit: number): Promise<SessionEntryPage> {
		if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
			throw new Error("afterOrdinal must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > SESSION_STORE_READ_ENTRIES_MAX) {
			throw new Error(`limit must be a safe integer from 1 to ${SESSION_STORE_READ_ENTRIES_MAX}`);
		}
		const lastOrdinal = this.getOrdinal();
		// fileEntries[0] is the header; entry ordinals are their contiguous indexes.
		const end = Math.min(afterOrdinal + limit, lastOrdinal) + 1;
		const entries = this.fileEntries.slice(afterOrdinal + 1, end) as CommittedSessionEntry[];
		return { entries: cloneCanonicalData(entries, "Session entry page"), lastOrdinal };
	}

	/**
	 * Observe public conversation entries in ordinal order, each only after its
	 * commit, from inside the write that committed it: the manager's reads
	 * already include the entry. An entry whose commit fails is never
	 * delivered. Host-only sidecar records (admission WAL, subagent spawn
	 * edges) are intentionally excluded.
	 */
	subscribeEntries(listener: SessionEntryListener): () => void {
		this.entryListeners.add(listener);
		return () => {
			this.entryListeners.delete(listener);
		};
	}

	/**
	 * Observe a low-level active-leaf move after its leaf entry commits, ordered
	 * with subscribeEntries() by ordinal. This is not an Agent context commit
	 * boundary; consumers that require the rebuilt message state must observe
	 * AgentSession's conversation generation.
	 */
	subscribeBranchChanges(listener: SessionBranchListener): () => void {
		this.branchListeners.add(listener);
		return () => {
			this.branchListeners.delete(listener);
		};
	}

	private _notifyBranchListeners(previousLeafId: string | null, nextLeafId: string | null): void {
		for (const listener of this.branchListeners) {
			try {
				listener({ previousLeafId, nextLeafId });
			} catch {
				// Branch mutation remains authoritative if a projection observer fails.
			}
		}
	}

	getPrReviewBinding(): PrReviewPlacement | undefined {
		const binding = this.derivedState.prReviewBinding;
		return binding === undefined ? undefined : cloneCanonicalData(binding, "Session PR review binding");
	}

	getStartingGitContext(): RpcGitContext | null | undefined {
		const gitContext = this.derivedState.startingGitContext;
		return gitContext === undefined ? undefined : cloneCanonicalData(gitContext, "Session starting Git context");
	}

	/** Get the incrementally maintained lifetime message summary for session listing. */
	getSessionEntrySummary(): SessionEntrySummary {
		return sessionEntrySummary(this.derivedState);
	}

	/** Get the current session name from the latest session_info entry, if any. */
	getSessionName(): string | undefined {
		return this.derivedState.name;
	}

	/**
	 * Whether the first Git observation of this session is still to be
	 * recorded: this manager created the session, and it has none yet.
	 */
	capturesStartingGitContext(): boolean {
		return this.createdSession && this.derivedState.startingGitContext === undefined;
	}

	// =========================================================================
	// Tree Traversal
	// =========================================================================

	getLeafId(): string | null {
		return this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		const leafId = this.getLeafId();
		return leafId ? this.getEntry(leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		const entry = this.byId.get(id);
		return entry && !isHostOnlySessionEntry(entry) ? entry : undefined;
	}

	/**
	 * Get all direct children of an entry.
	 */
	getChildren(parentId: string): SessionEntry[] {
		if (!this.getEntry(parentId)) return [];
		const children: SessionEntry[] = [];
		for (const entry of this.byId.values()) {
			if (entry.parentId === parentId && !isHostOnlySessionEntry(entry)) {
				children.push(entry);
			}
		}
		return children;
	}

	/**
	 * Get the label for an entry, if any.
	 */
	getLabel(id: string): string | undefined {
		return this.getEntry(id) ? this.labelsById.get(id) : undefined;
	}

	/** All durable spawn edges in file order, including edges recorded on other branches. */
	getSubagentSpawnEntries(): SubagentSpawnEntry[] {
		return [...this.derivedState.subagentSpawns];
	}

	/**
	 * Walk from entry to root, returning all entries in path order.
	 * Includes all conversation entry types (messages, compaction, model changes, etc.)
	 * while traversing transparently across any host-only sidecar parents
	 * (admission WAL, subagent spawn edges).
	 * `getConversationState().context` holds the branch's resolved model context.
	 */
	getBranch(fromId?: string): SessionEntry[] {
		return branchPath(this.byId, fromId ?? this.getLeafId());
	}

	/**
	 * Return a bounded active-branch window without materializing the full path.
	 * The walk is newest-to-oldest with one final parent lookup to determine
	 * whether more history exists, then reverses only the bounded result.
	 */
	getBranchWindow(options: SessionBranchWindowOptions): SessionBranchWindow | undefined {
		if (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0) {
			throw new Error("maxEntries must be a positive safe integer");
		}
		const lookbackEntries = options.lookbackEntries ?? 0;
		if (!Number.isSafeInteger(lookbackEntries) || lookbackEntries < 0) {
			throw new Error("lookbackEntries must be a non-negative safe integer");
		}
		if (options.maxEntries > Number.MAX_SAFE_INTEGER - lookbackEntries) {
			throw new Error("branch window size exceeds the safe integer range");
		}

		let current: SessionEntry | undefined;
		if (options.beforeEntryId !== undefined) {
			const before = this.getEntry(options.beforeEntryId);
			if (!before) return undefined;
			current = before.parentId ? this.byId.get(before.parentId) : undefined;
		} else {
			current = this.leafId ? this.byId.get(this.leafId) : undefined;
		}

		const reverseWindow: SessionEntry[] = [];
		const seen = new Set<string>();
		const capacity = options.maxEntries + lookbackEntries;
		while (current && reverseWindow.length < capacity) {
			if (seen.has(current.id)) {
				throw new Error("Session branch contains a parent cycle");
			}
			seen.add(current.id);
			if (!isHostOnlySessionEntry(current)) {
				reverseWindow.push(current);
			}
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		while (current && isHostOnlySessionEntry(current)) {
			if (seen.has(current.id)) {
				throw new Error("Session branch contains a parent cycle");
			}
			seen.add(current.id);
			current = current.parentId ? this.byId.get(current.parentId) : undefined;
		}
		const hasEarlier = current !== undefined;
		const visitedEntries = reverseWindow.length;
		reverseWindow.reverse();
		const entryStart = Math.max(0, reverseWindow.length - options.maxEntries);
		return {
			entries: reverseWindow.slice(entryStart),
			lookback: reverseWindow.slice(0, entryStart),
			hasEarlier,
			visitedEntries,
		};
	}

	/**
	 * Get session header.
	 */
	getHeader(): SessionHeader | null {
		const h = this.fileEntries.find((e) => e.type === "session");
		return h ? (h as SessionHeader) : null;
	}

	/**
	 * Get all conversation entries (excludes the header and host-only sidecar records).
	 * Returns a shallow copy.
	 * The session is append-only: entries cannot be modified or deleted.
	 */
	getEntries(): SessionEntry[] {
		return this.fileEntries.filter(
			(entry): entry is SessionEntry => entry.type !== "session" && !isHostOnlySessionEntry(entry),
		);
	}

	/**
	 * Get the conversation as a tree. Returns a shallow defensive copy of public entries.
	 * A well-formed session has exactly one root (first entry with parentId === null).
	 * Orphaned entries (broken parent chain) are also returned as roots.
	 */
	getTree(): SessionTreeNode[] {
		// Admission WAL records share the JSONL for crash recovery but are not
		// conversation nodes and must never become blank/selectable tree rows.
		const entries = this.getEntries();
		const nodeMap = new Map<string, SessionTreeNode>();
		const roots: SessionTreeNode[] = [];

		// Create nodes with resolved labels
		for (const entry of entries) {
			const label = this.labelsById.get(entry.id);
			const labelTimestamp = this.labelTimestampsById.get(entry.id);
			nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
		}

		// Build tree
		for (const entry of entries) {
			const node = nodeMap.get(entry.id)!;
			if (entry.parentId === null || entry.parentId === entry.id) {
				roots.push(node);
			} else {
				const parent = nodeMap.get(entry.parentId);
				if (parent) {
					parent.children.push(node);
				} else {
					// Orphan - treat as root
					roots.push(node);
				}
			}
		}

		// Sort children by timestamp (oldest first, newest at bottom)
		// Use iterative approach to avoid stack overflow on deep trees
		const stack: SessionTreeNode[] = [...roots];
		while (stack.length > 0) {
			const node = stack.pop()!;
			node.children.sort((a, b) => new Date(a.entry.timestamp).getTime() - new Date(b.entry.timestamp).getTime());
			stack.push(...node.children);
		}

		return roots;
	}

	private static async _store(dir: string): Promise<SQLiteSessionStoreLease> {
		return acquireSharedSQLiteSessionStore(normalizePath(dir));
	}

	private static async _scopedStore<T>(
		dir: string,
		operation: (store: SQLiteSessionStoreClient) => Promise<T>,
	): Promise<T> {
		const lease = await SessionManager._store(dir);
		let result: T;
		try {
			result = await operation(lease.client);
		} catch (error) {
			try {
				await lease.release();
			} catch (releaseError) {
				throw new AggregateError(
					[error, releaseError],
					"Session store operation failed and its lease could not be released",
				);
			}
			throw error;
		}
		await lease.release();
		return result;
	}

	/**
	 * Create and durably reserve a hidden persisted session. Its log takes the
	 * session's lock and holds it until persistence closes.
	 */
	static async create(cwd: string, sessionDir?: string, options?: NewSessionOptions): Promise<SessionManager> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		const manager = new SessionManager(cwd, dir, true);
		await manager._createSession(options);
		return manager;
	}

	/**
	 * Open one authoritative SQLite session reference for writing. Its log takes
	 * the session's lock before loading it and holds it until persistence
	 * closes; throws `ConversationLockedError` while another host has it open.
	 */
	static async open(ref: SessionReference, cwdOverride?: string): Promise<SessionManager> {
		const log = await SqliteConversationLog.open(ref);
		try {
			const snapshot = log.takeOpenedSnapshot();
			const discussion = await SessionManager._scopedStore(log.ref.sessionDirectory, (store) =>
				store.findReviewDiscussionByChild({
					sessionId: snapshot.session.id,
					sessionGeneration: snapshot.session.sessionGeneration,
				}),
			);
			const manager = new SessionManager(cwdOverride ?? snapshot.session.cwd, log.ref.sessionDirectory, true);
			manager._loadStoreSnapshot(snapshot, cwdOverride ?? snapshot.session.cwd);
			manager.reviewDiscussion = deepFreezeCanonicalData(discussion);
			manager.storeId = log.ref.storeId;
			manager._attachLog(log);
			return manager;
		} catch (error) {
			try {
				await log.close();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session open failed and its log could not be closed");
			}
			throw error;
		}
	}

	/**
	 * Open one authoritative SQLite session reference to read it. Takes no lock
	 * and opens no log, so it works while the session is open elsewhere; every
	 * write throws.
	 */
	static async openReadOnly(ref: SessionReference, cwdOverride?: string): Promise<SessionManager> {
		const canonicalRef = parseSessionReference(ref);
		const dir = resolvePath(canonicalRef.sessionDirectory);
		const { snapshot, discussion, storeId } = await SessionManager._scopedStore(dir, async (store) => {
			if (store.info.storeId !== canonicalRef.storeId) {
				throw new Error("Session reference belongs to a different store");
			}
			const snapshot = await store.loadSession(canonicalRef.sessionId, canonicalRef.sessionGeneration);
			if (!snapshot) throw new Error(`Session not found: ${canonicalRef.sessionId}`);
			const discussion = await store.findReviewDiscussionByChild({
				sessionId: snapshot.session.id,
				sessionGeneration: snapshot.session.sessionGeneration,
			});
			return { snapshot, discussion, storeId: store.info.storeId };
		});
		const manager = new SessionManager(cwdOverride ?? snapshot.session.cwd, dir, true);
		manager._loadStoreSnapshot(snapshot, cwdOverride ?? snapshot.session.cwd);
		manager.reviewDiscussion = deepFreezeCanonicalData(discussion);
		manager.storeId = storeId;
		manager.readOnly = true;
		return manager;
	}

	/** The most recent visible or pending-input session for a cwd, found without opening it. */
	static async findContinuation(cwd: string, sessionDir?: string): Promise<SessionReference | undefined> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		return SessionManager._scopedStore(dir, async (store) => {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const latest = await store.findContinuationSession(filterCwd ? resolvePath(cwd) : undefined);
			return latest ? sessionReference(dir, store.info.storeId, latest.id, latest.sessionGeneration) : undefined;
		});
	}

	/**
	 * Continue the most recent visible or pending-input session for a cwd, or
	 * create one. Throws `ConversationLockedError` while the most recent session
	 * is open elsewhere.
	 */
	static async continueRecent(cwd: string, sessionDir?: string): Promise<SessionManager> {
		const latest = await SessionManager.findContinuation(cwd, sessionDir);
		return latest ? SessionManager.open(latest) : SessionManager.create(cwd, sessionDir);
	}

	static async readStartingGitContexts(
		sessionDir: string,
		sessionIds: readonly string[],
	): Promise<ReadonlyMap<string, RpcGitContext | null>> {
		for (const sessionId of sessionIds) assertValidSessionId(sessionId);
		if (new Set(sessionIds).size !== sessionIds.length) {
			throw new Error("Session context lookup requires unique session ids");
		}
		const contexts = new Map<string, RpcGitContext | null>(sessionIds.map((sessionId) => [sessionId, null]));
		if (sessionIds.length === 0) return contexts;
		return SessionManager._scopedStore(normalizePath(sessionDir), async (store) => {
			for (const sessionId of sessionIds) {
				const summary = await store.findSessionSummaryById(sessionId);
				if (!summary?.startingGitContextRecorded) continue;
				if (!Check(Type.Union([RpcGitContextSchema, Type.Null()]), summary.startingGitContext)) {
					throw new Error(`Session ${sessionId} has invalid starting Git context metadata`);
				}
				contexts.set(sessionId, summary.startingGitContext);
			}
			return contexts;
		});
	}

	/** Find a generation-pinned reference by exact id; open() performs full snapshot validation. */
	static async findForResume(sessionDir: string, sessionId: string): Promise<SessionReference | undefined> {
		const result = await findSessionSummaryById(sessionDir, sessionId);
		return result
			? sessionReference(result.directory, result.storeId, result.summary.id, result.summary.sessionGeneration)
			: undefined;
	}

	/** Create an in-memory session (no persistence). */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions): SessionManager {
		const manager = new SessionManager(cwd, "", false);
		manager._startInMemorySession(parseNewSessionOptions(options));
		return manager;
	}

	/**
	 * Create a session holding only the branch from the root to `leafId` of
	 * `source`, with the labels on it: persisted beside a persisted source,
	 * which becomes its parent session, otherwise in memory. `source` may be
	 * live or read-only; it is only read.
	 */
	static async createBranched(source: SessionManager, leafId: string): Promise<SessionManager> {
		source._assertNotLost();
		if (source.reviewDiscussion) {
			throw new Error("Finding discussion identity is source-linked; reset through the source session instead");
		}
		const path = source.getBranch(leafId);
		if (path.length === 0) throw new Error(`Entry ${leafId} not found`);

		const retained: SessionEntry[] = [];
		const retainedIds = new Set<string>();
		let parentId: string | null = null;
		for (const entry of path) {
			if (entry.type === "label") continue;
			const copy = withoutClientInputIdentity({ ...entry, parentId });
			delete copy.ordinal;
			retained.push(copy);
			retainedIds.add(copy.id);
			parentId = copy.id;
		}
		const labels = [...source.labelsById]
			.filter(([targetId]) => retainedIds.has(targetId))
			.map(([targetId, label]) => ({ targetId, label, timestamp: source.labelTimestampsById.get(targetId)! }));
		const parentSession = source.getSessionRef();
		const origin = source.getHeader()?.origin;
		const options: NewSessionOptions = {
			...(parentSession === undefined ? {} : { parentSession }),
			...(origin === undefined ? {} : { origin }),
		};
		const target = source.persist
			? await SessionManager.create(source.cwd, source.sessionDir, options)
			: SessionManager.inMemory(source.cwd, options);
		try {
			await target._commit((write) => {
				for (const entry of retained) write.append(entry);
				let labelParentId = retained.at(-1)?.id ?? null;
				for (const { targetId, label, timestamp } of labels) {
					labelParentId = write.append({
						type: "label",
						id: generateId(write),
						parentId: labelParentId,
						timestamp,
						targetId,
						label,
					});
				}
			}, true);
		} catch (error) {
			try {
				await target.closePersistence();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Branched session creation failed and could not be closed");
			}
			throw error;
		}
		return target;
	}

	/**
	 * Open an in-memory session (no persistence) over an existing log, such as
	 * an `InMemoryConversationLog` with entries already in it. The session id is
	 * the log's conversation id; the manager loads every entry, then writes
	 * through `log`. Only an empty log is a new session that captures its first
	 * Git observation.
	 */
	static async openInMemory(log: ConversationLog, cwd: string = process.cwd()): Promise<SessionManager> {
		const entries: CommittedSessionEntry[] = [];
		for (;;) {
			const page = await log.read(entries.length, CONVERSATION_LOG_READ_LIMIT_MAX);
			entries.push(...page.entries.map((entry) => toSessionEntry(entry, entry.ordinal)));
			if (page.entries.length === 0 || entries.length >= page.lastOrdinal) break;
		}
		assertValidSessionId(log.conversationId);
		const manager = new SessionManager(cwd, "", false);
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: log.conversationId,
			timestamp: new Date().toISOString(),
			cwd: manager.cwd,
		};
		manager.sessionId = log.conversationId;
		manager.sessionGeneration = randomUUID();
		manager.fileEntries = [header, ...entries];
		manager._buildIndex();
		manager.createdSession = entries.length === 0;
		manager._attachLog(log);
		return manager;
	}

	/** Import an explicit JSONL snapshot into SQLite; the JSONL file is never reopened as live storage. */
	static async importFromJsonl(
		inputPath: string,
		targetCwd?: string,
		sessionDir?: string,
		options?: { id?: string },
	): Promise<SessionManager> {
		return SessionManager._importFromJsonl(inputPath, targetCwd, sessionDir, options, true);
	}

	private static async _importFromJsonl(
		inputPath: string,
		targetCwd: string | undefined,
		sessionDir: string | undefined,
		options: { id?: string } | undefined,
		persist: boolean,
	): Promise<SessionManager> {
		const resolvedPath = resolvePath(inputPath);
		if (persist && sessionDir !== undefined) ensurePrivateDirectorySync(normalizePath(sessionDir));
		if (existsSync(resolvedPath)) hardenPrivateRegularFileSync(resolvedPath);
		const sourceEntries = loadEntriesFromFile(resolvedPath);
		if (sourceEntries.length === 0) throw new Error(`Cannot import invalid session JSONL: ${resolvedPath}`);
		const header = assertCurrentSessionSnapshot(sourceEntries);

		const cwd = targetCwd ?? header.cwd;
		const parentSession =
			header.parentSessionDirectory !== undefined &&
			header.parentStoreId !== undefined &&
			header.parentSessionId !== undefined &&
			header.parentSessionGeneration !== undefined
				? sessionReference(
						header.parentSessionDirectory,
						header.parentStoreId,
						header.parentSessionId,
						header.parentSessionGeneration,
					)
				: undefined;

		const sourceById = new Map<string, SessionEntry>();
		let sourceLeafId: string | null = null;
		for (const entry of sourceEntries) {
			if (entry.type === "session") continue;
			sourceById.set(entry.id, entry);
			if (entry.type === "leaf") sourceLeafId = entry.targetId;
			else sourceLeafId = entry.id;
		}
		const nearestPublicParent = (parentId: string | null): string | null => {
			let currentId = parentId;
			const visited = new Set<string>();
			while (currentId) {
				if (visited.has(currentId)) throw new Error("Imported session contains a host-only parent cycle");
				visited.add(currentId);
				const current = sourceById.get(currentId);
				if (!current) throw new Error(`Imported session references an unavailable entry: ${currentId}`);
				if (!isHostOnlySessionEntry(current)) return current.id;
				currentId = current.parentId;
			}
			return null;
		};
		const publicEntries = sourceEntries
			.filter((entry): entry is SessionEntry => entry.type !== "session" && !isHostOnlySessionEntry(entry))
			.map((entry) => withoutClientInputIdentity({ ...entry, parentId: nearestPublicParent(entry.parentId) }))
			.map((entry) => {
				delete entry.ordinal;
				return entry;
			});
		const finalLeafId = nearestPublicParent(sourceLeafId);
		const targetId = options?.id ?? header.id;
		const newSessionOptions = {
			id: targetId,
			...(parentSession === undefined ? {} : { parentSession }),
			...(header.origin === undefined ? {} : { origin: header.origin }),
		};
		const stage = async (manager: SessionManager): Promise<void> => {
			await manager._commit((write) => {
				for (const entry of publicEntries) write.append(entry);
				if (finalLeafId === null) write.leaf(null);
				else if (finalLeafId !== write.leafId) write.branch(finalLeafId);
			}, true);
		};

		const validationManager = SessionManager.inMemory(cwd, newSessionOptions);
		await stage(validationManager);
		if (!persist) return validationManager;

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const manager = await SessionManager.create(cwd, dir, newSessionOptions);
		try {
			await stage(manager);
			return manager;
		} catch (error) {
			try {
				await manager.closePersistence();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session import failed and its manager could not be closed");
			}
			throw error;
		}
	}

	static {
		importSessionFromJsonlInMemoryImpl = (inputPath, targetCwd) =>
			SessionManager._importFromJsonl(inputPath, targetCwd, undefined, undefined, false);
	}

	/** Fork a stored session into a new persisted session in another cwd/store. */
	static async forkFrom(
		sourceRef: SessionReference,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): Promise<SessionManager> {
		const source = await SessionManager.openReadOnly(sourceRef);
		let target: SessionManager | undefined;
		try {
			if (source.getReviewDiscussion()) {
				throw new Error(
					"Finding discussions cannot fork their source-linked identity; reset through the source review instead",
				);
			}
			const sourceLeafId = source.getLeafId();
			target = await SessionManager.create(targetCwd, sessionDir, {
				...options,
				parentSession: sourceRef,
			});
			const sourceById = source.byId;
			const nearestPublicParent = (parentId: string | null): string | null => {
				let currentId = parentId;
				while (currentId) {
					const current = sourceById.get(currentId);
					if (!current) return null;
					if (!isHostOnlySessionEntry(current)) return current.id;
					currentId = current.parentId;
				}
				return null;
			};
			const entries = source
				.getEntries()
				.map((entry) => withoutClientInputIdentity({ ...entry, parentId: nearestPublicParent(entry.parentId) }))
				.map((entry) => {
					delete entry.ordinal;
					return entry;
				});
			await target._commit((write) => {
				for (const entry of entries) write.append(entry);
				if (sourceLeafId === null) write.leaf(null);
				else if (write.leafId !== sourceLeafId) write.branch(sourceLeafId);
			}, true);
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (target) {
				try {
					await target.closePersistence();
				} catch (closeError) {
					cleanupErrors.push(closeError);
				}
			}
			try {
				await source.closePersistence();
			} catch (closeError) {
				cleanupErrors.push(closeError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError([error, ...cleanupErrors], "Session fork failed and cleanup did not complete");
			}
			throw error;
		}
		try {
			await source.closePersistence();
		} catch (error) {
			try {
				await target.closePersistence();
			} catch (closeError) {
				throw new AggregateError(
					[error, closeError],
					"Session fork source and unreturned target could not be closed",
				);
			}
			throw error;
		}
		return target;
	}

	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		return SessionManager._scopedStore(dir, async (store) => {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const summaries = await store.listSessionSummaries({
				includeHidden: options?.includeMessageFreeDurable,
				...(filterCwd ? { cwd: resolvePath(cwd) } : {}),
			});
			onProgress?.(summaries.length, summaries.length);
			return summaries.map((summary) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
		});
	}

	static async search(
		cwd: string,
		query: string,
		sessionDir?: string,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? resolvePath(sessionDir) : getDefaultSessionDir(cwd);
		return SessionManager._scopedStore(dir, async (store) => {
			const filterCwd = sessionDir !== undefined && !isDefaultShapedSessionDir(dir, cwd);
			const results = await store.searchSessionSummaries(query, {
				includeHidden: options?.includeMessageFreeDurable,
				...(filterCwd ? { cwd: resolvePath(cwd) } : {}),
			});
			return results.map(({ summary }) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
		});
	}

	static async searchAll(query: string, sessionDir?: string): Promise<SessionInfo[]> {
		if (sessionDir) {
			const dir = resolvePath(sessionDir);
			return SessionManager._scopedStore(dir, async (store) => {
				const results = await store.searchSessionSummaries(query);
				return results.map(({ summary }) => sessionInfoFromStoreSummary(dir, store.info.storeId, summary));
			});
		}
		const sessionsRoot = getSessionsDir();
		if (!existsSync(sessionsRoot)) return [];
		const directories = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
		const result: { session: SessionInfo; score: number }[] = [];
		const storeFailures: unknown[] = [];
		let successfulStores = 0;
		for (const directory of directories) {
			if (!existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME))) continue;
			let storeResults: { session: SessionInfo; score: number }[];
			try {
				storeResults = await SessionManager._scopedStore(directory, async (store) => {
					const results = await store.searchSessionSummaries(query);
					return results.map(({ summary, score }) => ({
						session: sessionInfoFromStoreSummary(directory, store.info.storeId, summary),
						score,
					}));
				});
			} catch (error) {
				storeFailures.push(error);
				continue;
			}
			successfulStores += 1;
			result.push(...storeResults);
		}
		if (successfulStores === 0 && storeFailures.length > 0) {
			throw new AggregateError(storeFailures, "Could not search sessions in any project store");
		}
		result.sort((left, right) => {
			if (left.score !== right.score) return left.score - right.score;
			return right.session.modified.getTime() - left.session.modified.getTime();
		});
		return result.map(({ session }) => session);
	}

	static async exportJsonlSnapshot(ref: SessionReference, outputPath: string): Promise<{ lastOrdinal: number }> {
		const manager = await SessionManager.openReadOnly(ref);
		let result: { lastOrdinal: number };
		try {
			const header = manager.getHeader();
			if (!header) throw new Error("Cannot export a session without a header");
			const content = serializeSessionJsonlSnapshot(header, manager.getEntries(), manager.getLeafId());
			writeDurableAtomicFileSync(resolvePath(outputPath), content, {
				directoryMode: PRIVATE_DIRECTORY_MODE,
				fileMode: PRIVATE_FILE_MODE,
			});
			result = { lastOrdinal: manager.getOrdinal() };
		} catch (error) {
			try {
				await manager.closePersistence();
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session export failed and its manager could not be closed");
			}
			throw error;
		}
		await manager.closePersistence();
		return result;
	}

	/** Delete a stored session. Throws `ConversationLockedError` while the session is open for writing. */
	static async delete(ref: SessionReference, expectedOrdinal?: number): Promise<boolean> {
		const canonicalRef = parseSessionReference(ref);
		const lock = ConversationLock.acquire(resolvePath(canonicalRef.sessionDirectory), canonicalRef.sessionId);
		try {
			return await SessionManager._scopedStore(canonicalRef.sessionDirectory, async (store) => {
				if (store.info.storeId !== canonicalRef.storeId) {
					throw new Error("Session reference belongs to a different store");
				}
				const summary = await store.findSessionSummary(canonicalRef.sessionId, canonicalRef.sessionGeneration);
				if (!summary) return false;
				const result = await store.deleteSession({
					sessionId: canonicalRef.sessionId,
					sessionGeneration: canonicalRef.sessionGeneration,
					expectedOrdinal: expectedOrdinal ?? summary.lastOrdinal,
				});
				if (result.status === "conflict") {
					throw new Error(`Session changed before deletion (ordinal ${result.actualOrdinal})`);
				}
				return result.status === "deleted";
			});
		} finally {
			lock.close();
		}
	}

	static async listAll(onProgress?: SessionListProgress, options?: SessionListOptions): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		options?: SessionListOptions,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrOptions?: SessionListProgress | SessionListOptions,
		options?: SessionListOptions,
	): Promise<SessionInfo[]> {
		const customDir =
			typeof sessionDirOrOnProgress === "string" && sessionDirOrOnProgress
				? resolvePath(sessionDirOrOnProgress)
				: undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrOptions === "function"
					? onProgressOrOptions
					: undefined;
		const listOptions =
			typeof sessionDirOrOnProgress === "function"
				? (onProgressOrOptions as SessionListOptions | undefined)
				: typeof onProgressOrOptions === "object" && onProgressOrOptions !== null
					? onProgressOrOptions
					: options;
		if (customDir) {
			return SessionManager._scopedStore(customDir, async (store) => {
				const summaries = await store.listSessionSummaries({
					includeHidden: listOptions?.includeMessageFreeDurable,
				});
				progress?.(summaries.length, summaries.length);
				return summaries.map((summary) => sessionInfoFromStoreSummary(customDir, store.info.storeId, summary));
			});
		}

		const sessionsRoot = getSessionsDir();
		if (!existsSync(sessionsRoot)) return [];
		const directories = (await readdir(sessionsRoot, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(sessionsRoot, entry.name));
		const result: SessionInfo[] = [];
		const storeFailures: unknown[] = [];
		let successfulStores = 0;
		let loaded = 0;
		for (const directory of directories) {
			if (existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME))) {
				let storeResults: SessionInfo[] | undefined;
				try {
					storeResults = await SessionManager._scopedStore(directory, async (store) => {
						const summaries = await store.listSessionSummaries({
							includeHidden: listOptions?.includeMessageFreeDurable,
						});
						return summaries.map((summary) =>
							sessionInfoFromStoreSummary(directory, store.info.storeId, summary),
						);
					});
				} catch (error) {
					storeFailures.push(error);
				}
				if (storeResults) {
					successfulStores += 1;
					result.push(...storeResults);
				}
			}
			loaded += 1;
			progress?.(loaded, directories.length);
		}
		if (successfulStores === 0 && storeFailures.length > 0) {
			throw new AggregateError(storeFailures, "Could not list sessions from any project store");
		}
		return result.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}
}

/** @internal Runtime-only JSONL import; intentionally omitted from the package entry point. */
export function importSessionFromJsonlInMemory(inputPath: string, targetCwd?: string): Promise<SessionManager> {
	return importSessionFromJsonlInMemoryImpl(inputPath, targetCwd);
}
