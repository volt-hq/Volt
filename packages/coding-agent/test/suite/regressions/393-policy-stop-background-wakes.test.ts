import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SubagentManager } from "../../../src/core/subagents/index.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import * as nativeTools from "../../../src/core/tools/index.ts";
import { createHarness } from "../harness.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => vi.restoreAllMocks());

describe("#393 subagent policy stops fence background wakes", () => {
	it.each([
		{ stage: "natural completion at limit", maxTurns: 2, exhausted: true },
		{ stage: "requested final report", maxTurns: 1, exhausted: true },
		{ stage: "ordinary completion below limit", maxTurns: 5, exhausted: false },
	])("handles late sibling outcomes after $stage", async ({ maxTurns, exhausted }) => {
		const fixture = await createHarness({
			settings: { lsp: { enabled: false }, retry: { enabled: false }, compaction: { enabled: false } },
		});
		const workers = new Map<string, ReturnType<typeof deferred>>();
		const exec = vi.fn<BashOperations["exec"]>(async (command, _cwd, options) => {
			const finish = deferred();
			workers.set(command, finish);
			options.signal?.addEventListener("abort", finish.resolve, { once: true });
			try {
				await finish.promise;
				if (options.signal?.aborted) throw new Error("Cancelled worker");
				options.onData(Buffer.from(`retained output for ${command}`));
				return { exitCode: command === "failed" ? 1 : 0 };
			} finally {
				options.signal?.removeEventListener("abort", finish.resolve);
			}
		});
		const original = nativeTools.createAllToolDefinitions;
		vi.spyOn(nativeTools, "createAllToolDefinitions").mockImplementation((cwd, options) =>
			original(cwd, { ...options, bash: { ...options?.bash, operations: { exec } } }),
		);
		let runtime: AgentSessionRuntime | undefined;
		const manager = new SubagentManager({
			cwd: fixture.tempDir,
			agentDir: fixture.tempDir,
			parentSessionManager: SessionManager.inMemory(fixture.tempDir),
			turnLimits: { maxTurns },
			createRuntime: async ({ cwd, sessionManager }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir: fixture.tempDir,
					authStorage: fixture.authStorage,
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					},
				});
				services.settingsManager.applyOverrides({
					lsp: { enabled: false },
					retry: { enabled: false },
					compaction: { enabled: false },
				});
				const created = await createAgentSessionFromServices({
					services,
					sessionManager,
					model: fixture.getModel(),
					tools: ["bash", "jobs"],
				});
				return { ...created, services, diagnostics: services.diagnostics };
			},
			onRuntimeCreated: (event) => {
				runtime = event.runtime;
			},
		});
		try {
			fixture.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("bash", { command: "completed", background: true }),
						fauxToolCall("bash", { command: "failed", background: true }),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Child final report."),
			]);
			const handle = await manager.start();
			if (!runtime) throw new Error("Expected child runtime");
			const child = runtime.session;
			await handle.prompt("Start independent background work and finish the report");
			await vi.waitFor(() => expect(fixture.faux.state.callCount).toBe(2));
			await child.waitForIdle();
			expect(child.getLastAssistantText()).toBe("Child final report.");
			expect(child.hasBackgroundJobs).toBe(true);
			expect(exec).toHaveBeenCalledTimes(2);
			const jobs = child.backgroundJobs.list();
			let expectedCalls = 2;
			for (const command of ["completed", "failed"]) {
				fixture.setResponses([fauxAssistantMessage(`Handled ${command} outcome.`)]);
				workers.get(command)!.resolve();
				const job = jobs.find((job) => job.label === command)!;
				await vi.waitFor(() => expect(child.backgroundJobs.get(job.id).endedAt).toBeDefined());
				await child.waitForIdle();
				if (!exhausted) expectedCalls++;
				expect(fixture.faux.state.callCount).toBe(expectedCalls);
				expect(child.backgroundJobs.get(job.id)).toMatchObject({
					status: command,
					output: expect.stringContaining(`retained output for ${command}`),
				});
			}
			expect((await handle.waitForEnd()).status).toBe("completed");
			if (exhausted) {
				expect(child.getLastAssistantText()).toBe("Child final report.");
				// Explicit new prompts are still allowed, but cannot execute tools after exhaustion.
				fixture.setResponses([fauxAssistantMessage("Explicit report-only follow-up.")]);
				await child.prompt("Answer one explicit follow-up");
				expect(fixture.faux.state.callCount).toBe(3);
				expect(child.getLastAssistantText()).toBe("Explicit report-only follow-up.");
				fixture.setResponses([
					fauxAssistantMessage(fauxToolCall("bash", { command: "must not run" }), { stopReason: "toolUse" }),
				]);
				await child.prompt("Attempt a tool after exhaustion");
				expect(fixture.faux.state.callCount).toBe(4);
				expect(exec).toHaveBeenCalledTimes(2);
				expect(JSON.stringify(child.messages)).toContain("turn budget is exhausted");
			}
		} finally {
			for (const worker of workers.values()) worker.resolve();
			await manager.dispose();
			await fixture.cleanupAsync();
		}
	});
});
