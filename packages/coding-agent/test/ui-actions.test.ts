import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type * as SessionIntents from "../src/core/host/session-intents.ts";
import {
	type IntentContext,
	type IntentServices,
	intentRegistry,
	LOCAL_INTENT_PROFILE,
} from "../src/core/protocol/intents/index.ts";
import { createIrohRemoteRpcGrant } from "../src/core/remote/iroh/access-grant.ts";
import type { ReviewWorkflowResult } from "../src/core/review.ts";
import type { UiActionDescriptor } from "../src/core/rpc/types.ts";
import { validateUiActionArgs } from "../src/core/rpc/ui-action-args.ts";
import {
	getUiActionDescriptors,
	isRemoteSafeBuiltinUiAction,
	prepareUiActionInvocation,
	type UiActionDiscoverySession,
} from "../src/core/rpc/ui-actions.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const openNewSession = vi.hoisted(() => vi.fn());
vi.mock("../src/core/host/session-intents.ts", async (importOriginal) => ({
	...(await importOriginal<typeof SessionIntents>()),
	openNewSession,
}));

const AGENT_MODE_ACTION_ID = "agent.mode";
const CONTEXT_AUTO_COMPACTION_ACTION_ID = "context.auto_compaction";
const CONTEXT_COMPACT_ACTION_ID = "context.compact";
const CONTEXT_COMPACTION_THRESHOLD_ACTION_ID = "context.compaction_threshold";
const PLAN_CHANGE_ACTION_ID = "plan.change";
const PLAN_DISCARD_ACTION_ID = "plan.discard";
const PLAN_EXECUTE_ACTION_ID = "plan.execute";
const REVIEW_BRANCH_ACTION_ID = "review.branch";
const REVIEW_COMMIT_ACTION_ID = "review.commit";
const REVIEW_EXPORT_FEEDBACK_ACTION_ID = "review.export_feedback";
const REVIEW_FEEDBACK_ACTION_ID = "review.feedback";
const REVIEW_FIX_ACTION_ID = "review.fix";
const REVIEW_PR_ACTION_ID = "review.pr";
const REVIEW_PUBLISH_ACTION_ID = "review.publish";
const REVIEW_RERUN_ACTION_ID = "review.rerun";
const REVIEW_UNCOMMITTED_ACTION_ID = "review.uncommitted";
const RUN_CANCEL_ACTION_ID = "run.cancel";
const SESSION_NEW_ACTION_ID = "session.new";
const SESSION_RENAME_ACTION_ID = "session.rename";
const THINKING_FAST_MODE_ACTION_ID = "thinking.fast_mode";

const tempDirectories: string[] = [];

afterEach(() => {
	openNewSession.mockReset();
	for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type FakeSession = Record<string, unknown> & { isStreaming: boolean; isCompacting: boolean };

/** A session that answers what availability, descriptors, and the invoked intents read. */
function fakeSession(state: Partial<FakeSession> = {}): FakeSession {
	return {
		sessionId: "session",
		isStreaming: false,
		isCompacting: false,
		extensionRunner: { getRegisteredCommands: () => [] },
		promptTemplates: [],
		resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
		sessionManager: { getCwd: () => "/repo", getOrdinal: () => 0 },
		compact: vi.fn(async () => createCompactionResult()),
		setSessionName: vi.fn(async () => {}),
		...state,
	};
}

function context(
	session: FakeSession,
	services: IntentServices = {},
	profile: IntentContext["profile"] = LOCAL_INTENT_PROFILE,
): IntentContext {
	return {
		target: { session, conversation: {}, host: {}, client: {} } as unknown as IntentContext["target"],
		services: { abortRun: vi.fn(async () => {}), ...services },
		profile,
	};
}

const remoteProfile = (): IntentContext["profile"] => ({
	name: "remote",
	grant: createIrohRemoteRpcGrant(["conversation.control.v1"]),
});

async function invoke(ctx: IntentContext, action: string, args?: unknown) {
	return prepareUiActionInvocation(ctx, { action, ...(args === undefined ? {} : { args }) }).run();
}

function descriptors(session: FakeSession): UiActionDescriptor[] {
	return getUiActionDescriptors(session as unknown as UiActionDiscoverySession, "all");
}

function descriptor(session: FakeSession, action: string): UiActionDescriptor | undefined {
	return descriptors(session).find((candidate) => candidate.id === action);
}

describe("UI action arguments", () => {
	test("validates the descriptor argument schema subset", () => {
		const args = [
			{ name: "message", label: "Message", type: "string", required: true, multiline: true },
			{ name: "enabled", label: "Enabled", type: "boolean", required: true },
			{
				name: "target",
				label: "Target",
				type: "enum",
				required: true,
				options: [
					{ value: "prod", label: "Production" },
					{ value: "staging", label: "Staging" },
				],
			},
			{ name: "retries", label: "Retries", type: "integer", required: false },
		];

		expect(validateUiActionArgs({ message: "Ship it", enabled: true, target: "prod", retries: 2 }, args)).toEqual({
			message: "Ship it",
			enabled: true,
			target: "prod",
			retries: 2,
		});
		expect(() => validateUiActionArgs({ message: "Ship it", enabled: true, target: "dev" }, args)).toThrow(
			'UI action argument "target" must be one of: prod, staging',
		);
		expect(() =>
			validateUiActionArgs({ message: "Ship it", enabled: true, target: "prod", retries: 1.5 }, args),
		).toThrow('UI action argument "retries" must be an integer');
		expect(() => validateUiActionArgs({ enabled: true, target: "prod" }, args)).toThrow(
			"Missing required UI action argument: message",
		);
	});
});

describe("built-in UI actions", () => {
	test("lists the built-in new session action and invokes it through its intent", async () => {
		openNewSession.mockResolvedValueOnce({ cancelled: false, sessionId: "new-session", seeded: false });
		const session = fakeSession();

		expect(intentRegistry.slashCommands()).toContainEqual({ name: "clear", description: "Start a new session" });
		expect(descriptor(session, SESSION_NEW_ACTION_ID)).toEqual(
			expect.objectContaining({
				id: SESSION_NEW_ACTION_ID,
				label: "New session",
				source: "builtin",
				category: "session",
				remoteSafe: true,
				slash: { name: "clear", example: "/clear" },
			}),
		);
		const ctx = context(session);
		await expect(invoke(ctx, SESSION_NEW_ACTION_ID)).resolves.toEqual({
			action: SESSION_NEW_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
		});
		// The client that asked follows the move through its host; the action only asks for the new session.
		expect(openNewSession).toHaveBeenCalledOnce();
		expect(openNewSession).toHaveBeenCalledWith(ctx.target?.host, ctx.target?.client, {});
	});

	test("lists cancel, compact, and rename built-ins and invokes them", async () => {
		const session = fakeSession({ isStreaming: true });
		const abortRun = vi.fn(async () => {});
		const ctx = context(session, { abortRun });

		const listed = descriptors(session);
		expect(listed.map((action) => action.id)).toEqual([
			AGENT_MODE_ACTION_ID,
			PLAN_EXECUTE_ACTION_ID,
			PLAN_CHANGE_ACTION_ID,
			PLAN_DISCARD_ACTION_ID,
			SESSION_NEW_ACTION_ID,
			RUN_CANCEL_ACTION_ID,
			CONTEXT_AUTO_COMPACTION_ACTION_ID,
			CONTEXT_COMPACTION_THRESHOLD_ACTION_ID,
			CONTEXT_COMPACT_ACTION_ID,
			SESSION_RENAME_ACTION_ID,
			THINKING_FAST_MODE_ACTION_ID,
			REVIEW_UNCOMMITTED_ACTION_ID,
			REVIEW_BRANCH_ACTION_ID,
			REVIEW_PR_ACTION_ID,
			REVIEW_COMMIT_ACTION_ID,
			REVIEW_FIX_ACTION_ID,
			REVIEW_FEEDBACK_ACTION_ID,
			REVIEW_RERUN_ACTION_ID,
			REVIEW_PUBLISH_ACTION_ID,
			REVIEW_EXPORT_FEEDBACK_ACTION_ID,
		]);
		expect(listed.find((action) => action.id === RUN_CANCEL_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Cancel run",
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "immediate",
			}),
		);
		expect(listed.find((action) => action.id === CONTEXT_COMPACT_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Compact context",
				remoteSafe: false,
				slash: { name: "compact", example: "/compact" },
			}),
		);
		expect(listed.find((action) => action.id === SESSION_RENAME_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Rename session",
				remoteSafe: false,
				slash: { name: "name", example: "/name <name>" },
			}),
		);

		await expect(invoke(ctx, RUN_CANCEL_ACTION_ID, {})).resolves.toEqual({
			action: RUN_CANCEL_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Run cancelled",
		});
		await expect(
			invoke(ctx, CONTEXT_COMPACT_ACTION_ID, { customInstructions: "preserve todo list" }),
		).resolves.toEqual({
			action: CONTEXT_COMPACT_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Context compacted",
		});
		await expect(invoke(ctx, SESSION_RENAME_ACTION_ID, { name: "  D.2 work  " })).resolves.toEqual({
			action: SESSION_RENAME_ACTION_ID,
			status: "completed",
			stateChanged: true,
			message: "Session name set: D.2 work",
		});
		expect(abortRun).toHaveBeenCalledOnce();
		expect(session.compact).toHaveBeenCalledWith("preserve todo list", undefined);
		expect(session.setSessionName).toHaveBeenCalledWith("D.2 work");
		expect(intentRegistry.resolveSlash("compact")).toBe("compact");
		expect(intentRegistry.resolveSlash("name")).toBe("set_session_name");
	});

	test("lists Fast mode as a remote-safe session-local priority toggle", async () => {
		let fastModeEnabled = false;
		const setFastModeEnabled = vi.fn(async (enabled: boolean) => {
			fastModeEnabled = enabled;
		});
		const session = fakeSession({
			model: createModel(),
			thinkingLevel: "high",
			setFastModeEnabled,
		});
		Object.defineProperty(session, "fastModeEnabled", { get: () => fastModeEnabled, enumerable: true });
		const ctx = context(session, {}, remoteProfile());

		expect(descriptor(session, THINKING_FAST_MODE_ACTION_ID)).toEqual(
			expect.objectContaining({
				id: THINKING_FAST_MODE_ACTION_ID,
				label: "Fast mode",
				description: "Request premium low-latency inference capacity for the current session.",
				category: "model",
				presentation: { kind: "toggle", group: "Model", priority: 100 },
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "disabled",
				slash: { name: "fast", example: "/fast [on|off]" },
				args: [expect.objectContaining({ name: "enabled", type: "boolean", required: true })],
				state: { type: "boolean", value: false, label: "Fast mode disabled" },
			}),
		);

		await expect(invoke(ctx, THINKING_FAST_MODE_ACTION_ID, { enabled: true })).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: true, label: "Fast mode enabled" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode enabled. Priority processing may cost more.",
		});
		expect(session.thinkingLevel).toBe("high");

		await expect(invoke(ctx, THINKING_FAST_MODE_ACTION_ID, { enabled: false })).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: false, label: "Fast mode disabled" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode disabled",
		});
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
		expect(session.thinkingLevel).toBe("high");
	});

	test("lists review actions as remote-safe cards that start reviews through one service", async () => {
		const runReview = vi.fn(async (): Promise<ReviewWorkflowResult> => createCompletedReviewResult());
		const session = fakeSession();
		const local = context(session, { runReview });
		const remote = context(session, { runReview }, remoteProfile());

		const listed = descriptors(session);
		expect(listed.find((action) => action.id === REVIEW_UNCOMMITTED_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review changes",
				category: "review",
				presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review uncommitted" },
				streamingBehavior: "disabled",
			}),
		);
		expect(listed.find((action) => action.id === REVIEW_BRANCH_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review branch",
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 90 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review branch [base]" },
				args: expect.arrayContaining([
					expect.objectContaining({ name: "base", type: "string", required: false, completion: "gitBranches" }),
				]),
			}),
		);
		expect(listed.find((action) => action.id === REVIEW_PR_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review pull request",
				description: expect.stringMatching(/GitHub CLI code-host provider.*linked issues.*inline review threads/),
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 80 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review pr [number]" },
				args: expect.arrayContaining([
					expect.objectContaining({ name: "number", type: "string", required: false }),
				]),
			}),
		);
		expect(listed.find((action) => action.id === REVIEW_COMMIT_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review commit",
				description: expect.stringContaining("workspace history"),
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 70 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review commit <ref>" },
				args: expect.arrayContaining([expect.objectContaining({ name: "ref", type: "string", required: true })]),
			}),
		);

		await expect(invoke(local, REVIEW_UNCOMMITTED_ACTION_ID, {})).resolves.toEqual({
			action: REVIEW_UNCOMMITTED_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});
		await expect(invoke(remote, REVIEW_BRANCH_ACTION_ID, { base: "  main  " })).resolves.toEqual({
			action: REVIEW_BRANCH_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});
		await expect(invoke(remote, REVIEW_PR_ACTION_ID, { number: " 42 " })).resolves.toMatchObject({
			action: REVIEW_PR_ACTION_ID,
			status: "completed",
		});
		await expect(invoke(remote, REVIEW_COMMIT_ACTION_ID, { ref: "HEAD~1" })).resolves.toMatchObject({
			action: REVIEW_COMMIT_ACTION_ID,
			status: "completed",
		});
		runReview.mockResolvedValueOnce(createCompletedReviewResult(0, "incomplete"));
		await expect(invoke(local, REVIEW_UNCOMMITTED_ACTION_ID, {})).resolves.toMatchObject({
			message: "Review incomplete; fresh session created with findings",
		});

		expect(runReview).toHaveBeenCalledWith(
			{ kind: "uncommitted" },
			{ remote: false, requireConfirmation: false, controls: {} },
		);
		expect(runReview).toHaveBeenCalledWith(
			{ kind: "branch", base: "main" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
		expect(runReview).toHaveBeenCalledWith(
			{ kind: "pr", number: "42" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
		expect(runReview).toHaveBeenCalledWith(
			{ kind: "commit", sha: "HEAD~1" },
			{ remote: true, requireConfirmation: true, controls: {} },
		);
	});

	test("keeps review feedback export local-only", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-ui-actions-"));
		tempDirectories.push(directory);
		const session = fakeSession({ sessionManager: SessionManager.inMemory(directory) });

		expect(descriptor(session, REVIEW_EXPORT_FEEDBACK_ACTION_ID)).toEqual(
			expect.objectContaining({ remoteSafe: false }),
		);
		expect(isRemoteSafeBuiltinUiAction(REVIEW_EXPORT_FEEDBACK_ACTION_ID)).toBe(false);
		await expect(
			invoke(context(session, {}, remoteProfile()), REVIEW_EXPORT_FEEDBACK_ACTION_ID, {
				path: "../../package.json",
			}),
		).rejects.toThrow(`UI action not available over remote host: ${REVIEW_EXPORT_FEEDBACK_ACTION_ID}`);

		const outputPath = join(directory, "review-feedback.json");
		await expect(
			invoke(context(session), REVIEW_EXPORT_FEEDBACK_ACTION_ID, { path: "review-feedback.json" }),
		).resolves.toEqual({
			action: REVIEW_EXPORT_FEEDBACK_ACTION_ID,
			status: "completed",
			message: `Review feedback exported to ${outputPath}`,
		});
		expect(JSON.parse(readFileSync(outputPath, "utf8"))).toMatchObject({ schemaVersion: 1, outcomes: [] });
	});

	test("rechecks built-in availability and validates arguments at invocation time", async () => {
		const idle = context(fakeSession());

		await expect(invoke(idle, RUN_CANCEL_ACTION_ID, {})).rejects.toThrow("No active run to cancel");

		const preflight = context(fakeSession({ isBusy: true }));
		await expect(invoke(preflight, RUN_CANCEL_ACTION_ID, {})).resolves.toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		await expect(invoke(preflight, REVIEW_UNCOMMITTED_ACTION_ID, {})).rejects.toThrow(
			"Review is not available while an agent operation is running",
		);
		await expect(invoke(preflight, THINKING_FAST_MODE_ACTION_ID, { enabled: true })).rejects.toThrow(
			"Fast mode is not available while an agent operation is running",
		);

		await expect(invoke(idle, SESSION_RENAME_ACTION_ID, { name: "   " })).rejects.toThrow(
			"Session name cannot be empty",
		);
		await expect(invoke(idle, CONTEXT_COMPACT_ACTION_ID, { unexpected: true })).rejects.toThrow(
			"Unsupported UI action argument: unexpected",
		);
		await expect(invoke(idle, REVIEW_UNCOMMITTED_ACTION_ID, { unexpected: true })).rejects.toThrow(
			"Unsupported UI action argument: unexpected",
		);
		await expect(
			invoke(
				context(
					fakeSession({ model: createModel(), thinkingLevel: "high", setFastModeEnabled: vi.fn(async () => {}) }),
				),
				THINKING_FAST_MODE_ACTION_ID,
				{ enabled: "yes" },
			),
		).rejects.toThrow('UI action argument "enabled" must be a boolean');
		await expect(invoke(idle, REVIEW_PR_ACTION_ID, { number: null })).rejects.toThrow(
			'UI action argument "number" must be a string',
		);
		await expect(invoke(context(fakeSession({ isStreaming: true })), REVIEW_BRANCH_ACTION_ID, {})).rejects.toThrow(
			"Review is not available while the agent is streaming",
		);
	});
});

function createCompactionResult() {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

function createCompletedReviewResult(
	findingsCount = 2,
	completionStatus: "complete" | "incomplete" = "complete",
): Extract<ReviewWorkflowResult, { status: "completed" }> {
	return {
		status: "completed",
		resolution: {
			identity: { kind: "uncommitted", baseTree: "a".repeat(40), headTree: "b".repeat(40) },
			changedFiles: [],
			root: "/tmp/review",
			description: "uncommitted changes",
			workflowDescription: "uncommitted changes",
			diffCommand: "git diff HEAD",
			readFile: async () => undefined,
			listFiles: async () => [],
			search: async () => ({
				matches: [],
				filesScanned: 0,
				skippedPaths: [],
				nextFileIndex: 0,
				nextLineIndex: 0,
				complete: true,
			}),
			materializeHead: async () => "/tmp/review",
			dispose: async () => {},
		},
		findingsCount,
		completionStatus,
		sessionSwitchCancelled: false,
	};
}

function createModel(): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}
