import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionError,
	ExtensionFactory,
	ExtensionUIContext,
} from "../../../src/index.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("regression #527: extension cleanup after conversation authority loss", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRuntimeForTest(
		extend?: (volt: ExtensionAPI, instance: number) => void,
		otherExtensions: ExtensionFactory[] = [],
		uiOverrides?: Partial<ExtensionUIContext>,
	) {
		const harness = await createHarness();
		const eventBus = createEventBus();
		cleanups.push(() => harness.cleanupAsync());
		const lifecycle: string[] = [];
		const resources: AbortController[] = [];
		const errors: ExtensionError[] = [];
		let instances = 0;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				resourceLoaderOptions: {
					eventBus,
					extensionFactories: [
						(volt) => {
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
						},
						...otherExtensions,
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
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: await SessionManager.create(harness.tempDir),
		});
		cleanups.push(() => runtime.dispose().catch(() => undefined));
		const shutdown = vi.fn();
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({
				uiContext: uiOverrides ? { ...session.extensionRunner.getUIContext(), ...uiOverrides } : undefined,
				shutdownHandler: shutdown,
				onError: (error) => errors.push(error),
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: (options) => runtime.newSession(options),
					fork: (entryId, options) => runtime.fork(entryId, options),
					switchSession: (ref, options) => runtime.switchSession(ref, options),
					navigateTree: (targetId, options) => session.navigateTree(targetId, options),
					reload: () => session.reload(),
				},
			});
		});
		await runtime.getRebindSession()?.(runtime.session);
		await runtime.session.sessionManager.flush();
		return { runtime, harness, lifecycle, resources, errors, shutdown, eventBus };
	}

	async function conflict(
		runtime: AgentSessionRuntime,
		write: () => void = () => runtime.session.sessionManager.appendCustomEntry("stale-write", {}),
	) {
		const manager = runtime.session.sessionManager;
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session");
		const other = await SessionManager.open(ref);
		try {
			other.appendMessage({ role: "user", content: "authoritative input", timestamp: Date.now() });
			await other.flush();
		} finally {
			await other.closePersistence();
		}
		write();
		await expect(manager.flush()).rejects.toThrow("Session revision changed");
		expect(manager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		return ref;
	}

	it.each(["switch", "reload"] as const)(
		"cleans the conflicted instance before %s and starts a fresh one",
		async (operation) => {
			const { runtime, harness, lifecycle, resources } = await createRuntimeForTest();
			const oldSession = runtime.session;
			const ref = await conflict(runtime);
			if (operation === "switch") await runtime.switchSession(ref);
			else await runtime.reloadCurrentSessionFromStore({ expectedSessionId: oldSession.sessionId });

			expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:resume", "2:start:resume"]);
			expect(resources.map((resource) => resource.signal.aborted)).toEqual([true, false]);
			expect(runtime.session).not.toBe(oldSession);
			expect(runtime.session.messages.map(getMessageText)).toEqual(["authoritative input"]);
			harness.setResponses([fauxAssistantMessage("new reply")]);
			await runtime.session.prompt("new input");
			await runtime.dispose();
			await runtime.dispose();
			expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:resume", "2:start:resume", "2:shutdown:quit"]);
			expect(resources.every((resource) => resource.signal.aborted)).toBe(true);
		},
	);

	it("cleans up once on quit while preserving the original persistence failure", async () => {
		const { runtime, lifecycle, resources } = await createRuntimeForTest();
		await conflict(runtime);
		const disposal = runtime.dispose();
		expect(runtime.dispose()).toBe(disposal);
		await expect(disposal).rejects.toThrow("Session revision changed");
		expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:quit"]);
		expect(resources[0].signal.aborted).toBe(true);
	});

	it("revokes captured APIs before cleanup and keeps detached cleanup continuations fenced", async () => {
		let oldVolt: ExtensionAPI | undefined;
		let oldCommand: ExtensionCommandContext | undefined;
		let shutdownContext: ExtensionContext | undefined;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const lateRelease = Promise.withResolvers<void>();
		let lateWork: Promise<unknown[]> | undefined;
		const rejected = async (operation: () => unknown): Promise<unknown> => {
			try {
				await operation();
				return undefined;
			} catch (error) {
				return error;
			}
		};
		const attempts = () =>
			Promise.all([
				rejected(() => oldVolt!.appendEntry("forbidden", {})),
				rejected(() => oldVolt!.sendUserMessage("forbidden")),
				rejected(() => oldVolt!.setSessionName("forbidden")),
				rejected(() => oldVolt!.registerProvider("forbidden", { baseUrl: "https://example.invalid" })),
				rejected(() => oldVolt!.events.emit("forbidden", {})),
				rejected(() => oldVolt!.events.on("forbidden", () => {})),
				rejected(() => oldCommand!.newSession()),
				rejected(() => oldCommand!.reload()),
				rejected(() => oldCommand!.shutdown()),
				rejected(() => shutdownContext!.compact()),
			]);
		const { runtime, harness, lifecycle, errors, shutdown } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) return;
			oldVolt = volt;
			volt.registerCommand("capture", {
				handler: async (_args, ctx) => {
					oldCommand = ctx;
				},
			});
			volt.on("session_shutdown", async (_event, ctx) => {
				shutdownContext = ctx;
				lateWork = lateRelease.promise.then(attempts);
				entered.resolve();
				await release.promise;
				throw new Error("cleanup failure must not suppress later cleanup handlers");
			});
		});
		cleanups.push(async () => {
			release.resolve();
			lateRelease.resolve();
			await lateWork;
		});
		await runtime.session.prompt("/capture");
		expect(oldCommand).toBeDefined();
		const ref = await conflict(runtime);
		const reload = runtime.switchSession(ref);
		const cleanupEntered = await Promise.race([entered.promise.then(() => true), reload.then(() => false)]);
		expect(cleanupEntered).toBe(true);
		const duringCleanup = await attempts();
		release.resolve();
		await reload;
		lateRelease.resolve();
		const afterReplacement = await lateWork;
		for (const outcomes of [duringCleanup, afterReplacement]) {
			expect(outcomes).toHaveLength(10);
			for (const error of outcomes ?? [])
				expect(error).toMatchObject({ message: expect.stringContaining("stale after conversation authority") });
		}
		expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:resume", "2:start:resume"]);
		expect(errors).toEqual([]);
		expect(shutdown).not.toHaveBeenCalled();
		expect(runtime.session.sessionId).toBe(ref.sessionId);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["authoritative input"]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(runtime.session.sessionName).toBeUndefined();
	});

	it("fences shared event buses while allowing owned subscriptions to be removed", async () => {
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
		const ref = await conflict(runtime);
		await runtime.switchSession(ref);
		eventBus.emit("probe", {});
		eventBus.emit("owned", {});
		expect(oldListener).toHaveBeenCalledOnce();
		expect(ownedListener).toHaveBeenCalledOnce();
		expect(() => oldEvents!.on("mutate-new", () => {})).toThrow(/stale/);
		release.resolve();
		expect(await lateWork).toMatchObject({ message: expect.stringContaining("stale after conversation authority") });
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "bus-write"),
		).toBe(false);
		// Other owners of the same bus and the new generation remain usable.
		eventBus.emit("mutate-new", {});
		expect(
			runtime.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "bus-write"),
		).toBe(true);
	});

	it("revokes captured UI objects and methods without losing the replacement draft", async () => {
		let draft = "initial draft";
		const notify = vi.fn();
		const unsubscribe = vi.fn();
		const contexts: ExtensionUIContext[] = [];
		let capturedNotify: ExtensionUIContext["notify"];
		let capturedInput: ExtensionUIContext["input"];
		const input = vi.fn(async () => "answer");
		const cleanupErrors: unknown[] = [];
		const { runtime } = await createRuntimeForTest(
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
					if (instance !== 1) return;
					removeListener();
					for (const operation of [
						() => contexts[0].setEditorText("cleanup overwrote draft"),
						() => capturedNotify("retired notification"),
					]) {
						try {
							operation();
							cleanupErrors.push(undefined);
						} catch (error) {
							cleanupErrors.push(error);
						}
					}
				});
			},
			[],
			{
				setEditorText(text) {
					draft = text;
				},
				getEditorText: () => draft,
				notify,
				input,
				onTerminalInput: () => unsubscribe,
			},
		);
		contexts[0].setEditorText("unsent draft");
		expect(contexts[0].getEditorText()).toBe("unsent draft");
		expect(contexts[0].notify).toBe(capturedNotify!);
		capturedNotify!("active notification");
		await expect(capturedInput!("active dialog")).resolves.toBe("answer");
		const ref = await conflict(runtime);
		await runtime.switchSession(ref);
		expect(cleanupErrors).toHaveLength(2);
		for (const error of cleanupErrors) expect(error).toMatchObject({ message: expect.stringContaining("stale") });
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

	it("revokes cached model and credential services while keeping the shared host services live", async () => {
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
		const ref = await conflict(runtime);
		await runtime.switchSession(ref);
		expect(() => registry!.registerProvider("cleanup-probe", { name: "retired name" })).toThrow(/stale/);
		expect(() => credentials!.setRuntimeApiKey("cleanup-probe", "retired test credential")).toThrow(/stale/);
		expect(() => capturedRegister("cleanup-probe", { name: "retired name" })).toThrow(/stale/);
		await expect(Promise.resolve().then(() => capturedGetKey("cleanup-probe"))).rejects.toThrow(/stale/);
		const liveRegistry = runtime.session.modelRegistry;
		liveRegistry.registerProvider("cleanup-probe", { name: "live name" });
		expect(liveRegistry.getProviderDisplayName("cleanup-probe")).toBe("live name");
		await expect(liveRegistry.authStorage.getApiKey("cleanup-probe")).resolves.toBe("active test credential");
	});

	it.each(["before", "during"] as const)(
		"allows process cleanup when authority is lost %s shutdown without restoring session access",
		async (timing) => {
			let firstResource: string;
			let secondResource: string;
			let cleanupScript: string;
			const results: number[] = [];
			const directories: string[] = [];
			let firstVolt: ExtensionAPI;
			const blocked: unknown[] = [];
			const { runtime, harness, errors } = await createRuntimeForTest(
				(volt, instance) => {
					if (instance !== 1) return;
					firstVolt = volt;
					volt.on("session_shutdown", async () => {
						if (timing === "during") await conflict(runtime, () => volt.appendEntry("shutdown-write", {}));
						results.push((await volt.exec(process.execPath, [cleanupScript, firstResource])).code);
					});
				},
				[
					(volt) => {
						volt.on("session_shutdown", async (_event, ctx) => {
							directories.push(ctx.cwd);
							for (const operation of [
								() => volt.appendEntry("forbidden", {}),
								() => volt.sendUserMessage("forbidden"),
								() => ctx.sessionManager.getEntries(),
								() => ctx.ui.notify("forbidden"),
								() => firstVolt.exec(process.execPath, [cleanupScript, firstResource]),
							]) {
								try {
									await operation();
									blocked.push(undefined);
								} catch (error) {
									blocked.push(error);
								}
							}
							results.push(
								(await volt.exec(process.execPath, [cleanupScript, secondResource], { cwd: ctx.cwd })).code,
							);
						});
					},
				],
			);
			firstResource = join(harness.tempDir, "first-owned-resource");
			secondResource = join(harness.tempDir, "second-owned-resource");
			cleanupScript = join(harness.tempDir, "cleanup.mjs");
			await writeFile(firstResource, "owned by the first extension");
			await writeFile(secondResource, "owned by the second extension");
			await writeFile(cleanupScript, 'import { unlink } from "node:fs/promises"; await unlink(process.argv[2]);');
			if (timing === "before") await conflict(runtime);
			await expect(runtime.dispose()).rejects.toThrow("Session revision changed");
			expect(results).toEqual([0, 0]);
			expect(directories).toEqual([harness.tempDir]);
			expect(existsSync(firstResource)).toBe(false);
			expect(existsSync(secondResource)).toBe(false);
			expect(blocked).toHaveLength(5);
			for (const error of blocked) expect(error).toMatchObject({ message: expect.stringContaining("stale") });
			expect(errors).toEqual([]);
		},
	);

	it("expires cleanup access per handler without opening concurrent or detached callbacks", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		const detachedRelease = Promise.withResolvers<void>();
		let oldVolt: ExtensionAPI;
		let oldContext: ExtensionContext;
		let detached: Promise<unknown[]> | undefined;
		let synchronousDetached: Promise<unknown[]> | undefined;
		let otherGenerationError: unknown;
		const attempts = async () => {
			const errors: unknown[] = [];
			for (const operation of [() => oldContext.cwd, () => oldVolt.exec(process.execPath, ["--version"])]) {
				try {
					await operation();
					errors.push(undefined);
				} catch (error) {
					errors.push(error);
				}
			}
			return errors;
		};
		const { runtime } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) {
				volt.on("session_shutdown", async () => {
					try {
						await oldVolt.exec(process.execPath, ["--version"]);
					} catch (error) {
						otherGenerationError = error;
					}
				});
				return;
			}
			oldVolt = volt;
			volt.on("session_shutdown", (_event, ctx) => {
				oldContext = ctx;
				synchronousDetached = Promise.resolve().then(attempts);
			});
			volt.on("session_shutdown", async (_event, ctx) => {
				oldContext = ctx;
				detached = detachedRelease.promise.then(attempts);
				entered.resolve();
				await release.promise;
				throw new Error("cleanup failed");
			});
			volt.on("session_shutdown", async () => {
				secondEntered.resolve();
				await secondRelease.promise;
			});
		});
		cleanups.push(async () => {
			release.resolve();
			secondRelease.resolve();
			detachedRelease.resolve();
			await detached;
		});
		const ref = await conflict(runtime);
		const replacing = runtime.switchSession(ref);
		await entered.promise;
		const concurrentErrors = await attempts();
		release.resolve();
		await secondEntered.promise;
		detachedRelease.resolve();
		const detachedErrors = await detached;
		secondRelease.resolve();
		await replacing;
		await runtime.dispose();
		for (const error of [
			...concurrentErrors,
			...(detachedErrors ?? []),
			...((await synchronousDetached) ?? []),
			...(await attempts()),
			otherGenerationError,
		]) {
			expect(error).toMatchObject({ message: expect.stringContaining("stale") });
		}
	});

	it("revokes a shutdown handler that loses authority while awaiting cleanup", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let oldVolt: ExtensionAPI | undefined;
		let writeError: unknown;
		const { runtime, lifecycle, resources, errors } = await createRuntimeForTest((volt, instance) => {
			if (instance !== 1) return;
			oldVolt = volt;
			volt.on("session_shutdown", async () => {
				entered.resolve();
				await release.promise;
				try {
					volt.appendEntry("forbidden", {});
				} catch (error) {
					writeError = error;
				}
			});
		});
		cleanups.push(async () => {
			release.resolve();
		});
		const manager = runtime.session.sessionManager;
		const reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId });
		await entered.promise;
		expect(manager.getConversationAuthorityStatus().status).toBe("available");
		manager.retireConversationAuthority(new Error("uncertain shutdown write"));
		expect(() => oldVolt!.registerCommand("forbidden", { handler: async () => {} })).toThrow(/stale/);
		release.resolve();
		await expect(reload).resolves.toEqual({ reloaded: true });
		expect(writeError).toBeInstanceOf(Error);
		expect(lifecycle).toEqual(["1:start:startup", "1:shutdown:resume", "2:start:resume"]);
		expect(resources.map((resource) => resource.signal.aborted)).toEqual([true, false]);
		expect(errors).toEqual([]);
	});
});
