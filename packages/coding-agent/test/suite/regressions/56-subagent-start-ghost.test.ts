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
		commit: vi.fn(),
		rollback: vi.fn(async () => {}),
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
