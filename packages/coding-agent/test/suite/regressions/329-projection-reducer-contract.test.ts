import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcGitContext } from "../../../src/core/rpc/types.ts";
import {
	type BranchSummaryEntry,
	CLIENT_INPUT_MAX_OUTSTANDING_BYTES,
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	createClientInputSemanticDigest,
	type LabelEntry,
	type SessionEntry,
	SessionManager,
	type SessionTreeNode,
} from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	digestSessionStoreTransactionPayload,
	SESSION_STORE_DATABASE_FILENAME,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInputWrite,
	type SessionStoreEntryWrite,
	type SessionStoreJsonValue,
	type SessionStoreSessionProjection,
	type SessionStoreTransactionPayload,
	SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import { createSessionManagerTestOwner } from "../../session-manager-owner.ts";
import { seedSession } from "../../utilities/seed-log.ts";

const CREATED_AT = "2026-09-03T12:00:00.000Z";
const SECOND_AT = "2026-09-03T12:01:00.000Z";
const LARGE_CLIENT_INPUT_TEXT = "x".repeat(500_000);
const PROJECTION_PROPERTY_SEED = 329_103;

interface ClientInputFixture {
	readonly entries: readonly SessionStoreEntryWrite[];
	readonly projection: SessionStoreClientInputWrite;
}

interface OpenLowLevelStore {
	readonly client: SQLiteSessionStoreClient;
	readonly sessionId: string;
	readonly sessionGeneration: string;
}

const managerOwner = createSessionManagerTestOwner();
const clients: SQLiteSessionStoreClient[] = [];
const leases = new Set<SQLiteSessionStoreLease>();
let root = "";

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string | undefined {
	return error instanceof Error ? error.message : undefined;
}

function messageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	return content
		.filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function captureAsyncError(operation: () => Promise<unknown>): Promise<unknown> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error;
	}
}

/** The writes a session manager's own commit lane builds one batch from, before a live session takes its log. */
interface SessionManagerWrite {
	place(entry: SessionEntry): string;
	label(entry: LabelEntry): string;
	leaf(leafId: string | null): void;
	branchWithSummary(branchFromId: string | null, entry: BranchSummaryEntry): string;
}

type SessionMutation = (write: SessionManagerWrite) => unknown;

/** Commit `mutations` as one atomic batch through the manager's commit lane; ids and parents come from the lane. */
async function commitBatch(manager: SessionManager, mutations: readonly SessionMutation[]): Promise<void> {
	const internals = manager as unknown as {
		_commit<T>(build: (write: SessionManagerWrite) => T, atomic?: boolean): Promise<T>;
	};
	await internals._commit((write) => {
		for (const mutation of mutations) mutation(write);
	}, true);
}

/** Commit one entry; returns its id. */
async function commitEntry(manager: SessionManager, entry: SessionEntry): Promise<string> {
	let id = "";
	await commitBatch(manager, [
		(write) => {
			id = write.place(entry);
		},
	]);
	return id;
}

/** Envelope fields the commit lane replaces: the id and parent of the new entry. */
function envelope(): { id: string; parentId: null; timestamp: string } {
	return { id: "pending", parentId: null, timestamp: CREATED_AT };
}

function generationFor(sessionId: string): string {
	return `generation:${sessionId}:1`;
}

function sessionProjection(overrides: Partial<SessionStoreSessionProjection> = {}): SessionStoreSessionProjection {
	return {
		updatedAt: CREATED_AT,
		startingGitContextRecorded: false,
		startingGitContext: null,
		name: null,
		visible: false,
		leafId: null,
		messageCount: 0,
		firstMessage: "",
		...overrides,
	};
}

function storePayload(
	options: {
		readonly session?: Partial<SessionStoreSessionProjection>;
		readonly entries?: readonly SessionStoreEntryWrite[];
		readonly clientInputs?: readonly SessionStoreClientInputWrite[];
		readonly searchChunks?: SessionStoreTransactionPayload["searchChunks"];
	} = {},
): SessionStoreTransactionPayload {
	return {
		session: sessionProjection(options.session),
		entries: options.entries ?? [],
		clientInputs: options.clientInputs ?? [],
		searchChunks: options.searchChunks ?? [],
	};
}

function transaction(
	sessionId: string,
	sessionGeneration: string,
	expectedOrdinal: number,
	commitId: string,
	payload: SessionStoreTransactionPayload,
): SessionStoreApplyTransactionInput {
	return {
		sessionId,
		sessionGeneration,
		expectedOrdinal,
		commitId,
		digest: digestSessionStoreTransactionPayload(payload),
		payload,
	};
}

function entryWrite(entry: SessionStoreJsonValue): SessionStoreEntryWrite {
	return { entry };
}

function acceptedReceiptFixture(prefix: string, index: number, ordinal: number, message: string): ClientInputFixture {
	const clientMessageId = `${prefix}-client-${index}`;
	const receiptEntryId = `${prefix}-receipt-${index}`;
	const input = { message, images: [] };
	const semanticDigest = createClientInputSemanticDigest("steer", input);
	return {
		entries: [
			entryWrite({
				type: "client_input_receipt",
				id: receiptEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal,
				clientMessageId,
				command: "steer",
				semanticDigest,
				input,
			}),
		],
		projection: {
			clientMessageId,
			receiptEntryId,
			command: "steer",
			origin: null,
			semanticDigest,
			input,
			queuedEntryId: null,
			queuedInput: null,
			state: "accepted",
			error: null,
			canonicalEntryId: null,
		},
	};
}

function queuedReceiptFixture(
	prefix: string,
	index: number,
	firstOrdinal: number,
	message: string,
): ClientInputFixture {
	const clientMessageId = `${prefix}-client-${index}`;
	const receiptEntryId = `${prefix}-receipt-${index}`;
	const queuedEntryId = `${prefix}-queued-${index}`;
	const input = { message, images: [] };
	const queuedInput = { delivery: "steer" as const, message, images: [] };
	const semanticDigest = createClientInputSemanticDigest("steer", input);
	return {
		entries: [
			entryWrite({
				type: "client_input_receipt",
				id: receiptEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal: firstOrdinal,
				clientMessageId,
				command: "steer",
				semanticDigest,
				input,
			}),
			entryWrite({
				type: "client_input_queued",
				id: queuedEntryId,
				parentId: null,
				timestamp: CREATED_AT,
				ordinal: firstOrdinal + 1,
				receiptId: receiptEntryId,
				clientMessageId,
				queuedInput,
			}),
		],
		projection: {
			clientMessageId,
			receiptEntryId,
			command: "steer",
			origin: null,
			semanticDigest,
			input,
			queuedEntryId,
			queuedInput,
			state: "accepted",
			error: null,
			canonicalEntryId: null,
		},
	};
}

function fixturesPayload(fixtures: readonly ClientInputFixture[]): SessionStoreTransactionPayload {
	return storePayload({
		entries: fixtures.flatMap((fixture) => fixture.entries),
		clientInputs: fixtures.map((fixture) => fixture.projection),
	});
}

function clientInputProjectionBytes(fixture: ClientInputFixture): number {
	return (
		Buffer.byteLength(JSON.stringify(fixture.projection.input), "utf8") +
		(fixture.projection.queuedInput === null
			? 0
			: Buffer.byteLength(JSON.stringify(fixture.projection.queuedInput), "utf8"))
	);
}

async function openLowLevelStore(name: string): Promise<OpenLowLevelStore> {
	const sessionDirectory = join(root, name);
	const sessionId = `${name}-session`;
	const sessionGeneration = generationFor(sessionId);
	const client = await SQLiteSessionStoreClient.open(sessionDirectory);
	clients.push(client);
	await client.createHiddenSession({
		id: sessionId,
		sessionGeneration,
		formatVersion: 5,
		cwd: root,
		createdAt: CREATED_AT,
		parentSessionDirectory: null,
		parentStoreId: null,
		parentSessionId: null,
		parentSessionGeneration: null,
		origin: null,
	});
	return { client, sessionId, sessionGeneration };
}

function userMessageWrite(
	id: string,
	ordinal: number,
	content: string,
	timestamp: string,
	parentId: string | null,
): SessionStoreEntryWrite {
	return entryWrite({
		type: "message",
		id,
		parentId,
		timestamp,
		ordinal,
		message: { role: "user", content, timestamp: Date.parse(timestamp) },
	});
}

function firstSearchableMessagePayload(): SessionStoreTransactionPayload {
	return storePayload({
		session: {
			visible: true,
			leafId: "message-1",
			messageCount: 1,
			firstMessage: "first searchable",
		},
		entries: [userMessageWrite("message-1", 1, "first searchable", CREATED_AT, null)],
		searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
	});
}

interface TransactionProjectionMismatchCase {
	readonly name: string;
	malformedPayload(canonical: SessionStoreTransactionPayload): SessionStoreTransactionPayload;
}

const TRANSACTION_PROJECTION_MISMATCH_CASES: readonly TransactionProjectionMismatchCase[] = [
	{
		name: "rejects omission of the canonical message's required search chunk",
		malformedPayload: (canonical) => ({ ...canonical, searchChunks: [] }),
	},
	{
		name: "rejects a supplied search chunk whose text disagrees with the canonical message",
		malformedPayload: (canonical) => ({
			...canonical,
			searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "different search text" }],
		}),
	},
];

async function seedSearchableMessage(store: OpenLowLevelStore): Promise<void> {
	const payload = firstSearchableMessagePayload();
	const result = await store.client.applyTransaction(
		transaction(store.sessionId, store.sessionGeneration, 0, `${store.sessionId}-seed`, payload),
	);
	if (result.status !== "committed") throw new Error("Could not seed low-level searchable session");
}

function findTreeNode(manager: SessionManager, entryId: string): SessionTreeNode | undefined {
	const pending = [...manager.getTree()];
	while (pending.length > 0) {
		const node = pending.shift()!;
		if (node.entry.id === entryId) return node;
		pending.push(...node.children);
	}
	return undefined;
}

function clearedLabelState(manager: SessionManager, targetId: string): object {
	const treeNode = findTreeNode(manager, targetId);
	return {
		label: manager.getLabel(targetId),
		treeLabel: treeNode?.label,
		treeLabelTimestamp: treeNode?.labelTimestamp,
		leafType: manager.getLeafEntry()?.type,
		labelEntries: manager
			.getEntries()
			.filter((entry) => entry.type === "label")
			.map((entry) => ({ targetId: entry.targetId, label: entry.label })),
		summary: manager.getSessionEntrySummary(),
		messages: manager.getConversationState().context.messages.map((message) => ({
			role: message.role,
			text: messageText(message),
		})),
	};
}

function replayComparableState(manager: SessionManager, targetId: string, clientMessageId?: string): object {
	return {
		entries: manager.getEntries(),
		leafId: manager.getLeafId(),
		tree: manager.getTree(),
		summary: manager.getSessionEntrySummary(),
		name: manager.getSessionName(),
		startingGitContext: manager.getStartingGitContext(),
		context: manager.getConversationState().context,
		label: manager.getLabel(targetId),
		subagentSpawns: manager.getSubagentSpawnEntries(),
		clientInput: clientMessageId === undefined ? undefined : manager.getClientInput(clientMessageId),
		recovery: clientInputRecovery(manager.getConversationState()),
	};
}

async function expectReplayMatches(manager: SessionManager, targetId: string, clientMessageId?: string): Promise<void> {
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected persisted session reference");
	const reopened = await SessionManager.openReadOnly(ref);
	try {
		expect(replayComparableState(reopened, targetId, clientMessageId)).toEqual(
			replayComparableState(manager, targetId, clientMessageId),
		);
	} finally {
		await reopened.closePersistence();
	}
}

type PropertyThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ProjectionPropertyScenario {
	readonly label: string;
	readonly clearWithEmpty: boolean;
	readonly thinkingLevel: PropertyThinkingLevel;
	readonly modelId: string;
	readonly fastModeEnabled: boolean;
	readonly gitContextKind: "null" | "value";
	readonly gitRevision: number;
	readonly clientInputMessage: string;
	readonly completeClientInput: boolean;
	readonly failure: string;
	readonly batchWidths: readonly number[];
}

const propertyToken = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const projectionPropertyScenario: fc.Arbitrary<ProjectionPropertyScenario> = fc.record({
	label: propertyToken,
	clearWithEmpty: fc.boolean(),
	thinkingLevel: fc.constantFrom("off", "minimal", "low", "medium", "high", "xhigh", "max"),
	modelId: propertyToken.map((suffix) => `property-model-${suffix}`),
	fastModeEnabled: fc.boolean(),
	gitContextKind: fc.constantFrom("null", "value"),
	gitRevision: fc.integer({ min: 1, max: 10 }),
	clientInputMessage: propertyToken.map((suffix) => `queued-${suffix}`),
	completeClientInput: fc.boolean(),
	failure: propertyToken.map((suffix) => `failure-${suffix}`),
	batchWidths: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 6 }),
});

function partitionMutations(rootEntryId: string, scenario: ProjectionPropertyScenario): SessionMutation[] {
	return [
		(write) => write.label({ type: "label", ...envelope(), targetId: rootEntryId, label: scenario.label }),
		(write) => write.leaf(null),
		(write) => write.leaf(rootEntryId),
		(write) =>
			write.branchWithSummary(rootEntryId, {
				type: "branch_summary",
				...envelope(),
				fromId: rootEntryId,
				summary: "retained branch summary",
				details: { source: "partition" },
				fromHook: true,
			}),
		(write) => write.place({ type: "thinking_level_change", ...envelope(), thinkingLevel: scenario.thinkingLevel }),
		(write) =>
			write.place({ type: "model_change", ...envelope(), provider: "property-provider", modelId: scenario.modelId }),
		(write) =>
			write.place({
				type: "custom_message",
				...envelope(),
				customType: "partition-visible",
				content: [{ type: "text", text: "partition visible text" }],
				display: true,
				details: { retained: true },
			}),
		(write) =>
			write.place({
				type: "custom_message",
				...envelope(),
				customType: "partition-hidden",
				content: "partition hidden text",
				display: false,
			}),
		(write) => write.place({ type: "session_info", ...envelope(), name: "Partition name" }),
		(write) => write.place({ type: "session_info", ...envelope(), name: "" }),
		(write) => write.place({ type: "planning_state_change", ...envelope(), planning: { mode: "plan", plan: null } }),
		(write) =>
			write.label({
				type: "label",
				...envelope(),
				targetId: rootEntryId,
				...(scenario.clearWithEmpty ? { label: "" } : {}),
			}),
		(write) => write.place({ type: "custom", ...envelope(), customType: "partition-data", data: { retained: true } }),
		(write) =>
			write.place({
				type: "compaction",
				...envelope(),
				summary: "partition compaction",
				firstKeptEntryId: rootEntryId,
				tokensBefore: 42,
				details: { retained: true },
				fromHook: true,
			}),
	];
}

function partitionByWidths<T>(values: readonly T[], widths: readonly number[]): T[][] {
	const partitions: T[][] = [];
	let offset = 0;
	let widthIndex = 0;
	while (offset < values.length) {
		const width = widths[widthIndex % widths.length]!;
		partitions.push(values.slice(offset, offset + width));
		offset += width;
		widthIndex++;
	}
	return partitions;
}

function propertyGitContext(scenario: ProjectionPropertyScenario): RpcGitContext | null {
	if (scenario.gitContextKind === "null") return null;
	const emptyChanges = { added: 0, modified: 0, deleted: 0, renamed: 0 };
	return {
		repository: "projection-property",
		head: { kind: "branch", name: "main", oid: "a".repeat(40) },
		upstream: null,
		base: null,
		status: {
			staged: emptyChanges,
			unstaged: emptyChanges,
			untracked: 0,
			conflicted: 0,
			total: 0,
			clean: true,
		},
		operation: null,
		revision: scenario.gitRevision,
		observedAt: CREATED_AT,
		stale: false,
	};
}

function partitionFinalState(manager: SessionManager, rootEntryId: string, clientMessageId: string): object {
	const state = manager.getConversationState();
	const context = state.context;
	const clientInput = manager.getClientInput(clientMessageId);
	return {
		entryTypes: manager.getEntries().map((entry) => entry.type),
		leafType: manager.getLeafEntry()?.type,
		summary: {
			messageCount: manager.getSessionEntrySummary().messageCount,
			firstMessage: manager.getSessionEntrySummary().firstMessage,
		},
		name: manager.getSessionName(),
		label: manager.getLabel(rootEntryId),
		startingGitContext: manager.getStartingGitContext(),
		context: {
			thinkingLevel: context.thinkingLevel,
			model: context.model,
			fastMode: context.fastMode,
			planning: state.planning,
			messages: context.messages.map((message) => ({ role: message.role, text: messageText(message) })),
		},
		subagentSpawns: manager.getSubagentSpawnEntries().map((entry) => ({
			toolCallId: entry.toolCallId,
			subagentId: entry.subagentId,
			agent: entry.agent,
			childSessionId: entry.childSessionId,
			requestKey: entry.requestKey,
		})),
		clientInput:
			clientInput === undefined
				? undefined
				: {
						clientMessageId: clientInput.clientMessageId,
						command: clientInput.command,
						input: clientInput.input,
						queuedInput: clientInput.queuedInput,
						state: clientInput.state,
						error: clientInput.error,
					},
		recoveryKind: clientInputRecovery(manager.getConversationState()).kind,
	};
}

async function runProjectionPropertyPartition(
	caseId: number,
	variant: string,
	scenario: ProjectionPropertyScenario,
	batchWidths: readonly number[],
): Promise<object> {
	const cwd = join(root, `property-${caseId}-${variant}-workspace`);
	const sessionDir = join(root, `property-${caseId}-${variant}-sessions`);
	const sessionId = `property-${caseId}-${variant}`;
	mkdirSync(cwd, { recursive: true });
	const manager = await SessionManager.create(cwd, sessionDir, { id: sessionId });
	const rootEntryId = await manager.logWriter.appendMessage({
		role: "user",
		content: "partition root",
		timestamp: Date.parse(CREATED_AT),
	});
	await expectReplayMatches(manager, rootEntryId);

	const mutations = partitionMutations(rootEntryId, scenario);
	for (const batch of partitionByWidths(mutations, batchWidths)) {
		await commitBatch(manager, batch);
		await expectReplayMatches(manager, rootEntryId);
	}

	await manager.logWriter.appendFastModeChange(scenario.fastModeEnabled);
	await expectReplayMatches(manager, rootEntryId);
	expect(await manager.logWriter.recordStartingGitContext(propertyGitContext(scenario))).toBe(true);
	await expectReplayMatches(manager, rootEntryId);
	await manager.logWriter.appendSubagentSpawn({
		toolCallId: `property-call-${caseId}`,
		subagentId: `sa_property_${caseId}`,
		agent: "researcher",
		childSessionId: `property-child-${caseId}`,
		requestKey: `property-request-${caseId}`,
	});
	await expectReplayMatches(manager, rootEntryId);
	const clientMessageId = `property-client-${caseId}`;
	const input = { message: scenario.clientInputMessage, images: [] };
	const receiptId = await commitEntry(manager, {
		type: "client_input_receipt",
		...envelope(),
		clientMessageId,
		command: "steer",
		semanticDigest: createClientInputSemanticDigest("steer", input),
		input,
	});
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	await commitEntry(manager, {
		type: "client_input_queued",
		...envelope(),
		receiptId,
		clientMessageId,
		queuedInput: { delivery: "steer", ...input },
	});
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	await commitEntry(manager, {
		type: "client_input_state",
		...envelope(),
		receiptId,
		clientMessageId,
		state: "started",
	});
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	if (scenario.completeClientInput) {
		await manager.logWriter.appendMessage({
			role: "user",
			content: scenario.clientInputMessage,
			timestamp: Date.parse(SECOND_AT),
			clientMessageId,
		});
	} else {
		await commitEntry(manager, {
			type: "client_input_state",
			...envelope(),
			receiptId,
			clientMessageId,
			state: "failed",
			error: scenario.failure,
		});
	}
	await expectReplayMatches(manager, rootEntryId, clientMessageId);

	const beforeRollback = replayComparableState(manager, rootEntryId, clientMessageId);
	const originalApplyTransaction = SQLiteSessionStoreClient.prototype.applyTransaction;
	let injectedRollback = false;
	const applyTransaction = vi
		.spyOn(SQLiteSessionStoreClient.prototype, "applyTransaction")
		.mockImplementation(function (this: SQLiteSessionStoreClient, input) {
			if (!injectedRollback && input.sessionId === manager.getSessionId()) {
				injectedRollback = true;
				return Promise.reject(new Error("Injected pre-commit persistence failure"));
			}
			return originalApplyTransaction.call(this, input);
		});
	let rollbackError: unknown;
	try {
		rollbackError = await captureAsyncError(() =>
			commitBatch(manager, [
				(write) => write.place({ type: "custom", ...envelope(), customType: "must-roll-back", data: { caseId } }),
			]),
		);
	} finally {
		applyTransaction.mockRestore();
	}
	expect(injectedRollback).toBe(true);
	expect(rollbackError).toMatchObject({ effect: "rolled_back" });
	expect(replayComparableState(manager, rootEntryId, clientMessageId)).toEqual(beforeRollback);
	await expectReplayMatches(manager, rootEntryId, clientMessageId);
	expect(
		(await SessionManager.search(cwd, "partition visible text", sessionDir)).map((session) => session.id),
	).toEqual([sessionId]);
	return partitionFinalState(manager, rootEntryId, clientMessageId);
}

beforeEach(() => {
	managerOwner.start();
	root = mkdtempSync(join(tmpdir(), "volt-329-projection-reducer-"));
});

afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		await managerOwner.drain();
	} catch (error) {
		cleanupErrors.push(error);
	}
	for (const lease of [...leases]) {
		try {
			await lease.release();
		} catch (error) {
			cleanupErrors.push(error);
		}
		leases.delete(lease);
	}
	for (const client of clients.splice(0).reverse()) {
		try {
			await client.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
	if (cleanupErrors.length === 1) throw cleanupErrors[0];
	if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Projection reducer test cleanup failed");
});

describe("PR #329 projection reducer contract", () => {
	describe("low-level client-input admission", () => {
		it("rejects an outstanding receipt beyond the incremental reducer count limit without mutation", async () => {
			const store = await openLowLevelStore("count-limit");
			const atLimit = Array.from({ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES }, (_, index) =>
				acceptedReceiptFixture("count", index, index + 1, `message-${index}`),
			);
			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "count-at-limit", fixturesPayload(atLimit)),
			);

			const incrementalOracle = SessionManager.inMemory(root);
			for (let index = 0; index < CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES; index++) {
				await seedSession(incrementalOracle, (seed) =>
					seed.clientInput(`count-oracle-${index}`, "steer", { message: `message-${index}` }),
				);
			}
			const oracleError = await captureAsyncError(() =>
				seedSession(incrementalOracle, (seed) =>
					seed.clientInput("count-oracle-overflow", "steer", { message: "overflow" }),
				),
			);

			const overflow = acceptedReceiptFixture(
				"count",
				CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
				CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES + 1,
				"overflow",
			);
			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(
						store.sessionId,
						store.sessionGeneration,
						CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
						"count-overflow",
						fixturesPayload([overflow]),
					),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				seedStatus: seeded.status,
				oracleRejected: oracleError instanceof Error,
				lowLevelErrorCode: errorCode(lowLevelError),
				lastOrdinal: snapshot?.session.lastOrdinal,
				clientInputCount: snapshot?.clientInputs.length,
				hasOverflow: snapshot?.clientInputs.some(
					(record) => record.clientMessageId === overflow.projection.clientMessageId,
				),
			}).toEqual({
				seedStatus: "committed",
				oracleRejected: true,
				lowLevelErrorCode: "constraint_failed",
				lastOrdinal: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
				clientInputCount: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
				hasOverflow: false,
			});
		});

		it("rejects aggregate outstanding bytes beyond the incremental reducer budget without mutation", async () => {
			const store = await openLowLevelStore("byte-limit");
			const atLimit = Array.from({ length: 16 }, (_, index) =>
				queuedReceiptFixture("bytes", index, index * 2 + 1, LARGE_CLIENT_INPUT_TEXT),
			);
			const overflow = queuedReceiptFixture(
				"bytes",
				atLimit.length,
				atLimit.length * 2 + 1,
				LARGE_CLIENT_INPUT_TEXT,
			);
			const admittedBytes = atLimit.reduce((total, fixture) => total + clientInputProjectionBytes(fixture), 0);
			const overflowBytes = admittedBytes + clientInputProjectionBytes(overflow);
			expect(admittedBytes).toBeLessThanOrEqual(CLIENT_INPUT_MAX_OUTSTANDING_BYTES);
			expect(overflowBytes).toBeGreaterThan(CLIENT_INPUT_MAX_OUTSTANDING_BYTES);

			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "bytes-at-limit", fixturesPayload(atLimit)),
			);

			const incrementalOracle = SessionManager.inMemory(root);
			const largeInput = { message: LARGE_CLIENT_INPUT_TEXT, images: [] };
			const queueLargeInput = (clientMessageId: string, receiptId: string) =>
				commitEntry(incrementalOracle, {
					type: "client_input_queued",
					...envelope(),
					receiptId,
					clientMessageId,
					queuedInput: { delivery: "steer", ...largeInput },
				});
			const receiveLargeInput = async (clientMessageId: string) => {
				const [receipt] = await seedSession(incrementalOracle, (seed) =>
					seed.clientInput(clientMessageId, "steer", largeInput),
				);
				return receipt!.id;
			};
			for (let index = 0; index < atLimit.length; index++) {
				const clientMessageId = `bytes-oracle-${index}`;
				await queueLargeInput(clientMessageId, await receiveLargeInput(clientMessageId));
			}
			const overflowReceiptId = await receiveLargeInput("bytes-oracle-overflow");
			const oracleError = await captureAsyncError(() => queueLargeInput("bytes-oracle-overflow", overflowReceiptId));

			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(
						store.sessionId,
						store.sessionGeneration,
						atLimit.length * 2,
						"bytes-overflow",
						fixturesPayload([overflow]),
					),
				),
			);
			const summary = await store.client.findSessionSummary(store.sessionId, store.sessionGeneration);

			expect({
				seedStatus: seeded.status,
				oracleRejected: oracleError instanceof Error,
				lowLevelErrorCode: errorCode(lowLevelError),
				lastOrdinal: summary?.lastOrdinal,
			}).toEqual({
				seedStatus: "committed",
				oracleRejected: true,
				lowLevelErrorCode: "constraint_failed",
				lastOrdinal: atLimit.length * 2,
			});
		}, 60_000);

		it("keeps recoverable queued inputs within the externally shared outstanding-entry bound", async () => {
			const store = await openLowLevelStore("queue-limit");
			const sharedBound = Math.min(CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES, CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES);
			const atLimit = Array.from({ length: sharedBound }, (_, index) =>
				queuedReceiptFixture("queue", index, index * 2 + 1, `queued-${index}`),
			);
			const seeded = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, "queue-at-limit", fixturesPayload(atLimit)),
			);

			// Every recoverable queued item is also outstanding. This black-box case
			// verifies their shared external bound, not which equal internal guard fires first.
			const overflow = queuedReceiptFixture("queue", sharedBound, sharedBound * 2 + 1, "overflow");
			const lowLevelError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(
						store.sessionId,
						store.sessionGeneration,
						sharedBound * 2,
						"queue-overflow",
						fixturesPayload([overflow]),
					),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);
			const recoverableCount = snapshot?.clientInputs.filter(
				(record) => record.state === "accepted" && record.queuedInput !== null,
			).length;

			expect({
				seedStatus: seeded.status,
				lowLevelErrorCode: errorCode(lowLevelError),
				lastOrdinal: snapshot?.session.lastOrdinal,
				recoverableCount,
			}).toEqual({
				seedStatus: "committed",
				lowLevelErrorCode: "constraint_failed",
				lastOrdinal: sharedBound * 2,
				recoverableCount: sharedBound,
			});
		});
	});

	describe("malformed retained projection classification", () => {
		it.each([
			{
				component: "summary" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE sessions SET updated_at = 'not-a-timestamp' WHERE id = ?")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained summary projection");
				},
			},
			{
				component: "client_inputs" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare(
							`UPDATE client_inputs SET input_json = '{ "images":[],"message":"pending"}' WHERE session_id = ?`,
						)
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained client-input projection");
				},
			},
			{
				component: "search_chunks" as const,
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE search_chunks SET chunk_index = 9007199254740992 WHERE session_id = ?")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt retained search projection");
				},
			},
		])("classifies malformed $component data and releases the failed-open lease", async ({ component, mutate }) => {
			const cwd = join(root, `corruption-${component}-workspace`);
			const sessionDir = join(root, `corruption-${component}-sessions`);
			mkdirSync(cwd, { recursive: true });
			const manager = await SessionManager.create(cwd, sessionDir, { id: `malformed-${component}` });
			await manager.logWriter.appendMessage({
				role: "user",
				content: "searchable",
				timestamp: Date.parse(CREATED_AT),
			});
			await seedSession(manager, (seed) =>
				seed.clientInput(`pending-${component}`, "prompt", { message: "pending" }),
			);
			const ref = manager.getSessionRef();
			if (!ref) throw new Error("Expected persisted corruption reference");
			await manager.closePersistence();

			const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
			let foreignKeysValid = false;
			try {
				mutate(database, ref.sessionId);
				foreignKeysValid = database.prepare("PRAGMA foreign_key_check").all().length === 0;
			} finally {
				database.close();
			}

			const openError = await captureAsyncError(() => SessionManager.open(ref));
			const probeLease = await acquireSharedSQLiteSessionStore(sessionDir);
			leases.add(probeLease);
			const close = vi.spyOn(probeLease.client, "close");
			await probeLease.release();
			leases.delete(probeLease);
			const releasedFinalLease = close.mock.calls.length === 1;
			if (!releasedFinalLease) await probeLease.client.close();

			expect({
				foreignKeysValid,
				openErrorCode: errorCode(openError),
				openErrorMessage: errorMessage(openError),
				releasedFinalLease,
			}).toEqual({
				foreignKeysValid: true,
				openErrorCode: "session_store_projection_integrity",
				openErrorMessage: `Session store ${component} projection does not match canonical entries`,
				releasedFinalLease: true,
			});
		});
	});

	describe("canonical entry integrity classification", () => {
		it.each([
			{
				name: "malformed canonical payload",
				slug: "payload",
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE entries SET payload_json = '{}' WHERE session_id = ? AND ordinal = 1")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt the canonical entry payload");
				},
				read(database: DatabaseSync, sessionId: string): unknown {
					return database
						.prepare("SELECT payload_json AS value FROM entries WHERE session_id = ? AND ordinal = 1")
						.get(sessionId)?.value;
				},
				expectedStoredValue: "{}",
			},
			{
				name: "canonical payload and envelope mismatch",
				slug: "envelope",
				mutate(database: DatabaseSync, sessionId: string): void {
					const result = database
						.prepare("UPDATE entries SET entry_type = 'custom' WHERE session_id = ? AND ordinal = 1")
						.run(sessionId);
					if (result.changes !== 1) throw new Error("Could not corrupt the canonical entry envelope");
				},
				read(database: DatabaseSync, sessionId: string): unknown {
					return database
						.prepare("SELECT entry_type AS value FROM entries WHERE session_id = ? AND ordinal = 1")
						.get(sessionId)?.value;
				},
				expectedStoredValue: "custom",
			},
		])("classifies $name without repair and releases the failed-open lease", async (testCase) => {
			const cwd = join(root, `entry-integrity-${testCase.slug}-workspace`);
			const sessionDir = join(root, `entry-integrity-${testCase.slug}-sessions`);
			mkdirSync(cwd, { recursive: true });
			const corrupted = await SessionManager.create(cwd, sessionDir, {
				id: `corrupted-${testCase.slug}`,
			});
			await corrupted.logWriter.appendMessage({
				role: "user",
				content: "corrupt me",
				timestamp: Date.parse(CREATED_AT),
			});
			const corruptedRef = corrupted.getSessionRef();
			if (!corruptedRef) throw new Error("Expected a persisted corrupted-session reference");
			const healthy = await SessionManager.create(cwd, sessionDir, { id: `healthy-${corruptedRef.sessionId}` });
			await healthy.logWriter.appendMessage({
				role: "user",
				content: "healthy sibling",
				timestamp: Date.parse(SECOND_AT),
			});
			const healthyRef = healthy.getSessionRef();
			if (!healthyRef) throw new Error("Expected a persisted healthy-session reference");
			await Promise.all([corrupted.closePersistence(), healthy.closePersistence()]);

			const database = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME));
			let foreignKeysValid = false;
			try {
				testCase.mutate(database, corruptedRef.sessionId);
				foreignKeysValid = database.prepare("PRAGMA foreign_key_check").all().length === 0;
			} finally {
				database.close();
			}

			const openError = await captureAsyncError(() => SessionManager.open(corruptedRef));
			const probeLease = await acquireSharedSQLiteSessionStore(sessionDir);
			leases.add(probeLease);
			const close = vi.spyOn(probeLease.client, "close");
			await probeLease.release();
			leases.delete(probeLease);
			const releasedFinalLease = close.mock.calls.length === 1;
			if (!releasedFinalLease) await probeLease.client.close();
			const reopenedHealthy = await SessionManager.open(healthyRef);
			const unchanged = new DatabaseSync(join(sessionDir, SESSION_STORE_DATABASE_FILENAME), { readOnly: true });
			let storedCorruption: unknown;
			try {
				storedCorruption = testCase.read(unchanged, corruptedRef.sessionId);
			} finally {
				unchanged.close();
			}

			expect({
				foreignKeysValid,
				openErrorCode: errorCode(openError),
				openErrorMessage: errorMessage(openError),
				releasedFinalLease,
				storedCorruption,
				healthyMessages: reopenedHealthy.getConversationState().context.messages.map(messageText),
			}).toEqual({
				foreignKeysValid: true,
				openErrorCode: "session_store_entry_integrity",
				openErrorMessage: "Session store canonical entries are invalid or inconsistent",
				releasedFinalLease: true,
				storedCorruption: testCase.expectedStoredValue,
				healthyMessages: ["healthy sibling"],
			});
		});
	});

	describe("batch-local canonical search projection agreement", () => {
		it.each(TRANSACTION_PROJECTION_MISMATCH_CASES)("$name at write time", async ({ name, malformedPayload }) => {
			const store = await openLowLevelStore(
				`projection-${TRANSACTION_PROJECTION_MISMATCH_CASES.findIndex((testCase) => testCase.name === name)}`,
			);
			const canonicalPayload = firstSearchableMessagePayload();
			const rejection = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(
						store.sessionId,
						store.sessionGeneration,
						0,
						`${store.sessionId}-malformed`,
						malformedPayload(canonicalPayload),
					),
				),
			);
			const afterRejection = await store.client.loadSession(store.sessionId, store.sessionGeneration);
			const corrected = await store.client.applyTransaction(
				transaction(store.sessionId, store.sessionGeneration, 0, `${store.sessionId}-corrected`, canonicalPayload),
			);
			const afterCorrected = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(rejection),
				rejectedOrdinal: afterRejection?.session.lastOrdinal,
				rejectedSummary: afterRejection
					? {
							visible: afterRejection.session.visible,
							leafId: afterRejection.session.leafId,
							messageCount: afterRejection.session.messageCount,
							firstMessage: afterRejection.session.firstMessage,
						}
					: undefined,
				rejectedEntryIds: afterRejection?.entries.map((entry) => entry.id),
				rejectedChunks: afterRejection?.searchChunks,
				correctedStatus: corrected.status,
				correctedOrdinal: afterCorrected?.session.lastOrdinal,
				correctedSummary: afterCorrected
					? {
							visible: afterCorrected.session.visible,
							leafId: afterCorrected.session.leafId,
							messageCount: afterCorrected.session.messageCount,
							firstMessage: afterCorrected.session.firstMessage,
						}
					: undefined,
				correctedEntryIds: afterCorrected?.entries.map((entry) => entry.id),
				correctedChunks: afterCorrected?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				rejectedOrdinal: 0,
				rejectedSummary: { visible: false, leafId: null, messageCount: 0, firstMessage: "" },
				rejectedEntryIds: [],
				rejectedChunks: [],
				correctedStatus: "committed",
				correctedOrdinal: 1,
				correctedSummary: {
					visible: true,
					leafId: "message-1",
					messageCount: 1,
					firstMessage: "first searchable",
				},
				correctedEntryIds: ["message-1"],
				correctedChunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});
	});

	describe("search chunk canonical identity", () => {
		it("rejects rewriting an existing search chunk without a corresponding canonical entry", async () => {
			const store = await openLowLevelStore("search-rewrite");
			await seedSearchableMessage(store);
			const rewritePayload = storePayload({
				session: {
					updatedAt: SECOND_AT,
					name: "renamed",
					visible: true,
					leafId: "session-info-2",
					messageCount: 1,
					firstMessage: "first searchable",
				},
				entries: [
					entryWrite({
						type: "session_info",
						id: "session-info-2",
						parentId: "message-1",
						timestamp: SECOND_AT,
						ordinal: 2,
						name: "renamed",
					}),
				],
				searchChunks: [{ chunkIndex: 0, entryId: "message-1", text: "rewritten text" }],
			});
			const rewriteError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "rewrite-existing-chunk", rewritePayload),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(rewriteError),
				lastOrdinal: snapshot?.session.lastOrdinal,
				chunks: snapshot?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				lastOrdinal: 1,
				chunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});

		it("rejects a new chunk whose entry identity differs from its canonical searchable entry", async () => {
			const store = await openLowLevelStore("search-identity");
			await seedSearchableMessage(store);
			const invalidIdentityPayload = storePayload({
				session: {
					updatedAt: SECOND_AT,
					visible: true,
					leafId: "message-2",
					messageCount: 2,
					firstMessage: "first searchable",
				},
				entries: [userMessageWrite("message-2", 2, "second searchable", SECOND_AT, "message-1")],
				searchChunks: [{ chunkIndex: 1, entryId: "message-1", text: "second searchable" }],
			});
			const identityError = await captureAsyncError(() =>
				store.client.applyTransaction(
					transaction(store.sessionId, store.sessionGeneration, 1, "wrong-search-entry", invalidIdentityPayload),
				),
			);
			const snapshot = await store.client.loadSession(store.sessionId, store.sessionGeneration);

			expect({
				errorCode: errorCode(identityError),
				lastOrdinal: snapshot?.session.lastOrdinal,
				entryIds: snapshot?.entries.map((entry) => entry.id),
				chunks: snapshot?.searchChunks,
			}).toEqual({
				errorCode: "constraint_failed",
				lastOrdinal: 1,
				entryIds: ["message-1"],
				chunks: [{ chunkIndex: 0, entryId: "message-1", text: "first searchable" }],
			});
		});
	});

	describe("fork and import label clearing", () => {
		it("keeps a committed cleared label cleared through fork construction and reopen", async () => {
			const cwd = join(root, "fork-source-workspace");
			const sourceDir = join(root, "fork-source-sessions");
			mkdirSync(cwd, { recursive: true });
			const source = await SessionManager.create(cwd, sourceDir, { id: "clear-label-fork-source" });
			const targetId = await source.logWriter.appendMessage({
				role: "user",
				content: "fork retained",
				timestamp: Date.parse(CREATED_AT),
			});
			await source.logWriter.appendLabelChange(targetId, "temporary");
			await source.logWriter.appendLabelChange(targetId, undefined);
			const committedPrefix = clearedLabelState(source, targetId);
			const sourceRef = source.getSessionRef();
			if (!sourceRef) throw new Error("Expected source reference");

			const forkCwd = join(root, "fork-target-workspace");
			const forkDir = join(root, "fork-target-sessions");
			mkdirSync(forkCwd, { recursive: true });
			const forked = await SessionManager.forkFrom(sourceRef, forkCwd, forkDir, { id: "clear-label-fork" });
			const reopened = await SessionManager.openReadOnly(forked.getSessionRef()!);

			expect(committedPrefix).toEqual({
				label: undefined,
				treeLabel: undefined,
				treeLabelTimestamp: undefined,
				leafType: "label",
				labelEntries: [
					{ targetId, label: "temporary" },
					{ targetId, label: undefined },
				],
				summary: { messageCount: 1, firstMessage: "fork retained", lastActivityTime: Date.parse(CREATED_AT) },
				messages: [{ role: "user", text: "fork retained" }],
			});
			// A fork copies the branch without its label history, so the cleared label stays cleared.
			const copiedState = { ...committedPrefix, leafType: "message", labelEntries: [] };
			expect(clearedLabelState(forked, targetId)).toEqual(copiedState);
			expect(clearedLabelState(reopened, targetId)).toEqual(copiedState);
			expect((await SessionManager.search(forkCwd, "fork retained", forkDir)).map((session) => session.id)).toEqual([
				"clear-label-fork",
			]);
		});

		it("keeps a committed empty-cleared label cleared through snapshot import and reopen", async () => {
			const cwd = join(root, "import-source-workspace");
			const sourceDir = join(root, "import-source-sessions");
			mkdirSync(cwd, { recursive: true });
			const source = await SessionManager.create(cwd, sourceDir, { id: "clear-label-import-source" });
			const targetId = await source.logWriter.appendMessage({
				role: "user",
				content: "import retained",
				timestamp: Date.parse(CREATED_AT),
			});
			await source.logWriter.appendLabelChange(targetId, "temporary");
			await source.logWriter.appendLabelChange(targetId, "");
			const committedPrefix = clearedLabelState(source, targetId);
			const sourceRef = source.getSessionRef();
			if (!sourceRef) throw new Error("Expected source reference");

			const snapshotPath = join(root, "clear-label.jsonl");
			await SessionManager.exportJsonlSnapshot(sourceRef, snapshotPath);
			const importCwd = join(root, "import-target-workspace");
			const importDir = join(root, "import-target-sessions");
			mkdirSync(importCwd, { recursive: true });
			const imported = await SessionManager.importFromJsonl(snapshotPath, importCwd, importDir, {
				id: "clear-label-import",
			});
			const reopened = await SessionManager.openReadOnly(imported.getSessionRef()!);

			expect(committedPrefix).toEqual({
				label: undefined,
				treeLabel: undefined,
				treeLabelTimestamp: undefined,
				leafType: "label",
				labelEntries: [
					{ targetId, label: "temporary" },
					{ targetId, label: "" },
				],
				summary: { messageCount: 1, firstMessage: "import retained", lastActivityTime: Date.parse(CREATED_AT) },
				messages: [{ role: "user", text: "import retained" }],
			});
			// An import copies the branch without its label history, so the cleared label stays cleared.
			const copiedState = { ...committedPrefix, leafType: "message", labelEntries: [] };
			expect(clearedLabelState(imported, targetId)).toEqual(copiedState);
			expect(clearedLabelState(reopened, targetId)).toEqual(copiedState);
			expect(
				(await SessionManager.search(importCwd, "import retained", importDir)).map((session) => session.id),
			).toEqual(["clear-label-import"]);
		});
	});

	it(`keeps generated legal partitions and stateful rollback replay-equivalent (seed ${PROJECTION_PROPERTY_SEED})`, async () => {
		let caseId = 0;
		await fc.assert(
			fc.asyncProperty(projectionPropertyScenario, async (scenario) => {
				const currentCaseId = caseId++;
				const oneBatch = await runProjectionPropertyPartition(currentCaseId, "one-batch", scenario, [
					Number.MAX_SAFE_INTEGER,
				]);
				const generatedPartition = await runProjectionPropertyPartition(
					currentCaseId,
					"generated",
					scenario,
					scenario.batchWidths,
				);
				expect(generatedPartition).toEqual(oneBatch);
			}),
			{ seed: PROJECTION_PROPERTY_SEED, numRuns: 8 },
		);
	}, 60_000);
});
