/**
 * The legacy native UI action wire (`get_ui_actions`, `invoke_ui_action`,
 * `get_ui_action_completions`) over the intent registry. Built-in actions keep
 * their action ids and argument descriptors here; their label, availability,
 * remote safety, state, and behavior come from the intents they invoke.
 * Extension commands, prompt templates, and skills are the dynamic intents.
 *
 * Deleted with the legacy RPC wire once clients speak intent frames.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { BuiltinIntentName, IntentInput } from "@hansjm10/volt-protocol";
import type { ResolvedCommand } from "../extensions/types.ts";
import type { PromptTemplate } from "../prompt-templates.ts";
import { MAX_DYNAMIC_INTENTS } from "../protocol/intents/dynamic.ts";
import {
	type DynamicIntent,
	type DynamicIntentOutcome,
	type IntentAvailability,
	type IntentContext,
	type IntentDefinition,
	type IntentOutcome,
	type IntentState,
	type IntentView,
	intentRegistry,
	intentStateOf,
	LOCAL_INTENT_PROFILE,
	listDynamicIntents,
} from "../protocol/intents/index.ts";
import {
	agentModeState,
	autoCompactionState,
	compactionThresholdState,
	describeFastModeChange,
	fastModeState,
	isIntentStateBusy,
} from "../protocol/intents/state.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationResponse,
	UiActionListScope,
	UiActionOptionDescriptor,
	UiActionScalar,
} from "./types.ts";
import { validateUiActionArgs } from "./ui-action-args.ts";
import { CONTEXT_AUTO_COMPACTION_ACTION_ID, CONTEXT_COMPACTION_THRESHOLD_ACTION_ID } from "./ui-action-ids.ts";

export { CONTEXT_AUTO_COMPACTION_ACTION_ID, CONTEXT_COMPACTION_THRESHOLD_ACTION_ID } from "./ui-action-ids.ts";

export interface UiActionDiscoverySession {
	extensionRunner: {
		getRegisteredCommands(): ResolvedCommand[];
	};
	isBusy?: boolean;
	hasBackgroundJobs?: boolean;
	isCompacting?: boolean;
	isStreaming?: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fastModeEnabled?: boolean;
	settingsManager?: SettingsManager;
	promptTemplates: ReadonlyArray<PromptTemplate>;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
	sessionManager: { getCwd(): string };
}

export interface UiActionDescriptorOptions {
	remoteSafeOnly?: boolean;
	/** Advertise review actions as detached workflows. */
	detachedReviews?: boolean;
}

// ============================================================================
// Built-in actions
// ============================================================================

type Args = Record<string, UiActionScalar>;

interface BuiltinUiAction<N extends BuiltinIntentName> {
	readonly id: string;
	readonly intent: N;
	readonly args?: ReadonlyArray<UiActionArgumentDescriptor> | ((view: IntentView) => UiActionArgumentDescriptor[]);
	/** Availability the action had beyond its intent's (the typed commands never had it). */
	readonly available?: (view: IntentView) => IntentAvailability;
	toInput(args: Args): IntentInput<N>;
	respond(
		outcome: IntentOutcome<N>,
		context: { before: IntentState; after: () => IntentView; args: Args },
	): UiActionInvocationResponse;
}

type AnyBuiltinUiAction = BuiltinUiAction<BuiltinIntentName>;

function builtinUiAction<N extends BuiltinIntentName>(action: BuiltinUiAction<N>): AnyBuiltinUiAction {
	return action;
}

const REVIEW_OPTION_ARGUMENTS: ReadonlyArray<UiActionArgumentDescriptor> = [
	{
		name: "focus",
		label: "Review focus",
		type: "string",
		required: false,
		placeholder: "Security and authorization",
	},
	{
		name: "scope",
		label: "Path scope",
		type: "string",
		required: false,
		placeholder: "src/**/*.ts,test/**/*.ts",
		description: "Comma-separated repository-relative globs.",
	},
	{
		name: "effort",
		label: "Effort",
		type: "enum",
		required: false,
		options: [
			{ value: "low", label: "Low" },
			{ value: "standard", label: "Standard" },
			{ value: "high", label: "High" },
		],
	},
	{ name: "includeOptional", label: "Include optional P3 findings", type: "boolean", required: false },
	{
		name: "scopeMode",
		label: "Review mode",
		type: "enum",
		required: false,
		options: [
			{ value: "incremental", label: "Incremental" },
			{ value: "full", label: "Full" },
		],
	},
];

const PLAN_ARGUMENTS: ReadonlyArray<UiActionArgumentDescriptor> = [
	{ name: "planId", label: "Plan ID", type: "string", required: true },
	{ name: "expectedRevision", label: "Revision", type: "integer", required: true },
];

function compactionTargetArguments(view: IntentView): UiActionArgumentDescriptor[] {
	return [
		{
			name: "provider",
			label: "Provider",
			type: "string",
			required: true,
			defaultValue: view.state.model?.provider ?? "",
		},
		{
			name: "modelId",
			label: "Model ID",
			type: "string",
			required: true,
			defaultValue: view.state.model?.id ?? "",
		},
		{
			name: "expectedProfile",
			label: "Profile",
			type: "string",
			required: true,
			defaultValue: view.state.settingsManager?.getActiveProfile() ?? "",
		},
	];
}

function planArgs(args: Args): { planId: string; expectedRevision: number } {
	const planId = args.planId;
	if (typeof planId !== "string" || !planId) {
		throw new Error('UI action argument "planId" must be a non-empty string');
	}
	const expectedRevision = args.expectedRevision;
	if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error('UI action argument "expectedRevision" must be a non-negative integer');
	}
	return { planId, expectedRevision };
}

function planReady(view: IntentView): IntentAvailability {
	return view.state.planningState?.plan?.phase === "ready"
		? { enabled: true }
		: { enabled: false, reason: "No plan is ready for approval" };
}

function planPresent(view: IntentView): IntentAvailability {
	return view.state.planningState?.plan ? { enabled: true } : { enabled: false, reason: "No plan is available" };
}

function reviewControls(args: Args): IntentInput<"review_uncommitted"> {
	const { focus, scope, effort, includeOptional, scopeMode } = args;
	return {
		...(typeof focus === "string" ? { focus } : {}),
		...(typeof scope === "string" ? { scope } : {}),
		...(effort === "low" || effort === "standard" || effort === "high" ? { effort } : {}),
		...(typeof includeOptional === "boolean" ? { includeOptional } : {}),
		...(scopeMode === "incremental" || scopeMode === "full" ? { scopeMode } : {}),
	};
}

function reviewStartResponse(action: string, result: IntentOutcome<"review_uncommitted">): UiActionInvocationResponse {
	if (result.status === "accepted") {
		return {
			action,
			status: "accepted",
			workflowId: result.workflowId,
			actionsChanged: true,
			message: result.message ?? "Review started",
		};
	}
	if (result.status === "cancelled") {
		return { action, status: "cancelled", actionsChanged: true, message: "Review cancelled" };
	}
	const findingCount = result.findingsCount;
	const summary =
		result.completionStatus === "incomplete"
			? `Review incomplete${findingCount ? `: ${findingCount} verified finding${findingCount === 1 ? "" : "s"}` : ""}`
			: findingCount === undefined
				? "Review complete"
				: findingCount === 0
					? "Review complete: no issues found"
					: `Review complete: ${findingCount} finding${findingCount === 1 ? "" : "s"}`;
	return {
		action,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: result.sessionSwitchCancelled
			? `${summary}; findings added to the current session`
			: `${summary}; fresh session created with findings`,
	};
}

function optionalTrimmed(value: UiActionScalar | undefined): string | undefined {
	return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** The built-in actions, in the order clients list them. */
const BUILTIN_UI_ACTIONS: readonly AnyBuiltinUiAction[] = [
	builtinUiAction({
		id: "agent.mode",
		intent: "set_agent_mode",
		args: [
			{
				name: "mode",
				label: "Mode",
				type: "enum",
				required: true,
				options: [
					{ value: "build", label: "Build" },
					{ value: "plan", label: "Plan" },
				],
			},
		],
		toInput: (args) => ({ mode: args.mode as "build" | "plan" }),
		respond: (_planning, { before, after, args }) => {
			const changed = before.planningState?.mode !== args.mode;
			return {
				action: "agent.mode",
				status: "completed",
				state: agentModeState(after()),
				stateChanged: changed,
				actionsChanged: changed,
				message: args.mode === "plan" ? "Plan mode enabled" : "Build mode enabled",
			};
		},
	}),
	builtinUiAction({
		id: "plan.execute",
		intent: "plan_execute",
		args: [
			...PLAN_ARGUMENTS,
			{
				name: "strategy",
				label: "Execution context",
				type: "enum",
				required: true,
				options: [
					{ value: "retain_context", label: "Execute Plan" },
					{ value: "new_session", label: "Execute Plan & Clear Context" },
				],
			},
		],
		available: planReady,
		toInput: (args) => ({ ...planArgs(args), strategy: args.strategy as "retain_context" | "new_session" }),
		respond: (result, { args }) => ({
			action: "plan.execute",
			status: "completed",
			stateChanged: result.started,
			actionsChanged: result.started,
			message:
				args.strategy === "new_session"
					? result.started
						? "Plan started in a clear execution session"
						: "Plan was already started in its execution session"
					: result.started
						? "Plan execution started"
						: "Plan execution was already started",
		}),
	}),
	builtinUiAction({
		id: "plan.change",
		intent: "plan_change",
		args: PLAN_ARGUMENTS,
		available: planReady,
		toInput: planArgs,
		respond: () => ({
			action: "plan.change",
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Plan returned to draft",
		}),
	}),
	builtinUiAction({
		id: "plan.discard",
		intent: "plan_discard",
		args: PLAN_ARGUMENTS,
		available: planPresent,
		toInput: planArgs,
		respond: () => ({
			action: "plan.discard",
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Plan discarded",
		}),
	}),
	builtinUiAction({
		id: "session.new",
		intent: "new_session",
		toInput: () => ({}),
		respond: (result) =>
			result.cancelled
				? { action: "session.new", status: "cancelled" }
				: { action: "session.new", status: "completed", stateChanged: true, actionsChanged: true },
	}),
	builtinUiAction({
		id: "run.cancel",
		intent: "abort",
		available: (view) =>
			isIntentStateBusy(view.state) || view.state.isCompacting || view.state.hasBackgroundJobs
				? { enabled: true }
				: { enabled: false, reason: "No active run to cancel" },
		toInput: () => ({}),
		respond: () => ({
			action: "run.cancel",
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Run cancelled",
		}),
	}),
	builtinUiAction({
		id: CONTEXT_AUTO_COMPACTION_ACTION_ID,
		intent: "set_auto_compaction",
		args: (view) => [
			{ name: "enabled", label: "Enabled", type: "boolean", required: true },
			...compactionTargetArguments(view),
		],
		toInput: (args) => ({
			enabled: args.enabled as boolean,
			provider: args.provider as string,
			modelId: args.modelId as string,
			expectedProfile: args.expectedProfile as string,
		}),
		respond: (_result, { after }) => ({
			action: CONTEXT_AUTO_COMPACTION_ACTION_ID,
			status: "completed",
			state: autoCompactionState(after()),
			stateChanged: true,
			actionsChanged: true,
			message: "Compaction settings saved",
		}),
	}),
	builtinUiAction({
		id: CONTEXT_COMPACTION_THRESHOLD_ACTION_ID,
		intent: "set_compaction_threshold",
		args: (view) => [
			{ name: "tokens", label: "Tokens (0 uses default)", type: "integer", required: true },
			...compactionTargetArguments(view),
		],
		toInput: (args) => ({
			tokens: args.tokens as number,
			provider: args.provider as string,
			modelId: args.modelId as string,
			expectedProfile: args.expectedProfile as string,
		}),
		respond: (_result, { after }) => ({
			action: CONTEXT_COMPACTION_THRESHOLD_ACTION_ID,
			status: "completed",
			state: compactionThresholdState(after()),
			stateChanged: true,
			actionsChanged: true,
			message: "Compaction settings saved",
		}),
	}),
	builtinUiAction({
		id: "context.compact",
		intent: "compact",
		args: [
			{ name: "customInstructions", label: "Custom instructions", type: "string", required: false, multiline: true },
		],
		available: (view) =>
			view.state.isCompacting ? { enabled: false, reason: "Compaction is already running" } : { enabled: true },
		toInput: (args) =>
			typeof args.customInstructions === "string" ? { customInstructions: args.customInstructions } : {},
		respond: () => ({
			action: "context.compact",
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: "Context compacted",
		}),
	}),
	builtinUiAction({
		id: "session.rename",
		intent: "set_session_name",
		args: [{ name: "name", label: "Name", type: "string", required: true, placeholder: "Session name" }],
		toInput: (args) => ({ name: args.name as string }),
		respond: (name) => ({
			action: "session.rename",
			status: "completed",
			stateChanged: true,
			message: `Session name set: ${name}`,
		}),
	}),
	builtinUiAction({
		id: "thinking.fast_mode",
		intent: "set_fast_mode",
		args: [{ name: "enabled", label: "Enabled", type: "boolean", required: true }],
		toInput: (args) => ({ enabled: args.enabled as boolean }),
		respond: (result, { after }) => {
			const changed = result.wasEnabled !== result.enabled;
			return {
				action: "thinking.fast_mode",
				status: "completed",
				state: fastModeState(after()),
				stateChanged: changed,
				actionsChanged: changed,
				message: describeFastModeChange(result),
			};
		},
	}),
	builtinUiAction({
		id: "review.uncommitted",
		intent: "review_uncommitted",
		args: REVIEW_OPTION_ARGUMENTS,
		toInput: reviewControls,
		respond: (result) => reviewStartResponse("review.uncommitted", result),
	}),
	builtinUiAction({
		id: "review.branch",
		intent: "review_branch",
		args: [
			{
				name: "base",
				label: "Base branch",
				type: "string",
				required: false,
				placeholder: "main",
				description: "Plain names refresh their upstream; refs/heads/* and refs/remotes/* use local cached state.",
				completion: "gitBranches",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		toInput: (args) => {
			const base = optionalTrimmed(args.base);
			return { ...(base === undefined ? {} : { base }), ...reviewControls(args) };
		},
		respond: (result) => reviewStartResponse("review.branch", result),
	}),
	builtinUiAction({
		id: "review.pr",
		intent: "review_pr",
		args: [
			{
				name: "number",
				label: "Pull request number",
				type: "string",
				required: false,
				placeholder: "Current branch",
				description: "Leave empty to review the pull request for the current branch.",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		toInput: (args) => {
			const number = optionalTrimmed(args.number);
			return { ...(number === undefined ? {} : { number }), ...reviewControls(args) };
		},
		respond: (result) => reviewStartResponse("review.pr", result),
	}),
	builtinUiAction({
		id: "review.commit",
		intent: "review_commit",
		args: [
			{
				name: "ref",
				label: "Commit ref",
				type: "string",
				required: true,
				placeholder: "HEAD",
				description: "A commit SHA, tag, or revision such as HEAD~1.",
			},
			...REVIEW_OPTION_ARGUMENTS,
		],
		toInput: (args) => {
			if (typeof args.ref !== "string" || !args.ref)
				throw new Error('UI action argument "ref" must be a non-empty string');
			return { ref: args.ref, ...reviewControls(args) };
		},
		respond: (result) => reviewStartResponse("review.commit", result),
	}),
	builtinUiAction({
		id: "review.fix",
		intent: "review_open_session",
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{
				name: "findingIds",
				label: "Finding IDs",
				type: "string",
				required: false,
				description: "Comma-separated durable finding IDs; empty selects all.",
			},
		],
		toInput: (args) => {
			const findingIds =
				typeof args.findingIds === "string" && args.findingIds.trim().length > 0
					? args.findingIds
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean)
					: undefined;
			return { runId: args.runId as string, ...(findingIds === undefined ? {} : { findingIds }) };
		},
		respond: ({ opened, selectedCount }) => ({
			action: "review.fix",
			status: opened.cancelled ? "cancelled" : "completed",
			stateChanged: !opened.cancelled,
			actionsChanged: !opened.cancelled,
			message: opened.cancelled
				? "Review fix session cancelled"
				: `Opened ${selectedCount} selected review findings`,
		}),
	}),
	builtinUiAction({
		id: "review.feedback",
		intent: "review_record_finding_outcome",
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{ name: "findingId", label: "Finding ID", type: "string", required: true },
			{
				name: "status",
				label: "Outcome",
				type: "enum",
				required: true,
				options: [
					{ value: "accepted", label: "Accepted" },
					{ value: "fixed", label: "Fixed" },
					{ value: "dismissed", label: "Dismissed" },
				],
			},
			{
				name: "reason",
				label: "Dismissal reason",
				type: "enum",
				required: false,
				options: [
					{ value: "false_positive", label: "False positive" },
					{ value: "intentional", label: "Intentional" },
					{ value: "not_actionable", label: "Not actionable" },
					{ value: "other", label: "Other" },
				],
			},
			{ name: "note", label: "Note", type: "string", required: false },
		],
		toInput: (args) => ({
			runId: args.runId as string,
			findingId: args.findingId as string,
			status: args.status as "accepted" | "fixed" | "dismissed",
			...(typeof args.reason === "string"
				? { reason: args.reason as "false_positive" | "intentional" | "not_actionable" | "other" }
				: {}),
			...(typeof args.note === "string" ? { note: args.note } : {}),
		}),
		respond: (result) => ({
			action: "review.feedback",
			status: "completed",
			stateChanged: true,
			actionsChanged: true,
			message: `Finding ${result.findingId} marked ${result.status}`,
		}),
	}),
	builtinUiAction({
		id: "review.rerun",
		intent: "review_rerun",
		args: [
			{ name: "runId", label: "Review run ID", type: "string", required: true },
			{
				name: "scopeMode",
				label: "Mode",
				type: "enum",
				required: false,
				options: [
					{ value: "incremental", label: "Incremental" },
					{ value: "full", label: "Full" },
				],
			},
		],
		toInput: (args) => ({ runId: args.runId as string, mode: args.scopeMode === "full" ? "full" : "incremental" }),
		respond: (result) =>
			result.status === "accepted"
				? {
						action: "review.rerun",
						status: "accepted",
						workflowId: result.workflowId,
						actionsChanged: true,
						message: "Review rerun accepted",
					}
				: { action: "review.rerun", status: "cancelled", message: "Review rerun was not accepted" },
	}),
	builtinUiAction({
		id: "review.publish",
		intent: "review_publish",
		args: [{ name: "runId", label: "Review run ID", type: "string", required: true }],
		toInput: (args) => ({ runId: args.runId as string, confirmed: true }),
		respond: (published) => ({
			action: "review.publish",
			status: "completed",
			message: published.url ? `Review published: ${published.url}` : "Review published",
		}),
	}),
	builtinUiAction({
		id: "review.export_feedback",
		intent: "review_export_feedback",
		args: [{ name: "path", label: "Output path", type: "string", required: false }],
		toInput: (args) => {
			if (typeof args.path !== "string" || !args.path.trim()) {
				throw new Error("RPC review feedback export requires an explicit local path.");
			}
			return { path: args.path };
		},
		respond: (result) => ({
			action: "review.export_feedback",
			status: "completed",
			message: `Review feedback exported to ${"path" in result ? result.path : ""}`,
		}),
	}),
];

const BUILTIN_UI_ACTION_BY_ID = new Map(BUILTIN_UI_ACTIONS.map((action) => [action.id, action]));

/** The intent a built-in UI action id invokes. */
export function getBuiltinUiActionIntent(actionId: string): BuiltinIntentName | undefined {
	return BUILTIN_UI_ACTION_BY_ID.get(actionId)?.intent;
}

/** Every built-in UI action id, in listing order. */
export function listBuiltinUiActionIds(): string[] {
	return BUILTIN_UI_ACTIONS.map((action) => action.id);
}

/** Whether a remote host may invoke a built-in UI action: its intent is remote-safe. */
export function isRemoteSafeBuiltinUiAction(actionId: string): boolean {
	const intent = getBuiltinUiActionIntent(actionId);
	return intent !== undefined && intentRegistry.get(intent).remote === "safe";
}

function definitionOf(action: AnyBuiltinUiAction): IntentDefinition<BuiltinIntentName, unknown> {
	return intentRegistry.get(action.intent);
}

function actionArgs(action: AnyBuiltinUiAction, view: IntentView): UiActionArgumentDescriptor[] {
	return typeof action.args === "function" ? action.args(view) : [...(action.args ?? [])];
}

function actionAvailability(action: AnyBuiltinUiAction, view: IntentView, rawInput?: object): IntentAvailability {
	const legacy = action.available?.(view);
	if (legacy && !legacy.enabled) return legacy;
	return intentRegistry.availability(definitionOf(action), view, rawInput);
}

function builtinDescriptor(action: AnyBuiltinUiAction, view: IntentView): UiActionDescriptor {
	const definition = definitionOf(action);
	const availability = actionAvailability(action, view);
	const state = definition.state?.(view);
	const descriptor: UiActionDescriptor = {
		schemaVersion: 1,
		id: action.id,
		label: definition.label,
		description: typeof definition.description === "function" ? definition.description(view) : definition.description,
		source: "builtin",
		sourceLabel: "Built in",
		category: definition.category as UiActionDescriptor["category"],
		presentation: definition.presentation,
		args: actionArgs(action, view),
		enabled: availability.enabled,
		disabledReason: availability.enabled ? null : availability.reason,
		destructive: definition.confirm?.destructive ?? false,
		requiresConfirmation: definition.confirm !== undefined,
		streamingBehavior: definition.whileBusy === "run" ? "immediate" : "disabled",
		remoteSafe: definition.remote === "safe",
		slash: definition.slash,
	};
	if (state) descriptor.state = state;
	return descriptor;
}

// ============================================================================
// Dynamic actions
// ============================================================================

function dynamicDescriptor(intent: DynamicIntent): UiActionDescriptor {
	return {
		schemaVersion: 1,
		id: intent.name,
		label: intent.label,
		description: typeof intent.description === "string" ? intent.description : undefined,
		source: intent.source,
		sourceScope: intent.sourceScope,
		sourceOrigin: intent.sourceOrigin,
		sourceLabel: intent.sourceLabel,
		category: intent.category as UiActionDescriptor["category"],
		presentation: intent.presentation,
		args: [dynamicArgument(intent)],
		enabled: true,
		disabledReason: null,
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: intent.whileBusy === "queue" ? ["queueSteer", "queueFollowUp"] : "immediate",
		remoteSafe: intent.remote === "safe",
		slash: intent.slash,
	};
}

function dynamicArgument(intent: DynamicIntent): UiActionArgumentDescriptor {
	return {
		name: "arguments",
		label: "Arguments",
		type: "string",
		required: false,
		...(intent.argumentHint ? { hint: intent.argumentHint, placeholder: intent.argumentHint } : {}),
		...(intent.completions?.includes("arguments") ? { completion: "commandArguments" } : {}),
	};
}

// ============================================================================
// Listing
// ============================================================================

/**
 * Descriptors list from a restricted view of the session: busy and model
 * state, settings, and fast mode, but not planning or review-discussion
 * linkage, exactly as the UI action wire always has.
 */
function discoveryView(session: UiActionDiscoverySession, options: UiActionDescriptorOptions): IntentView {
	return {
		state: {
			isBusy: session.isBusy ?? session.isStreaming ?? false,
			hasBackgroundJobs: session.hasBackgroundJobs,
			isCompacting: session.isCompacting ?? false,
			isStreaming: session.isStreaming ?? false,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			fastModeEnabled: session.fastModeEnabled,
			settingsManager: session.settingsManager,
		},
		services: options.detachedReviews === undefined ? {} : { detachedReviews: options.detachedReviews },
		profile: LOCAL_INTENT_PROFILE,
	};
}

function matchesUiActionScope(descriptor: UiActionDescriptor, scope: UiActionListScope): boolean {
	const kind = descriptor.presentation?.kind;
	switch (scope) {
		case "primary":
			return descriptor.source === "builtin" && (kind === "card" || kind === "toggle");
		case "palette":
			return kind === "palette";
		default:
			return true;
	}
}

export function getUiActionDescriptors(
	session: UiActionDiscoverySession,
	scope?: UiActionListScope,
	options: UiActionDescriptorOptions = {},
): UiActionDescriptor[] {
	const view = discoveryView(session, options);
	const normalizedScope = scope === "primary" || scope === "palette" || scope === "all" ? scope : "all";
	const builtinDescriptors = BUILTIN_UI_ACTIONS.map((action) => builtinDescriptor(action, view));
	const descriptors =
		normalizedScope === "primary"
			? builtinDescriptors
			: [...builtinDescriptors, ...listDynamicIntents(session).map(dynamicDescriptor)];
	return descriptors
		.filter((descriptor) => matchesUiActionScope(descriptor, normalizedScope))
		.filter((descriptor) => !options.remoteSafeOnly || descriptor.remoteSafe)
		.slice(0, MAX_DYNAMIC_INTENTS);
}

// ============================================================================
// Invocation
// ============================================================================

export interface UiActionInvocation {
	/** Wait for the action; a dynamic action is answered once its prompt is admitted. */
	run(): Promise<UiActionInvocationResponse>;
	/** The action sends a prompt: answer it without holding the command lane until its admission. */
	readonly prompt: boolean;
}

/**
 * Admit a UI action through its intent. Admission errors throw now, with the
 * UI action wire's messages; the returned run performs the action.
 */
export function prepareUiActionInvocation(
	ctx: IntentContext,
	options: { action: string; args?: unknown; streamingBehavior?: "steer" | "followUp" },
): UiActionInvocation {
	const actionId = options.action;
	if (typeof actionId !== "string" || actionId.length === 0) {
		throw new Error("UI action id must be a non-empty string");
	}
	const requireRemoteSafe = ctx.profile.name === "remote";
	const builtin = BUILTIN_UI_ACTION_BY_ID.get(actionId);
	if (builtin) return prepareBuiltinInvocation(ctx, builtin, options.args, requireRemoteSafe);

	const session = ctx.target?.session;
	const intent = session ? listDynamicIntents(session).find((candidate) => candidate.name === actionId) : undefined;
	if (!intent) throw new Error(`UI action not available: ${actionId}`);
	if (requireRemoteSafe && intent.remote !== "safe") {
		throw new Error(`UI action not available over remote host: ${actionId}`);
	}
	const record = validateUiActionArgs(options.args, [dynamicArgument(intent)]);
	const rawArguments = record.arguments;
	if (rawArguments !== undefined && rawArguments !== null && typeof rawArguments !== "string") {
		throw new Error('UI action argument "arguments" must be a string');
	}
	const prepared = intentRegistry.prepareFrame(ctx, actionId, {
		...(typeof rawArguments === "string" ? { arguments: rawArguments } : {}),
		...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
	});
	return {
		prompt: true,
		run: async () => {
			const { outcome } = await prepared.run();
			const dynamic = outcome as DynamicIntentOutcome;
			if (dynamic.source === "extension") return { action: actionId, status: "handled" };
			return dynamic.queuedAs === undefined
				? { action: actionId, status: "accepted" }
				: { action: actionId, status: "queued", queuedAs: dynamic.queuedAs };
		},
	};
}

function prepareBuiltinInvocation(
	ctx: IntentContext,
	action: AnyBuiltinUiAction,
	args: unknown,
	requireRemoteSafe: boolean,
): UiActionInvocation {
	const definition = definitionOf(action);
	if (requireRemoteSafe && definition.remote !== "safe") {
		throw new Error(`UI action not available over remote host: ${action.id}`);
	}
	const session = ctx.target?.session;
	const viewOf = (): IntentView => ({
		state: intentStateOf(session),
		services: ctx.services,
		profile: ctx.profile,
		...(ctx.target === undefined ? {} : { target: ctx.target }),
	});
	const view = viewOf();
	// Availability reads the raw arguments, as it always has: disabling fast mode stays available.
	const rawInput = typeof args === "object" && args !== null && !Array.isArray(args) ? args : undefined;
	const availability = actionAvailability(action, view, rawInput);
	if (!availability.enabled) throw new Error(availability.reason);
	const record = validateUiActionArgs(args, actionArgs(action, view));
	const prepared = intentRegistry.prepare(ctx, action.intent, action.toInput(record));
	return {
		prompt: false,
		run: async () => {
			const { outcome } = await prepared.run();
			return action.respond(outcome, { before: view.state, after: viewOf, args: record });
		},
	};
}

// ============================================================================
// Completions
// ============================================================================

export async function getUiActionCompletions(
	ctx: IntentContext,
	options: { action: string; argument: string; prefix?: unknown },
): Promise<UiActionOptionDescriptor[]> {
	if (typeof options.action !== "string" || options.action.length === 0) {
		throw new Error("UI action id must be a non-empty string");
	}
	if (typeof options.argument !== "string" || options.argument.length === 0) {
		throw new Error("UI action argument name must be a non-empty string");
	}
	if (options.prefix !== undefined && typeof options.prefix !== "string") {
		throw new Error("UI action completion prefix must be a string");
	}
	const requireRemoteSafe = ctx.profile.name === "remote";
	const prefix = options.prefix ?? "";
	// Completions ignore availability, so busy and detached state never gate them.
	const builtin = BUILTIN_UI_ACTION_BY_ID.get(options.action);
	if (builtin) {
		if (requireRemoteSafe && definitionOf(builtin).remote !== "safe") {
			throw new Error(`UI action not available over remote host: ${options.action}`);
		}
		const view: IntentView = {
			state: intentStateOf(ctx.target?.session),
			services: ctx.services,
			profile: ctx.profile,
		};
		const argument = actionArgs(builtin, view).find((candidate) => candidate.name === options.argument);
		if (!argument) throw new Error(`UI action argument not available: ${options.argument}`);
		if (argument.completion !== "gitBranches") return [];
		return intentRegistry.complete(ctx, builtin.intent, options.argument, prefix);
	}

	const session = ctx.target?.session;
	const intent = session
		? listDynamicIntents(session).find((candidate) => candidate.name === options.action)
		: undefined;
	if (!intent) throw new Error(`UI action not available: ${options.action}`);
	if (requireRemoteSafe && intent.remote !== "safe") {
		throw new Error(`UI action not available over remote host: ${options.action}`);
	}
	if (options.argument !== "arguments") throw new Error(`UI action argument not available: ${options.argument}`);
	return intentRegistry.complete(ctx, intent.name, options.argument, prefix);
}
