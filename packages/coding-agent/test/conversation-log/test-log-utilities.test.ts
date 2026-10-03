import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Conversation,
	ConversationError,
	type ConversationLog,
	type ConversationLogEntry,
	fold,
	InMemoryConversationLog,
} from "@hansjm10/volt-agent-core";
import { fauxToolCall } from "@hansjm10/volt-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SqliteConversationLog } from "../../src/core/conversation-log/sqlite-conversation-log.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { FaultyConversationLog, lose } from "../utilities/faulty-log.ts";
import { type LogSeed, seedLog } from "../utilities/seed-log.ts";

const MODEL = { api: "test-api", provider: "test", id: "model" };
const OTHER_MODEL = { api: "test-api", provider: "other", id: "other-model" };
const AT = Date.parse("2026-05-01T00:00:00.000Z");

let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "volt-test-log-utilities-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

async function readAll(log: ConversationLog): Promise<readonly ConversationLogEntry[]> {
	return (await log.read(0, 1_000)).entries;
}

const call = fauxToolCall("read", { path: "README.md" }, { id: "call-1" });

/** Every builder method, ending on a branch switched back to the first prompt. */
function everything(seed: LogSeed): void {
	seed
		.model(MODEL)
		.thinking("high")
		.user("first prompt", { id: "first" })
		.assistant("", { toolCalls: [call], usage: { input: 40, totalTokens: 40 } })
		.toolResult(call.id, "readme contents")
		.assistant("done reading")
		.label("checkpoint")
		.user("second prompt")
		.compaction({ summary: "earlier work", tokensBefore: 500 })
		.custom("extension-state", { step: 2 })
		.model(OTHER_MODEL)
		.assistant("answer from another model")
		.leaf("first")
		.branchSummary("abandoned the second prompt");
}

describe("seedLog", () => {
	it("seeds the same valid entries into in-memory and SQLite logs", async () => {
		const memory = new InMemoryConversationLog("seeded-memory");
		const sqlite = await SqliteConversationLog.create({ sessionDirectory: join(root, "sessions"), cwd: root });
		try {
			const seeded = await seedLog(memory, everything, { model: MODEL, at: AT });
			expect(await seedLog(sqlite, everything, { model: MODEL, at: AT })).toEqual(seeded);
			expect(await readAll(sqlite)).toEqual(await readAll(memory));
			expect(seeded.map((entry) => entry.ordinal)).toEqual(seeded.map((_, index) => index + 1));

			const state = fold(await readAll(memory));
			expect(state.leafId).toBe(seeded.at(-1)?.id);
			expect(state.context.thinkingLevel).toBe("high");
			expect(state.context.model).toEqual({ provider: "test", modelId: "model" });
			expect(state.context.messages.map((message) => message.role)).toEqual(["user", "branchSummary"]);
			const answer = seeded.find((entry) => entry.type === "message" && entry.id === "seed-12");
			expect(answer?.payload).toMatchObject({ message: { provider: "other", model: "other-model" } });
			expect(seeded.find((entry) => entry.type === "label")?.payload).toEqual({
				targetId: "seed-6",
				label: "checkpoint",
			});
			expect(seeded.find((entry) => entry.type === "compaction")?.payload).toMatchObject({
				firstKeptEntryId: "seed-8",
			});
		} finally {
			await sqlite.close();
		}
	});

	it("appends a later seed on the active branch", async () => {
		const log = new InMemoryConversationLog("seeded-twice");
		await seedLog(log, (seed) => seed.user("hello", { id: "u1" }).assistant("hi").leaf("u1"));
		const [next] = await seedLog(log, (seed) => seed.assistant("again"));
		expect(next).toMatchObject({ ordinal: 4, id: "seed-4", parentId: "u1" });
		expect(await seedLog(log, () => undefined)).toEqual([]);
	});

	it("opens an in-memory session manager over a seeded log", async () => {
		const log = new InMemoryConversationLog("seeded-session");
		await seedLog(log, everything, { model: MODEL });
		const manager = await SessionManager.openInMemory(log);
		const state = fold(await readAll(log));
		expect(manager.getSessionId()).toBe("seeded-session");
		expect(manager.isPersisted()).toBe(false);
		expect(manager.getOrdinal()).toBe(state.ordinal);
		expect(manager.getLeafId()).toBe(state.leafId);
		expect(manager.getLabel("seed-6")).toBe("checkpoint");
		expect(manager.getConversationState().context.messages).toEqual(state.context.messages);
		// The manager writes through the log it was opened over.
		await manager.logWriter.appendCustomEntry("after-seed");
		expect(log.head()).toBe(state.ordinal + 1);
	});
});

describe("FaultyConversationLog", () => {
	it("injects rollbacks and losses into a conversation kernel", async () => {
		const log = new FaultyConversationLog(new InMemoryConversationLog("faulty-kernel"));
		const conversation = await Conversation.open({
			log,
			stream: () => {
				throw new Error("No request is expected");
			},
			resolveModel: () => undefined,
		});
		log.failNext("rolled_back");
		await expect(conversation.setName("rolled back")).rejects.toMatchObject({ code: "commit_rolled_back" });
		expect(conversation.state.name).toBeNull();
		await conversation.setName("committed");
		expect(conversation.state.name).toBe("committed");
		log.failNext(lose("storage"));
		await expect(conversation.setName("lost")).rejects.toBeInstanceOf(ConversationError);
		expect(await conversation.ended).toMatchObject({ reason: "storage" });
		expect(log.faulted).toHaveLength(2);
		await conversation.close();
	});

	it("injects rollbacks and losses into a session manager", async () => {
		const log = new FaultyConversationLog(new InMemoryConversationLog("faulty-manager"));
		const manager = await SessionManager.openInMemory(log);
		log.failNext("rolled_back");
		await expect(manager.logWriter.appendCustomEntry("rolled-back")).rejects.toThrow();
		expect(manager.getEntries()).toEqual([]);
		await manager.logWriter.appendCustomEntry("committed");
		expect(manager.getEntries()).toHaveLength(1);
		log.failNext(lose("storage", { committed: true }));
		await expect(manager.logWriter.appendCustomEntry("lost")).rejects.toThrow();
		expect(await manager.lost).toMatchObject({ reason: "storage" });
		await expect(manager.logWriter.appendCustomEntry("after loss")).rejects.toThrow();
	});
});
