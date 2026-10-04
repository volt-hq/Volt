import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/rpc/index.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SubagentManager } from "../../../src/core/subagents/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { adoptTestSession, connectTestClient } from "../../utilities/host-client.ts";
import { createHarness, type Harness } from "../harness.ts";

function createServices(harness: Harness, cwd = harness.tempDir, agentDir = harness.tempDir): AgentSessionServices {
	return {
		cwd,
		projectCwd: cwd,
		lexicalProjectCwd: cwd,
		agentDir,
		authStorage: harness.authStorage,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		resourceLoader: harness.session.resourceLoader,
		gitContextProvider: harness.session.gitContextProvider,
		releaseGitContextProvider: () => {},
		diagnostics: [],
	};
}

function createHarnessRuntimeFactory(options: { onHarness?: (harness: Harness, index: number) => void } = {}): {
	createRuntime: ConversationFactory;
	harnesses: Harness[];
} {
	const harnesses: Harness[] = [];
	const createRuntime: ConversationFactory = async ({ cwd, agentDir, sessionManager }) => {
		const harness = await createHarness({ sessionManager });
		const index = harnesses.push(harness) - 1;
		options.onHarness?.(harness, index);
		const services = createServices(harness, cwd, agentDir);
		return {
			session: harness.session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services,
			diagnostics: services.diagnostics,
		};
	};
	return { createRuntime, harnesses };
}

function cleanupHarnesses(harnesses: Harness[]): void {
	for (const harness of harnesses.reverse()) harness.cleanup();
}

/** Make `host` fail closing `conversation` with `error`, once the conversation closed. */
function failClose(host: ConversationHost, conversation: HostedConversation, error: Error): void {
	const close = host.close.bind(host);
	host.close = async (closing, event) => {
		await close(closing, event);
		if (closing === conversation) throw error;
	};
}

describe("PR #329 finalizer error contract", () => {
	it("closes the child conversation once when local subagent RPC startup fails", async () => {
		const owner = await createHarness();
		const startupError = new Error("injected local RPC startup failure");
		const fixture = createHarnessRuntimeFactory({
			onHarness: (harness) => {
				vi.spyOn(harness.session, "attachExtensionClient").mockImplementation(() => ({
					ready: Promise.reject(startupError),
					detach: () => {},
				}));
			},
		});
		const manager = new SubagentManager({
			createRuntime: fixture.createRuntime,
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
		});
		const originalClose = ConversationHost.prototype.close;
		let logicalFinalizerCalls = 0;
		const closeSpy = vi.spyOn(ConversationHost.prototype, "close").mockImplementation(function (
			this: ConversationHost,
			conversation,
			event,
		): Promise<void> {
			if (fixture.harnesses.some((harness) => harness.session === conversation.session)) logicalFinalizerCalls += 1;
			return originalClose.call(this, conversation, event);
		});

		try {
			await expect(manager.start()).rejects.toBe(startupError);
			expect(logicalFinalizerCalls).toBe(1);
		} finally {
			await manager.dispose().catch(() => undefined);
			closeSpy.mockRestore();
			cleanupHarnesses(fixture.harnesses);
			owner.cleanup();
		}
	});

	it("aggregates every child-handle disposal failure from SubagentManager.dispose", async () => {
		const owner = await createHarness();
		const fixture = createHarnessRuntimeFactory();
		const disposalErrors = [new Error("first child disposal failed"), new Error("second child disposal failed")];
		let runtimeIndex = 0;
		const manager = new SubagentManager({
			createRuntime: fixture.createRuntime,
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
			onRuntimeCreated: ({ host, conversation }) => {
				const disposalError = disposalErrors[runtimeIndex++];
				if (!disposalError) throw new Error("unexpected extra child runtime");
				// The child's in-process client closes its conversation when the handle is disposed.
				failClose(host, conversation, disposalError);
			},
		});

		try {
			await manager.start();
			await manager.start();

			const thrown = await manager.dispose().catch((error: unknown) => error);

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate child cleanup failure");
			const errors = thrown.errors as unknown[];
			expect(errors).toHaveLength(disposalErrors.length);
			for (const disposalError of disposalErrors) expect(errors).toContain(disposalError);
		} finally {
			await manager.dispose().catch(() => undefined);
			cleanupHarnesses(fixture.harnesses);
			owner.cleanup();
		}
	});

	it("preserves RPC startup and runtime disposal failures together", async () => {
		const harness = await createHarness();
		const startupError = new Error("injected RPC bind failure");
		const cleanupError = new Error("injected RPC runtime disposal failure");
		vi.spyOn(harness.session, "attachExtensionClient").mockImplementation(() => ({
			ready: Promise.reject(startupError),
			detach: () => {},
		}));
		const createRuntime: ConversationFactory = async ({ cwd, agentDir }) => {
			const services = createServices(harness, cwd, agentDir);
			return {
				session: harness.session,
				extensionsResult: harness.session.resourceLoader.getExtensions(),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const { host, conversation } = adoptTestSession(harness.session, createServices(harness), createRuntime);
		failClose(host, conversation, cleanupError);
		const pair = createLoopbackRpcTransportPair();

		try {
			const running = runRpcMode(host, conversation, {
				transport: pair.server,
				exitProcess: false,
			}).catch((error: unknown) => error);
			// The client attaches, and its extensions bind, once it says hello.
			await pair.client.write({
				type: "hello",
				protocol: 1,
				client: { name: "test", version: "1" },
				accepts: { hostRequests: [] },
			});
			const thrown = await running;

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate RPC startup cleanup failure");
			const errors = thrown.errors as unknown[];
			expect(errors).toHaveLength(2);
			expect(errors[0]).toBe(startupError);
			expect(errors.slice(1)).toContain(cleanupError);
		} finally {
			await pair.client.close();
			harness.cleanup();
		}
	});

	it("preserves subagent and persistence failures through conversation close", async () => {
		const owner = await createHarness();
		const sessionManager = await SessionManager.create(owner.tempDir, join(owner.tempDir, "runtime-sessions"));
		const subagentManager = new SubagentManager({
			createRuntime: async () => {
				throw new Error("child runtime creation is not expected");
			},
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
		});
		const created = await createAgentSession({
			cwd: owner.tempDir,
			agentDir: owner.tempDir,
			authStorage: owner.authStorage,
			modelRegistry: owner.session.modelRegistry,
			model: owner.getModel(),
			settingsManager: owner.settingsManager,
			resourceLoader: owner.session.resourceLoader,
			sessionManager,
			subagentToolManager: subagentManager,
			disableMcp: true,
			noTools: "all",
		});
		const services: AgentSessionServices = {
			cwd: owner.tempDir,
			projectCwd: owner.tempDir,
			lexicalProjectCwd: owner.tempDir,
			agentDir: owner.tempDir,
			authStorage: owner.authStorage,
			settingsManager: created.session.settingsManager,
			modelRegistry: created.session.modelRegistry,
			resourceLoader: created.session.resourceLoader,
			gitContextProvider: created.session.gitContextProvider,
			releaseGitContextProvider: () => {},
			diagnostics: [],
		};
		const { host, conversation } = adoptTestSession(created.session, services, async () => {
			throw new Error("replacement runtime creation is not expected");
		});
		const runtime = await connectTestClient(host, conversation);
		const subagentError = new Error("injected subagent cleanup failure");
		const persistenceError = new Error("injected persistence cleanup failure");
		const disposeSubagents = subagentManager.dispose.bind(subagentManager);
		const closePersistence = sessionManager.closePersistence.bind(sessionManager);
		let subagentDisposeCalls = 0;
		let managerCloseCalls = 0;
		const subagentDisposeSpy = vi.spyOn(subagentManager, "dispose").mockImplementation(async () => {
			subagentDisposeCalls++;
			await disposeSubagents();
			throw subagentError;
		});
		const managerCloseSpy = vi.spyOn(sessionManager, "closePersistence").mockImplementation(async () => {
			managerCloseCalls++;
			await closePersistence();
			throw persistenceError;
		});

		try {
			const thrown = await runtime.dispose().catch((error: unknown) => error);

			expect(thrown).toBeInstanceOf(AggregateError);
			if (!(thrown instanceof AggregateError)) throw new Error("expected aggregate runtime cleanup failure");
			expect(thrown.message).toBe("Conversation cleanup did not complete");
			expect(thrown.errors as unknown[]).toEqual([subagentError, persistenceError]);
			expect(subagentDisposeCalls).toBe(1);
			expect(managerCloseCalls).toBe(1);
			await expect(created.session.prompt("must not run")).rejects.toThrow("Cannot prompt a disposed session");
			await expect(runtime.newSession()).rejects.toThrow("The client is not attached to a conversation");
		} finally {
			subagentDisposeSpy.mockRestore();
			managerCloseSpy.mockRestore();
			await runtime.dispose().catch(() => undefined);
			await sessionManager.closePersistence().catch(() => undefined);
			await subagentManager.dispose().catch(() => undefined);
			await owner.cleanupAsync();
		}
	});
});
