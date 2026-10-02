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
import { createHarness, getMessageText, type Harness } from "../harness.ts";

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
		await runtime.dispose();
		for (const harness of harnesses) await harness.cleanupAsync();
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
	it("cancels a running review, joins cleanup, then reloads and persists the next prompt", async () => {
		const runtime = await createRuntime();
		const otherRuntime = await createRuntime();
		const unrelated = startReview(otherRuntime, "unrelated");
		const events: Array<ReviewWorkflowEvent | ReviewWorkflowToolEvent> = [];
		runtime.reviewWorkflows.attachSink((event) => events.push(event));
		for (let generation = 0; generation < 2; generation++) {
			const staleSession = runtime.session;
			const review = startReview(runtime, `review-${generation}`);
			await review.started;
			const reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: staleSession.sessionId });
			const settled = vi.fn();
			void reload.then(settled);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(settled).not.toHaveBeenCalled();
			staleSession.sessionManager.retireConversationAuthority(new Error("write could not be confirmed"));
			await vi.waitFor(() => expect(review.workflow.signal.aborted).toBe(true));
			expect(unrelated.workflow.signal.aborted).toBe(false);
			expect(runtime.session).toBe(staleSession);
			expect(settled).not.toHaveBeenCalled();
			review.releaseCleanup();
			await expect(reload).resolves.toEqual({ reloaded: true });
			expect(runtime.session).not.toBe(staleSession);
			expect(runtime.reviewWorkflows.get(`review-${generation}`)?.status).toBe("cancelled");
			expect(
				events.filter((event) => event.type === "workflow_end" && event.workflowId === `review-${generation}`),
			).toHaveLength(1);
			await runtime.session.prompt(`after reload ${generation}`);
			const reference = runtime.session.sessionRef;
			if (!reference) throw new Error("expected persisted reference");
			const reopened = await SessionManager.open(reference);
			try {
				expect(reopened.buildSessionContext().messages.map(getMessageText).slice(-2)).toEqual([
					`after reload ${generation}`,
					"saved reply",
				]);
			} finally {
				await reopened.closePersistence();
			}
		}
	});

	it("cancels a review registered before launch without starting its executor", async () => {
		const runtime = await createRuntime();
		const review = startReview(runtime, "not-launched", false);
		const stale = runtime.session;
		stale.sessionManager.retireConversationAuthority(new Error("lost"));
		await expect(runtime.reloadCurrentSessionFromStore({ expectedSessionId: stale.sessionId })).resolves.toEqual({
			reloaded: true,
		});
		await expect(review.workflow.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(review.workflow.signal.aborted).toBe(true);
	});
});
