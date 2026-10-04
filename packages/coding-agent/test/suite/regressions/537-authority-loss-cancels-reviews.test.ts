import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import type { ConversationFactory, HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import type { ReviewWorkflowEvent, ReviewWorkflowToolEvent } from "../../../src/core/review.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { openTestHost } from "../../utilities/host-client.ts";
import { createHarness, type Harness } from "../harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function openConversation(): Promise<HostedConversation> {
	const directory = mkdtempSync(join(tmpdir(), "volt-537-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const harnesses: Harness[] = [];
	const factory: ConversationFactory = async ({ cwd, sessionManager }) => {
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
	const { host, conversation } = await openTestHost(factory, {
		cwd: directory,
		agentDir: directory,
		sessionManager: manager,
	});
	cleanups.push(async () => {
		await host.dispose().catch(() => {});
		for (const harness of harnesses) await harness.cleanupAsync().catch(() => {});
	});
	await conversation.session.prompt("initial prompt");
	return conversation;
}

function startReview(conversation: HostedConversation, workflowId: string, launched = true) {
	const finished = Promise.withResolvers<void>();
	const cleanupFinished = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	const workflow = conversation.reviewWorkflows.start({
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

describe("regression #537: a conversation that loses its log cancels only its own reviews", () => {
	it("cancels a running review and joins its cleanup, leaving other conversations' reviews running", async () => {
		const conversation = await openConversation();
		const other = await openConversation();
		const unrelated = startReview(other, "unrelated");
		const events: Array<ReviewWorkflowEvent | ReviewWorkflowToolEvent> = [];
		conversation.reviewWorkflows.attachSink((event) => events.push(event));
		const review = startReview(conversation, "review");
		await review.started;

		const lost = await loseLog(conversation.session.sessionWriter);
		await expect(conversation.lost).resolves.toBe(lost);

		await vi.waitFor(() => expect(review.workflow.signal.aborted).toBe(true));
		expect(unrelated.workflow.signal.aborted).toBe(false);
		review.releaseCleanup();
		await expect(review.workflow.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(conversation.reviewWorkflows.get("review")?.status).toBe("cancelled");
		expect(events.filter((event) => event.type === "workflow_end" && event.workflowId === "review")).toHaveLength(1);
	});

	it("cancels a review registered before launch without starting its executor", async () => {
		const conversation = await openConversation();
		const review = startReview(conversation, "not-launched", false);
		await loseLog(conversation.session.sessionWriter);
		await expect(review.workflow.finished).resolves.toMatchObject({ status: "cancelled" });
		expect(review.workflow.signal.aborted).toBe(true);
	});
});
