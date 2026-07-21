import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model, ThinkingLevelMap } from "@hansjm10/volt-ai";
import { describe, expect, test, vi } from "vitest";
import {
	CONTEXT_COMPACT_ACTION_ID,
	CONTEXT_COMPACT_SLASH_ALIAS,
	HostActionRegistry,
	REVIEW_BRANCH_ACTION_ID,
	REVIEW_UNCOMMITTED_ACTION_ID,
	RUN_CANCEL_ACTION_ID,
	registerBuiltinHostActions,
	SESSION_NEW_ACTION_ID,
	SESSION_NEW_SLASH_ALIAS,
	SESSION_RENAME_ACTION_ID,
	SESSION_RENAME_SLASH_ALIAS,
	THINKING_FAST_MODE_ACTION_ID,
} from "../src/core/host-actions.ts";

describe("HostActionRegistry", () => {
	test("registers descriptors, availability checks, slash aliases, and handlers", async () => {
		const handler = vi.fn(async () => ({
			action: "test.disabled",
			status: "completed" as const,
		}));
		const registry = new HostActionRegistry().register({
			id: "test.disabled",
			label: "Disabled action",
			description: "Cannot run right now",
			category: "session",
			presentation: { kind: "palette", group: "Tests" },
			args: [{ name: "note", label: "Note", type: "string", required: false }],
			remoteSafe: true,
			slashAliases: [{ name: "disabled", example: "/disabled" }],
			availability: () => ({ enabled: false, disabledReason: "Action is disabled for this session" }),
			handler,
		});

		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		expect(registry.getDescriptors(context)).toEqual([
			expect.objectContaining({
				id: "test.disabled",
				label: "Disabled action",
				source: "builtin",
				sourceLabel: "Built in",
				enabled: false,
				disabledReason: "Action is disabled for this session",
				args: [expect.objectContaining({ name: "note", type: "string" })],
				slash: { name: "disabled", example: "/disabled" },
			}),
		]);
		expect(registry.resolveSlashAlias("/disabled")?.id).toBe("test.disabled");
		expect(registry.getSlashCommand("disabled")).toEqual({
			name: "disabled",
			description: "Cannot run right now",
		});
		await expect(registry.invokeBySlashAlias("disabled", context)).rejects.toThrow(
			"Action is disabled for this session",
		);
		expect(handler).not.toHaveBeenCalled();
	});

	test("registers the built-in new session action", async () => {
		const afterSessionSwitch = vi.fn(async () => {});
		const newSession = vi.fn(async () => ({ cancelled: false, seeded: false }));
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession,
			afterSessionSwitch,
			renameSession: vi.fn(() => {}),
		};

		expect(registry.getSlashCommand(SESSION_NEW_SLASH_ALIAS)).toEqual({
			name: SESSION_NEW_SLASH_ALIAS,
			description: "Start a new session",
		});

		const [descriptor] = registry.getDescriptors(context);
		expect(descriptor).toEqual(
			expect.objectContaining({
				id: SESSION_NEW_ACTION_ID,
				label: "New session",
				source: "builtin",
				category: "session",
				remoteSafe: true,
				slash: { name: SESSION_NEW_SLASH_ALIAS, example: "/clear" },
			}),
		);
		await expect(registry.invokeBySlashAlias(SESSION_NEW_SLASH_ALIAS, context)).resolves.toEqual({
			action: SESSION_NEW_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
		});
		expect(newSession).toHaveBeenCalledWith(undefined);
		expect(afterSessionSwitch).toHaveBeenCalledOnce();
	});

	test("validates descriptor argument schema subset before invoking handlers", async () => {
		const handler = vi.fn(async () => ({
			action: "test.schema",
			status: "completed" as const,
		}));
		const registry = new HostActionRegistry().register({
			id: "test.schema",
			label: "Schema action",
			category: "advanced",
			presentation: { kind: "palette", group: "Tests" },
			args: [
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
			],
			remoteSafe: true,
			handler,
		});
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		await expect(
			registry.invoke("test.schema", context, {
				message: "Ship it",
				enabled: true,
				target: "prod",
				retries: 2,
			}),
		).resolves.toEqual({ action: "test.schema", status: "completed" });
		expect(handler).toHaveBeenCalledWith(
			context,
			{ message: "Ship it", enabled: true, target: "prod", retries: 2 },
			{},
		);
		await expect(
			registry.invoke("test.schema", context, { message: "Ship it", enabled: true, target: "dev" }),
		).rejects.toThrow('UI action argument "target" must be one of: prod, staging');
		await expect(
			registry.invoke("test.schema", context, {
				message: "Ship it",
				enabled: true,
				target: "prod",
				retries: 1.5,
			}),
		).rejects.toThrow('UI action argument "retries" must be an integer');
		await expect(registry.invoke("test.schema", context, { enabled: true, target: "prod" })).rejects.toThrow(
			"Missing required UI action argument: message",
		);
	});

	test("registers cancel, compact, and rename built-ins", async () => {
		const abortRun = vi.fn(async () => {});
		const compactContext = vi.fn(async () => createCompactionResult());
		const renameSession = vi.fn(() => {});
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: true, isCompacting: false },
			abortRun,
			compactContext,
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession,
		};

		const descriptors = registry.getDescriptors(context);
		expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
			SESSION_NEW_ACTION_ID,
			RUN_CANCEL_ACTION_ID,
			CONTEXT_COMPACT_ACTION_ID,
			SESSION_RENAME_ACTION_ID,
			THINKING_FAST_MODE_ACTION_ID,
			REVIEW_UNCOMMITTED_ACTION_ID,
			REVIEW_BRANCH_ACTION_ID,
		]);
		expect(descriptors.find((descriptor) => descriptor.id === RUN_CANCEL_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Cancel run",
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "immediate",
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === CONTEXT_COMPACT_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Compact context",
				remoteSafe: false,
				slash: { name: CONTEXT_COMPACT_SLASH_ALIAS, example: "/compact" },
			}),
		);
		expect(descriptors.find((descriptor) => descriptor.id === SESSION_RENAME_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Rename session",
				remoteSafe: false,
				slash: { name: SESSION_RENAME_SLASH_ALIAS, example: "/name <name>" },
			}),
		);

		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, context, {})).resolves.toEqual({
			action: RUN_CANCEL_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Run cancelled",
		});
		await expect(
			registry.invokeBySlashAlias(CONTEXT_COMPACT_SLASH_ALIAS, context, {
				customInstructions: "preserve todo list",
			}),
		).resolves.toEqual({
			action: CONTEXT_COMPACT_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Context compacted",
		});
		await expect(
			registry.invokeBySlashAlias(SESSION_RENAME_SLASH_ALIAS, context, { name: "  D.2 work  " }),
		).resolves.toEqual({
			action: SESSION_RENAME_ACTION_ID,
			status: "completed",
			stateChanged: true,
			message: "Session name set: D.2 work",
		});
		expect(abortRun).toHaveBeenCalledOnce();
		expect(compactContext).toHaveBeenCalledWith("preserve todo list");
		expect(renameSession).toHaveBeenCalledWith("D.2 work");
	});

	test("registers Fast mode as a remote-safe session-local thinking toggle", async () => {
		let thinkingLevel: ThinkingLevel = "high";
		let fastModeRestoreThinkingLevel: ThinkingLevel | undefined;
		const setThinkingLevel = vi.fn(
			(level: ThinkingLevel, _options?: { persistDefault?: boolean; preserveFastMode?: boolean }) => {
				thinkingLevel = level;
			},
		);
		const setFastModeRestoreThinkingLevel = vi.fn((level: ThinkingLevel | undefined) => {
			fastModeRestoreThinkingLevel = level;
		});
		const session = {
			isStreaming: false,
			isCompacting: false,
			model: createModel({ reasoning: true }),
			get thinkingLevel() {
				return thinkingLevel;
			},
			get fastModeRestoreThinkingLevel() {
				return fastModeRestoreThinkingLevel;
			},
		};
		const context = {
			session,
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			setThinkingLevel,
			setFastModeRestoreThinkingLevel,
		};
		const registry = registerBuiltinHostActions(new HostActionRegistry());

		expect(registry.getDescriptor(THINKING_FAST_MODE_ACTION_ID, context)).toEqual(
			expect.objectContaining({
				id: THINKING_FAST_MODE_ACTION_ID,
				label: "Fast mode",
				category: "model",
				presentation: { kind: "toggle", group: "Model", priority: 100 },
				enabled: true,
				remoteSafe: true,
				streamingBehavior: "disabled",
				args: [expect.objectContaining({ name: "enabled", type: "boolean", required: true })],
				state: { type: "boolean", value: false, label: "Normal reasoning" },
			}),
		);

		await expect(
			registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: true }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: true, label: "Fast: thinking off" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode enabled: thinking off",
		});
		expect(setThinkingLevel).toHaveBeenCalledWith("off", { persistDefault: false, preserveFastMode: true });
		expect(setFastModeRestoreThinkingLevel).toHaveBeenCalledWith("high");

		await expect(
			registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: false }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: { type: "boolean", value: false, label: "Normal reasoning" },
			stateChanged: true,
			actionsChanged: true,
			message: "Fast mode disabled: restored high thinking",
		});
		expect(setThinkingLevel).toHaveBeenLastCalledWith("high", { persistDefault: false, preserveFastMode: true });
		expect(setFastModeRestoreThinkingLevel).toHaveBeenLastCalledWith(undefined);
	});

	test("disables Fast mode when no lower supported thinking level exists", async () => {
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: {
				isStreaming: false,
				isCompacting: false,
				model: createModel({ reasoning: true, thinkingLevelMap: { off: null, minimal: null } }),
				thinkingLevel: "low" as ThinkingLevel,
			},
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			setThinkingLevel: vi.fn(() => {}),
			setFastModeRestoreThinkingLevel: vi.fn(() => {}),
		};

		expect(registry.getDescriptor(THINKING_FAST_MODE_ACTION_ID, context)).toEqual(
			expect.objectContaining({
				enabled: false,
				disabledReason: "Current model is already at its fastest supported thinking level.",
				state: { type: "boolean", value: false, label: "Normal reasoning" },
			}),
		);
		await expect(registry.invoke(THINKING_FAST_MODE_ACTION_ID, context, { enabled: true })).rejects.toThrow(
			"Current model is already at its fastest supported thinking level.",
		);
	});

	test("registers review actions as remote-safe cards with shared handlers", async () => {
		const runReviewAction = vi.fn(async () => ({
			status: "completed" as const,
			resolution: {
				description: "uncommitted changes",
				diffCommand: "git diff HEAD",
				diff: "diff --git a/file.txt b/file.txt",
				truncated: false,
			},
			findingsCount: 2,
			sessionSwitchCancelled: false,
		}));
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const context = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
			runReviewAction,
		};

		const descriptors = registry.getDescriptors(context);
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_UNCOMMITTED_ACTION_ID)).toEqual(
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
		expect(descriptors.find((descriptor) => descriptor.id === REVIEW_BRANCH_ACTION_ID)).toEqual(
			expect.objectContaining({
				label: "Review branch",
				category: "review",
				presentation: expect.objectContaining({ kind: "card", group: "Review", priority: 90 }),
				requiresConfirmation: true,
				remoteSafe: true,
				slash: { name: "review", example: "/review branch [base]" },
				args: [
					expect.objectContaining({ name: "base", type: "string", required: false, completion: "gitBranches" }),
				],
			}),
		);

		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, context, {})).resolves.toEqual({
			action: REVIEW_UNCOMMITTED_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});
		await expect(
			registry.invoke(REVIEW_BRANCH_ACTION_ID, context, { base: "  main  " }, { requireRemoteSafe: true }),
		).resolves.toEqual({
			action: REVIEW_BRANCH_ACTION_ID,
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Review complete: 2 findings; fresh session created with findings",
		});

		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "uncommitted" },
			{ remote: false, requireConfirmation: false },
		);
		expect(runReviewAction).toHaveBeenCalledWith(
			{ kind: "branch", base: "main" },
			{ remote: true, requireConfirmation: true },
		);
	});

	test("rechecks built-in availability and validates arguments at invocation time", async () => {
		const registry = registerBuiltinHostActions(new HostActionRegistry());
		const idleContext = {
			session: { isStreaming: false, isCompacting: false },
			abortRun: vi.fn(async () => {}),
			compactContext: vi.fn(async () => createCompactionResult()),
			newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
			renameSession: vi.fn(() => {}),
		};

		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, idleContext, {})).rejects.toThrow("No active run to cancel");

		const preflightContext = {
			...idleContext,
			session: { isBusy: true, isStreaming: false, isCompacting: false },
		};
		await expect(registry.invoke(RUN_CANCEL_ACTION_ID, preflightContext, {})).resolves.toEqual(
			expect.objectContaining({ status: "completed" }),
		);
		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, preflightContext, {})).rejects.toThrow(
			"Review is not available while an agent operation is running",
		);
		await expect(registry.invoke(THINKING_FAST_MODE_ACTION_ID, preflightContext, { enabled: true })).rejects.toThrow(
			"Fast mode is not available while an agent operation is running",
		);

		await expect(
			registry.invokeBySlashAlias(SESSION_RENAME_SLASH_ALIAS, idleContext, { name: "   " }),
		).rejects.toThrow("Session name cannot be empty");
		await expect(
			registry.invokeBySlashAlias(CONTEXT_COMPACT_SLASH_ALIAS, idleContext, { unexpected: true }),
		).rejects.toThrow("Unsupported UI action argument: unexpected");
		await expect(registry.invoke(REVIEW_UNCOMMITTED_ACTION_ID, idleContext, { unexpected: true })).rejects.toThrow(
			"Unsupported UI action argument: unexpected",
		);
		await expect(
			registry.invoke(
				THINKING_FAST_MODE_ACTION_ID,
				{
					...idleContext,
					session: {
						isStreaming: false,
						isCompacting: false,
						model: createModel({ reasoning: true }),
						thinkingLevel: "high",
					},
					setThinkingLevel: vi.fn(() => {}),
					setFastModeRestoreThinkingLevel: vi.fn(() => {}),
				},
				{ enabled: "yes" },
			),
		).rejects.toThrow('UI action argument "enabled" must be a boolean');
		await expect(
			registry.invoke(
				REVIEW_BRANCH_ACTION_ID,
				{
					...idleContext,
					session: { isStreaming: true, isCompacting: false },
				},
				{},
			),
		).rejects.toThrow("Review is not available while the agent is streaming");
	});
});

function createCompactionResult() {
	return {
		summary: "summary",
		firstKeptEntryId: "entry-1",
		tokensBefore: 100,
	};
}

function createModel(options: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap } = {}): Model<Api> {
	return {
		id: "faux-fast",
		name: "Faux Fast",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test",
		reasoning: options.reasoning ?? false,
		thinkingLevelMap: options.thinkingLevelMap,
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
