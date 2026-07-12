import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import { getSupportedThinkingLevels } from "@hansjm10/volt-ai";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import type { ReviewTarget, ReviewWorkflowResult } from "./review.ts";
import type {
	UiActionArgumentDescriptor,
	UiActionDescriptor,
	UiActionInvocationResponse,
	UiActionSlashAlias,
	UiActionStateDescriptor,
} from "./rpc/types.ts";
import { validateUiActionArgs } from "./rpc/ui-action-args.ts";

type RuntimeNewSession = AgentSessionRuntime["newSession"];
type RuntimeSession = AgentSessionRuntime["session"];

export type HostActionNewSessionOptions = Parameters<RuntimeNewSession>[0];
export type HostActionNewSessionResult = Awaited<ReturnType<RuntimeNewSession>>;
export type HostActionCompactResult = Awaited<ReturnType<RuntimeSession["compact"]>>;

export interface HostActionSessionState {
	/** Falls back to isStreaming for legacy host integrations. */
	isBusy?: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	fastModeRestoreThinkingLevel?: ThinkingLevel;
}

export interface HostActionDescriptorContext {
	session: HostActionSessionState;
}

export interface HostActionInvocationContext extends HostActionDescriptorContext {
	abortRun(): Promise<void>;
	compactContext(customInstructions?: string): Promise<HostActionCompactResult>;
	newSession(options?: HostActionNewSessionOptions): Promise<HostActionNewSessionResult>;
	afterSessionSwitch?: () => Promise<void>;
	renameSession(name: string): void;
	setThinkingLevel?(level: ThinkingLevel, options?: { persistDefault?: boolean; preserveFastMode?: boolean }): void;
	setFastModeRestoreThinkingLevel?(level: ThinkingLevel | undefined): void;
	runReviewAction?(target: ReviewTarget, options: HostActionReviewOptions): Promise<ReviewWorkflowResult>;
}

export type HostActionAvailability =
	| {
			enabled: true;
			disabledReason?: null;
	  }
	| {
			enabled: false;
			disabledReason: string;
	  };

export interface HostActionDefinition {
	id: string;
	label: string;
	description?: string;
	category: UiActionDescriptor["category"];
	presentation: UiActionDescriptor["presentation"];
	args?: ReadonlyArray<UiActionArgumentDescriptor>;
	destructive?: boolean;
	requiresConfirmation?: boolean;
	streamingBehavior?: UiActionDescriptor["streamingBehavior"];
	remoteSafe: boolean;
	state?: UiActionStateDescriptor | ((context: HostActionDescriptorContext) => UiActionStateDescriptor | undefined);
	slashAliases?: ReadonlyArray<UiActionSlashAlias>;
	slash?: UiActionSlashAlias;
	availability?: (context: HostActionDescriptorContext) => HostActionAvailability;
	handler: (
		context: HostActionInvocationContext,
		args: unknown,
		options: HostActionInvokeOptions,
	) => Promise<UiActionInvocationResponse>;
}

export interface HostActionInvokeOptions {
	requireRemoteSafe?: boolean;
}

export interface HostActionSlashCommand {
	name: string;
	description: string;
}

export const CONTEXT_COMPACT_ACTION_ID = "context.compact";
export const CONTEXT_COMPACT_SLASH_ALIAS = "compact";
export const REVIEW_BRANCH_ACTION_ID = "review.branch";
export const REVIEW_UNCOMMITTED_ACTION_ID = "review.uncommitted";
export const RUN_CANCEL_ACTION_ID = "run.cancel";
export const SESSION_NEW_ACTION_ID = "session.new";
export const SESSION_NEW_SLASH_ALIAS = "clear";
export const SESSION_RENAME_ACTION_ID = "session.rename";
export const SESSION_RENAME_SLASH_ALIAS = "name";
export const THINKING_FAST_MODE_ACTION_ID = "thinking.fast_mode";

export interface HostActionReviewOptions {
	remote: boolean;
	requireConfirmation: boolean;
}

const REMOTE_SAFE_BUILTIN_HOST_ACTION_IDS = new Set<string>([
	SESSION_NEW_ACTION_ID,
	RUN_CANCEL_ACTION_ID,
	THINKING_FAST_MODE_ACTION_ID,
	REVIEW_UNCOMMITTED_ACTION_ID,
	REVIEW_BRANCH_ACTION_ID,
]);

export class HostActionRegistry {
	private readonly actionIds: string[] = [];
	private readonly actions = new Map<string, HostActionDefinition>();
	private readonly slashAliases = new Map<string, string>();

	register(definition: HostActionDefinition): this {
		if (definition.id.length === 0) {
			throw new Error("Host action id must be a non-empty string");
		}
		if (this.actions.has(definition.id)) {
			throw new Error(`Host action already registered: ${definition.id}`);
		}

		for (const alias of definition.slashAliases ?? []) {
			const name = normalizeSlashAlias(alias.name);
			const existingActionId = this.slashAliases.get(name);
			if (existingActionId) {
				throw new Error(`Host action slash alias already registered: ${name}`);
			}
		}

		this.actions.set(definition.id, definition);
		this.actionIds.push(definition.id);
		for (const alias of definition.slashAliases ?? []) {
			this.slashAliases.set(normalizeSlashAlias(alias.name), definition.id);
		}
		return this;
	}

	get(actionId: string): HostActionDefinition | undefined {
		return this.actions.get(actionId);
	}

	resolveSlashAlias(alias: string): HostActionDefinition | undefined {
		const actionId = this.slashAliases.get(normalizeSlashAlias(alias));
		return actionId ? this.actions.get(actionId) : undefined;
	}

	getSlashCommand(alias: string): HostActionSlashCommand | undefined {
		const action = this.resolveSlashAlias(alias);
		if (!action) {
			return undefined;
		}
		const normalizedAlias = normalizeSlashAlias(alias);
		const slashAlias = action.slashAliases?.find(
			(candidate) => normalizeSlashAlias(candidate.name) === normalizedAlias,
		);
		if (!slashAlias) {
			return undefined;
		}
		return {
			name: normalizedAlias,
			description: action.description ?? action.label,
		};
	}

	getSlashCommands(): HostActionSlashCommand[] {
		return this.actionIds.flatMap((actionId) => {
			const action = this.actions.get(actionId);
			if (!action) {
				return [];
			}
			return (action.slashAliases ?? []).map((alias) => ({
				name: normalizeSlashAlias(alias.name),
				description: action.description ?? action.label,
			}));
		});
	}

	getDescriptor(actionId: string, context: HostActionDescriptorContext): UiActionDescriptor | undefined {
		const action = this.actions.get(actionId);
		return action ? createDescriptor(action, context) : undefined;
	}

	getDescriptors(context: HostActionDescriptorContext): UiActionDescriptor[] {
		return this.actionIds.flatMap((actionId) => {
			const action = this.actions.get(actionId);
			return action ? [createDescriptor(action, context)] : [];
		});
	}

	async invoke(
		actionId: string,
		context: HostActionInvocationContext,
		args: unknown,
		options: HostActionInvokeOptions = {},
	): Promise<UiActionInvocationResponse> {
		if (actionId.length === 0) {
			throw new Error("UI action id must be a non-empty string");
		}
		const action = this.actions.get(actionId);
		if (!action) {
			throw new Error(`UI action not available: ${actionId}`);
		}
		const descriptor = createDescriptor(action, context);
		if (options.requireRemoteSafe && !descriptor.remoteSafe) {
			throw new Error(`UI action not available over remote host: ${actionId}`);
		}
		if (!descriptor.enabled) {
			throw new Error(descriptor.disabledReason ?? `UI action is disabled: ${actionId}`);
		}
		const validatedArgs = validateUiActionArgs(args, descriptor.args ?? []);
		return action.handler(context, validatedArgs, options);
	}

	invokeBySlashAlias(
		alias: string,
		context: HostActionInvocationContext,
		args?: unknown,
		options?: HostActionInvokeOptions,
	): Promise<UiActionInvocationResponse> {
		const action = this.resolveSlashAlias(alias);
		if (!action) {
			throw new Error(`Host action slash alias not available: ${normalizeSlashAlias(alias)}`);
		}
		return this.invoke(action.id, context, args, options);
	}
}

export async function runSessionNewHostAction(
	context: HostActionInvocationContext,
	options?: HostActionNewSessionOptions,
): Promise<HostActionNewSessionResult> {
	const result = await context.newSession(options);
	if (!result.cancelled) {
		await context.afterSessionSwitch?.();
	}
	return result;
}

export async function runCancelHostAction(context: HostActionInvocationContext): Promise<void> {
	await context.abortRun();
}

export async function runContextCompactHostAction(
	context: HostActionInvocationContext,
	customInstructions?: string,
): Promise<HostActionCompactResult> {
	return context.compactContext(customInstructions);
}

export function runSessionRenameHostAction(context: HostActionInvocationContext, name: string): string {
	const trimmedName = name.trim();
	if (!trimmedName) {
		throw new Error("Session name cannot be empty");
	}
	context.renameSession(trimmedName);
	return trimmedName;
}

export async function runReviewHostAction(
	context: HostActionInvocationContext,
	target: ReviewTarget,
	options: HostActionReviewOptions,
): Promise<ReviewWorkflowResult> {
	if (!context.runReviewAction) {
		throw new Error("Review actions are not available in this host");
	}
	return context.runReviewAction(target, options);
}

export function registerBuiltinHostActions(registry: HostActionRegistry): HostActionRegistry {
	registry.register({
		id: SESSION_NEW_ACTION_ID,
		label: "New session",
		description: "Start a new session",
		category: "session",
		presentation: { kind: "palette", group: "Session" },
		args: [],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slashAliases: [
			{
				name: SESSION_NEW_SLASH_ALIAS,
				example: `/${SESSION_NEW_SLASH_ALIAS}`,
			},
		],
		availability: () => ({ enabled: true }),
		handler: invokeSessionNewAction,
	});
	registry.register({
		id: RUN_CANCEL_ACTION_ID,
		label: "Cancel run",
		description: "Abort the current agent operation",
		category: "session",
		presentation: { kind: "button", group: "Session" },
		args: [],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "immediate",
		remoteSafe: true,
		availability: (context) =>
			isHostSessionBusy(context.session) || context.session.isCompacting
				? { enabled: true }
				: { enabled: false, disabledReason: "No active run to cancel" },
		handler: invokeRunCancelAction,
	});
	registry.register({
		id: CONTEXT_COMPACT_ACTION_ID,
		label: "Compact context",
		description: "Summarize the current session context",
		category: "context",
		presentation: { kind: "palette", group: "Context" },
		args: [
			{
				name: "customInstructions",
				label: "Custom instructions",
				type: "string",
				required: false,
				multiline: true,
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: false,
		slashAliases: [
			{
				name: CONTEXT_COMPACT_SLASH_ALIAS,
				example: `/${CONTEXT_COMPACT_SLASH_ALIAS}`,
			},
		],
		availability: (context) =>
			context.session.isCompacting
				? { enabled: false, disabledReason: "Compaction is already running" }
				: { enabled: true },
		handler: invokeContextCompactAction,
	});
	registry.register({
		id: SESSION_RENAME_ACTION_ID,
		label: "Rename session",
		description: "Set the current session display name",
		category: "session",
		presentation: { kind: "palette", group: "Session" },
		args: [
			{
				name: "name",
				label: "Name",
				type: "string",
				required: true,
				placeholder: "Session name",
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "immediate",
		remoteSafe: false,
		slashAliases: [
			{
				name: SESSION_RENAME_SLASH_ALIAS,
				example: `/${SESSION_RENAME_SLASH_ALIAS} <name>`,
			},
		],
		availability: () => ({ enabled: true }),
		handler: invokeSessionRenameAction,
	});
	registry.register({
		id: THINKING_FAST_MODE_ACTION_ID,
		label: "Fast mode",
		description: "Prefer lower-latency thinking for the current session.",
		category: "model",
		presentation: { kind: "toggle", group: "Model", priority: 100 },
		args: [
			{
				name: "enabled",
				label: "Enabled",
				type: "boolean",
				required: true,
			},
		],
		destructive: false,
		requiresConfirmation: false,
		streamingBehavior: "disabled",
		remoteSafe: true,
		state: createThinkingFastModeState,
		availability: thinkingFastModeAvailability,
		handler: invokeThinkingFastModeAction,
	});
	registry.register({
		id: REVIEW_UNCOMMITTED_ACTION_ID,
		label: "Review changes",
		description: "Review uncommitted workspace changes.",
		category: "review",
		presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
		args: [],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review uncommitted",
		},
		availability: reviewAvailability,
		handler: invokeReviewUncommittedAction,
	});
	registry.register({
		id: REVIEW_BRANCH_ACTION_ID,
		label: "Review branch",
		description: "Review the current branch against its merge base.",
		category: "review",
		presentation: {
			kind: "card",
			group: "Review",
			priority: 90,
			icon: "point.topleft.down.curvedto.point.bottomright.up",
		},
		args: [
			{
				name: "base",
				label: "Base branch",
				type: "string",
				required: false,
				placeholder: "main",
			},
		],
		destructive: false,
		requiresConfirmation: true,
		streamingBehavior: "disabled",
		remoteSafe: true,
		slash: {
			name: "review",
			example: "/review branch [base]",
		},
		availability: reviewAvailability,
		handler: invokeReviewBranchAction,
	});
	return registry;
}

export function createBuiltinHostActionRegistry(): HostActionRegistry {
	return registerBuiltinHostActions(new HostActionRegistry());
}

export const BUILTIN_HOST_ACTION_REGISTRY = createBuiltinHostActionRegistry();

export function getBuiltinHostActionSlashCommand(alias: string): HostActionSlashCommand | undefined {
	return BUILTIN_HOST_ACTION_REGISTRY.getSlashCommand(alias);
}

export function isRemoteSafeBuiltinHostActionId(actionId: string): boolean {
	return REMOTE_SAFE_BUILTIN_HOST_ACTION_IDS.has(actionId);
}

async function invokeSessionNewAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	assertNoActionArgs(args);
	const result = await runSessionNewHostAction(context);
	const response: UiActionInvocationResponse = {
		action: SESSION_NEW_ACTION_ID,
		status: result.cancelled ? "cancelled" : "completed",
	};
	if (!result.cancelled) {
		response.stateChanged = true;
		response.actionsChanged = true;
	}
	return response;
}

async function invokeRunCancelAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	assertNoActionArgs(args);
	await runCancelHostAction(context);
	return {
		action: RUN_CANCEL_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Run cancelled",
	};
}

async function invokeContextCompactAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const customInstructions = getOptionalStringArg(args, "customInstructions");
	await runContextCompactHostAction(context, customInstructions);
	return {
		action: CONTEXT_COMPACT_ACTION_ID,
		status: "completed",
		stateChanged: true,
		actionsChanged: true,
		message: "Context compacted",
	};
}

async function invokeSessionRenameAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	const name = getRequiredStringArg(args, "name");
	const trimmedName = runSessionRenameHostAction(context, name);
	return {
		action: SESSION_RENAME_ACTION_ID,
		status: "completed",
		stateChanged: true,
		message: `Session name set: ${trimmedName}`,
	};
}

function invokeThinkingFastModeAction(
	context: HostActionInvocationContext,
	args: unknown,
): Promise<UiActionInvocationResponse> {
	return Promise.resolve(runThinkingFastModeHostAction(context, getRequiredBooleanArg(args, "enabled")));
}

export function runThinkingFastModeHostAction(
	context: HostActionInvocationContext,
	enabled: boolean,
): UiActionInvocationResponse {
	if (!context.setThinkingLevel || !context.setFastModeRestoreThinkingLevel) {
		throw new Error("Fast mode is not available in this host");
	}

	const isEnabled = isThinkingFastModeEnabled(context.session);
	if (enabled) {
		if (isEnabled) {
			return {
				action: THINKING_FAST_MODE_ACTION_ID,
				status: "completed",
				state: createThinkingFastModeState(context),
				stateChanged: false,
				actionsChanged: false,
				message: "Fast mode already enabled",
			};
		}

		const restoreLevel = context.session.thinkingLevel;
		const targetLevel = getFastModeTargetThinkingLevel(context.session);
		if (!restoreLevel || !targetLevel) {
			throw new Error(getThinkingFastModeDisabledReason(context.session));
		}

		context.setThinkingLevel(targetLevel, { persistDefault: false, preserveFastMode: true });
		context.setFastModeRestoreThinkingLevel(restoreLevel);
		return {
			action: THINKING_FAST_MODE_ACTION_ID,
			status: "completed",
			state: createThinkingFastModeState(context),
			stateChanged: true,
			actionsChanged: true,
			message: `Fast mode enabled: ${formatThinkingLevelLabel(context.session.thinkingLevel ?? targetLevel)}`,
		};
	}

	const restoreLevel = context.session.fastModeRestoreThinkingLevel;
	if (restoreLevel !== undefined) {
		context.setThinkingLevel(restoreLevel, { persistDefault: false, preserveFastMode: true });
	}
	context.setFastModeRestoreThinkingLevel(undefined);
	return {
		action: THINKING_FAST_MODE_ACTION_ID,
		status: "completed",
		state: createThinkingFastModeState(context),
		stateChanged: restoreLevel !== undefined,
		actionsChanged: restoreLevel !== undefined,
		message:
			restoreLevel === undefined
				? "Fast mode already disabled"
				: `Fast mode disabled: restored ${formatThinkingLevelLabel(context.session.thinkingLevel ?? restoreLevel)}`,
	};
}

async function invokeReviewUncommittedAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	assertNoActionArgs(args);
	return createReviewInvocationResponse(
		REVIEW_UNCOMMITTED_ACTION_ID,
		await runReviewHostAction(context, { kind: "uncommitted" }, createReviewOptions(options)),
	);
}

async function invokeReviewBranchAction(
	context: HostActionInvocationContext,
	args: unknown,
	options: HostActionInvokeOptions,
): Promise<UiActionInvocationResponse> {
	const base = getOptionalStringArg(args, "base")?.trim() || undefined;
	return createReviewInvocationResponse(
		REVIEW_BRANCH_ACTION_ID,
		await runReviewHostAction(context, { kind: "branch", base }, createReviewOptions(options)),
	);
}

function reviewAvailability(context: HostActionDescriptorContext): HostActionAvailability {
	if (context.session.isStreaming) {
		return { enabled: false, disabledReason: "Review is not available while the agent is streaming" };
	}
	if (isHostSessionBusy(context.session)) {
		return { enabled: false, disabledReason: "Review is not available while an agent operation is running" };
	}
	if (context.session.isCompacting) {
		return { enabled: false, disabledReason: "Review is not available while compaction is running" };
	}
	return { enabled: true };
}

function thinkingFastModeAvailability(context: HostActionDescriptorContext): HostActionAvailability {
	if (context.session.isStreaming) {
		return { enabled: false, disabledReason: "Fast mode is not available while the agent is streaming" };
	}
	if (isHostSessionBusy(context.session)) {
		return { enabled: false, disabledReason: "Fast mode is not available while an agent operation is running" };
	}
	if (context.session.isCompacting) {
		return { enabled: false, disabledReason: "Fast mode is not available while compaction is running" };
	}
	if (isThinkingFastModeEnabled(context.session)) {
		return { enabled: true };
	}
	const targetLevel = getFastModeTargetThinkingLevel(context.session);
	if (!targetLevel) {
		return { enabled: false, disabledReason: getThinkingFastModeDisabledReason(context.session) };
	}
	return { enabled: true };
}

function createReviewOptions(options: HostActionInvokeOptions): HostActionReviewOptions {
	return {
		remote: options.requireRemoteSafe === true,
		requireConfirmation: options.requireRemoteSafe === true,
	};
}

function createReviewInvocationResponse(action: string, result: ReviewWorkflowResult): UiActionInvocationResponse {
	if (result.status === "cancelled") {
		return {
			action,
			status: "cancelled",
			actionsChanged: true,
			message: "Review cancelled",
		};
	}
	const findingCount = result.findingsCount;
	const summary =
		findingCount === undefined
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

function createDescriptor(action: HostActionDefinition, context: HostActionDescriptorContext): UiActionDescriptor {
	const availability = action.availability?.(context) ?? { enabled: true };
	const state = typeof action.state === "function" ? action.state(context) : action.state;
	const descriptor: UiActionDescriptor = {
		schemaVersion: 1,
		id: action.id,
		label: action.label,
		description: action.description,
		source: "builtin",
		sourceLabel: "Built in",
		category: action.category,
		presentation: action.presentation,
		args: [...(action.args ?? [])],
		enabled: availability.enabled,
		disabledReason: availability.enabled ? null : availability.disabledReason,
		destructive: action.destructive ?? false,
		requiresConfirmation: action.requiresConfirmation ?? false,
		streamingBehavior: action.streamingBehavior ?? "disabled",
		remoteSafe: action.remoteSafe,
		slash: action.slashAliases?.[0] ?? action.slash,
	};
	if (state) {
		descriptor.state = state;
	}
	return descriptor;
}

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FAST_MODE_TARGET_ORDER: ThinkingLevel[] = ["off", "minimal", "low"];

function createThinkingFastModeState(context: HostActionDescriptorContext): UiActionStateDescriptor {
	const enabled = isThinkingFastModeEnabled(context.session);
	return {
		type: "boolean",
		value: enabled,
		label: enabled ? `Fast: ${formatThinkingLevelLabel(context.session.thinkingLevel)}` : "Normal reasoning",
	};
}

function isHostSessionBusy(session: HostActionSessionState): boolean {
	return session.isBusy ?? session.isStreaming;
}

function isThinkingFastModeEnabled(session: HostActionSessionState): boolean {
	return session.fastModeRestoreThinkingLevel !== undefined;
}

function getFastModeTargetThinkingLevel(session: HostActionSessionState): ThinkingLevel | undefined {
	if (!session.model || !session.thinkingLevel) {
		return undefined;
	}
	const currentRank = getThinkingLevelRank(session.thinkingLevel);
	if (currentRank <= 0) {
		return undefined;
	}
	const supportedLevels = getSupportedThinkingLevels(session.model) as ThinkingLevel[];
	return FAST_MODE_TARGET_ORDER.find((level) => {
		const targetRank = getThinkingLevelRank(level);
		return supportedLevels.includes(level) && targetRank >= 0 && targetRank < currentRank;
	});
}

function getThinkingFastModeDisabledReason(session: HostActionSessionState): string {
	if (!session.model) {
		return "No model is selected.";
	}
	if (!session.thinkingLevel) {
		return "No thinking level is selected.";
	}
	return "Current model is already at its fastest supported thinking level.";
}

function getThinkingLevelRank(level: ThinkingLevel): number {
	return THINKING_LEVEL_ORDER.indexOf(level);
}

function formatThinkingLevelLabel(level: ThinkingLevel | undefined): string {
	if (level === undefined) {
		return "current thinking";
	}
	return level === "off" ? "thinking off" : `${level} thinking`;
}

function normalizeSlashAlias(alias: string): string {
	const normalized = alias.startsWith("/") ? alias.slice(1) : alias;
	if (normalized.length === 0) {
		throw new Error("Host action slash alias must be a non-empty string");
	}
	return normalized;
}

function assertNoActionArgs(args: unknown): void {
	if (args === undefined) {
		return;
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	const unknownKeys = Object.keys(args);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
}

function getArgsRecord(args: unknown): Record<string, unknown> {
	if (args === undefined) {
		return {};
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) {
		throw new Error("UI action args must be an object");
	}
	return args as Record<string, unknown>;
}

function getOptionalStringArg(args: unknown, name: string): string | undefined {
	const record = getArgsRecord(args);
	const unknownKeys = Object.keys(record).filter((key) => key !== name);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
	const value = record[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`UI action argument "${name}" must be a string`);
	}
	return value;
}

function getRequiredStringArg(args: unknown, name: string): string {
	const value = getOptionalStringArg(args, name);
	if (value === undefined) {
		throw new Error(`Missing required UI action argument: ${name}`);
	}
	return value;
}

function getOptionalBooleanArg(args: unknown, name: string): boolean | undefined {
	const record = getArgsRecord(args);
	const unknownKeys = Object.keys(record).filter((key) => key !== name);
	if (unknownKeys.length > 0) {
		throw new Error(`Unsupported UI action argument: ${unknownKeys[0]}`);
	}
	const value = record[name];
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new Error(`UI action argument "${name}" must be a boolean`);
	}
	return value;
}

function getRequiredBooleanArg(args: unknown, name: string): boolean {
	const value = getOptionalBooleanArg(args, name);
	if (value === undefined) {
		throw new Error(`UI action argument "${name}" is required`);
	}
	return value;
}
