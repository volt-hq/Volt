import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationLogEntryDraft } from "@hansjm10/volt-agent-core";
import type { Message } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/client.ts";
import { seedSession } from "../utilities/seed-log.ts";

const PROPERTY_SEED = 329_003;

async function withPropertyStore(run: (root: string, sessionDir: string) => Promise<void>): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "volt-session-projection-property-"));
	const sessionDir = join(root, "sessions");
	try {
		// Reuse only worker/schema setup. Every generated case, including shrinks, creates a fresh session.
		const lease = await acquireSharedSQLiteSessionStore(sessionDir);
		try {
			await run(root, sessionDir);
		} finally {
			await lease.release();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

type GeneratedOperation =
	| { kind: "user"; text: string; timestamp: number }
	| { kind: "assistant"; text: string; timestamp: number }
	| { kind: "custom_message"; text: string; display: boolean }
	| { kind: "custom"; value: string }
	| { kind: "name"; name: string }
	| { kind: "planning"; mode: "build" | "plan" };

type GeneratedStatefulOperation =
	| { kind: "branch_first" }
	| { kind: "reset" }
	| { kind: "label_first"; label: string; clear: boolean }
	| { kind: "client_input"; message: string }
	| { kind: "starting_git_null" }
	| { kind: "subagent"; suffix: string }
	| { kind: "compaction" }
	| { kind: "branch_summary" }
	| { kind: "rollback" };

const generatedOperation: fc.Arbitrary<GeneratedOperation> = fc.oneof(
	fc.record({
		kind: fc.constant("user" as const),
		text: fc.string({ maxLength: 30 }),
		timestamp: fc.integer({ min: 1_700_000_000_000, max: 1_700_100_000_000 }),
	}),
	fc.record({
		kind: fc.constant("assistant" as const),
		text: fc.string({ maxLength: 30 }),
		timestamp: fc.integer({ min: 1_700_000_000_000, max: 1_700_100_000_000 }),
	}),
	fc.record({
		kind: fc.constant("custom_message" as const),
		text: fc.string({ maxLength: 30 }),
		display: fc.boolean(),
	}),
	fc.record({ kind: fc.constant("custom" as const), value: fc.string({ maxLength: 30 }) }),
	fc.record({ kind: fc.constant("name" as const), name: fc.string({ maxLength: 30 }) }),
	fc.record({ kind: fc.constant("planning" as const), mode: fc.constantFrom("build" as const, "plan" as const) }),
);

const generatedStatefulOperation: fc.Arbitrary<GeneratedStatefulOperation> = fc.oneof(
	fc.constant({ kind: "branch_first" as const }),
	fc.constant({ kind: "reset" as const }),
	fc.record({
		kind: fc.constant("label_first" as const),
		label: fc.string({ maxLength: 20 }),
		clear: fc.boolean(),
	}),
	fc.record({ kind: fc.constant("client_input" as const), message: fc.string({ maxLength: 20 }) }),
	fc.constant({ kind: "starting_git_null" as const }),
	fc.record({ kind: fc.constant("subagent" as const), suffix: fc.stringMatching(/^[A-Za-z0-9]{1,8}$/) }),
	fc.constant({ kind: "compaction" as const }),
	fc.constant({ kind: "branch_summary" as const }),
	fc.constant({ kind: "rollback" as const }),
);

function assistantMessage(text: string, timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

/** The log form of a generated entry; every generated type is public, so each extends the branch. */
function logEntryBody(operation: GeneratedOperation): { type: string; payload: Record<string, unknown> } {
	switch (operation.kind) {
		case "user":
			return {
				type: "message",
				payload: { message: { role: "user", content: operation.text, timestamp: operation.timestamp } },
			};
		case "assistant":
			return { type: "message", payload: { message: assistantMessage(operation.text, operation.timestamp) } };
		case "custom_message":
			return {
				type: "custom_message",
				payload: { customType: "property", content: operation.text, display: operation.display },
			};
		case "custom":
			return { type: "custom", payload: { customType: "property", data: { value: operation.value } } };
		case "name":
			return { type: "session_info", payload: { name: operation.name } };
		case "planning":
			return { type: "planning_state_change", payload: { planning: { mode: operation.mode, plan: null } } };
	}
}

/** Commit `operations` to `manager` as one transaction, each entry a child of the one before. */
async function commitBatch(manager: SessionManager, operations: readonly GeneratedOperation[]): Promise<void> {
	const head = manager.getOrdinal();
	let parentId = manager.getLeafId();
	await seedSession(manager, (seed) => {
		for (const [index, operation] of operations.entries()) {
			const id = `batch-${head + index + 1}`;
			seed.drafts.push({
				...logEntryBody(operation),
				id,
				parentId,
				timestamp: new Date().toISOString(),
				visibility: "public",
			} as ConversationLogEntryDraft);
			parentId = id;
		}
	});
}

async function expectReplayMatches(manager: SessionManager, clientMessageIds: readonly string[] = []): Promise<void> {
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected a persisted property-test session");
	const reopened = await SessionManager.openReadOnly(ref);
	try {
		expect(reopened.getEntries()).toEqual(manager.getEntries());
		expect(reopened.getLeafId()).toBe(manager.getLeafId());
		expect(reopened.getSessionEntrySummary()).toEqual(manager.getSessionEntrySummary());
		expect(reopened.getSessionName()).toBe(manager.getSessionName());
		expect(reopened.getStartingGitContext()).toEqual(manager.getStartingGitContext());
		expect(reopened.getConversationState().context).toEqual(manager.getConversationState().context);
		expect(reopened.getTree()).toEqual(manager.getTree());
		expect(reopened.getSubagentSpawnEntries()).toEqual(manager.getSubagentSpawnEntries());
		for (const clientMessageId of clientMessageIds) {
			expect(reopened.getClientInput(clientMessageId)).toEqual(manager.getClientInput(clientMessageId));
		}
	} finally {
		await reopened.closePersistence();
	}
}

async function applyStatefulOperation(
	manager: SessionManager,
	operation: GeneratedStatefulOperation,
	index: number,
	clientMessageIds: string[],
): Promise<void> {
	const firstEntry = manager.getEntries()[0];
	switch (operation.kind) {
		case "branch_first":
			if (firstEntry) await manager.logWriter.branch(firstEntry.id);
			break;
		case "reset":
			await manager.logWriter.resetLeaf();
			break;
		case "label_first":
			if (firstEntry)
				await manager.logWriter.appendLabelChange(firstEntry.id, operation.clear ? undefined : operation.label);
			break;
		case "client_input": {
			const clientMessageId = `property-client-${index}`;
			clientMessageIds.push(clientMessageId);
			await seedSession(manager, (seed) =>
				seed.clientInput(
					clientMessageId,
					"steer",
					{ message: operation.message },
					{ queued: "steer", states: ["started", "completed"] },
				),
			);
			break;
		}
		case "starting_git_null":
			if (manager.getStartingGitContext() === undefined) {
				await manager.logWriter.recordStartingGitContext(null);
			}
			break;
		case "subagent":
			await manager.logWriter.appendSubagentSpawn({
				toolCallId: `call-${index}`,
				subagentId: `sa_${operation.suffix}`,
				agent: "researcher",
				childSessionId: `child-${index}`,
				requestKey: `request-${index}`,
			});
			break;
		case "compaction": {
			const branch = manager.getBranch();
			if (branch.length > 0) await manager.logWriter.appendCompaction("summary", branch[0]!.id, 1);
			break;
		}
		case "branch_summary":
			await manager.logWriter.branchWithSummary(manager.getLeafId(), "branch summary");
			break;
		case "rollback": {
			// A batch with one invalid entry commits nothing.
			const before = manager.getEntries();
			await expect(
				seedSession(manager, (seed) =>
					seed.custom("rolled-back", { index }).model({ api: "test-api", provider: "", id: "invalid" }),
				),
			).rejects.toMatchObject({ effect: "rolled_back" });
			expect(manager.getEntries()).toEqual(before);
			break;
		}
	}
}

describe("session projection reducer properties", () => {
	it(`keeps incremental and replay state equal across transaction partitions (seed ${PROPERTY_SEED})`, async () => {
		await withPropertyStore(async (root, sessionDir) => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(generatedOperation, { minLength: 1, maxLength: 8 }),
					fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
					async (operations, cuts) => {
						const cwd = mkdtempSync(join(root, "workspace-"));
						let manager: SessionManager | undefined;
						try {
							manager = await SessionManager.create(cwd, sessionDir);
							expect(manager.getEntries()).toEqual([]);
							let batch: GeneratedOperation[] = [];
							for (const [index, operation] of operations.entries()) {
								batch.push(operation);
								if (index !== operations.length - 1 && cuts[index % cuts.length] !== true) continue;
								await commitBatch(manager, batch);
								batch = [];
								await expectReplayMatches(manager);
							}
						} finally {
							await manager?.closePersistence();
						}
					},
				),
				{ seed: PROPERTY_SEED, numRuns: 20 },
			);
		});
	}, 60_000);

	it(`keeps stateful projections replayable across branch, metadata, and rollback operations (seed ${PROPERTY_SEED + 1})`, async () => {
		await withPropertyStore(async (root, sessionDir) => {
			await fc.assert(
				fc.asyncProperty(
					fc.array(generatedStatefulOperation, { minLength: 1, maxLength: 10 }),
					async (operations) => {
						const cwd = mkdtempSync(join(root, "workspace-"));
						let manager: SessionManager | undefined;
						const clientMessageIds: string[] = [];
						try {
							manager = await SessionManager.create(cwd, sessionDir);
							expect(manager.getEntries()).toEqual([]);
							await manager.logWriter.appendMessage({
								role: "user",
								content: "seed",
								timestamp: 1_700_000_000_000,
							});
							for (const [index, operation] of operations.entries()) {
								await applyStatefulOperation(manager, operation, index, clientMessageIds);
								await expectReplayMatches(manager, clientMessageIds);
							}
						} finally {
							await manager?.closePersistence();
						}
					},
				),
				{ seed: PROPERTY_SEED + 1, numRuns: 15 },
			);
		});
	}, 60_000);
});
