import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import type { ReviewWorkflowEvent, ReviewWorkflowToolEvent } from "../../../src/core/review.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function createRuntime() {
	const directory = mkdtempSync(join(tmpdir(), "volt-537-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const harnesses: Harness[] = [];
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager }) => {
		const harness = await createHarness({
			sessionManager,
			agentDir: directory,
			settings: { lsp: { enabled: false }, compaction: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("saved reply")]);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: directory,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		return {
			session: harness.session,
			extensionsResult: harness.session.resourceLoader.getExtensions(),
			services,
			diagnostics: [],
		};
	};
	const manager = await SessionManager.create(directory);
	const runtime = await createAgentSessionRuntime(factory, {
		cwd: directory,
		agentDir: directory,
		sessionManager: manager,
	});
	cleanups.push(async () => {
		// A runtime whose session lost authority cannot close its persistence cleanly.
		await runtime.dispose().catch(() => {});
		for (const harness of harnesses) await harness.cleanupAsync().catch(() => {});
	});
	await runtime.session.prompt("initial prompt");
	return runtime;
}

function startReview(runtime: AgentSessionRuntime, workflowId: string, launched = true) {
	const finished = Promise.withResolvers<void>();
	const cleanupFinished = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const workflow = runtime.reviewWorkflows.start({
		prepared: {
			workflowId,
			action: "review.custom",
			startedAt: Date.now(),
			resolution: { description: "test review", diffCommand: "git diff" },
		},
		execute: async ({ signal }) => {
			signal.addEventListener("abort", () => finished.resolve(), { once: true });
			started.resolve();
			await finished.promise;
			await cleanupFinished.promise;
			return { status: "cancelled" };
		},
	});
	cleanups.push(() => {
		finished.resolve();
		cleanupFinished.resolve();
	});
	if (launched) workflow.launch();
	return { workflow, started: started.promise, finish: finished.resolve, releaseCleanup: cleanupFinished.resolve };
}

describe("regression #537: authority loss cancels only the owning runtime's reviews", () => {
	it("cancels a running review and joins its cleanup, leaving other runtimes' reviews running", async () => {
		const runtime = await createRuntime();
		const otherRuntime = await createRuntime();
		const unrelated = startReview(otherRuntime, "unrelated");
		const events: Array<ReviewWorkflowEvent | ReviewWorkflowToolEvent> = [];
		runtime.reviewWorkflows.attachSink((event) => events.push(event));
		const review = startReview(runtime, "review");
		await review.started;

		runtime.session.sessionManager.retireConversationAuthority(new Error("write could not be confirmed"));

		await vi.waitFor(() => expect(review.workflow.signal.aborted).toBe(true));
		expect(unrelated.workflow.signal.aborted).toBe(false);
		review.releaseCleanup();
		await expect(review.workflow.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(runtime.reviewWorkflows.get("review")?.status).toBe("cancelled");
		expect(events.filter((event) => event.type === "workflow_end" && event.workflowId === "review")).toHaveLength(1);
	});

	it("cancels a review registered before launch without starting its executor", async () => {
		const runtime = await createRuntime();
		const review = startReview(runtime, "not-launched", false);
		runtime.session.sessionManager.retireConversationAuthority(new Error("lost"));
		await expect(review.workflow.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(review.workflow.signal.aborted).toBe(true);
	});
});
