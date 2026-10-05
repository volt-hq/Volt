import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import type { ConversationFactory, HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { reviewWorkInput } from "../../../src/core/review-work.ts";
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

/** Start a review on `conversation` as its `review` work; its executor runs until it is stopped or finished. */
async function startReview(conversation: HostedConversation, workId: string) {
	const finished = Promise.withResolvers<void>();
	const cleanupFinished = Promise.withResolvers<void>();
	const started = Promise.withResolvers<AbortSignal>();
	await conversation.work.start(
		"review",
		reviewWorkInput("review.custom", "test review"),
		async ({ signal }) => {
			signal.addEventListener("abort", () => finished.resolve(), { once: true });
			started.resolve(signal);
			await finished.promise;
			await cleanupFinished.promise;
			return signal.aborted ? { outcome: "cancelled" } : { outcome: "completed", result: { summary: "Reviewed." } };
		},
		{ workId },
	);
	cleanups.push(() => {
		finished.resolve();
		cleanupFinished.resolve();
	});
	return { started: started.promise, finish: finished.resolve, releaseCleanup: cleanupFinished.resolve };
}

describe("regression #537: a conversation that loses its log stops only its own reviews", () => {
	it("stops a running review and joins its cleanup, leaving other conversations' reviews running", async () => {
		const conversation = await openConversation();
		const other = await openConversation();
		const unrelated = await startReview(other, "unrelated");
		const review = await startReview(conversation, "review");
		const signal = await review.started;
		const unrelatedSignal = await unrelated.started;

		const lost = await loseLog(conversation.session.sessionWriter);
		await expect(conversation.lost).resolves.toBe(lost);

		await vi.waitFor(() => expect(signal.aborted).toBe(true));
		expect(unrelatedSignal.aborted).toBe(false);
		expect(conversation.work.running().map((record) => record.workId)).toEqual(["review"]);
		review.releaseCleanup();
		// The review stops; its lost log cannot record how, so the next open reconciles it.
		await vi.waitFor(() => expect(conversation.work.running()).toEqual([]));
		expect(conversation.session.work.busy()).toBe(false);
		expect(conversation.work.get("review")?.outcome).toBeUndefined();

		// The other conversation's review runs on and finishes as usual.
		expect(other.work.running().map((record) => record.workId)).toEqual(["unrelated"]);
		unrelated.finish();
		unrelated.releaseCleanup();
		await other.work.settled("unrelated");
		expect(other.work.get("unrelated")).toMatchObject({ kind: "review", outcome: "completed" });
	});

	it("starts no review once the conversation lost its log", async () => {
		const conversation = await openConversation();
		await loseLog(conversation.session.sessionWriter);
		const execute = vi.fn(async () => ({ outcome: "completed" as const }));
		await expect(
			conversation.work.start("review", reviewWorkInput("review.custom", "test review"), execute, {
				workId: "after-loss",
			}),
		).rejects.toMatchObject({ code: "closed" });
		expect(execute).not.toHaveBeenCalled();
		expect(conversation.work.get("after-loss")).toBeUndefined();
	});
});
