import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, ConversationLogEntryDraft, ConversationTurnReservation } from "@hansjm10/volt-agent-core";
import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ClientInputConflictError,
	ClientInputOutcomeAmbiguousError,
	QueueClearPersistenceError,
} from "../src/core/agent-session.ts";
import { getClientMessageId } from "../src/core/messages.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { projectSessionTranscript } from "../src/core/rpc/transcript.ts";
import {
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	type ClientInputCommand,
	type ClientInputPayload,
	type ClientInputPayloadInput,
	type ClientInputQueuedPayload,
	type ClientInputState,
	createClientInputSemanticDigest,
	getDefaultSessionDir,
	isValidClientMessageId,
	SessionManager,
} from "../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreLease } from "../src/core/session-store/index.ts";
import {
	type ConversationCommandContext,
	type ConversationCommandRuntime,
	createRemoteConversationTranscriptPage,
	listRemoteWorkspaceSessionSummaries,
} from "../src/daemon/conversation-commands.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.ts";
import { appendsEntryType, type ConversationLogBatchMatcher, lose } from "./utilities/faulty-log.ts";
import { seedSession } from "./utilities/seed-log.ts";
import { loadPersistedSessionSnapshot } from "./utilities.ts";

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

/** Claim the idle conversation as a running turn does, so queued input stays pending until it is released. */
function holdConversation(harness: Harness): ConversationTurnReservation {
	return harness.control.conversation.reserve();
}

/** `promise`, or a rejection when it does not settle within `ms`: a hung retry fails instead of timing out the test. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Whether a batch records `state` for `clientMessageId`. */
function recordsClientInputState(clientMessageId: string, state: ClientInputState): ConversationLogBatchMatcher {
	return (batch) =>
		batch.entries.some((entry) => {
			if (entry.type !== "client_input_state") return false;
			const payload = entry.payload as { clientMessageId?: string; state?: string };
			return payload.clientMessageId === clientMessageId && payload.state === state;
		});
}

type ClientInputEntryBody =
	| {
			type: "client_input_receipt";
			payload: {
				clientMessageId: string;
				command: ClientInputCommand;
				semanticDigest: string;
				input: ClientInputPayload;
			};
	  }
	| {
			type: "client_input_queued";
			payload: { receiptId: string; clientMessageId: string; queuedInput: ClientInputQueuedPayload };
	  }
	| {
			type: "client_input_state";
			payload: { receiptId: string; clientMessageId: string; state: ClientInputState };
	  };

/**
 * Commit one client-input entry to a manager no session has opened, for the
 * shapes `LogSeed.clientInput` does not build: a prompt's streaming behavior,
 * a queued payload unlike its receipt, a later step of an existing receipt.
 */
async function seedClientInputEntry(manager: SessionManager, body: ClientInputEntryBody): Promise<void> {
	const id = `client-entry-${manager.getOrdinal() + 1}`;
	const parentId = manager.getLeafId();
	await seedSession(manager, (seed) => {
		seed.drafts.push({
			...body,
			id,
			parentId,
			timestamp: new Date().toISOString(),
			visibility: "host",
		} as ConversationLogEntryDraft);
	});
}

async function seedReceipt(
	manager: SessionManager,
	clientMessageId: string,
	command: ClientInputCommand,
	input: ClientInputPayloadInput,
): Promise<void> {
	const payload: ClientInputPayload = {
		message: input.message,
		images: (input.images ?? []).map((image) => ({ type: "image", mimeType: image.mimeType, data: image.data })),
		...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
	};
	await seedClientInputEntry(manager, {
		type: "client_input_receipt",
		payload: {
			clientMessageId,
			command,
			semanticDigest: createClientInputSemanticDigest(command, payload),
			input: payload,
		},
	});
}

function receiptIdOf(manager: SessionManager, clientMessageId: string): string {
	const record = manager.getClientInput(clientMessageId);
	if (!record) throw new Error(`No client input ${clientMessageId}`);
	return record.receiptId;
}

async function seedQueued(
	manager: SessionManager,
	clientMessageId: string,
	queuedInput: Omit<ClientInputQueuedPayload, "images"> & Partial<Pick<ClientInputQueuedPayload, "images">>,
): Promise<void> {
	await seedClientInputEntry(manager, {
		type: "client_input_queued",
		payload: {
			receiptId: receiptIdOf(manager, clientMessageId),
			clientMessageId,
			queuedInput: { ...queuedInput, images: [...(queuedInput.images ?? [])] },
		},
	});
}

async function seedState(manager: SessionManager, clientMessageId: string, state: ClientInputState): Promise<void> {
	await seedClientInputEntry(manager, {
		type: "client_input_state",
		payload: { receiptId: receiptIdOf(manager, clientMessageId), clientMessageId, state },
	});
}

describe("durable client input idempotency", () => {
	const harnesses: Harness[] = [];
	const managerOwner = createSessionManagerTestOwner();
	const storeLeases: SQLiteSessionStoreLease[] = [];
	const tempDirs: string[] = [];

	beforeEach(() => managerOwner.start());

	afterEach(async () => {
		while (harnesses.length > 0)
			await harnesses
				.pop()!
				.cleanupAsync()
				.catch(() => {});
		await managerOwner.drain();
		vi.restoreAllMocks();
		while (storeLeases.length > 0) await storeLeases.pop()!.release();
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
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

	it("fails a live admission whose conversation authority expires during its receipt commit", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const receipt = harness.log!.holdNext(appendsEntryType("client_input_receipt"));
		let authorityCurrent = true;

		const first = harness.session.prompt("authority race", {
			clientMessageId: "authority-race",
			assertConversationGenerationCurrent: () => {
				if (!authorityCurrent) throw new Error("stale conversation authority");
			},
		});
		await receipt.started;
		authorityCurrent = false;
		receipt.release();
		await expect(first).rejects.toThrow("stale conversation authority");
		expect(harness.sessionManager.getClientInput("authority-race")).toMatchObject({
			state: "failed",
			error: "stale conversation authority",
		});

		// The live admission is gone: a retry replays the recorded failure instead of joining it.
		await expect(harness.session.prompt("authority race", { clientMessageId: "authority-race" })).rejects.toThrow(
			"stale conversation authority",
		);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("fences an identified prompt receipt commit against concurrent abort", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const receipt = harness.log!.holdNext(appendsEntryType("client_input_receipt"));

		const promptOutcome = harness.session
			.prompt("abort receipt race", { clientMessageId: "abort-receipt-race" })
			.then(
				() => undefined,
				(error: unknown) => error,
			);
		await receipt.started;
		const abort = harness.session.abort();
		receipt.release();
		await expect(abort).resolves.toBeUndefined();

		expect(await promptOutcome).toMatchObject({
			message: "Client input admission was aborted before its receipt became durable",
		});
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getClientInput("abort-receipt-race")?.state).toBe("failed");

		// The aborted admission is a definitive failure: a retry replays it and runs nothing.
		await expect(
			harness.session.prompt("abort receipt race", { clientMessageId: "abort-receipt-race" }),
		).rejects.toThrow("aborted before its receipt became durable");
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
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
		expect(user && getClientMessageId(user)).toBe("transport-owned");
		expect(harness.sessionManager.getClientInput("transport-owned")?.state).toBe("completed");
		expect(harness.sessionManager.getClientInput("extension-hijack")).toBeUndefined();
	});

	it("fails closed when an extension changes the role of a transport-identified user message", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						return { message: fauxAssistantMessage("role changed") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must not run")]);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});

		await expect(
			harness.session.prompt("identified", { clientMessageId: "role-change-rejected" }),
		).rejects.toMatchObject({ code: "extension_message_role_mismatch" });
		expect(harness.sessionManager.getClientInput("role-change-rejected")?.state).toBe("failed");
		expect(terminalOutcomes).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		await expect(harness.session.prompt("identified", { clientMessageId: "role-change-rejected" })).rejects.toThrow(
			"cannot change the role",
		);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("emits a terminal outcome when an admitted queued input fails during dequeue", async () => {
		let releaseTool!: () => void;
		let markToolStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});
		const toolGate = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait-for-dequeue-failure",
			label: "Wait",
			description: "Wait for queued input admission",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (
							event.message.role !== "user" ||
							getClientMessageId(event.message) !== "queued-role-change-rejected"
						) {
							return;
						}
						return { message: fauxAssistantMessage("role changed after admission") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait-for-dequeue-failure", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("tool finished"),
			fauxAssistantMessage("must not run"),
		]);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.prompt("fail after dequeue", {
			clientMessageId: "queued-role-change-rejected",
			streamingBehavior: "followUp",
		});
		expect(harness.sessionManager.getClientInput("queued-role-change-rejected")?.state).toBe("accepted");
		releaseTool();

		await expect(run).rejects.toMatchObject({ code: "extension_message_role_mismatch" });
		expect(harness.sessionManager.getClientInput("queued-role-change-rejected")?.state).toBe("failed");
		expect(clientInputRecovery(harness.sessionManager.getConversationState())).toEqual({ kind: "idle", records: [] });
		expect(terminalOutcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "queued-role-change-rejected",
				outcome: "failed",
				reason: "dispatch_failed",
			},
		]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("persists an ambiguous boundary before a handled command side effect", async () => {
		let sideEffects = 0;
		const harness = await createHarness({
			log: "memory",
			extensionFactories: [
				(volt) => {
					volt.registerCommand("once", {
						handler: async () => {
							sideEffects++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.log!.failNext("rolled_back", recordsClientInputState("handled-command-once", "completed"));

		await expect(harness.session.prompt("/once", { clientMessageId: "handled-command-once" })).rejects.toThrow(
			"Injected rollback",
		);
		expect(sideEffects).toBe(1);
		expect(harness.sessionManager.getClientInput("handled-command-once")?.state).toBe("started");
		await expect(
			settleWithin(harness.session.prompt("/once", { clientMessageId: "handled-command-once" }), 2_000),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(sideEffects).toBe(1);
	});

	it("persists an ambiguous boundary before a handled input-hook side effect", async () => {
		let sideEffects = 0;
		const harness = await createHarness({
			log: "memory",
			extensionFactories: [
				(volt) => {
					volt.on("input", () => {
						sideEffects++;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.log!.failNext("rolled_back", recordsClientInputState("handled-input-once", "completed"));

		await expect(
			harness.session.prompt("handled by hook", { clientMessageId: "handled-input-once" }),
		).rejects.toThrow("Injected rollback");
		expect(sideEffects).toBe(1);
		expect(harness.sessionManager.getClientInput("handled-input-once")?.state).toBe("started");
		await expect(
			settleWithin(harness.session.prompt("handled by hook", { clientMessageId: "handled-input-once" }), 2_000),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(sideEffects).toBe(1);
	});

	it.each([{ boundary: "command" as const }, { boundary: "input_hook" as const }])(
		"does not cross a persisted $boundary dispatch boundary after concurrent abort",
		async ({ boundary }) => {
			let sideEffects = 0;
			const clientMessageId = `abort-${boundary}-dispatch`;
			const harness = await createHarness({
				log: "memory",
				extensionFactories: [
					(volt) => {
						if (boundary === "command") {
							volt.registerCommand("side-effect", {
								handler: async () => {
									sideEffects++;
								},
							});
							return;
						}
						volt.on("input", () => {
							sideEffects++;
							return { action: "handled" };
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const dispatch = harness.log!.holdNext(recordsClientInputState(clientMessageId, "started"));

			const promptOutcome = harness.session
				.prompt(boundary === "command" ? "/side-effect" : "handle in input hook", { clientMessageId })
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			await dispatch.started;
			const abort = harness.session.abort();
			dispatch.release();
			await abort;

			expect(await promptOutcome).toMatchObject({
				message: "Client input was aborted while persisting its dispatch boundary",
			});
			expect(sideEffects).toBe(0);
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("failed");
			expect(clientInputRecovery(harness.sessionManager.getConversationState())).toEqual({
				kind: "idle",
				records: [],
			});
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
		},
	);

	it("enqueues duplicate steer and follow-up inputs once and rejects cross-command id reuse", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});
		const turn = holdConversation(harness);

		await Promise.all([
			harness.session.steer("steer once", undefined, "client-steer"),
			harness.session.steer("steer once", undefined, "client-steer"),
		]);
		await Promise.all([
			harness.session.followUp("follow once", undefined, "client-follow"),
			harness.session.followUp("follow once", undefined, "client-follow"),
		]);

		expect(harness.session.getSteeringMessages()).toEqual([{ clientMessageId: "client-steer", text: "steer once" }]);
		expect(harness.session.getFollowUpMessages()).toEqual([
			{ clientMessageId: "client-follow", text: "follow once" },
		]);
		await expect(harness.session.followUp("steer once", undefined, "client-steer")).rejects.toBeInstanceOf(
			ClientInputConflictError,
		);

		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["steer once"],
			followUp: ["follow once"],
		});
		expect(harness.sessionManager.getClientInput("client-steer")?.state).toBe("withdrawn");
		expect(harness.sessionManager.getClientInput("client-follow")?.state).toBe("withdrawn");
		expect(terminalOutcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "client-steer",
				outcome: "failed",
				reason: "queue_cleared",
			},
			{
				type: "client_input_outcome",
				clientMessageId: "client-follow",
				outcome: "failed",
				reason: "queue_cleared",
			},
		]);
		turn.cancel();
	});

	it("revokes runtime queue ownership before awaiting cleared-input durability", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		const turn = holdConversation(harness);
		await harness.session.steer("must not dequeue", undefined, "clear-before-flush");
		const withdrawal = harness.log!.holdNext(recordsClientInputState("clear-before-flush", "withdrawn"));

		const clearing = harness.session.clearQueue();
		try {
			await withdrawal.started;
			await vi.waitFor(() => expect(harness.session.getSteeringMessages()).toEqual([]));
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.control.hasQueuedMessages()).toBe(false);
			expect(harness.sessionManager.getClientInput("clear-before-flush")?.state).toBe("accepted");
		} finally {
			withdrawal.release();
		}
		await expect(clearing).resolves.toEqual({ steering: ["must not dequeue"], followUp: [] });
		expect(harness.sessionManager.getClientInput("clear-before-flush")?.state).toBe("withdrawn");
		turn.cancel();
	});

	it.each([
		{ command: "steer" as const, clientMessageId: "clear-pending-steer" },
		{ command: "followUp" as const, clientMessageId: "clear-pending-follow" },
	])(
		"keeps a pending $command admission visible to concurrent queue clearing",
		async ({ command, clientMessageId }) => {
			const harness = await createHarness({ log: "memory" });
			harnesses.push(harness);
			const turn = holdConversation(harness);
			const admission = harness.log!.holdNext(appendsEntryType("client_input_queued"));

			const queueOutcome = (
				command === "steer"
					? harness.session.steer("clear pending admission", undefined, clientMessageId)
					: harness.session.followUp("clear pending admission", undefined, clientMessageId)
			).then(
				() => undefined,
				(error: unknown) => error,
			);
			await admission.started;
			const clearing = harness.session.clearQueue();
			admission.release();
			await clearing;
			await queueOutcome;

			// Clearing the queue while an admission commits clears that input too.
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("withdrawn");
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.control.hasQueuedMessages()).toBe(false);
			turn.cancel();
		},
	);

	it("clears local queued input durably without reporting a client outcome", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const terminalOutcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") terminalOutcomes.push(event);
		});
		const turn = holdConversation(harness);
		// Input without a client identity gets a local one; clearing withdraws it, but no client awaits an outcome.
		await harness.session.steer("steered draft");
		await harness.session.followUp("follow-up draft");
		const localIds = [...harness.control.conversation.state.clientInputs.inputs.keys()];
		expect(localIds).toHaveLength(2);

		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["steered draft"],
			followUp: ["follow-up draft"],
		});
		for (const clientMessageId of localIds) {
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("withdrawn");
		}
		expect(terminalOutcomes).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		turn.cancel();
	});

	it("carries the cleared queue text on the error when cancellation cannot be persisted", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		const turn = holdConversation(harness);
		await harness.session.steer("steered draft", undefined, "clear-steer-flush-failure");
		await harness.session.followUp("follow-up draft", undefined, "clear-follow-flush-failure");

		harness.log!.failNext("rolled_back", appendsEntryType("client_input_state"));
		let thrown: unknown;
		try {
			await harness.session.clearQueue();
		} catch (error) {
			thrown = error;
		}

		// The runtime queues are revoked before durability is awaited, so the error
		// holds the only surviving copy of what the user typed.
		expect(thrown).toBeInstanceOf(QueueClearPersistenceError);
		const persistenceError = thrown as QueueClearPersistenceError;
		expect(persistenceError.steering).toEqual(["steered draft"]);
		expect(persistenceError.followUp).toEqual(["follow-up draft"]);
		expect(persistenceError.cause).toMatchObject({ code: "commit_rolled_back", message: "Injected rollback" });
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		turn.cancel();
	});

	it("hands back identified queues once when the session's log was closed under it", async () => {
		const harness = await createHarness({ log: "sqlite" });
		harnesses.push(harness);
		holdConversation(harness);
		await harness.session.steer("restore steer", undefined, "clear-closed-steer");
		await harness.session.followUp("restore follow-up", undefined, "clear-closed-follow");
		await harness.sessionManager.closePersistence();

		// The closed log ends the session's conversation: the session has lost its log, and nothing
		// queued is delivered. Clearing hands the text back once.
		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["restore steer"],
			followUp: ["restore follow-up"],
		});
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		await expect(harness.session.clearQueue()).resolves.toEqual({ steering: [], followUp: [] });
		await expect(harness.session.steer("restore steer", undefined, "clear-closed-steer")).rejects.toThrow();
		await expect(harness.session.followUp("restore follow-up", undefined, "clear-closed-follow")).rejects.toThrow();
	});

	it("queues local input under the durable identity the session gave it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		holdConversation(harness);
		await harness.session.steer("local queued input");
		const [entry] = harness.session.getSteeringMessages();
		if (!entry) throw new Error("missing local queue entry");
		expect(entry.clientMessageId).toMatch(/^local-/);
		expect(harness.sessionManager.getClientInput(entry.clientMessageId)).toMatchObject({
			state: "accepted",
			queuedInput: { delivery: "steer", message: "local queued input" },
		});

		// The identity is durable: other input cannot take it over.
		await expect(
			harness.session.steer("forged remote collision", undefined, entry.clientMessageId),
		).rejects.toBeInstanceOf(ClientInputConflictError);
		expect(harness.session.getSteeringMessages()).toEqual([entry]);
		expect(harness.control.hasQueuedMessages()).toBe(true);
	});

	it.each([
		{ command: "steer" as const, clientMessageId: "failed-steer-enqueue" },
		{ command: "followUp" as const, clientMessageId: "failed-follow-enqueue" },
	])("records nothing when a $command admission commit rolls back", async ({ command, clientMessageId }) => {
		const harness = await createHarness({ log: "sqlite" });
		harnesses.push(harness);
		holdConversation(harness);
		const queueUpdates: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") queueUpdates.push(event);
		});
		harness.log!.failNext("rolled_back", appendsEntryType("client_input_queued"));
		const queue = () =>
			command === "steer"
				? harness.session.steer("must not project", undefined, clientMessageId)
				: harness.session.followUp("must not project", undefined, clientMessageId);

		await expect(queue()).rejects.toThrow("Injected rollback");
		expect(harness.sessionManager.getClientInput(clientMessageId)).toBeUndefined();
		expect(clientInputRecovery(harness.sessionManager.getConversationState()).records).toEqual([]);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(queueUpdates).toEqual([]);
		const persisted = await loadPersistedSessionSnapshot(harness.sessionManager);
		expect(persisted.entries.filter((entry) => entry.type.startsWith("client_input_"))).toEqual([]);

		// Nothing was recorded, so the same input is admitted again.
		await expect(queue()).resolves.toBeUndefined();
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
	});

	it("keeps durable and core queue admission authoritative when a projection listener throws", async () => {
		const harness = await createHarness({ log: "sqlite" });
		harnesses.push(harness);
		holdConversation(harness);
		harness.session.subscribe((event) => {
			if (event.type === "queue_update") throw new Error("injected projection listener failure");
		});

		await expect(harness.session.steer("survives observer", undefined, "observer-safe")).resolves.toBeUndefined();
		expect(harness.sessionManager.getClientInput("observer-safe")).toMatchObject({ state: "accepted" });
		expect(clientInputRecovery(harness.sessionManager.getConversationState()).records).toMatchObject([
			{ clientMessageId: "observer-safe", queuedInput: { delivery: "steer", message: "survives observer" } },
		]);
		await vi.waitFor(() =>
			expect(harness.session.getSteeringMessages()).toEqual([
				{ clientMessageId: "observer-safe", text: "survives observer" },
			]),
		);
		expect(harness.control.hasQueuedMessages()).toBe(true);
	});

	it("commits pass-through and transformed input-hook queues back to exact recoverable payloads", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionManager = await SessionManager.create(tempDir, tempDir);
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
			description: "Wait for queued hook admission",
			parameters: Type.Object({}),
			execute: async () => {
				markToolStarted();
				await toolGate;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			sessionManager,
			tools: [waitTool],
			extensionFactories: [
				(volt) => {
					volt.on("input", (event) =>
						event.text === "queued transform"
							? { action: "transform", text: "queued transformed", images: event.images }
							: { action: "continue" },
					);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("after tool"),
			fauxAssistantMessage("pass done"),
			fauxAssistantMessage("transform done"),
		]);

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.prompt("queued pass", {
			clientMessageId: "hook-queue-pass",
			streamingBehavior: "followUp",
		});
		await harness.session.prompt("queued transform", {
			clientMessageId: "hook-queue-transform",
			streamingBehavior: "followUp",
		});
		expect(harness.sessionManager.getClientInput("hook-queue-pass")?.state).toBe("accepted");
		expect(harness.sessionManager.getClientInput("hook-queue-transform")?.state).toBe("accepted");
		const reopened = await SessionManager.openReadOnly(
			harness.sessionManager.getSessionRef()!,
			harness.sessionManager.getCwd(),
		);
		expect(clientInputRecovery(reopened.getConversationState()).records).toMatchObject([
			{ clientMessageId: "hook-queue-pass", queuedInput: { message: "queued pass" } },
			{ clientMessageId: "hook-queue-transform", queuedInput: { message: "queued transformed" } },
		]);

		releaseTool();
		await run;
		const persisted = await loadPersistedSessionSnapshot(harness.sessionManager);
		for (const clientMessageId of ["hook-queue-pass", "hook-queue-transform"]) {
			expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
			const states = persisted.entries
				.filter(
					(entry) =>
						entry.type === "client_input_state" &&
						JSON.stringify(entry.payload).includes(`"clientMessageId":"${clientMessageId}"`),
				)
				.map((entry) => JSON.parse(JSON.stringify(entry.payload)) as { state?: string })
				.map((entry) => entry.state);
			// Input-hook dispatch and later queue consumption are distinct
			// side-effectful attempts separated by durable queue re-admission.
			expect(states).toEqual(["started", "started"]);
			// The canonical identified user entry is itself the durable completion
			// boundary; no redundant client_input_state terminal marker is required.
			expect(
				persisted.entries.some(
					(entry) =>
						entry.type === "message" &&
						JSON.stringify(entry.payload).includes(`"clientMessageId":"${clientMessageId}"`),
				),
			).toBe(true);
			const completed = await SessionManager.openReadOnly(harness.sessionManager.getSessionRef()!);
			expect(completed.getClientInput(clientMessageId)?.state).toBe("completed");
		}
	});

	it("publishes a dequeued input only after its canonical entry is complete", async () => {
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
				getClientMessageId(event.message) === "client-consuming"
			) {
				void harness.session.clearQueue();
				stateImmediatelyAfterClear = harness.sessionManager.getClientInput("client-consuming")?.state;
			}
		});

		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.steer("consume me", undefined, "client-consuming");
		releaseTool();
		await run;

		expect(stateImmediatelyAfterClear).toBe("completed");
		expect(harness.sessionManager.getClientInput("client-consuming")?.state).toBe("completed");
	});

	it("fails an accepted-but-not-started prompt receipt after SQLite reopen instead of replaying it", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) => seed.clientInput("client-accepted", "prompt", { message: "resume me" }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		// An earlier runtime stopped before any side effect or delivery; a retry learns it must resubmit.
		await expect(harness.session.prompt("resume me", { clientMessageId: "client-accepted" })).rejects.toThrow(
			"interrupted before it was delivered",
		);
		expect(harness.sessionManager.getClientInput("client-accepted")?.state).toBe("failed");
		await expect(harness.session.prompt("resume me", { clientMessageId: "client-accepted" })).rejects.toThrow(
			"interrupted before it was delivered",
		);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("reloads exact queued inputs in durable admission order and refuses a second queue record", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		const image = { type: "image" as const, mimeType: "image/png", data: "b3JpZ2luYWw=" };
		await seedReceipt(manager, "queued-a", "steer", { message: "original a", images: [image] });
		await seedReceipt(manager, "queued-b", "prompt", { message: "original b", streamingBehavior: "followUp" });
		await seedQueued(manager, "queued-b", { delivery: "follow_up", message: "expanded b" });
		await seedQueued(manager, "queued-a", { delivery: "steer", message: "expanded a", images: [image] });
		image.data = "bXV0YXRlZA==";

		await expect(seedQueued(manager, "queued-a", { delivery: "steer", message: "expanded a" })).rejects.toThrow();
		const queuedEntries = (await loadPersistedSessionSnapshot(manager)).entries.filter(
			(entry) => entry.type === "client_input_queued",
		);
		expect(queuedEntries).toHaveLength(2);

		const reopened = await SessionManager.openReadOnly(manager.getSessionRef()!, tempDir);
		expect(clientInputRecovery(reopened.getConversationState()).records).toMatchObject([
			{
				clientMessageId: "queued-b",
				command: "prompt",
				state: "accepted",
				input: { message: "original b", images: [], streamingBehavior: "followUp" },
				queuedInput: { delivery: "follow_up", message: "expanded b", images: [] },
			},
			{
				clientMessageId: "queued-a",
				command: "steer",
				state: "accepted",
				input: {
					message: "original a",
					images: [{ type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" }],
				},
				queuedInput: {
					delivery: "steer",
					message: "expanded a",
					images: [{ type: "image", mimeType: "image/png", data: "b3JpZ2luYWw=" }],
				},
			},
		]);
	});

	it("fences later durable queue entries behind an ambiguous started predecessor", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("ambiguous-a", "steer", { message: "older a" }, { queued: "steer", states: ["started"] })
					.clientInput("queued-b", "follow_up", { message: "later b" }, { queued: "follow_up" }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const reopened = harness.sessionManager;
		expect(clientInputRecovery(reopened.getConversationState())).toMatchObject({
			kind: "blocked",
			blocker: { clientMessageId: "ambiguous-a", state: "started" },
			records: [{ clientMessageId: "queued-b", state: "accepted" }],
		});

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toBeInstanceOf(
			ClientInputOutcomeAmbiguousError,
		);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(reopened.getClientInput("queued-b")?.state).toBe("accepted");

		await expect(harness.session.prompt("fresh c", { clientMessageId: "fresh-c" })).rejects.toThrow(
			"Ambiguous recovered client input",
		);
		expect(reopened.getClientInput("fresh-c")).toBeUndefined();
		await expect(harness.session.steer("older a", undefined, "ambiguous-a")).rejects.toBeInstanceOf(
			ClientInputOutcomeAmbiguousError,
		);
		await expect(harness.session.followUp("later b", undefined, "queued-b")).resolves.toBeUndefined();
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("keeps fenced recovered queue entries visible behind an ambiguous predecessor", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("ambiguous-a", "steer", { message: "older a" }, { queued: "steer", states: ["started"] })
					.clientInput("queued-b", "follow_up", { message: "later b" }, { queued: "follow_up" }),
		});
		harnesses.push(harness);

		expect(clientInputRecovery(harness.sessionManager.getConversationState())).toMatchObject({ kind: "blocked" });
		expect(harness.session.getFollowUpMessages()).toMatchObject([{ clientMessageId: "queued-b", text: "later b" }]);
	});

	it("restores every still-accepted queue after recovered delivery rolls back before its user message commits", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("recover-steer", "steer", { message: "steer original" }, { queued: "steer" })
					.clientInput("recover-follow", "follow_up", { message: "follow original" }, { queued: "follow_up" }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		harness.log!.failNext("rolled_back", appendsEntryType("message"));

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow();
		const reopened = harness.sessionManager;
		expect(reopened.getClientInput("recover-steer")?.state).toBe("accepted");
		expect(reopened.getClientInput("recover-follow")?.state).toBe("accepted");
		expect(clientInputRecovery(reopened.getConversationState()).records).toHaveLength(2);
		expect(harness.session.getSteeringMessages()).toEqual([
			{ clientMessageId: "recover-steer", text: "steer original" },
		]);
		expect(harness.session.getFollowUpMessages()).toEqual([
			{ clientMessageId: "recover-follow", text: "follow original" },
		]);
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("resumes the same recovered input after one rolled-back delivery", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed.clientInput("recover-retained", "steer", { message: "recover retained" }, { queued: "steer" }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("recovered once")]);
		harness.log!.failNext("rolled_back", appendsEntryType("message"));
		const reopened = harness.sessionManager;

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow();
		expect(reopened.getClientInput("recover-retained")?.state).toBe("accepted");
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.resumeRecoveredClientInputs();
		expect(reopened.getClientInput("recover-retained")?.state).toBe("completed");
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["recover retained"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("terminalizes a recovered delivery that fails after its boundary instead of fencing later input", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) => seed.clientInput("recover-started", "steer", { message: "recover me" }, { queued: "steer" }),
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user" || getClientMessageId(event.message) !== "recover-started") return;
						return { message: fauxAssistantMessage("role changed after its boundary") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const reopened = harness.sessionManager;

		await harness.session.resumeRecoveredClientInputs().catch(() => undefined);
		expect(reopened.getClientInput("recover-started")).toMatchObject({
			state: "failed",
			error: expect.stringContaining("cannot change the role"),
		});
		expect(clientInputRecovery(reopened.getConversationState())).toEqual({ kind: "idle", records: [] });
		expect(reopened.getConversationState().context.messages.filter((message) => message.role === "user")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		// The same-ID retry replays the definitive failure; it is neither ambiguous nor re-dispatched.
		await expect(harness.session.steer("recover me", undefined, "recover-started")).rejects.toThrow(
			"cannot change the role",
		);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		// Later input is not fenced.
		await expect(
			harness.session.prompt("fresh", { clientMessageId: "fresh-after-failure" }),
		).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toEqual(["fresh"]);
	});

	it("reports a recovered delivery that fails after its boundary to the resume caller and its client", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) => seed.clientInput("recover-started", "steer", { message: "recover me" }, { queued: "steer" }),
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user" || getClientMessageId(event.message) !== "recover-started") return;
						return { message: fauxAssistantMessage("role changed after its boundary") } as never;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow("cannot change the role");
		expect(harness.eventsOfType("client_input_outcome")).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "recover-started",
				outcome: "failed",
				reason: "dispatch_failed",
			},
		]);
	});

	it("reports clearing recovered queued input to its client", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput(
						"recover-cleared",
						"follow_up",
						{ message: "cleared after restart" },
						{ queued: "follow_up" },
					)
					.clientInput("local-recovered", "steer", { message: "local after restart" }, { queued: "steer" }),
		});
		harnesses.push(harness);
		expect(harness.session.getFollowUpMessages()).toEqual([
			{ clientMessageId: "recover-cleared", text: "cleared after restart" },
		]);

		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["local after restart"],
			followUp: ["cleared after restart"],
		});
		expect(harness.sessionManager.getClientInput("recover-cleared")?.state).toBe("withdrawn");
		expect(harness.sessionManager.getClientInput("local-recovered")?.state).toBe("withdrawn");
		// Input queued before the restart reports its outcome like input queued now; local input has no client.
		expect(harness.eventsOfType("client_input_outcome")).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId: "recover-cleared",
				outcome: "failed",
				reason: "queue_cleared",
			},
		]);
	});

	it("rejects and restores recovery when the recovered turn is aborted before delivery", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed.clientInput("recover-silent-cancel", "steer", { message: "original" }, { queued: "steer" }),
			extensionFactories: [
				(volt) => {
					volt.on("message_start", (event, ctx) => {
						if (getClientMessageId(event.message) === "recover-silent-cancel") ctx.abort();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const reopened = harness.sessionManager;

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow();
		expect(reopened.getClientInput("recover-silent-cancel")?.state).toBe("accepted");
		expect(clientInputRecovery(reopened.getConversationState()).records).toHaveLength(1);
		expect(harness.session.getSteeringMessages()).toEqual([
			{ clientMessageId: "recover-silent-cancel", text: "original" },
		]);
	});

	it("does not resurrect recovered input after its user message commits", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) => seed.clientInput("recover-committed", "steer", { message: "recover me" }, { queued: "steer" }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		// The delivery commits, but the log is lost before the writer learns it.
		harness.log!.failNext(lose("storage", { committed: true }), appendsEntryType("message"));
		const sessionRef = harness.sessionManager.getSessionRef()!;

		await expect(harness.session.resumeRecoveredClientInputs()).rejects.toThrow();
		harness.session.dispose();
		await harness.session.waitForClosed();

		const reopened = await SessionManager.open(sessionRef);
		expect(reopened.getClientInput("recover-committed")?.state).toBe("completed");
		expect(clientInputRecovery(reopened.getConversationState()).records).toEqual([]);
		expect(reopened.getConversationState().context.messages).toMatchObject([
			{ role: "user", clientMessageId: "recover-committed" },
		]);
		const restarted = await createHarness({ sessionManager: reopened });
		harnesses.push(restarted);
		await expect(restarted.session.steer("recover me", undefined, "recover-committed")).resolves.toBeUndefined();
		expect(restarted.session.getSteeringMessages()).toEqual([]);
		expect(restarted.session.getFollowUpMessages()).toEqual([]);
		expect(
			reopened.getConversationState().context.messages.filter((message) => message.role === "user"),
		).toHaveLength(1);
	});

	it("fails closed before persisting an oversized queued replay payload", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		await seedSession(manager, (seed) =>
			seed.clientInput("queued-oversized", "steer", { message: "small original" }),
		);

		await expect(
			seedQueued(manager, "queued-oversized", { delivery: "steer", message: "\0".repeat(400 * 1024) }),
		).rejects.toThrow("serialized limit");
		expect(manager.getClientInput("queued-oversized")?.state).toBe("accepted");
		expect(manager.getClientInput("queued-oversized")?.queuedInput).toBeUndefined();
		expect(clientInputRecovery(manager.getConversationState()).records).toEqual([]);
	});

	it("bounds aggregate outstanding receipt and queued payload memory", async () => {
		const manager = SessionManager.inMemory();
		const nearMaximumMessage = "x".repeat(512 * 1024 - 1024);
		let aggregateError: Error | undefined;
		for (let index = 0; index < 128; index++) {
			const clientMessageId = `aggregate-${index}`;
			try {
				await seedSession(manager, (seed) =>
					seed.clientInput(clientMessageId, "steer", { message: nearMaximumMessage }),
				);
				await seedQueued(manager, clientMessageId, { delivery: "steer", message: nearMaximumMessage });
			} catch (error) {
				aggregateError = error instanceof Error ? error : new Error(String(error));
				break;
			}
		}

		expect(aggregateError?.message).toContain("aggregate limit");
		expect(clientInputRecovery(manager.getConversationState()).records.length).toBeGreaterThan(1);
		expect(clientInputRecovery(manager.getConversationState()).records.length).toBeLessThan(128);
	});

	it("caps tiny live receipts while input preflight is stalled", async () => {
		let releasePreflight!: () => void;
		let enteredPreflight = 0;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", async () => {
						enteredPreflight++;
						await preflightGate;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);

		const admitted = Array.from({ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES }, (_, index) =>
			harness.session.prompt("x", { clientMessageId: `slow-preflight-${index}` }),
		);
		const overflow = harness.session.prompt("x", { clientMessageId: "slow-preflight-overflow" });
		const overflowError = overflow.then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.waitFor(() => expect(enteredPreflight).toBeGreaterThan(0));
		expect(await overflowError).toMatchObject({
			message: `Outstanding client input exceeds the ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES}-entry limit`,
		});
		expect(harness.sessionManager.getClientInput("slow-preflight-overflow")).toBeUndefined();

		releasePreflight();
		await expect(Promise.all(admitted)).resolves.toHaveLength(CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES);
		expect(harness.sessionManager.getClientInput("slow-preflight-0")?.state).toBe("completed");
		expect(
			harness.sessionManager.getClientInput(`slow-preflight-${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES - 1}`)?.state,
		).toBe("completed");
	});

	it("counts a started receipt's original payload when it is durably re-admitted to the queue", async () => {
		const manager = SessionManager.inMemory();
		const nearMaximumMessage = "x".repeat(512 * 1024 - 1024);
		for (let index = 0; index < 32; index++) {
			await seedSession(manager, (seed) =>
				seed.clientInput(`started-budget-${index}`, "steer", { message: nearMaximumMessage }),
			);
		}
		await seedState(manager, "started-budget-0", "started");

		await expect(
			seedQueued(manager, "started-budget-0", { delivery: "steer", message: "q".repeat(64 * 1024) }),
		).rejects.toThrow("aggregate limit");
		expect(manager.getClientInput("started-budget-0")?.state).toBe("started");
		expect(manager.getClientInput("started-budget-0")?.queuedInput).toBeUndefined();
	});

	it("blocks fresh input from overtaking a durable queue restored after restart", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) => seed.clientInput("recovered-older", "steer", { message: "older" }, { queued: "steer" }),
		});
		harnesses.push(harness);
		const reopened = harness.sessionManager;

		await expect(harness.session.prompt("fresh", { clientMessageId: "fresh-after-recovery" })).rejects.toThrow(
			"Recovered client input must finish replaying",
		);
		expect(reopened.getClientInput("fresh-after-recovery")).toBeUndefined();
		// An idempotent retry of the older receipt still joins its original
		// accepted outcome instead of creating or reordering work.
		await expect(harness.session.steer("older", undefined, "recovered-older")).resolves.toBeUndefined();

		await harness.session.clearQueue();
		expect(reopened.getClientInput("recovered-older")?.state).toBe("withdrawn");
		harness.setResponses([fauxAssistantMessage("fresh done")]);
		await expect(harness.session.prompt("fresh", { clientMessageId: "fresh-after-clear" })).resolves.toBeUndefined();
		expect(reopened.getClientInput("fresh-after-clear")?.state).toBe("completed");
	});

	it("admits only canonical bounded ASCII client identities", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("valid")]);
		const maximumId = `client:${"x".repeat(249)}`;

		expect(maximumId).toHaveLength(256);
		expect(isValidClientMessageId(maximumId)).toBe(true);
		await harness.session.prompt("valid", { clientMessageId: maximumId });
		expect(harness.sessionManager.getClientInput(maximumId)?.state).toBe("completed");
		for (const invalidId of [
			"",
			"-starts-with-punctuation",
			"contains space",
			"contains\ttab",
			"contains\nnewline",
			'contains"quote',
			"contains\\backslash",
			"é",
			`client-${"x".repeat(250)}`,
		]) {
			expect(isValidClientMessageId(invalidId)).toBe(false);
			await expect(harness.session.prompt("invalid", { clientMessageId: invalidId })).rejects.toThrow(
				"invalid client input identity",
			);
			expect(harness.sessionManager.getClientInput(invalidId)).toBeUndefined();
		}
		expect(getUserTexts(harness)).toEqual(["valid"]);
	});

	it("rejects host-only recovery state in an explicit conversation snapshot", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const sessionFile = join(tempDir, "snapshot.jsonl");
		const timestamp = new Date().toISOString();
		writeFileSync(
			sessionFile,
			`${[
				{ type: "session", version: 5, snapshotVersion: 1, id: "snapshot", timestamp, cwd: tempDir },
				{
					type: "client_input_receipt",
					id: "snapshot-receipt",
					parentId: null,
					timestamp,
					ordinal: 1,
					clientMessageId: "snapshot-client-id",
					command: "steer",
					semanticDigest: "not-an-interchange-field",
					input: { message: "original", images: [] },
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(SessionManager.importFromJsonl(sessionFile, tempDir, join(tempDir, "sqlite-store"))).rejects.toThrow(
			"Session snapshot contains unsupported host-only entry: client_input_receipt",
		);
	});

	it("fails closed for a started receipt with no terminal record after SQLite reopen", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed.clientInput("client-started", "prompt", { message: "do not replay" }, { states: ["started"] }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);

		await expect(
			harness.session.prompt("do not replay", { clientMessageId: "client-started" }),
		).rejects.toBeInstanceOf(ClientInputOutcomeAmbiguousError);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("infers completion from the canonical user entry when rebuilding the all-entry index", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		await seedSession(manager, (seed) =>
			seed
				.clientInput("client-canonical", "prompt", { message: "committed" }, { states: ["started"] })
				.user("committed", { clientMessageId: "client-canonical" }),
		);
		const sessionRef = manager.getSessionRef();
		expect(sessionRef).toBeDefined();

		const reopened = await SessionManager.openReadOnly(sessionRef!, tempDir);
		expect(reopened.getClientInput("client-canonical")?.state).toBe("completed");
		expect(reopened.getConversationState().context.messages).toHaveLength(1);
	});

	it("replays completed and failed terminal outcomes after reopening SQLite", async () => {
		const completedHarness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("persisted-complete", "prompt", { message: "already done" }, { states: ["started"] })
					.user("already done", { clientMessageId: "persisted-complete" }),
		});
		harnesses.push(completedHarness);
		completedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await completedHarness.session.prompt("already done", { clientMessageId: "persisted-complete" });
		expect(completedHarness.getPendingResponseCount()).toBe(1);
		expect(completedHarness.sessionManager.getConversationState().context.messages).toHaveLength(1);

		const failedHarness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed.clientInput(
					"persisted-failed",
					"prompt",
					{ message: "still failed" },
					{ states: ["started", "failed"], error: "persisted precommit failure" },
				),
		});
		harnesses.push(failedHarness);
		failedHarness.setResponses([fauxAssistantMessage("must remain unused")]);
		await expect(
			failedHarness.session.prompt("still failed", { clientMessageId: "persisted-failed" }),
		).rejects.toThrow("persisted precommit failure");
		expect(failedHarness.getPendingResponseCount()).toBe(1);
		expect(getUserTexts(failedHarness)).toEqual([]);
	});

	it("keeps host WAL out of every public conversation and bootstrap projection", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		const observedEntryTypes: string[] = [];
		manager.subscribeEntries((entry) => observedEntryTypes.push(entry.type));
		await seedSession(manager, (seed) =>
			seed.clientInput("private-wal", "prompt", { message: "visible later" }, { states: ["started"] }),
		);
		const receiptId = receiptIdOf(manager, "private-wal");
		const persistedTypes = (await loadPersistedSessionSnapshot(manager)).entries.map((entry) => entry.type);
		expect(persistedTypes).toEqual(["client_input_receipt", "client_input_state"]);

		expect(observedEntryTypes).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getEntry(receiptId)).toBeUndefined();
		expect(manager.getChildren(receiptId)).toEqual([]);
		expect(manager.getBranch()).toEqual([]);
		expect(manager.getBranch(receiptId)).toEqual([]);
		expect(manager.getBranchWindow({ maxEntries: 10 })).toMatchObject({ entries: [], lookback: [] });
		expect(manager.getBranchWindow({ maxEntries: 10, beforeEntryId: receiptId })).toBeUndefined();
		expect(manager.getTree()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getLabel(receiptId)).toBeUndefined();
		expect(manager.getConversationState().context.messages).toEqual([]);
		expect(projectSessionTranscript(manager).items).toEqual([]);
		await expect(manager.logWriter.branch(receiptId)).rejects.toThrow(`Entry ${receiptId} not found`);
		await expect(manager.logWriter.branchWithSummary(receiptId, "hidden")).rejects.toThrow(
			`Entry ${receiptId} not found`,
		);
		await expect(manager.logWriter.appendLabelChange(receiptId, "hidden")).rejects.toThrow(
			`Entry ${receiptId} not found`,
		);

		const runtime = {
			session: { sessionId: manager.getSessionId(), sessionManager: manager },
			listSessions: async () => [],
		} satisfies ConversationCommandRuntime;
		const bootstrapBefore = createRemoteConversationTranscriptPage(createAuthorization(tempDir), runtime);
		expect(bootstrapBefore).toMatchObject({ items: [], head: null });

		const userEntryCommit = manager.logWriter.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
			clientMessageId: "private-wal",
			timestamp: Date.now(),
		});
		expect(observedEntryTypes).toEqual([]);
		const userEntryId = await userEntryCommit;
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
		const manager = await SessionManager.create(workspaceDir, sessionDir);
		await seedSession(manager, (seed) =>
			seed.clientInput(
				"private-list-wal",
				"prompt",
				{ message: "visible later" },
				{ states: ["started", "failed"], error: "preflight rejected" },
			),
		);
		const sessionRef = manager.getSessionRef();
		expect(sessionRef).toBeDefined();

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
		await manager.closePersistence();
		const reopened = await SessionManager.open(sessionRef!, sessionDir);
		expect(reopened.getClientInput("private-list-wal")).toMatchObject({
			state: "failed",
			error: "preflight rejected",
		});
		await reopened.logWriter.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible later" }],
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

	it("does not copy recoverable input WAL into a forked conversation", async () => {
		const sourceDir = createTempDir();
		const targetDir = createTempDir();
		tempDirs.push(sourceDir, targetDir);
		const source = await SessionManager.create(sourceDir, sourceDir);
		await seedSession(source, (seed) =>
			seed.clientInput("source-queued", "follow_up", { message: "source only" }, { queued: "follow_up" }),
		);

		const fork = await SessionManager.forkFrom(source.getSessionRef()!, targetDir, targetDir);
		expect(fork.getClientInput("source-queued")).toBeUndefined();
		expect(clientInputRecovery(fork.getConversationState()).records).toEqual([]);
		const forkSnapshot = await loadPersistedSessionSnapshot(fork);
		expect(forkSnapshot.entries).toEqual([]);
		expect(forkSnapshot.clientInputs).toEqual([]);
	});

	it("drops transport identity with WAL when forking or extracting a completed conversation", async () => {
		const sourceDir = createTempDir();
		const forkDir = createTempDir();
		tempDirs.push(sourceDir, forkDir);
		const source = await SessionManager.create(sourceDir, sourceDir);
		await seedSession(source, (seed) =>
			seed
				.clientInput("source-canonical", "prompt", { message: "source canonical" }, { states: ["started"] })
				.user("source canonical", { clientMessageId: "source-canonical" }),
		);
		const assistantId = await source.logWriter.appendMessage(fauxAssistantMessage("source answer"));

		const fork = await SessionManager.forkFrom(source.getSessionRef()!, forkDir, forkDir);
		expect(fork.getConversationState().context.messages[0]).not.toHaveProperty("clientMessageId");
		await expect(SessionManager.openReadOnly(fork.getSessionRef()!, forkDir)).resolves.toBeInstanceOf(SessionManager);

		const extracted = await SessionManager.createBranched(source, assistantId);
		const extractedRef = extracted.getSessionRef();
		expect(extractedRef).toBeDefined();
		expect(extracted.getConversationState().context.messages[0]).not.toHaveProperty("clientMessageId");
		await expect(SessionManager.openReadOnly(extractedRef!, sourceDir)).resolves.toBeInstanceOf(SessionManager);
	});

	it("loses the log of a dirty manager after an uncertain persistence failure", async () => {
		const tempDir = createTempDir();
		tempDirs.push(tempDir);
		const manager = await SessionManager.create(tempDir, tempDir);
		const storeLease = await acquireSharedSQLiteSessionStore(manager.getSessionDir());
		storeLeases.push(storeLease);
		vi.spyOn(storeLease.client, "applyTransaction").mockRejectedValueOnce(
			new Error("injected uncertain store failure"),
		);
		const reconcile = vi
			.spyOn(storeLease.client, "reconcileCommit")
			.mockRejectedValueOnce(new Error("injected reconciliation failure"));

		const seedInput = (target: SessionManager, clientMessageId: string) =>
			seedSession(target, (seed) => seed.clientInput(clientMessageId, "prompt", { message: clientMessageId }));
		await expect(seedInput(manager, "uncertain")).rejects.toThrow("could not be determined");
		expect(reconcile).toHaveBeenCalledOnce();
		await expect(manager.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
		const persisted = await loadPersistedSessionSnapshot(manager);
		expect(persisted.entries).toEqual([]);
		expect(persisted.clientInputs).toEqual([]);
		await expect(seedInput(manager, "later")).rejects.toThrow("could not be determined");

		const freshManager = await SessionManager.create(tempDir, tempDir);
		await seedInput(freshManager, "fresh");
		expect(freshManager.getClientInput("fresh")?.state).toBe("accepted");
	});
});
