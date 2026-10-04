// Regression for #585 (RFC §4.4): fork, clone, and import create a log whose
// first entry records its lineage, followed by a copy of the branch path.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import {
	type CommittedSessionEntry,
	importSessionFromJsonlInMemory,
	type SessionEntry,
	SessionManager,
} from "../../../src/core/session-manager.ts";
import { replaySessionEntries } from "../../../src/core/session-store/projection.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const managers: SessionManager[] = [];
const runtimes: AgentSessionRuntime[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose();
	for (const manager of managers.splice(0).reverse()) await manager.closePersistence();
	for (const harness of harnesses.splice(0).reverse()) await harness.cleanupAsync();
});

async function persistedHarness(): Promise<Harness> {
	const harness = await createHarness({ log: "sqlite", settings: { lsp: { enabled: false } } });
	harnesses.push(harness);
	return harness;
}

function own(manager: SessionManager): SessionManager {
	managers.push(manager);
	return manager;
}

/** Every committed entry of a manager's log, host records included. */
async function logEntries(manager: SessionManager): Promise<CommittedSessionEntry[]> {
	return (await manager.readEntries(0, 1_000)).entries;
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function text(entry: SessionEntry): string | undefined {
	return entry.type === "message" && entry.message.role === "user" ? getMessageText(entry.message) : undefined;
}

describe("#585 forked_from lineage", () => {
	it("clones a live session's branch after its lineage, without host records or client identities", async () => {
		const harness = await persistedHarness();
		harness.setResponses([fauxAssistantMessage("first reply"), fauxAssistantMessage("second reply")]);
		await harness.session.prompt("first", { clientMessageId: "client-first" });
		await harness.session.prompt("second", { clientMessageId: "client-second" });
		const source = harness.sessionManager;
		const firstId = source.getEntries().find((entry) => text(entry) === "first")!.id;
		await harness.session.sessionWriter.appendLabelChange(firstId, "start");
		const leafId = source.getLeafId()!;
		const copied = source.getBranch(leafId).filter((entry) => entry.type !== "label");

		const clone = own(await SessionManager.createBranched(source, leafId));
		const entries = await logEntries(clone);

		expect(entries[0]).toMatchObject({
			type: "forked_from",
			ordinal: 1,
			parentId: null,
			sessionId: source.getSessionId(),
			entryId: leafId,
		});
		// The branch path keeps its ids; its parents are relinked and its ordinals reassigned.
		expect(entries.slice(1, copied.length + 1).map((entry) => entry.id)).toEqual(copied.map((entry) => entry.id));
		expect(entries[1]?.parentId).toBeNull();
		expect(entries.map((entry) => entry.ordinal)).toEqual(entries.map((_, index) => index + 1));
		expect(entries.slice(copied.length + 1)).toMatchObject([{ type: "label", targetId: firstId, label: "start" }]);
		expect(entries.some((entry) => entry.type === "message" && entry.clientMessageId !== undefined)).toBe(false);
		expect(entries.filter((entry) => entry.type.startsWith("client_input_"))).toEqual([]);
		expect(clone.getForkedFrom()).toEqual({ sessionId: source.getSessionId(), entryId: leafId });
		expect(clone.getHeader()?.parentSession).toEqual(source.getSessionRef());
		expect(clone.getLabel(firstId)).toBe("start");
		expect(clone.getConversationState().context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);

		const cloneRef = clone.getSessionRef()!;
		await clone.closePersistence();
		const reopened = own(await SessionManager.openReadOnly(cloneRef));
		expect(reopened.getForkedFrom()).toEqual({ sessionId: source.getSessionId(), entryId: leafId });
		expect(await logEntries(reopened)).toEqual(entries);
	});

	it("forks before the first message into a log holding only its lineage", async () => {
		const harness = await persistedHarness();
		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.prompt("first");
		const source = harness.sessionManager;

		const fork = own(await SessionManager.createBranched(source, null));

		expect(await logEntries(fork)).toMatchObject([
			{ type: "forked_from", ordinal: 1, parentId: null, sessionId: source.getSessionId(), entryId: null },
		]);
		expect(fork.getForkedFrom()).toEqual({ sessionId: source.getSessionId(), entryId: null });
		expect(fork.getLeafId()).toBeNull();
		expect(fork.getEntries()).toEqual([]);
		expect(fork.getHeader()?.parentSession).toEqual(source.getSessionRef());
	});

	it("copies an in-memory source from its open log", async () => {
		const source = SessionManager.inMemory("/workspace", { id: "memory-source" });
		const firstId = await source.logWriter.appendMessage(user("first"));
		await source.logWriter.appendMessage(fauxAssistantMessage("reply"));

		const fork = await SessionManager.createBranched(source, firstId);

		expect(fork.isPersisted()).toBe(false);
		expect(fork.getForkedFrom()).toEqual({ sessionId: "memory-source", entryId: firstId });
		expect((await logEntries(fork)).map((entry) => [entry.type, entry.id])).toEqual([
			["forked_from", expect.any(String)],
			["message", firstId],
		]);
		expect(fork.getHeader()?.parentSession).toBeUndefined();
	});

	it("forks a stored session's active branch for --fork under the requested id", async () => {
		const harness = await persistedHarness();
		const sessionDir = join(harness.tempDir, "stored");
		const source = own(await SessionManager.create(harness.tempDir, sessionDir));
		const rootId = await source.logWriter.appendMessage(user("root"));
		await source.logWriter.appendMessage(user("abandoned"));
		await source.logWriter.branch(rootId);
		const activeId = await source.logWriter.appendMessage(user("active"));
		const sourceRef = source.getSessionRef()!;

		const forkDir = join(harness.tempDir, "forks");
		const fork = own(await SessionManager.forkFrom(sourceRef, harness.tempDir, forkDir, { id: "requested-fork" }));

		expect(fork.getSessionId()).toBe("requested-fork");
		expect(fork.getForkedFrom()).toEqual({ sessionId: sourceRef.sessionId, entryId: activeId });
		expect(fork.getHeader()?.parentSession).toEqual(sourceRef);
		expect((await logEntries(fork)).map((entry) => [entry.type, text(entry)])).toEqual([
			["forked_from", undefined],
			["message", "root"],
			["message", "active"],
		]);
		expect(fork.getLeafId()).toBe(activeId);
	});

	it("imports a snapshot under a new id unless one is named, with the snapshot as lineage", async () => {
		const harness = await persistedHarness();
		const sessionDir = join(harness.tempDir, "stored");
		const parent = own(await SessionManager.create(harness.tempDir, sessionDir));
		await parent.logWriter.appendMessage(user("parent"));
		// A fork's snapshot carries its parent locator in the header.
		const child = await SessionManager.createBranched(parent, parent.getLeafId());
		const rootId = await child.logWriter.appendMessage(user("root"));
		await child.logWriter.appendMessage(user("abandoned"));
		await child.logWriter.branch(rootId);
		const activeId = await child.logWriter.appendMessage(user("active"));
		const childRef = child.getSessionRef()!;
		await child.closePersistence();
		const snapshotPath = join(harness.tempDir, "child.jsonl");
		await SessionManager.exportJsonlSnapshot(childRef, snapshotPath);
		const lineage = { sessionId: childRef.sessionId, entryId: activeId };

		const importDir = join(harness.tempDir, "imports");
		const first = own(await SessionManager.importFromJsonl(snapshotPath, harness.tempDir, importDir));
		const second = own(await SessionManager.importFromJsonl(snapshotPath, harness.tempDir, importDir));
		const named = own(
			await SessionManager.importFromJsonl(snapshotPath, harness.tempDir, importDir, { id: "named-import" }),
		);
		const inMemory = await importSessionFromJsonlInMemory(snapshotPath, harness.tempDir);

		expect(new Set([first, second, named, inMemory].map((manager) => manager.getSessionId())).size).toBe(4);
		expect([first, second, inMemory].map((manager) => manager.getSessionId())).not.toContain(childRef.sessionId);
		expect(named.getSessionId()).toBe("named-import");
		for (const imported of [first, second, named, inMemory]) {
			expect(imported.getForkedFrom()).toEqual(lineage);
			// The snapshot's parent locator is not carried; the lineage names the snapshot.
			expect(imported.getHeader()?.parentSession).toBeUndefined();
			expect((await logEntries(imported)).map((entry) => [entry.type, text(entry)])).toEqual([
				["forked_from", undefined],
				["message", "parent"],
				["message", "root"],
				["message", "active"],
			]);
		}
		expect(inMemory.getSessionRef()).toBeUndefined();
	});

	it("imports a snapshot of an empty branch as lineage alone", async () => {
		const harness = await persistedHarness();
		const sessionDir = join(harness.tempDir, "stored");
		const empty = await SessionManager.create(harness.tempDir, sessionDir);
		const emptyRef = empty.getSessionRef()!;
		await empty.closePersistence();
		const snapshotPath = join(harness.tempDir, "empty.jsonl");
		await SessionManager.exportJsonlSnapshot(emptyRef, snapshotPath);

		const imported = own(await SessionManager.importFromJsonl(snapshotPath, harness.tempDir, sessionDir));

		expect(imported.getForkedFrom()).toEqual({ sessionId: emptyRef.sessionId, entryId: null });
		expect((await logEntries(imported)).map((entry) => entry.type)).toEqual(["forked_from"]);
	});

	it("keeps lineage the first entry of its log", async () => {
		const header = {
			type: "session" as const,
			version: 5,
			id: "projection",
			timestamp: new Date().toISOString(),
			cwd: "/workspace",
		};
		const message = { type: "message" as const, id: "m", parentId: null, timestamp: header.timestamp, ordinal: 1 };
		const lineage = {
			type: "forked_from" as const,
			id: "l",
			parentId: null,
			timestamp: header.timestamp,
			sessionId: "source",
			entryId: null,
		};
		expect(() =>
			replaySessionEntries(header, [
				{ ...message, message: user("first") },
				{ ...lineage, ordinal: 2 },
			]),
		).toThrow("Lineage entry l must be the first entry of its session");
		expect(replaySessionEntries(header, [{ ...lineage, ordinal: 1 }]).forkedFrom).toEqual({
			sessionId: "source",
			entryId: null,
		});
	});

	it("writes lineage when the runtime forks before the first message or clones", async () => {
		const harness = await persistedHarness();
		const cwd = join(harness.tempDir, "workspace");
		mkdirSync(cwd, { recursive: true });
		const initial = await SessionManager.create(cwd, join(harness.tempDir, "sessions"));
		// The first user message is the root, so forking before it copies an empty branch.
		const firstId = await initial.logWriter.appendMessage(user("hello"));
		const replyId = await initial.logWriter.appendMessage(fauxAssistantMessage("hi"));
		const branchIds = initial.getBranch(replyId).map((entry) => entry.id);
		const sourceRef = initial.getSessionRef()!;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			agentDir,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				noTools: "all",
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: harness.tempDir,
			sessionManager: initial,
		});
		runtimes.push(runtime);
		await runtime.session.bindExtensions({});

		await expect(runtime.fork(replyId, { position: "at" })).resolves.toMatchObject({ cancelled: false });
		const clone = runtime.session.sessionManager;
		expect(clone.getForkedFrom()).toEqual({ sessionId: sourceRef.sessionId, entryId: replyId });
		expect(clone.getBranch(replyId).map((entry) => entry.id)).toEqual(branchIds);
		expect((await logEntries(clone))[0]).toMatchObject({ type: "forked_from", ordinal: 1 });
		const cloneRef = clone.getSessionRef()!;

		await expect(runtime.fork(firstId)).resolves.toMatchObject({ cancelled: false, selectedText: "hello" });
		const fork = runtime.session.sessionManager;
		expect(fork.getForkedFrom()).toEqual({ sessionId: cloneRef.sessionId, entryId: null });
		expect(fork.getHeader()?.parentSession).toEqual(cloneRef);
		// The opened session may record its starting policy after the lineage; no message is copied.
		expect((await logEntries(fork))[0]).toMatchObject({ type: "forked_from", ordinal: 1 });
		expect(fork.getEntries().filter((entry) => entry.type === "message")).toEqual([]);
	});
});
