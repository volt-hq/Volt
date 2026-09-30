import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionError } from "../../../src/index.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("regression #527: extension cleanup after conversation authority loss", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function createRuntimeForTest(extend?: (volt: ExtensionAPI, instance: number) => void) {
		const harness = await createHarness();
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
		return { runtime, harness, lifecycle, resources, errors, shutdown };
	}

	async function conflict(runtime: AgentSessionRuntime) {
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
		manager.appendCustomEntry("stale-write", {});
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
			expect(outcomes).toHaveLength(8);
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
