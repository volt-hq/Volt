import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import {
	type SubagentDefinition,
	SubagentManager,
	type SubagentRuntimeRegistration,
} from "../../../src/core/subagents/index.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

interface TestContext {
	manager: SubagentManager;
	registration: SubagentRuntimeRegistration;
	cleanup(): Promise<void>;
}

function createDeferred(): { promise: Promise<void>; resolve(): void } {
	let resolve: () => void = () => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createDefinition(): SubagentDefinition {
	const filePath = join(tmpdir(), "issue-56-researcher.md");
	return {
		name: "researcher",
		description: "Research the task",
		systemPrompt: "Research the task.",
		source: "user",
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "user" }),
		filePath,
	};
}

async function createTestContext(options: {
	withConfiguredAuth: boolean;
	providerFailure?: boolean;
	commit?: () => void;
	rollback?: () => Promise<void>;
}): Promise<TestContext> {
	const children: Harness[] = [];
	const definition = createDefinition();
	const resourceLoader: ResourceLoader = {
		...createTestResourceLoader(),
		getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, agentDir, sessionManager }) => {
		const child = await createHarness({ withConfiguredAuth: options.withConfiguredAuth });
		children.push(child);
		if (options.providerFailure) {
			child.setResponses([
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "provider rejected the accepted request",
				}),
			]);
		}
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: child.authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		services.settingsManager.applyOverrides({ retry: { enabled: false } });
		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			model: child.getModel(),
			noTools: "all",
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const registration: SubagentRuntimeRegistration = {
		commit: vi.fn(options.commit ?? (() => {})),
		rollback: vi.fn(options.rollback ?? (async () => {})),
	};
	const manager = new SubagentManager({
		createRuntime,
		cwd: tmpdir(),
		agentDir: tmpdir(),
		resourceLoader,
		requestTimeoutMs: 5_000,
		onRuntimeCreated: () => registration,
	});
	return {
		manager,
		registration,
		async cleanup() {
			await manager.dispose();
			for (const child of children) child.cleanup();
		},
	};
}

describe("issue #56", () => {
	it("does not publish a prepared child before its first prompt is accepted", async () => {
		const context = await createTestContext({ withConfiguredAuth: false });
		try {
			await context.manager.startByName("researcher");

			expect(context.manager.listActivities()).toEqual([]);
			expect(context.manager.listDelegations()).toEqual([]);
			expect(context.registration.commit).not.toHaveBeenCalled();
			expect(context.registration.rollback).not.toHaveBeenCalled();
		} finally {
			await context.cleanup();
		}
	});

	it("leaves no activity or delegation after first-prompt preflight rejection", async () => {
		const context = await createTestContext({ withConfiguredAuth: false });
		try {
			const handle = await context.manager.startByName("researcher");

			await expect(handle.prompt("inspect authentication")).rejects.toThrow(/API key/i);
			await handle.dispose();

			expect(context.manager.listActivities()).toEqual([]);
			expect(context.manager.listDelegations()).toEqual([]);
			expect(context.registration.commit).not.toHaveBeenCalled();
			expect(context.registration.rollback).toHaveBeenCalledOnce();
		} finally {
			await context.cleanup();
		}
	});

	it("waits for an in-flight registration rollback before disposal completes", async () => {
		const rollbackStarted = createDeferred();
		const finishRollback = createDeferred();
		const context = await createTestContext({
			withConfiguredAuth: false,
			rollback: async () => {
				rollbackStarted.resolve();
				await finishRollback.promise;
			},
		});
		let prompt: Promise<void> | undefined;
		try {
			const handle = await context.manager.startByName("researcher");
			prompt = handle.prompt("inspect authentication");
			void prompt.catch(() => undefined);
			await rollbackStarted.promise;

			const disposal = handle.dispose();
			const disposalState = await Promise.race([
				disposal.then(() => "resolved" as const),
				new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
			]);

			expect(disposalState).toBe("pending");
			finishRollback.resolve();
			await expect(prompt).rejects.toThrow(/API key/i);
			await disposal;
			expect(context.registration.rollback).toHaveBeenCalledOnce();
		} finally {
			finishRollback.resolve();
			if (prompt) await prompt.catch(() => undefined);
			await context.cleanup();
		}
	});

	it("disposes the handle after an unpublished prompt failure", async () => {
		const context = await createTestContext({ withConfiguredAuth: false });
		try {
			const handle = await context.manager.startByName("researcher");

			await expect(handle.prompt("inspect authentication")).rejects.toThrow(/API key/i);

			// The rollback disposed the prepared child runtime, so the handle is
			// dead: later calls must fail with a clear disposed-handle error.
			await expect(handle.getState()).rejects.toThrow(`Subagent ${handle.id} is disposed`);
			await expect(handle.prompt("retry")).rejects.toThrow(`Subagent ${handle.id} is disposed`);
			await expect(handle.waitForEnd()).rejects.toThrow(/disposed before completion/);
			await handle.dispose();
			expect(context.registration.rollback).toHaveBeenCalledOnce();
		} finally {
			await context.cleanup();
		}
	});

	it("disposes the handle when the registration commit rejects an accepted prompt", async () => {
		const context = await createTestContext({
			withConfiguredAuth: true,
			commit: () => {
				throw new Error("Parent runtime is not active");
			},
		});
		try {
			const handle = await context.manager.startByName("researcher");

			// The commit runs after the child accepted the prompt; its failure must
			// still take the unpublished rollback path and dispose the handle.
			await expect(handle.prompt("inspect authentication")).rejects.toThrow("Parent runtime is not active");

			await expect(handle.getState()).rejects.toThrow(`Subagent ${handle.id} is disposed`);
			await expect(handle.prompt("retry")).rejects.toThrow(`Subagent ${handle.id} is disposed`);
			await expect(handle.waitForEnd()).rejects.toThrow(/disposed before completion/);
			expect(context.manager.listActivities()).toEqual([]);
			expect(context.manager.listDelegations()).toEqual([]);
			expect(context.registration.rollback).toHaveBeenCalledOnce();
		} finally {
			await context.cleanup();
		}
	});

	it("retains an accepted run that fails during provider execution", async () => {
		const context = await createTestContext({ withConfiguredAuth: true, providerFailure: true });
		try {
			const handle = await context.manager.startByName("researcher");
			const completion = handle.waitForEnd();

			await handle.prompt("inspect authentication");
			await completion;
			await handle.dispose();

			expect(context.manager.listActivities()).toMatchObject([
				{
					id: handle.id,
					task: "inspect authentication",
					status: "failed",
					error: "provider rejected the accepted request",
				},
			]);
			expect(context.manager.listDelegations()).toMatchObject([
				{
					id: handle.id,
					status: "failed",
					error: "provider rejected the accepted request",
				},
			]);
			expect(context.registration.commit).toHaveBeenCalledOnce();
			expect(context.registration.rollback).not.toHaveBeenCalled();
		} finally {
			await context.cleanup();
		}
	});
});
