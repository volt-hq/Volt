import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ClientInputConflictError, ClientInputOutcomeAmbiguousError } from "../src/core/agent-session.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import {
	type ClientInputCommand,
	getDefaultSessionDir,
	type SessionEntry,
	SessionManager,
} from "../src/core/session-manager.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	createRemoteConversationTranscriptPage,
	listRemoteWorkspaceSessionSummaries,
} from "../src/daemon/conversation-commands.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";

function digestClientInput(command: ClientInputCommand, message: string): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				command,
				message,
				images: [],
				...(command === "prompt" ? { streamingBehavior: null } : {}),
			}),
		)
		.digest("hex");
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `volt-client-input-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

function createAuthorization(workspacePath: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-idempotency-test",
			label: "test",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

describe("durable client input idempotency", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("joins concurrent prompt duplicates and replays completed admission without another model run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("only once")]);

		const options = { clientMessageId: "client-prompt-1" } as const;
		const original = harness.session.prompt("hello", options);
		const duplicate = harness.session.prompt("hello", options);
		await Promise.all([original, duplicate]);

		expect(getUserTexts(harness)).toEqual(["hello"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.sessionManager.getClientInput("client-prompt-1")).toMatchObject({
			command: "prompt",
			state: "completed",
		});

		await harness.session.prompt("hello", options);
		expect(getUserTexts(harness)).toEqual(["hello"]);
	});

	it("rejects reuse of an id for a different semantic input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("original", { clientMessageId: "client-conflict" });

		await expect(harness.session.prompt("different", { clientMessageId: "client-conflict" })).rejects.toBeInstanceOf(
			ClientInputConflictError,
		);
		expect(getUserTexts(harness)).toEqual(["original"]);
	});

	it("includes exact ordered image bytes and streaming behavior in the semantic identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("image done"), fauxAssistantMessage("behavior done")]);
		const firstImage = { type: "image" as const, mimeType: "image/png", data: "Zmlyc3Q=" };
		const secondImage = { type: "image" as const, mimeType: "image/jpeg", data: "c2Vjb25k" };

		await harness.session.prompt("images", {
			clientMessageId: "client-images",
			images: [firstImage, secondImage],
		});
		await expect(
			harness.session.prompt("images", {
				clientMessageId: "client-images",
				images: [secondImage, firstImage],
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);
		await expect(
			harness.session.prompt("images", {
				clientMessageId: "client-images",
				images: [firstImage, { ...secondImage, data: "Y2hhbmdlZA==" }],
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);

		await harness.session.prompt("behavior", {
			clientMessageId: "client-behavior",
			streamingBehavior: "steer",
		});
		await expect(
			harness.session.prompt("behavior", {
				clientMessageId: "client-behavior",
				streamingBehavior: "followUp",
			}),
		).rejects.toBeInstanceOf(ClientInputConflictError);
	});

	it("replays a definitive preflight failure instead of dispatching a retry", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		const first = harness.session.prompt("cannot start", { clientMessageId: "client-failed" });
		await expect(first).rejects.toThrow("No API key found");
		const failedRecord = harness.sessionManager.getClientInput("client-failed");
		expect(failedRecord).toMatchObject({ command: "prompt", state: "failed" });

		await expect(harness.session.prompt("cannot start", { clientMessageId: "client-failed" })).rejects.toThrow(
			"No API key found",
		);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("keeps transport-owned identity when an extension replaces a user message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return { message: { ...event.message, clientMessageId: "extension-hijack" } };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("identity", { clientMessageId: "transport-owned" });

		const user = harness.session.messages.find((message) => message.role === "user");
		expect(user?.clientMessageId).toBe("transport-owned");
		expect(harness.sessionManager.getClientInput("transport-owned")?.state).toBe("completed");
		expect(harness.sessionManager.getClientInput("extension-hijack")).toBeUndefined();
	});

	it("enqueues duplicate steer and follow-up inputs once and rejects cross-command id reuse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await Promise.all([
			harness.session.steer("steer once", undefined, "client-steer"),
			harness.session.steer("steer once", undefined, "client-steer"),
		]);
		await Promise.all([
			harness.session.followUp("follow once", undefined, "client-follow"),
			harness.session.followUp("follow once", undefined, "client-follow"),
		]);

		expect(harness.session.getSteeringMessages()).toEqual(["steer once"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["follow once"]);
		await expect(harness.session.followUp("steer once", undefined, "client-steer")).rejects.toBeInstanceOf(
			ClientInputConflictError,
		);

		harness.session.clearQueue();
		expect(harness.sessionManager.getClientInput("client-steer")?.state).toBe("failed");
		expect(harness.sessionManager.getClientInput("client-follow")?.state).toBe("failed");
	});

	it("does not fail a queued input cleared after its irreversible dequeue boundary", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for the test gate",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		let stateImmediatelyAfterClear: string | undefined;
		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				event.message.clientMessageId === "client-consuming"
			) {
				harness.session.clearQueue();
				stateImmediatelyAfterClear = harness.sessionManager.getClientInput("client-consuming")?.state;
			}
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("consume me", undefined, "client-consuming");
		releaseTool();
		await run;

		expect(stateImmediatelyAfterClear).toBe("started");
		expect(harness.sessionManager.getClientInput("client-consuming")?.state).toBe("completed");
	});

	it("starts an accepted-but-not-started receipt after JSONL reload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-accepted", "prompt", digestClientInput("prompt", "resume me"));
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		const reopened = SessionManager.open(sessionFile!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("resumed")]);

		await harness.session.prompt("resume me", { clientMessageId: "client-accepted" });
		expect(getUserTexts(harness)).toEqual(["resume me"]);
		expect(reopened.getClientInput("client-accepted")?.state).toBe("completed");
	});

	it("fails closed for a started receipt with no terminal record after JSONL reload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-started", "prompt", digestClientInput("prompt", "do not replay"));
		manager.transitionClientInput("client-started", "started");
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!, tempDir);
		const harness = await createHarness({ sessionManager: reopened });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(
			harness.session.prompt("do not replay", { clientMessageId: "client-started" }),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("infers completion from the canonical user entry when rebuilding the all-entry index", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		manager.reserveClientInput("client-canonical", "prompt", digestClientInput("prompt", "committed"));
		manager.transitionClientInput("client-canonical", "started");
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "committed" }],
			clientMessageId: "client-canonical",
			timestamp: Date.now(),
		});
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(reopened.getClientInput("client-canonical")?.state).toBe("completed");
		expect(reopened.buildSessionContext().messages).toHaveLength(1);
	});

	it("replays completed and failed terminal outcomes after reopening the JSONL", async () => {
		const completedDir = createTempDir();
		const failedDir = createTempDir();
		tempDirs.push(completedDir, failedDir);

		const completed = SessionManager.create(completedDir, completedDir);
		completed.reserveClientInput("persisted-complete", "prompt", digestClientInput("prompt", "already done"));
		completed.transitionClientInput("persisted-complete", "started");
		completed.appendMessage({
			role: "user",
			content: [{ type: "text", text: "already done" }],
			clientMessageId: "persisted-complete",
			timestamp: Date.now(),
		});
		const reopenedCompleted = SessionManager.open(completed.getSessionFile()!, completedDir);
		const completedHarness = await createHarness({ sessionManager: reopenedCompleted });
		harnesses.push(completedHarness);
		completedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await completedHarness.session.prompt("already done", { clientMessageId: "persisted-complete" });
		expect(completedHarness.getPendingResponseCount()).toBe(1);
		expect(reopenedCompleted.buildSessionContext().messages).toHaveLength(1);

		const failed = SessionManager.create(failedDir, failedDir);
		failed.reserveClientInput("persisted-failed", "prompt", digestClientInput("prompt", "still failed"));
		failed.transitionClientInput("persisted-failed", "started");
		failed.transitionClientInput("persisted-failed", "failed", "persisted precommit failure");
		const reopenedFailed = SessionManager.open(failed.getSessionFile()!, failedDir);
		const failedHarness = await createHarness({ sessionManager: reopenedFailed });
		harnesses.push(failedHarness);
		failedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await expect(
			failedHarness.session.prompt("still failed", { clientMessageId: "persisted-failed" }),
		).rejects.toThrow("persisted precommit failure");
		expect(failedHarness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(failedHarness)).toEqual([]);
	});

	it("keeps host WAL out of every public conversation and bootstrap projection", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const observedEntryTypes: string[] = [];
		manager.subscribeEntries((entry) => observedEntryTypes.push(entry.type));
		const receipt = manager.reserveClientInput("private-wal", "prompt", digestClientInput("prompt", "visible later"));
		manager.transitionClientInput("private-wal", "started");
		const persistedTypes = readFileSync(manager.getSessionFile()!, "utf8")
			.trim()
			.split("\n")
			.map((line) => (JSON.parse(line) as { type: string }).type);
		expect(persistedTypes).toEqual(["session", "client_input_receipt", "client_input_state"]);

		expect(observedEntryTypes).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getEntry(receipt.record.receiptId)).toBeUndefined();
		expect(manager.getChildren(receipt.record.receiptId)).toEqual([]);
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getBranch(receipt.record.receiptId)).toEqual([]);
		expect(manager.getBranchWindow({ maxEntries: 10 })).toMatchObject({ entries: [], lookback: [] });
		expect(manager.getBranchWindow({ maxEntries: 10, beforeEntryId: receipt.record.receiptId })).toBeUndefined();
		expect(manager.getTree()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getLabel(receipt.record.receiptId)).toBeUndefined();
		expect(manager.buildSessionContext().messages).toEqual([]);
		expect(projectSessionTranscript(manager).items).toEqual([]);
		expect(() => manager.branch(receipt.record.receiptId)).toThrow(`Entry ${receipt.record.receiptId} not found`);
		expect(() => manager.branchWithSummary(receipt.record.receiptId, "hidden")).toThrow(
			`Entry ${receipt.record.receiptId} not found`,
		);
		expect(() => manager.appendLabelChange(receipt.record.receiptId, "hidden")).toThrow(
			`Entry ${receipt.record.receiptId} not found`,
		);

		const runtime = {
			session: { sessionId: manager.getSessionId(), sessionManager: manager },
			listSessions: async () => [],
		} satisfies ConversationCommandRuntime;
		const bootstrapBefore = createRemoteConversationTranscriptPage(createAuthorization(tempDir), runtime);
		expect(bootstrapBefore).toMatchObject({ items: [], head: null });

		const userEntryId = manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
			clientMessageId: "private-wal",
			timestamp: Date.now(),
		});
		expect(observedEntryTypes).toEqual(["message"]);
		expect(manager.getEntries()).toHaveLength(1);
		expect(manager.getBranch()).toHaveLength(1);
		expect(manager.getTree()).toHaveLength(1);
		const bootstrapAfter = createRemoteConversationTranscriptPage(createAuthorization(tempDir), runtime);
		expect(bootstrapAfter).toMatchObject({
			items: [{ entryId: userEntryId, role: "user", clientMessageId: "private-wal" }],
			head: { entryId: userEntryId },
		});
	});

	it("keeps WAL-only files out of local and remote session enumeration until canonical content commits", async () => {
		const agentDir = createTempDir();
		const workspaceDir = join(agentDir, "workspace");
		mkdirSync(workspaceDir, { recursive: true });
		tempDirs.push(agentDir);
		const sessionDir = getDefaultSessionDir(workspaceDir, agentDir);
		const manager = SessionManager.create(workspaceDir, sessionDir);
		manager.reserveClientInput("private-list-wal", "prompt", digestClientInput("prompt", "visible later"));
		manager.transitionClientInput("private-list-wal", "started");
		manager.transitionClientInput("private-list-wal", "failed", "preflight rejected");
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);

		expect(await SessionManager.list(workspaceDir, sessionDir)).toEqual([]);
		expect(await SessionManager.listAll(sessionDir)).toEqual([]);
		const context: ConversationCommandContext = {
			stateManager: new IrohRemoteHostStateManager(),
			sessionListCursors: new Map(),
			sessionListCursorTtlMs: 60_000,
			agentDir,
		};
		expect(await listRemoteWorkspaceSessionSummaries(createAuthorization(workspaceDir), context)).toEqual([]);

		// Enumeration purity does not weaken recovery: an explicit reopen still
		// sees the terminal receipt and can deterministically replay its outcome.
		const reopened = SessionManager.open(sessionFile!, sessionDir);
		expect(reopened.getClientInput("private-list-wal")).toMatchObject({
			state: "failed",
			error: "preflight rejected",
		});
		reopened.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
			clientMessageId: "private-list-wal",
			timestamp: Date.now(),
		});

		expect(await SessionManager.list(workspaceDir, sessionDir)).toMatchObject([
			{ id: manager.getSessionId(), messageCount: 1, firstMessage: "visible later" },
		]);
		expect(await SessionManager.listAll(sessionDir)).toHaveLength(1);
		expect(await listRemoteWorkspaceSessionSummaries(createAuthorization(workspaceDir), context)).toMatchObject([
			{ session: { sessionId: manager.getSessionId(), messageCount: 1, title: "visible later" } },
		]);
	});

	it("fail-stops a dirty manager after an uncertain persistence failure", () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = SessionManager.create(tempDir, tempDir);
		const persistence = manager as unknown as { _persist(entry: SessionEntry): void };
		const originalPersist = persistence._persist;
		persistence._persist = () => {
			throw new Error("injected append failure");
		};

		expect(() => manager.reserveClientInput("uncertain", "prompt", "digest")).toThrow("injected append failure");
		expect(manager.getEntries()).toEqual([]);
		persistence._persist = originalPersist;
		expect(() => manager.reserveClientInput("uncertain", "prompt", "digest")).toThrow(
			"Session persistence is fail-stopped after an uncertain write",
		);

		manager.newSession();
		expect(manager.reserveClientInput("fresh", "prompt", "digest").record.state).toBe("accepted");
	});
});
