import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import {
	type IntentContext,
	IntentRejectedError,
	type IntentTarget,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../../../src/core/protocol/intents/index.ts";
import { rejectionReason } from "../../../src/core/protocol/server/connection.ts";
import { HostReviewDiscussionService } from "../../../src/core/review-discussions.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../../../src/core/session-store/client.ts";
import { openTestHost } from "../../utilities/host-client.ts";
import { anchorReviewRun, recordReviewDiscussion, resetRecordedReviewDiscussion } from "../../utilities/review-runs.ts";
import { seedSession } from "../../utilities/seed-log.ts";
import { createHarness } from "../harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

const DISCUSSION = {
	discussionId: "discussion",
	runId: "run",
	findingId: "finding",
	contextSnapshot: { finding: "Canonical finding" },
};

/**
 * A hosted review source whose discussion was started (request `start`) and
 * then reset once (request `reset`), with the local intent context of a
 * client on it and the review discussion service a daemon gives it.
 */
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), "volt-818-"));
	const harness = await createHarness({ settings: { lsp: { enabled: false }, compaction: { enabled: false } } });
	const manager = await SessionManager.create(root, join(root, "sessions"));
	await seedSession(manager, (seed) =>
		seed.user("first").assistant("one", { id: "answer-one" }).user("second").assistant("two"),
	);
	await anchorReviewRun(manager, DISCUSSION.runId);
	const first = await recordReviewDiscussion(manager, DISCUSSION, { requestId: "start" });
	const second = await resetRecordedReviewDiscussion(manager, DISCUSSION, "reset");
	const factory: ConversationFactory = async ({ sessionManager, cwd, agentDir }) => {
		const created = await createAgentSession({
			sessionManager,
			cwd,
			agentDir,
			modelRegistry: harness.session.modelRegistry,
			authStorage: harness.authStorage,
			resourceLoader: harness.session.resourceLoader,
			settingsManager: harness.settingsManager,
			disableMcp: true,
		});
		return {
			...created,
			services: {
				cwd,
				projectCwd: cwd,
				lexicalProjectCwd: cwd,
				agentDir,
				authStorage: harness.authStorage,
				modelRegistry: harness.session.modelRegistry,
				settingsManager: harness.settingsManager,
				resourceLoader: harness.session.resourceLoader,
				gitContextProvider: created.session.gitContextProvider,
				releaseGitContextProvider: () => {},
				diagnostics: [],
			},
			diagnostics: [],
		};
	};
	const { host, conversation } = await openTestHost(factory, { sessionManager: manager, cwd: root, agentDir: root });
	cleanups.push(async () => {
		await host.dispose();
		await harness.cleanupAsync();
		rmSync(root, { recursive: true, force: true });
	});
	const service = new HostReviewDiscussionService({
		findRuntime: (ref) => {
			const current = conversation.session.sessionRef;
			return current?.storeId === ref.storeId &&
				current.sessionId === ref.sessionId &&
				current.sessionGeneration === ref.sessionGeneration
				? conversation
				: undefined;
		},
		assertCurrent: () => {},
		createSibling: () => Promise.reject(new Error("This test opens no discussion child")),
	});
	const ctx: IntentContext = {
		target: { session: conversation.session, conversation, host } as IntentTarget,
		services: { reviewDiscussions: service.forRuntime(conversation) },
		profile: LOCAL_INTENT_PROFILE,
	};
	return { ctx, session: conversation.session, first, second };
}

async function failure(run: Promise<unknown>): Promise<unknown> {
	return run.then(
		() => {
			throw new Error("Expected the intent to fail");
		},
		(error: unknown) => error,
	);
}

describe("regression #818: review discussion intents keep their rejection reasons", () => {
	it.each([
		["review_start_discussions", { runId: DISCUSSION.runId, findingIds: [DISCUSSION.findingId], requestId: "again" }],
		["review_reset_discussion", { discussionId: DISCUSSION.discussionId, expectedSessionId: "", requestId: "next" }],
	] as const)(
		"rejects %s stale, with the switch's ordinal, once the branch switched after admission",
		async (name, input) => {
			const { ctx, session, second } = await fixture();
			const prepared = intentRegistry.prepareFrame(
				ctx,
				name,
				name === "review_reset_discussion" ? { ...input, expectedSessionId: second.sessionId } : input,
				{ expectedOrdinal: session.sessionManager.getOrdinal() },
			);
			await session.navigateTree("answer-one");
			const switched = session.conversationGenerationRevision;

			const error = await failure(prepared.run());

			expect(error).toBeInstanceOf(IntentRejectedError);
			expect(rejectionReason(error)).toEqual({
				code: "stale",
				message: "The branch switched after the client's position",
				ordinal: switched,
			});
		},
	);

	it("rejects a reset conflict when its request id already reset another predecessor", async () => {
		const { ctx, first, second } = await fixture();
		const reset = { discussionId: DISCUSSION.discussionId, requestId: "reset" };

		// The request's own predecessor replays the reset it made.
		const replayed = await intentRegistry.invoke(ctx, "review_reset_discussion", {
			...reset,
			expectedSessionId: first.sessionId,
		});
		expect(replayed.result).toMatchObject({
			requestId: "reset",
			status: "reset",
			discussion: { sessionId: second.sessionId },
		});

		const error = await failure(
			intentRegistry.invoke(ctx, "review_reset_discussion", { ...reset, expectedSessionId: second.sessionId }),
		);

		expect(error).toBeInstanceOf(IntentRejectedError);
		expect(rejectionReason(error)).toEqual({ code: "conflict", message: "Review reset request identity conflict" });
	});

	it("reports a host fault as it is, and an unavailable discussion source as the stable review error", async () => {
		const { ctx, second } = await fixture();
		const reset = { discussionId: DISCUSSION.discussionId, expectedSessionId: second.sessionId, requestId: "next" };
		vi.spyOn(SQLiteSessionStoreClient.prototype, "findReviewDiscussion").mockRejectedValueOnce(
			new Error("disk I/O error"),
		);

		const fault = await failure(intentRegistry.invoke(ctx, "review_reset_discussion", reset));
		expect(rejectionReason(fault)).toEqual({ code: "failed", message: "disk I/O error" });

		const unknown = await failure(
			intentRegistry.invoke(ctx, "review_reset_discussion", { ...reset, discussionId: "unknown" }),
		);
		expect(unknown).toMatchObject({
			code: "review_source_unavailable",
			message: "Review source identity, placement, or runtime admission changed",
		});
	});
});
