import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `volt-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
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
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
			});
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("reserves replacement ownership before invalidating the old runtime", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		runtimeHost.setPrepareSessionReplacement(async () => {
			phases.push("prepare");
			return {
				async commit() {
					phases.push("commit");
				},
				async finalize() {
					phases.push("finalize");
				},
				async rollback() {
					phases.push("rollback");
				},
				async dispose() {
					phases.push("dispose");
				},
			};
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebind");
		});
		const commitSourceRebind = runtimeHost.conversationProjectionFeed.commitSourceRebind.bind(
			runtimeHost.conversationProjectionFeed,
		);
		vi.spyOn(runtimeHost.conversationProjectionFeed, "commitSourceRebind").mockImplementation(() => {
			phases.push("publish");
			commitSourceRebind();
		});

		await runtimeHost.newSession();
		expect(phases).toEqual(["prepare", "session_shutdown", "commit", "publish", "finalize", "rebind"]);
	});

	it("leaves the old runtime live when replacement ownership preflight rejects", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		const originalSessionId = originalSession.sessionId;
		runtimeHost.setPrepareSessionReplacement(async () => {
			throw new Error("target lease occupied");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("target lease occupied");
		expect(runtimeHost.session).toBe(originalSession);
		expect(runtimeHost.session.sessionId).toBe(originalSessionId);
		await expect(runtimeHost.session.prompt("still alive")).resolves.toBeUndefined();
	});

	it("serializes complete structural operations and rejects a queued stale derivation", async () => {
		const shutdownReasons: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", (event) => {
				shutdownReasons.push(event.reason);
			});
		});
		let releasePreparation!: () => void;
		let markPreparationStarted!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let preparationCount = 0;
		runtimeHost.setPrepareSessionReplacement(async () => {
			preparationCount++;
			markPreparationStarted();
			await preparationGate;
			return undefined;
		});

		const first = runtimeHost.newSession();
		await preparationStarted;
		const queuedFromOldSession = runtimeHost.newSession();
		releasePreparation();

		await first;
		await expect(queuedFromOldSession).rejects.toThrow("Stale agent session structural operation");
		expect(preparationCount).toBe(1);
		expect(shutdownReasons).toEqual(["new"]);
	});

	it("leases a stable session across streams and supports nested structural replacement", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releasePreparation!: () => void;
		let markPreparationStarted!: () => void;
		const preparationStarted = new Promise<void>((resolve) => {
			markPreparationStarted = resolve;
		});
		const preparationGate = new Promise<void>((resolve) => {
			releasePreparation = resolve;
		});
		let prepareCount = 0;
		runtimeHost.setPrepareSessionReplacement(async () => {
			prepareCount++;
			if (prepareCount === 1) {
				markPreparationStarted();
				await preparationGate;
			}
			return undefined;
		});

		const replacement = runtimeHost.newSession();
		await preparationStarted;
		expect(runtimeHost.isSessionOperationInProgress).toBe(true);
		let stableReadStarted = false;
		const stableRead = runtimeHost.runWithStableSession((session) => {
			stableReadStarted = true;
			return session.sessionId;
		});
		await Promise.resolve();
		expect(stableReadStarted).toBe(false);

		releasePreparation();
		await replacement;
		expect(await stableRead).toBe(runtimeHost.session.sessionId);
		expect(runtimeHost.isSessionOperationInProgress).toBe(false);

		const nestedSourceSession = runtimeHost.session;
		const nestedResult = await runtimeHost.runWithStableSession(async (leasedSession) => {
			await runtimeHost.newSession();
			return { leasedSession, replacementSession: runtimeHost.session };
		});
		expect(nestedResult.leasedSession).toBe(nestedSourceSession);
		expect(nestedResult.replacementSession).not.toBe(nestedSourceSession);
	});

	it("rejects interruption acquisition while a replacement generation is unpublished", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		let releasePublication = (): void => {};
		let markPublicationStarted = (): void => {};
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const detach = runtimeHost.subscribeSessionWillProject(async () => {
			markPublicationStarted();
			await publicationGate;
		});

		const replacement = runtimeHost.newSession();
		await publicationStarted;
		const duringReplacement = vi.fn();
		expect(() => runtimeHost.runSessionInterruption(duringReplacement)).toThrow(
			"Agent session generation is changing; retry the interruption",
		);
		expect(duringReplacement).not.toHaveBeenCalled();

		releasePublication();
		await replacement;
		const replacementSession = runtimeHost.session;
		expect(replacementSession).not.toBe(originalSession);
		const afterPublication = vi.fn();
		runtimeHost.runSessionInterruption(afterPublication);
		expect(afterPublication).toHaveBeenCalledOnce();
		expect(afterPublication).toHaveBeenCalledWith(replacementSession);
		detach();
	});

	it("recursively drains fire-and-forget actor children before advancing the lifecycle FIFO", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releaseChild = () => {};
		let markChildStarted = () => {};
		const childStarted = new Promise<void>((resolve) => {
			markChildStarted = resolve;
		});
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let releaseGrandchild = () => {};
		let markGrandchildStarted = () => {};
		const grandchildStarted = new Promise<void>((resolve) => {
			markGrandchildStarted = resolve;
		});
		const grandchildGate = new Promise<void>((resolve) => {
			releaseGrandchild = resolve;
		});

		let rootSettled = false;
		const root = runtimeHost
			.runWithStableSession(async () => {
				void runtimeHost.runWithStableSession(async () => {
					markChildStarted();
					await childGate;
					void runtimeHost.runWithStableSession(async () => {
						markGrandchildStarted();
						await grandchildGate;
					});
				});
				await childStarted;
			})
			.then(() => {
				rootSettled = true;
			});
		await childStarted;

		let followingStarted = false;
		const following = runtimeHost.runWithStableSession(() => {
			followingStarted = true;
		});
		try {
			releaseChild();
			await grandchildStarted;
			await Promise.resolve();
			expect(rootSettled).toBe(false);
			expect(followingStarted).toBe(false);
		} finally {
			releaseChild();
			releaseGrandchild();
		}
		await root;
		await following;
		expect(rootSettled).toBe(true);
		expect(followingStarted).toBe(true);
	});

	it("revokes actor authority from detached descendants after their parent settles", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let triggerDetached = () => {};
		const detachedTrigger = new Promise<void>((resolve) => {
			triggerDetached = resolve;
		});
		let detachedOperation: Promise<void> | undefined;
		let detachedStarted = false;

		await runtimeHost.runWithStableSession(() => {
			void detachedTrigger.then(() => {
				detachedOperation = runtimeHost.runWithStableSession(() => {
					detachedStarted = true;
				});
			});
		});

		let releaseBlocker = () => {};
		let markBlockerStarted = () => {};
		const blockerStarted = new Promise<void>((resolve) => {
			markBlockerStarted = resolve;
		});
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		const blocker = runtimeHost.runWithStableSession(async () => {
			markBlockerStarted();
			await blockerGate;
		});
		await blockerStarted;
		try {
			triggerDetached();
			await vi.waitFor(() => expect(detachedOperation).toBeDefined());
			expect(detachedStarted).toBe(false);
		} finally {
			releaseBlocker();
		}
		await blocker;
		await detachedOperation;
		expect(detachedStarted).toBe(true);
	});

	it("orders disposal after an admitted replacement and exposes its drain barrier", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		let releasePublication!: () => void;
		let markPublicationStarted!: () => void;
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		runtimeHost.subscribeSessionWillProject(async () => {
			markPublicationStarted();
			await publicationGate;
		});

		const replacement = runtimeHost.newSession();
		await publicationStarted;
		let drainSettled = false;
		const drain = runtimeHost.waitForSessionOperations().then(() => {
			drainSettled = true;
		});
		let disposeSettled = false;
		const disposal = runtimeHost.dispose().then(() => {
			disposeSettled = true;
		});
		await Promise.resolve();
		expect(drainSettled).toBe(false);
		expect(disposeSettled).toBe(false);
		await expect(runtimeHost.newSession()).rejects.toThrow(/no longer accepting structural operations/);

		releasePublication();
		await replacement;
		await drain;
		await disposal;
		expect(drainSettled).toBe(true);
		expect(disposeSettled).toBe(true);
	});

	it("fences the old feed before staging transcript commits and swapping the runtime session", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const originalSession = runtimeHost.session;
		vi.spyOn(SessionManager.prototype, "subscribeEntries").mockImplementationOnce(() => {
			expect(runtimeHost.session).toBe(originalSession);
			expect(() =>
				runtimeHost.conversationProjectionFeed.attach({
					write: () => {},
					buildSnapshot: () => {
						throw new Error("replacement generation must remain unpublished");
					},
				}),
			).toThrow(/awaiting host ownership rekey/);
			throw new Error("transcript subscription failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("transcript subscription failed");
		expect(runtimeHost.session).toBe(originalSession);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("disposed feed must not snapshot");
				},
			}),
		).toThrow(/disposed/);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("notifies independent co-attached replacement listeners", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const first: string[] = [];
		const second: string[] = [];
		const detachFirst = runtimeHost.subscribeSessionReplaced((session) => {
			first.push(session.sessionId);
		});
		runtimeHost.subscribeSessionReplaced((session) => {
			second.push(session.sessionId);
		});

		await runtimeHost.newSession();
		const replacementID = runtimeHost.session.sessionId;
		detachFirst();
		await runtimeHost.newSession();

		expect(first).toEqual([replacementID]);
		expect(second).toEqual([replacementID, runtimeHost.session.sessionId]);
	});

	it("keeps an attached conversation projection healthy while host-only input WAL is committed", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const writes: object[] = [];
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
			projectExternal: (event) => ({
				type: "visible-transcript-commit",
				entryType: (event as { entry: { type: string } }).entry.type,
			}),
		});
		await subscription.ready;
		const bootstrapCount = writes.length;
		const manager = runtimeHost.session.sessionManager;

		manager.reserveClientInput("runtime-private-wal", "prompt", "semantic-digest");
		manager.transitionClientInput("runtime-private-wal", "started");
		await subscription.flush();
		expect(writes).toHaveLength(bootstrapCount);

		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "visible" }],
			clientMessageId: "runtime-private-wal",
			timestamp: Date.now(),
		});
		await subscription.flush();
		expect(writes.at(-1)).toMatchObject({
			type: "visible-transcript-commit",
			entryType: "message",
			delivery: { subscriptionId: subscription.subscriptionId },
		});

		subscription.requestCheckpoint("still-healthy");
		await subscription.flush();
		expect(writes.at(-1)).toMatchObject({ type: "conversation_bootstrap", reason: "resync" });
		subscription.detach();
	});

	it("does not publish a replacement generation before host ownership rekeys", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const phases: string[] = [];
		const writes: object[] = [];
		let releaseRekey!: () => void;
		let markRekeyStarted!: () => void;
		const rekeyStarted = new Promise<void>((resolve) => {
			markRekeyStarted = resolve;
		});
		const rekeyGate = new Promise<void>((resolve) => {
			releaseRekey = resolve;
		});
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: (value) => {
				writes.push(value);
			},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: runtimeHost.session.agent.state.messages.length,
					pendingMessageCount: 0,
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
		});
		await subscription.ready;
		const initialWriteCount = writes.length;
		const detachWillProject = runtimeHost.subscribeSessionWillProject(async () => {
			phases.push("ownership-rekey-started");
			markRekeyStarted();
			await rekeyGate;
			phases.push("ownership-rekeyed");
		});
		const detachReplaced = runtimeHost.subscribeSessionReplaced(() => {
			phases.push("session-rebound");
		});

		const replacement = runtimeHost.newSession();
		await rekeyStarted;
		expect(writes).toHaveLength(initialWriteCount);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must remain fenced");
				},
			}),
		).toThrow(/awaiting host ownership rekey/);

		releaseRekey();
		await replacement;
		await subscription.flush();
		expect(phases).toEqual(["ownership-rekey-started", "ownership-rekeyed", "session-rebound"]);
		expect(writes.at(-1)).toMatchObject({
			type: "conversation_bootstrap",
			reason: "session_rebind",
			conversation: { sessionId: runtimeHost.session.sessionId },
			delivery: { subscriptionId: subscription.subscriptionId, cursor: 0 },
		});

		detachWillProject();
		detachReplaced();
		subscription.detach();
	});

	it("disposes replacement ownership exactly once when a pre-publication barrier fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const ownershipPhases: string[] = [];
		runtimeHost.setPrepareSessionReplacement(async () => ({
			async commit() {
				ownershipPhases.push("commit");
			},
			async finalize() {
				ownershipPhases.push("finalize");
			},
			async rollback() {
				ownershipPhases.push("rollback");
			},
			async dispose() {
				ownershipPhases.push("dispose");
			},
		}));
		const subscription = runtimeHost.conversationProjectionFeed.attach({
			write: () => {},
			buildSnapshot: ({ activeAssistant, branchEpoch }) => ({
				conversation: { workspaceName: "test", sessionId: runtimeHost.session.sessionId },
				state: {
					thinkingLevel: "off",
					availableThinkingLevels: ["off"],
					isStreaming: false,
					isCompacting: false,
					steeringMode: "one-at-a-time",
					followUpMode: "one-at-a-time",
					sessionId: runtimeHost.session.sessionId,
					autoCompactionEnabled: true,
					messageCount: 0,
					pendingMessageCount: 0,
				},
				transcript: {
					sessionId: runtimeHost.session.sessionId,
					items: [],
					hasMore: false,
					nextBeforeEntryId: null,
					projectionVersion: 3,
					branchEpoch,
					head: null,
				},
				activeAssistant,
				activeWorkflows: [],
			}),
		});
		await subscription.ready;
		const detach = runtimeHost.subscribeSessionWillProject(() => {
			// Real hosts release/dispose their old lease before rejecting this barrier.
			throw new Error("target lease occupied");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("target lease occupied");
		await expect(subscription.flush()).rejects.toThrow(/closed/);
		expect(ownershipPhases).toEqual(["commit", "dispose"]);
		detach();

		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must not build from a disposed replacement");
				},
			}),
		).toThrow(/disposed/);
	});

	it("disposes committed replacement ownership when post-publication rebind fails", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {});
		const ownershipPhases: string[] = [];
		runtimeHost.setPrepareSessionReplacement(async () => ({
			async commit() {
				ownershipPhases.push("commit");
			},
			async finalize() {
				ownershipPhases.push("finalize");
			},
			async rollback() {
				ownershipPhases.push("rollback");
			},
			async dispose() {
				ownershipPhases.push("dispose");
			},
		}));
		runtimeHost.setRebindSession(async () => {
			throw new Error("rebind failed");
		});

		await expect(runtimeHost.newSession()).rejects.toThrow("rebind failed");
		expect(ownershipPhases).toEqual(["commit", "finalize", "dispose"]);
		expect(() =>
			runtimeHost.conversationProjectionFeed.attach({
				write: () => {},
				buildSnapshot: () => {
					throw new Error("must not build from a disposed replacement");
				},
			}),
		).toThrow(/disposed/);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((volt) => {
			volt.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			volt.on("session_shutdown", (event) => {
				events.push(event);
			});
			volt.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});
