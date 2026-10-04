import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ConversationFactory } from "../src/core/host/hosted-conversation.ts";
import type {
	ConversationProjectionSnapshotBuilder,
	ConversationProjectionSubscription,
} from "../src/core/rpc/conversation-projection-feed.ts";
import { buildRpcSessionState } from "../src/core/rpc/session-state.ts";
import type { RpcConversationTranscriptItem } from "../src/core/rpc/types.ts";
import { SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { getCurrentConversationAuthority, parseWrittenObjects, startIrohRpcMode } from "./iroh-stream-doubles.ts";
import { connectTestClient, type OpenTestHostOptions, openTestHost, type TestClient } from "./utilities/host-client.ts";

/** Open a conversation in a host of its own and attach an in-place anchor client to it. */
async function openRuntime(factory: ConversationFactory, options: OpenTestHostOptions): Promise<TestClient> {
	const { host, conversation } = await openTestHost(factory, options);
	return connectTestClient(host, conversation);
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

describe("AgentSession conversation generation commits", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("rotates the projection only after branch transcript and Agent state commit together", async () => {
		const tempDir = join(
			tmpdir(),
			`volt-conversation-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const faux = createFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
				cwd,
			});
			services.modelRegistry.client.registerProvider(faux);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await openRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.attachExtensionClient({ id: "test", mode: "print" }).ready;
		let subscription: ConversationProjectionSubscription | undefined;
		cleanups.push(async () => {
			subscription?.detach();
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		const manager = runtime.session.sessionManager;
		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
		const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
			fauxAssistantMessage("first assistant"),
		);
		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 2 });
		const oldLeafId = await runtime.session.sessionWriter.appendMessage(fauxAssistantMessage("second assistant"));

		const transcriptItems = (): RpcConversationTranscriptItem[] => {
			const items: RpcConversationTranscriptItem[] = [];
			for (const entry of manager.getBranch()) {
				if (entry.type !== "message" || (entry.message.role !== "user" && entry.message.role !== "assistant")) {
					continue;
				}
				items.push({
					entryId: entry.id,
					ordinal: entry.ordinal ?? 0,
					createdAt: entry.timestamp,
					role: entry.message.role,
					text: messageText(entry.message),
					truncated: false,
					...(entry.message.role === "assistant" ? { stopReason: entry.message.stopReason } : {}),
				});
			}
			return items;
		};

		const snapshotCuts: Array<{ stateMessages: number; transcriptMessages: number }> = [];
		const buildSnapshot: ConversationProjectionSnapshotBuilder = ({ activeAssistant, branchEpoch }) => {
			const items = transcriptItems();
			const state = buildRpcSessionState(runtime.session);
			snapshotCuts.push({ stateMessages: state.messageCount, transcriptMessages: items.length });
			const head = items.at(-1);
			return {
				conversation: { workspaceName: "test", sessionId: runtime.session.sessionId },
				state,
				transcript: {
					sessionId: runtime.session.sessionId,
					items,
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: head ? { entryId: head.entryId, ordinal: head.ordinal } : null,
				},
				activeAssistant,
				activeWorkflows: [],
			};
		};

		const writes: object[] = [];
		subscription = runtime.conversation.projectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot,
		});
		await subscription.ready;

		const rawLeafCuts: Array<{ nextLeafId: string | null; stateMessages: number }> = [];
		const detachRawLeaf = manager.subscribeBranchChanges((change) => {
			rawLeafCuts.push({ nextLeafId: change.nextLeafId, stateMessages: runtime.session.messages.length });
		});
		const committedCuts: Array<{
			previousLeafId: string | null;
			nextLeafId: string | null;
			stateMessages: number;
			transcriptMessages: number;
		}> = [];
		const detachCommitted = runtime.session.subscribeConversationGenerationChanges((change) => {
			committedCuts.push({
				...change,
				stateMessages: runtime.session.messages.length,
				transcriptMessages: transcriptItems().length,
			});
		});

		await runtime.session.navigateTree(firstAssistantId, { summarize: false });
		await subscription.flush();
		detachRawLeaf();
		detachCommitted();

		// SessionManager is now the sole message authority, so its raw branch
		// observer and the AgentSession projection see the same committed cut.
		expect(rawLeafCuts).toEqual([{ nextLeafId: firstAssistantId, stateMessages: 2 }]);
		expect(committedCuts).toEqual([
			{
				previousLeafId: oldLeafId,
				nextLeafId: firstAssistantId,
				stateMessages: 2,
				transcriptMessages: 2,
			},
		]);
		expect(snapshotCuts).toEqual([
			{ stateMessages: 4, transcriptMessages: 4 },
			{ stateMessages: 2, transcriptMessages: 2 },
		]);
		const bootstraps = writes.filter(
			(value): value is object & { type: "conversation_bootstrap" } =>
				"type" in value && value.type === "conversation_bootstrap",
		);
		expect(bootstraps).toHaveLength(2);
		expect(bootstraps[1]).toMatchObject({
			type: "conversation_bootstrap",
			reason: "branch_rebase",
			conversation: { sessionId: runtime.session.sessionId },
			state: { messageCount: 2 },
			transcript: {
				items: [
					{ entryId: expect.any(String), role: "user", text: "first user" },
					{ entryId: firstAssistantId, role: "assistant", text: "first assistant" },
				],
			},
		});
	});

	it("rejects tree navigation during a faux-provider message_update and preserves the run parent chain", async () => {
		const tempDir = join(
			tmpdir(),
			`volt-navigation-stream-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const faux = createFauxProvider();
		faux.setResponses([fauxAssistantMessage("streamed answer")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
				cwd,
			});
			services.modelRegistry.client.registerProvider(faux);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		// Stored beside the switch target, so a switch by id finds it before refusing the busy source.
		const manager = await SessionManager.create(tempDir, tempDir);
		const runtime = await openRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: manager,
		});
		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		await runtime.session.attachExtensionClient({ id: "test", mode: "print" }).ready;

		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
		const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
			fauxAssistantMessage("first assistant", { timestamp: 2 }),
		);
		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 3 });
		await runtime.session.sessionWriter.appendMessage(fauxAssistantMessage("second assistant", { timestamp: 4 }));
		const targetManager = await SessionManager.create(tempDir, tempDir);
		cleanups.push(() => targetManager.closePersistence());
		await targetManager.logWriter.appendMessage({ role: "user", content: "target user", timestamp: 5 });
		await targetManager.logWriter.appendMessage(fauxAssistantMessage("target assistant", { timestamp: 6 }));

		let releaseUpdate = () => {};
		const updateRelease = new Promise<void>((resolve) => {
			releaseUpdate = resolve;
		});
		let notifyUpdateStarted = () => {};
		const updateStarted = new Promise<void>((resolve) => {
			notifyUpdateStarted = resolve;
		});
		let heldUpdate = false;
		const runner = runtime.session.extensionRunner;
		const originalEmit = runner.emit.bind(runner);
		vi.spyOn(runner, "emit").mockImplementation(async (event) => {
			if (event.type === "message_update" && !heldUpdate) {
				heldUpdate = true;
				notifyUpdateStarted();
				await updateRelease;
			}
			return originalEmit(event);
		});

		const prompt = runtime.session.prompt("third user");
		await updateStarted;
		try {
			await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
				"Cannot navigate the session tree while an agent, bash run, or background job is active",
			);
			const structuralError = "Cannot change sessions while an agent run is active; abort or wait for it to finish";
			await expect(runtime.newSession()).rejects.toThrow(structuralError);
			await expect(runtime.switchSession(targetManager.getSessionRef()!)).rejects.toThrow(structuralError);
			await expect(runtime.switchSessionById(targetManager.getSessionId())).rejects.toThrow(structuralError);
			await expect(runtime.fork(firstAssistantId, { position: "at" })).rejects.toThrow(structuralError);
		} finally {
			releaseUpdate();
			await prompt;
		}

		const branchMessages = manager
			.getBranch()
			.filter(
				(entry): entry is SessionMessageEntry =>
					entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
			);
		expect(branchMessages.map((entry) => entry.message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(branchMessages.map((entry) => messageText(entry.message))).toEqual([
			"first user",
			"first assistant",
			"second user",
			"second assistant",
			"third user",
			"streamed answer",
		]);
		expect(branchMessages.at(-1)?.parentId).toBe(branchMessages.at(-2)?.id);
	});

	// A prompt reserves the conversation's turn before its extension preflight, so
	// no branch rebase can interleave with it: the prompt commits on the branch it targeted.
	it("refuses a branch rebase while a local prompt's extension preflight awaits", async () => {
		const tempDir = join(
			tmpdir(),
			`volt-local-prompt-generation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const faux = createFauxProvider();
		faux.setResponses([fauxAssistantMessage("targeted assistant")]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
				cwd,
			});
			services.modelRegistry.client.registerProvider(faux);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const manager = SessionManager.inMemory(tempDir);
		const runtime = await openRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: manager,
		});
		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
		const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
			fauxAssistantMessage("first assistant", { timestamp: 2 }),
		);
		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 3 });
		await runtime.session.sessionWriter.appendMessage(fauxAssistantMessage("second assistant", { timestamp: 4 }));

		let releasePreflight = () => {};
		const preflightRelease = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let notifyPreflightStarted = () => {};
		const preflightStarted = new Promise<void>((resolve) => {
			notifyPreflightStarted = resolve;
		});
		const runner = runtime.session.extensionRunner;
		const originalHasHandlers = runner.hasHandlers.bind(runner);
		vi.spyOn(runner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "before_agent_start" || originalHasHandlers(eventType),
		);
		vi.spyOn(runner, "emitBeforeAgentStart").mockImplementation(async () => {
			notifyPreflightStarted();
			await preflightRelease;
			return undefined;
		});

		const prompt = runtime.session.prompt("enters the targeted branch");
		await preflightStarted;
		try {
			await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
				"Cannot navigate the session tree while an agent, bash run, or background job is active",
			);
		} finally {
			releasePreflight();
		}
		await prompt;

		expect(
			manager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")
						? [messageText(entry.message)]
						: [],
				),
		).toEqual([
			"first user",
			"first assistant",
			"second user",
			"second assistant",
			"enters the targeted branch",
			"targeted assistant",
		]);
	});

	it.each(["input", "before_agent_start"] as const)(
		"refuses a branch rebase while a remote prompt's %s hook awaits",
		async (boundary) => {
			const tempDir = join(
				tmpdir(),
				`volt-conversation-authority-race-${boundary}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(tempDir, { recursive: true });
			const faux = createFauxProvider();
			faux.setResponses([fauxAssistantMessage("targeted assistant")]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					agentDir: tempDir,
					authStorage,
					resourceLoaderOptions: {
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
					},
					cwd,
				});
				services.modelRegistry.client.registerProvider(faux);
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: faux.getModel(),
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};
			const runtime = await openRuntime(createRuntime, {
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.inMemory(tempDir),
			});
			let modePromise: Promise<void> | undefined;
			let endMode: (() => void) | undefined;
			cleanups.push(async () => {
				endMode?.();
				await modePromise;
				await runtime.dispose();
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			});

			const manager = runtime.session.sessionManager;
			await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
			const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
				fauxAssistantMessage("first assistant"),
			);
			await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 2 });
			await runtime.session.sessionWriter.appendMessage(fauxAssistantMessage("second assistant"));

			let releaseBoundary = () => {};
			const boundaryRelease = new Promise<void>((resolve) => {
				releaseBoundary = resolve;
			});
			let notifyBoundaryStarted = () => {};
			const boundaryStarted = new Promise<void>((resolve) => {
				notifyBoundaryStarted = resolve;
			});
			const runner = runtime.session.extensionRunner;
			const originalHasHandlers = runner.hasHandlers.bind(runner);
			runner.hasHandlers = (eventType) => eventType === boundary || originalHasHandlers(eventType);
			if (boundary === "input") {
				runner.emitInput = async (text, images) => {
					notifyBoundaryStarted();
					await boundaryRelease;
					return { action: "transform", text, images };
				};
			} else {
				runner.emitBeforeAgentStart = async () => {
					notifyBoundaryStarted();
					await boundaryRelease;
					return undefined;
				};
			}

			vi.spyOn(runtime.session, "attachExtensionClient");
			const mode = await startIrohRpcMode(
				{ host: runtime.host, conversation: runtime.conversation },
				runtime.session,
			);
			modePromise = mode.modePromise;
			endMode = () => mode.recv.end();
			const authority = getCurrentConversationAuthority(mode.send);
			mode.recv.pushLine(
				JSON.stringify({
					id: `targeted-${boundary}`,
					type: "prompt",
					clientMessageId: `targeted-client-${boundary}`,
					message: "enters the targeted branch",
					conversationAuthority: authority,
				}),
			);
			await boundaryStarted;

			try {
				await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
					"Cannot navigate the session tree while an agent, bash run, or background job is active",
				);
			} finally {
				releaseBoundary();
			}

			await vi.waitFor(() => {
				expect(parseWrittenObjects(mode.send)).toContainEqual(
					expect.objectContaining({ id: `targeted-${boundary}`, success: true }),
				);
			});
			await runtime.session.waitForIdle();
			const frames = parseWrittenObjects(mode.send);
			expect(
				frames.some((frame) => frame.type === "conversation_bootstrap" && frame.reason === "branch_rebase"),
			).toBe(false);
			expect(
				manager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [],
					),
			).toEqual(["first user", "second user", "enters the targeted branch"]);
		},
	);

	it.each([
		{
			name: "new_session",
			command: (_targetSessionId: string) => ({ type: "new_session" as const }),
		},
		{
			name: "switch_session_by_id",
			command: (targetSessionId: string) => ({
				type: "switch_session_by_id" as const,
				sessionId: targetSessionId,
			}),
		},
		{
			name: "invoke_ui_action session.new",
			command: (_targetSessionId: string) => ({
				type: "invoke_ui_action" as const,
				action: "session.new",
			}),
		},
	])("rejects remote $name when session_before_switch awaits across a branch rebase", async ({ name, command }) => {
		const tempDir = join(
			tmpdir(),
			`volt-structural-authority-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(tempDir, { recursive: true });
		const faux = createFauxProvider();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
				cwd,
			});
			services.modelRegistry.client.registerProvider(faux);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const activeManager = await SessionManager.create(tempDir, tempDir);
		const runtime = await openRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: activeManager,
		});
		const targetManager = await SessionManager.create(tempDir, tempDir);
		await targetManager.logWriter.appendMessage({ role: "user", content: "switch target", timestamp: 1 });
		await targetManager.logWriter.appendMessage(fauxAssistantMessage("switch target assistant"));
		const targetSessionId = targetManager.getSessionId();
		let modePromise: Promise<void> | undefined;
		let endMode: (() => void) | undefined;
		cleanups.push(async () => {
			endMode?.();
			await modePromise;
			await runtime.dispose();
			await targetManager.closePersistence();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
		const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
			fauxAssistantMessage("first assistant"),
		);
		await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 2 });
		await runtime.session.sessionWriter.appendMessage(fauxAssistantMessage("second assistant"));
		const originalSession = runtime.session;
		const originalSessionId = originalSession.sessionId;

		let releaseSwitch = () => {};
		const switchRelease = new Promise<void>((resolve) => {
			releaseSwitch = resolve;
		});
		let notifySwitchStarted = () => {};
		const switchStarted = new Promise<void>((resolve) => {
			notifySwitchStarted = resolve;
		});
		const runner = runtime.session.extensionRunner;
		const originalHasHandlers = runner.hasHandlers.bind(runner);
		vi.spyOn(runner, "hasHandlers").mockImplementation(
			(eventType) => eventType === "session_before_switch" || originalHasHandlers(eventType),
		);
		const originalEmit = runner.emit.bind(runner);
		vi.spyOn(runner, "emit").mockImplementation(async (event) => {
			if (event.type === "session_before_switch") {
				notifySwitchStarted();
				await switchRelease;
				return undefined;
			}
			return originalEmit(event);
		});

		vi.spyOn(runtime.session, "attachExtensionClient");
		const mode = await startIrohRpcMode({ host: runtime.host, conversation: runtime.conversation }, runtime.session);
		modePromise = mode.modePromise;
		endMode = () => mode.recv.end();
		const id = `stale-structural-${name.replaceAll(" ", "-")}`;
		mode.recv.pushLine(
			JSON.stringify({
				id,
				...command(targetSessionId),
				conversationAuthority: getCurrentConversationAuthority(mode.send),
			}),
		);
		await switchStarted;

		await runtime.session.navigateTree(firstAssistantId, { summarize: false });
		releaseSwitch();

		await vi.waitFor(() => {
			const frames = parseWrittenObjects(mode.send);
			expect(frames).toContainEqual(
				expect.objectContaining({
					id,
					success: false,
					errorCode: "stale_conversation_authority",
				}),
			);
			const rebaseIndex = frames.findIndex(
				(frame) => frame.type === "conversation_bootstrap" && frame.reason === "branch_rebase",
			);
			const rejectionIndex = frames.findIndex((frame) => frame.id === id);
			expect(rebaseIndex).toBeGreaterThanOrEqual(0);
			expect(rejectionIndex).toBeGreaterThan(rebaseIndex);
		});
		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionId).toBe(originalSessionId);
		expect(
			activeManager
				.getBranch()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [],
				),
		).toEqual(["first user"]);
	});

	// Pre-admission auto-compaction runs inside the prompt's turn, before its first
	// request, so no branch rebase can interleave with its hook.
	it.each([
		{
			phase: "pre-admission",
			initialUsageTokens: 100,
			boundary: "session_before_compact" as const,
		},
	])(
		"refuses a branch rebase while $phase auto-compaction's $boundary awaits",
		async ({ initialUsageTokens, boundary }) => {
			const tempDir = join(
				tmpdir(),
				`volt-compaction-authority-race-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			);
			mkdirSync(tempDir, { recursive: true });
			const faux = createFauxProvider();
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					agentDir: tempDir,
					authStorage,
					resourceLoaderOptions: {
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
					},
					cwd,
				});
				services.modelRegistry.client.registerProvider(faux);
				return {
					...(await createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: faux.getModel(),
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};
			const manager = SessionManager.inMemory(tempDir);
			const runtime = await openRuntime(createRuntime, {
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: manager,
			});
			let modePromise: Promise<void> | undefined;
			let endMode: (() => void) | undefined;
			cleanups.push(async () => {
				endMode?.();
				await modePromise;
				await runtime.dispose();
				if (existsSync(tempDir)) {
					rmSync(tempDir, { recursive: true, force: true });
				}
			});

			await runtime.session.sessionWriter.appendMessage({ role: "user", content: "first user", timestamp: 1 });
			const firstAssistantId = await runtime.session.sessionWriter.appendMessage(
				fauxAssistantMessage("first assistant", { timestamp: 2 }),
			);
			await runtime.session.sessionWriter.appendMessage({ role: "user", content: "second user", timestamp: 3 });
			const secondAssistant = fauxAssistantMessage("second assistant", { timestamp: 4 });
			secondAssistant.usage = {
				input: initialUsageTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: initialUsageTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			await runtime.session.sessionWriter.appendMessage(secondAssistant);
			faux.setResponses([fauxAssistantMessage("fresh assistant")]);
			vi.spyOn(runtime.session.settingsManager, "getCompactionSettings").mockReturnValue({
				enabled: true,
				reserveTokens: faux.getModel().contextWindow ?? 200_000,
				keepRecentTokens: 1,
			});

			let releaseBoundary = () => {};
			const boundaryRelease = new Promise<void>((resolve) => {
				releaseBoundary = resolve;
			});
			let notifyBoundaryStarted = () => {};
			const boundaryStarted = new Promise<void>((resolve) => {
				notifyBoundaryStarted = resolve;
			});
			let compactionHookCalls = 0;
			const runner = runtime.session.extensionRunner;
			const originalHasHandlers = runner.hasHandlers.bind(runner);
			vi.spyOn(runner, "hasHandlers").mockImplementation(
				(eventType) => eventType === "session_before_compact" || originalHasHandlers(eventType),
			);
			const originalEmit = runner.emit.bind(runner);
			vi.spyOn(runner, "emit").mockImplementation(async (event) => {
				if (event.type === "session_before_compact") {
					compactionHookCalls++;
					if (boundary === "session_before_compact") {
						notifyBoundaryStarted();
						await boundaryRelease;
					}
					return {
						compaction: {
							summary: "hook compaction summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				}
				return originalEmit(event);
			});

			vi.spyOn(runtime.session, "attachExtensionClient");
			const mode = await startIrohRpcMode(
				{ host: runtime.host, conversation: runtime.conversation },
				runtime.session,
			);
			modePromise = mode.modePromise;
			endMode = () => mode.recv.end();
			mode.recv.pushLine(
				JSON.stringify({
					id: "targeted-compaction",
					type: "prompt",
					clientMessageId: "targeted-compaction-client",
					message: "enters the targeted branch",
					conversationAuthority: getCurrentConversationAuthority(mode.send),
				}),
			);
			await boundaryStarted;

			try {
				await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
					"Cannot navigate the session tree while an agent, bash run, or background job is active",
				);
			} finally {
				releaseBoundary();
			}

			await vi.waitFor(() => {
				const frames = parseWrittenObjects(mode.send);
				expect(frames).toContainEqual(expect.objectContaining({ id: "targeted-compaction", success: true }));
				expect(frames).toContainEqual(expect.objectContaining({ type: "compaction_end", aborted: false }));
			});
			await runtime.session.waitForIdle();
			const frames = parseWrittenObjects(mode.send);
			expect(
				frames.some((frame) => frame.type === "conversation_bootstrap" && frame.reason === "branch_rebase"),
			).toBe(false);
			expect(compactionHookCalls).toBe(1);
			expect(manager.getBranch().flatMap((entry) => (entry.type === "compaction" ? [entry.summary] : []))).toEqual([
				"hook compaction summary",
			]);
			expect(
				manager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [],
					),
			).toEqual(["first user", "second user", "enters the targeted branch"]);
		},
	);
});
