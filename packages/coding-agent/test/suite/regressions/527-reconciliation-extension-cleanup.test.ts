import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { LiveClient } from "../../../src/core/host/live-state.ts";
import type { ExtensionTerminalUI } from "../../../src/core/session/extension-binding.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionError,
	ExtensionFactory,
	ExtensionUIContext,
} from "../../../src/index.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { connectTestClient, openTestHost, type TestClient } from "../../utilities/host-client.ts";
import { testExtension } from "../../utilities.ts";
import { createHarness } from "../harness.ts";

describe("regression #527: extension cleanup when a session ends", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRuntimeForTest(
		extend?: (volt: ExtensionAPI, instance: number) => void,
		otherExtensions: ExtensionFactory[] = [],
		uiOverrides?: Partial<ExtensionTerminalUI>,
		live?: LiveClient,
	) {
		const harness = await createHarness();
		const eventBus = createEventBus();
		cleanups.push(() => harness.cleanupAsync());
		const lifecycle: string[] = [];
		const resources: AbortController[] = [];
		const errors: ExtensionError[] = [];
		let instances = 0;
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				resourceLoaderOptions: {
					eventBus,
					extensionFactories: [
						testExtension("test-extension-1", (volt) => {
							const instance = ++instances;
							let resource: AbortController;
							volt.on("session_start", (event) => {
								resource = new AbortController();
								resources.push(resource);
								lifecycle.push(`${instance}:start:${event.reason}`);
							});
							extend?.(volt, instance);
							// Runs even if an earlier shutdown handler throws.
							volt.on("session_shutdown", async (event) => {
								await Promise.resolve();
								resource.abort();
								lifecycle.push(`${instance}:shutdown:${event.reason}`);
							});
						}),
						...otherExtensions.map((factory, index) => testExtension(`other-${index + 1}`, factory)),
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: harness.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const { host, conversation } = await openTestHost(createRuntime, {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: await SessionManager.create(harness.tempDir),
		});
		cleanups.push(() => host.dispose().catch(() => undefined));
		const shutdown = vi.fn();
		// The extensions are not bound yet: their UI context is the inert default the overrides replace.
		const ui = uiOverrides ? { ...conversation.session.extensionRunner.getUIContext(), ...uiOverrides } : undefined;
		// The host attaches the client's surface on every conversation it joins.
		const runtime: TestClient = await connectTestClient(host, conversation, {
			id: "client",
			...(live === undefined ? {} : { live }),
			surface: {
				...(ui ? { ui } : {}),
				shutdownHandler: shutdown,
				onError: (error) => errors.push(error),
				commandContextActions: {
					waitForIdle: () => runtime.session.waitForIdle(),
					newSession: (options) => runtime.newSession(options),
					fork: async (entryId, options) => {
						const result = await runtime.fork(entryId, options);
						return result.cancelled
							? result
							: { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
					},
					switchSession: (ref, options) => runtime.switchSession(ref, options),
					navigateTree: (targetId, options) => runtime.session.navigateTree(targetId, options),
					reload: () => runtime.session.reload(),
				},
			},
		});
		return { runtime, harness, lifecycle, resources, errors, shutdown, eventBus };
	}

	/** The session's lock is lost and its next commit finds out: the conversation ends. */
	async function loseRuntimeLog(runtime: TestClient): Promise<Error> {
		const lost = await loseLog(runtime.session.sessionWriter);
		await expect(runtime.lost).resolves.toBe(lost);
		return lost;
	}

	it("cleans up once when the host closes a conversation whose session lost its log", async () => {
		const { runtime, lifecycle, resources, errors, shutdown } = await createRuntimeForTest();
		const lostSession = runtime.session;
		const lostConversation = runtime.conversation;
		await loseRuntimeLog(runtime);

		const disposal = runtime.host.close(lostConversation);
		expect(runtime.host.close(lostConversation)).toBe(disposal);
		// The loss was reported through `lost`; disposal does not report it again.
		await expect(disposal).resolves.toBeUndefined();
		expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:quit"]);
		expect(resources.map((resource) => resource.signal.aborted)).toEqual([true]);
		expect(runtime.session).toBe(lostSession);
		expect(errors).toEqual([]);
		expect(shutdown).not.toHaveBeenCalled();
	});

	it("aborts command signals with the loss and rejects session writes until the conversation closes", async () => {
		let oldVolt: ExtensionAPI | undefined;
		let oldCommand: ExtensionCommandContext | undefined;
		const { runtime, harness, errors } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) return;
			oldVolt = volt;
			volt.registerCommand("capture", {
				handler: async (_args, ctx) => {
					oldCommand = ctx;
				},
			});
		});
		await runtime.session.prompt("/capture");
		const signal = oldCommand!.signal;
		expect(signal.aborted).toBe(false);

		const lost = await loseRuntimeLog(runtime);

		expect(signal.aborted).toBe(true);
		expect(signal.reason).toBe(lost);
		await expect(oldVolt!.appendEntry("forbidden", {})).rejects.toThrow(lost.message);
		await expect(oldVolt!.setSessionName("forbidden")).rejects.toThrow(lost.message);
		oldVolt!.sendUserMessage("forbidden");
		await vi.waitFor(() =>
			expect(errors).toContainEqual(expect.objectContaining({ event: "send_user_message", error: lost.message })),
		);
		expect(harness.faux.state.callCount).toBe(0);

		await runtime.dispose();
		expect(() => oldVolt!.appendEntry("forbidden", {})).toThrow(/stale/);
		expect(() => oldCommand!.signal).toThrow(/stale/);
	});

	it.each(["before", "during"] as const)(
		"lets shutdown handlers clean up owned resources when the session lost its log %s shutdown",
		async (timing) => {
			let resource: string;
			let cleanupScript: string;
			const results: number[] = [];
			const writeErrors: unknown[] = [];
			const { runtime, harness, errors } = await createRuntimeForTest((volt, instance) => {
				if (instance !== 1) return;
				volt.on("session_shutdown", async (_event, ctx) => {
					if (timing === "during") await loseLog(runtime.session.sessionWriter);
					try {
						await volt.appendEntry("shutdown-write", {});
					} catch (error) {
						writeErrors.push(error);
					}
					results.push((await volt.exec(process.execPath, [cleanupScript, resource], { cwd: ctx.cwd })).code);
				});
			});
			resource = join(harness.tempDir, "owned-resource");
			cleanupScript = join(harness.tempDir, "cleanup.mjs");
			await writeFile(resource, "owned by the extension");
			await writeFile(cleanupScript, 'import { unlink } from "node:fs/promises"; await unlink(process.argv[2]);');
			if (timing === "before") await loseRuntimeLog(runtime);

			await expect(runtime.dispose()).resolves.toBeUndefined();
			expect(results).toEqual([0]);
			expect(existsSync(resource)).toBe(false);
			expect(writeErrors).toHaveLength(1);
			expect(writeErrors[0]).toMatchObject({ message: expect.stringContaining("but the log head is") });
			expect(errors).toEqual([]);
		},
	);

	it("does not end the client's conversation when the outgoing session loses its log during a move", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, lifecycle, resources, errors } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) return;
			volt.on("session_shutdown", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		cleanups.push(async () => {
			release.resolve();
		});
		let ended = false;
		void runtime.lost.then(() => {
			ended = true;
		});
		const outgoing = runtime.session;
		const replacement = runtime.newSession();
		await entered.promise;
		await loseLog(outgoing.sessionWriter);
		await expect(outgoing.lost).resolves.toBeInstanceOf(Error);
		release.resolve();

		await expect(replacement).resolves.toEqual({
			cancelled: false,
			sessionId: runtime.session.sessionId,
			seeded: false,
		});
		expect(runtime.session).not.toBe(outgoing);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(ended).toBe(false);
		expect(lifecycle).toEqual(["1:start:startup", "2:start:new", "1:shutdown:new"]);
		expect(resources.map((resource) => resource.signal.aborted)).toEqual([true, false]);
		expect(errors).toEqual([]);
	});

	it("fences shared event buses after replacement while allowing owned subscriptions to be removed", async () => {
		const release = Promise.withResolvers<void>();
		const oldListener = vi.fn();
		const ownedListener = vi.fn();
		let oldEvents: ExtensionAPI["events"] | undefined;
		let lateWork: Promise<unknown> | undefined;
		const { runtime, eventBus } = await createRuntimeForTest((volt, instance) => {
			if (instance === 1) {
				oldEvents = volt.events;
				volt.events.on("probe", oldListener);
				const unsubscribe = volt.events.on("owned", ownedListener);
				volt.on("session_shutdown", () => {
					unsubscribe();
					lateWork = release.promise
						.then(() => volt.events.emit("mutate-new", {}))
						.catch((error: unknown) => error);
				});
			} else {
				volt.events.on("mutate-new", () => volt.appendEntry("bus-write", {}));
			}
		});
		cleanups.push(async () => {
			release.resolve();
			await lateWork;
		});
		eventBus.emit("probe", {});
		eventBus.emit("owned", {});
		expect(oldListener).toHaveBeenCalledOnce();
		expect(ownedListener).toHaveBeenCalledOnce();
		await runtime.newSession();
		eventBus.emit("probe", {});
		eventBus.emit("owned", {});
		expect(oldListener).toHaveBeenCalledOnce();
		expect(ownedListener).toHaveBeenCalledOnce();
		expect(() => oldEvents!.on("mutate-new", () => {})).toThrow(/stale/);
		release.resolve();
		expect(await lateWork).toMatchObject({ message: expect.stringContaining("stale") });
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "bus-write"),
		).toBe(false);
		// Other owners of the same bus and the new generation remain usable.
		eventBus.emit("mutate-new", {});
		await vi.waitFor(() =>
			expect(
				runtime.session.sessionManager
					.getEntries()
					.some((entry) => entry.type === "custom" && entry.customType === "bus-write"),
			).toBe(true),
		);
	});

	it("revokes captured UI objects and methods after replacement without losing the draft", async () => {
		let draft = "initial draft";
		const notify = vi.fn();
		const unsubscribe = vi.fn();
		const contexts: ExtensionUIContext[] = [];
		let capturedNotify: ExtensionUIContext["notify"];
		let capturedInput: ExtensionUIContext["input"];
		const input = vi.fn(async (_title: string) => "answer");
		let runtime: TestClient | undefined;
		// The client's live view: editor text, notifications, and the dialogs it answers.
		const live: LiveClient = {
			acceptsHostRequest: (kind) => kind === "input" || kind === "editor_text",
			apply: (update) => {
				for (const item of update.items) {
					if (item.type === "directive") draft = item.text;
					else if (item.type === "notice") notify(item.message);
					else if (item.type === "set" && item.value.kind === "host_request") {
						const { requestId, request } = item.value;
						if (request.kind === "editor_text") {
							const text = draft;
							queueMicrotask(() => runtime?.conversation.liveState.answer(requestId, { value: text }, "client"));
						}
						if (request.kind !== "input") continue;
						void input(request.title).then((value) =>
							runtime?.conversation.liveState.answer(requestId, { value }, "client"),
						);
					}
				}
			},
		};
		({ runtime } = await createRuntimeForTest(
			(volt, instance) => {
				let removeListener: () => void;
				volt.on("session_start", (_event, ctx) => {
					contexts.push(ctx.ui);
					if (instance !== 1) return;
					capturedNotify = ctx.ui.notify;
					capturedInput = ctx.ui.input;
					removeListener = ctx.ui.onTerminalInput(() => undefined);
				});
				volt.on("session_shutdown", () => {
					if (instance === 1) removeListener();
				});
			},
			[],
			{
				onTerminalInput: () => unsubscribe,
			},
			live,
		));
		contexts[0].setEditorText("unsent draft");
		await expect(contexts[0].getEditorText()).resolves.toBe("unsent draft");
		expect(contexts[0].notify).toBe(capturedNotify!);
		capturedNotify!("active notification");
		await expect(capturedInput!("active dialog")).resolves.toBe("answer");
		await runtime?.newSession();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(() => contexts[0].setEditorText("late callback overwrote draft")).toThrow(/stale/);
		expect(() => capturedNotify!("late notification")).toThrow(/stale/);
		await expect(Promise.resolve().then(() => capturedInput!("late dialog"))).rejects.toThrow(/stale/);
		expect(draft).toBe("unsent draft");
		expect(notify).toHaveBeenCalledExactlyOnceWith("active notification");
		expect(input).toHaveBeenCalledExactlyOnceWith("active dialog");
		contexts[1].setEditorText("new generation draft");
		expect(draft).toBe("new generation draft");
	});

	it("revokes cached model and credential services after replacement while keeping the shared host services live", async () => {
		let registry: ExtensionContext["modelRegistry"];
		let credentials: ExtensionContext["modelRegistry"]["authStorage"];
		const { runtime } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) return;
			volt.on("session_start", (_event, ctx) => {
				registry = ctx.modelRegistry;
				credentials = registry.authStorage;
			});
		});
		registry!.registerProvider("cleanup-probe", { name: "active name" });
		credentials!.setRuntimeApiKey("cleanup-probe", "active test credential");
		const capturedRegister = registry!.registerProvider.bind(registry!);
		const capturedGetKey = credentials!.getApiKey.bind(credentials!);
		await expect(capturedGetKey("cleanup-probe")).resolves.toBe("active test credential");
		await runtime.newSession();
		expect(() => registry!.registerProvider("cleanup-probe", { name: "retired name" })).toThrow(/stale/);
		expect(() => credentials!.setRuntimeApiKey("cleanup-probe", "retired test credential")).toThrow(/stale/);
		expect(() => capturedRegister("cleanup-probe", { name: "retired name" })).toThrow(/stale/);
		await expect(Promise.resolve().then(() => capturedGetKey("cleanup-probe"))).rejects.toThrow(/stale/);
		const liveRegistry = runtime.session.modelRegistry;
		liveRegistry.registerProvider("cleanup-probe", { name: "live name" });
		expect(liveRegistry.getProviderDisplayName("cleanup-probe")).toBe("live name");
		await expect(liveRegistry.authStorage.getApiKey("cleanup-probe")).resolves.toBe("active test credential");
	});
});
