import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import {
	clientActiveBranch,
	clientRestore,
	type HostFrame,
	REMOTE_CAPABILITIES,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ConversationFactory } from "../src/core/host/hosted-conversation.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { SessionManager, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { connectTestClient, type OpenTestHostOptions, openTestHost, type TestClient } from "./utilities/host-client.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

type Frame<T extends HostFrame["type"]> = Extract<HostFrame, { type: T }>;

const ALL: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

/** Open a conversation in a host of its own and attach an in-place anchor client to it. */
async function openRuntime(factory: ConversationFactory, options: OpenTestHostOptions): Promise<TestClient> {
	const { host, conversation } = await openTestHost(factory, options);
	return connectTestClient(host, conversation);
}

/** Whether a device was sent a branch switch: the `leaf` entry a tree navigation commits. */
function isLeafEntry(frame: HostFrame): frame is Frame<"entry"> {
	return frame.type === "entry" && frame.entry.type === "leaf";
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

	/** A paired device on the client's conversation, subscribed from a snapshot; it disconnects at cleanup. */
	async function connectPhone(runtime: TestClient): Promise<RemotePhone> {
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: runtime.host,
			conversation: runtime.conversation,
			stream: pair.host,
			grant: ALL,
			redaction: { workspacePath: runtime.cwd },
			redirect: {},
		});
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(runtime.conversation.id);
		return phone;
	}

	it("switches the branch for devices only after branch transcript and Agent state commit together", async () => {
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
		cleanups.push(async () => {
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

		const transcriptMessages = (): number =>
			manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
				).length;

		const phone = await connectPhone(runtime);
		const from = phone.frames.length;

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
				transcriptMessages: transcriptMessages(),
			});
		});

		await runtime.session.navigateTree(firstAssistantId, { summarize: false });
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
		// A subscribed device folds the switch as one committed leaf entry.
		const leaf = await phone.waitFor(isLeafEntry, { from });
		expect(leaf.entry.payload).toEqual({ targetId: firstAssistantId });
		expect(phone.frames.slice(from).filter(isLeafEntry)).toHaveLength(1);
		// A device that subscribes now starts from the switched branch.
		await phone.subscribe(runtime.conversation.id, "after");
		const snapshot = phone.frames.find(
			(frame): frame is Frame<"snapshot"> => frame.type === "snapshot" && frame.subscriptionId === "after",
		);
		if (!snapshot) throw new Error("Expected a snapshot");
		expect(snapshot.state.leafId).toBe(firstAssistantId);
		expect(
			clientActiveBranch(clientRestore(snapshot.ordinal, snapshot.state)).flatMap((entry) =>
				entry.type === "message" ? [{ role: entry.view?.role, text: entry.view?.text }] : [],
			),
		).toEqual([
			{ role: "user", text: "first user" },
			{ role: "assistant", text: "first assistant" },
		]);
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
		"refuses a branch rebase while a device's prompt %s hook awaits",
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
			cleanups.push(async () => {
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
			const phone = await connectPhone(runtime);

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

			const from = phone.frames.length;
			const outcome = phone.intent(
				"prompt",
				{ message: "enters the targeted branch" },
				{ intentId: `targeted-client-${boundary}` },
			);
			await boundaryStarted;

			try {
				await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
					"Cannot navigate the session tree while an agent, bash run, or background job is active",
				);
			} finally {
				releaseBoundary();
			}

			expect(await outcome).toMatchObject({ type: "accepted" });
			await runtime.session.waitForIdle();
			expect(phone.frames.slice(from).some(isLeafEntry)).toBe(false);
			expect(
				manager
					.getBranch()
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "user" ? [messageText(entry.message)] : [],
					),
			).toEqual(["first user", "second user", "enters the targeted branch"]);
		},
	);

	// `invoke_ui_action session.new` is the `new_session` intent on protocol 1.
	it.each([
		{ name: "new_session", input: (_targetSessionId: string) => ({}) },
		{ name: "switch_session", input: (targetSessionId: string) => ({ sessionId: targetSessionId }) },
	])("rejects a device's $name when session_before_switch awaits across a branch rebase", async ({ name, input }) => {
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
		cleanups.push(async () => {
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
		const phone = await connectPhone(runtime);

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

		const from = phone.frames.length;
		const outcome = phone.intent(name, input(targetSessionId), { intentId: `stale-structural-${name}` });
		await switchStarted;

		await runtime.session.navigateTree(firstAssistantId, { summarize: false });
		releaseSwitch();

		const rejected = await outcome;
		expect(rejected).toMatchObject({
			type: "rejected",
			reason: { code: "stale", ordinal: runtime.session.conversationGenerationRevision },
		});
		// The device saw the branch switch before the intent it made on the old branch was refused.
		const frames = phone.frames.slice(from);
		const rebaseIndex = frames.findIndex(isLeafEntry);
		expect(rebaseIndex).toBeGreaterThanOrEqual(0);
		expect(frames.indexOf(rejected)).toBeGreaterThan(rebaseIndex);
		expect(frames.some((frame) => frame.type === "ended")).toBe(false);
		expect(runtime.session).toBe(originalSession);
		expect(runtime.session.sessionId).toBe(originalSessionId);
		expect(runtime.conversation.closed).toBe(false);
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
			const phone = await connectPhone(runtime);

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

			const from = phone.frames.length;
			const outcome = phone.intent(
				"prompt",
				{ message: "enters the targeted branch" },
				{ intentId: "targeted-compaction-client" },
			);
			await boundaryStarted;

			try {
				await expect(runtime.session.navigateTree(firstAssistantId, { summarize: false })).rejects.toThrow(
					"Cannot navigate the session tree while an agent, bash run, or background job is active",
				);
			} finally {
				releaseBoundary();
			}

			expect(await outcome).toMatchObject({ type: "accepted" });
			await phone.waitFor(
				(frame): frame is Frame<"entry"> => frame.type === "entry" && frame.entry.type === "compaction",
				{ from },
			);
			await runtime.session.waitForIdle();
			expect(phone.frames.slice(from).some(isLeafEntry)).toBe(false);
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
