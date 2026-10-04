/**
 * Host intents: the host's settings and defaults, MCP server control, push
 * targets, and the registered workspace a remote connection is bound to.
 */

import type { McpManager } from "../../mcp/manager.ts";
import { findAvailableModel, targetOf } from "./conversation.ts";
import { autoCompactionState, compactionThresholdState, intentStateOf, isIntentStateBusy } from "./state.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	IntentRejectedError,
	type IntentView,
	type IntentWorkspaceServices,
} from "./types.ts";

const control = ["conversation.control.v1"] as const;
const hostManage = ["host.manage.v1"] as const;
const integrations = ["integrations.manage.v1"] as const;
/** Persisting a default model or thinking level selects it for future conversations. */
const selectDefaults = ["model.select.v1", "host.manage.v1"] as const;

// ============================================================================
// Defaults and queue settings
// ============================================================================

export const setDefaultModelIntent = defineIntent({
	name: "set_default_model",
	label: "Default model",
	description: "Set the model new conversations start with",
	category: "model",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: selectDefaults,
	whileBusy: "run",
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const model = await findAvailableModel(session, input.provider, input.modelId, ctx.assertCurrent);
		session.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		await session.settingsManager.flush();
		return model;
	},
});

export const setDefaultThinkingLevelIntent = defineIntent({
	name: "set_default_thinking_level",
	label: "Default thinking level",
	description: "Set the thinking level new conversations start with",
	category: "model",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: selectDefaults,
	whileBusy: "run",
	async run(ctx, input) {
		const { settingsManager } = targetOf(ctx).session;
		settingsManager.setDefaultThinkingLevel(input.level);
		await settingsManager.flush();
	},
});

export const setSteeringModeIntent = defineIntent({
	name: "set_steering_mode",
	label: "Steering mode",
	description: "Deliver queued steering messages all at once or one at a time",
	category: "session",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx, input) {
		targetOf(ctx).session.setSteeringMode(input.mode);
	},
});

export const setFollowUpModeIntent = defineIntent({
	name: "set_follow_up_mode",
	label: "Follow-up mode",
	description: "Deliver queued follow-up messages all at once or one at a time",
	category: "session",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx, input) {
		targetOf(ctx).session.setFollowUpMode(input.mode);
	},
});

export const setAutoRetryIntent = defineIntent({
	name: "set_auto_retry",
	label: "Auto-retry",
	description: "Retry failed provider requests automatically",
	category: "session",
	scope: "host",
	fence: "none",
	remote: "unsafe",
	requires: hostManage,
	whileBusy: "run",
	async run(ctx, input) {
		targetOf(ctx).session.setAutoRetryEnabled(input.enabled);
	},
});

// ============================================================================
// Compaction settings
// ============================================================================

type CompactionField = "enabled" | "modelThresholds";

function compactionSaveScope(view: IntentView): string {
	const profile = view.state.settingsManager?.getActiveProfile();
	return profile ? `in global profile "${profile}" on the connected host` : "globally on the connected host";
}

export function compactionSettingsAvailability(view: IntentView, field: CompactionField): IntentAvailability {
	const { state } = view;
	if (state.isStreaming) return { enabled: false, reason: "Compaction settings are unavailable while streaming" };
	if (isIntentStateBusy(state)) {
		return { enabled: false, reason: "Compaction settings are unavailable while an agent operation is running" };
	}
	if (state.isCompacting) return { enabled: false, reason: "Compaction settings are unavailable while compacting" };
	const { model, settingsManager } = state;
	if (!model) return { enabled: false, reason: "Select a model to configure compaction" };
	if (!settingsManager) return { enabled: false, reason: "Compaction settings are unavailable in this host" };
	const reason = settingsManager.getCompactionWriteDisabledReason(field, `${model.provider}/${model.id}`);
	return reason ? { enabled: false, reason } : INTENT_ENABLED;
}

interface CompactionTarget {
	provider?: string;
	modelId?: string;
	expectedProfile?: string;
}

function hasCompactionTarget(input: CompactionTarget): boolean {
	return input.provider !== undefined || input.modelId !== undefined || input.expectedProfile !== undefined;
}

/**
 * Save a compaction setting for the model and settings profile the client
 * saw. Nothing awaits between the target and authority checks and the
 * settings mutation.
 */
async function saveCompactionSetting(
	ctx: IntentContext,
	input: CompactionTarget,
	field: CompactionField,
	value: boolean | number,
): Promise<void> {
	const { session } = targetOf(ctx);
	ctx.assertCurrent?.();
	const { model, settingsManager } = session;
	if (!model || !settingsManager) throw new Error("Compaction settings are unavailable in this host");
	if (
		input.provider !== model.provider ||
		input.modelId !== model.id ||
		input.expectedProfile !== (settingsManager.getActiveProfile() ?? "")
	) {
		throw new Error("Compaction settings target changed; refresh actions and retry");
	}
	const availability = compactionSettingsAvailability(
		{ state: intentStateOf(session), services: ctx.services, profile: ctx.profile },
		field,
	);
	if (!availability.enabled) throw new Error(availability.reason);
	if (field === "enabled") {
		settingsManager.setCompactionEnabled(value as boolean);
	} else {
		settingsManager.setCompactionThresholdTokens(`${model.provider}/${model.id}`, value as number);
	}
	await settingsManager.flush();
}

/**
 * With a target (`provider`, `modelId`, `expectedProfile`), the change is
 * rejected unless the client still sees that model and settings profile, and
 * only while the conversation is idle; remote clients must send the target.
 */
export const setAutoCompactionIntent = defineIntent({
	name: "set_auto_compaction",
	label: "Auto-compaction",
	description: (view) =>
		`Save auto-compaction ${compactionSaveScope(view)}. Trusted project and runtime overrides take precedence. Disabling retains model thresholds.`,
	category: "context",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "toggle", group: "Context", priority: 100 },
	state: autoCompactionState,
	available(view, input) {
		if (input !== undefined && !hasCompactionTarget(input)) {
			return view.profile.name === "remote"
				? {
						enabled: false,
						code: "invalid_input",
						reason: "Remote compaction changes name the provider, modelId, and expectedProfile they target",
					}
				: INTENT_ENABLED;
		}
		return compactionSettingsAvailability(view, "enabled");
	},
	async run(ctx, input) {
		if (hasCompactionTarget(input)) {
			await saveCompactionSetting(ctx, input, "enabled", input.enabled);
			return;
		}
		targetOf(ctx).session.setAutoCompactionEnabled(input.enabled);
	},
});

export const setCompactionThresholdIntent = defineIntent({
	name: "set_compaction_threshold",
	label: "Compact at",
	description: (view) =>
		`Save the token threshold for ${view.state.model ? `${view.state.model.provider}/${view.state.model.id}` : "the selected model"} ${compactionSaveScope(view)}. 0 uses the context-limit default. Trusted project and runtime overrides take precedence.`,
	category: "context",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "picker", group: "Context", priority: 90 },
	state: compactionThresholdState,
	available: (view) => compactionSettingsAvailability(view, "modelThresholds"),
	run: (ctx, input) => saveCompactionSetting(ctx, input, "modelThresholds", input.tokens),
});

// ============================================================================
// Host status
// ============================================================================

function unsupported(): IntentAvailability {
	return { enabled: false, reason: "unsupported_remote_command" };
}

export const setKeepAwakeIntent = defineIntent({
	name: "set_keep_awake",
	label: "Keep awake",
	description: "Keep the host from sleeping while it serves conversations",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: hostManage,
	whileBusy: "run",
	available: (view) => (view.services.keepAwake ? INTENT_ENABLED : unsupported()),
	async run(ctx, input) {
		const keepAwake = ctx.services.keepAwake;
		if (!keepAwake) throw new IntentRejectedError("unavailable", "unsupported_remote_command");
		return keepAwake.setEnabled(input.enabled);
	},
	accept: (result) => ({ result }),
});

export const setWebSearchKeyIntent = defineIntent({
	name: "set_web_search_key",
	label: "Web search key",
	description: "Store or remove the host's web search API key",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: integrations,
	whileBusy: "run",
	available: (view) => (view.services.webSearchKey ? INTENT_ENABLED : unsupported()),
	async run(ctx, input) {
		const webSearchKey = ctx.services.webSearchKey;
		if (!webSearchKey) throw new IntentRejectedError("unavailable", "unsupported_remote_command");
		const normalized = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
		webSearchKey.set(normalized.length > 0 ? normalized : null);
		return { configured: webSearchKey.configured };
	},
	accept: (result) => ({ result }),
});

/** The connection's workspace service an intent needs, or unavailable on hosts without it. */
export function workspaceService<K extends Exclude<keyof IntentWorkspaceServices, "name">>(
	ctx: IntentContext,
	key: K,
): { name: string; operation: NonNullable<IntentWorkspaceServices[K]> } {
	const workspace = ctx.services.workspace;
	const operation = workspace?.[key];
	if (!workspace || !operation) throw new IntentRejectedError("unavailable", "unsupported_remote_command");
	return { name: workspace.name, operation: operation as NonNullable<IntentWorkspaceServices[K]> };
}

function workspaceAvailability(key: Exclude<keyof IntentWorkspaceServices, "name">) {
	return (view: IntentView): IntentAvailability => (view.services.workspace?.[key] ? INTENT_ENABLED : unsupported());
}

export const uploadDeviceLogsIntent = defineIntent({
	name: "upload_device_logs",
	label: "Upload device logs",
	description: "Save a paired device's diagnostic log under the workspace",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: ["diagnostics.upload.v1"],
	whileBusy: "run",
	available: workspaceAvailability("uploadDeviceLogs"),
	run: (ctx, input) =>
		workspaceService(ctx, "uploadDeviceLogs").operation({
			...(input.fileName === undefined ? {} : { fileName: input.fileName }),
			content: input.content,
		}),
	accept: (result) => ({ result }),
});

// ============================================================================
// Push targets and the connection's workspace
// ============================================================================

export const registerPushTargetIntent = defineIntent({
	name: "register_push_target",
	label: "Register push target",
	description: "Register or update this device's push notification target",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	// Every paired device may manage its own push target.
	requires: [],
	whileBusy: "run",
	available: (view) =>
		view.services.pushTargets
			? INTENT_ENABLED
			: { enabled: false, reason: "Push target registration is not available over this RPC transport" },
	run(ctx, input) {
		const pushTargets = ctx.services.pushTargets;
		if (!pushTargets) {
			return Promise.reject(
				new IntentRejectedError("unavailable", "Push target registration is not available over this RPC transport"),
			);
		}
		return pushTargets.register(input);
	},
	accept: (result) => ({ result }),
});

export const unregisterWorkspaceIntent = defineIntent({
	name: "unregister_workspace",
	label: "Unregister workspace",
	description: "Remove this workspace from the host's registered workspaces",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: ["workspace.manage.v1"],
	whileBusy: "run",
	confirm: { destructive: true },
	available: workspaceAvailability("unregister"),
	async run(ctx, input) {
		const { name, operation } = workspaceService(ctx, "unregister");
		if (input.workspaceName !== name) throw new IntentRejectedError("invalid_input", "session_mismatch");
		await operation();
		return { workspaceName: name, unregistered: true as const };
	},
	accept: (result) => ({ result }),
});

const worktreesManage = ["worktrees.manage.v1"] as const;

export const createWorktreeIntent = defineIntent({
	name: "create_worktree",
	label: "New worktree",
	description: "Create a daemon-managed git worktree of this workspace",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: worktreesManage,
	whileBusy: "run",
	available: workspaceAvailability("createWorktree"),
	async run(ctx, input) {
		const worktree = await workspaceService(ctx, "createWorktree").operation({
			...(input.worktreeName === undefined ? {} : { id: input.worktreeName }),
			...(input.branch === undefined ? {} : { branch: input.branch }),
			...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
			...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
		});
		return { worktree };
	},
	accept: (result) => ({ result }),
});

export const removeWorktreeIntent = defineIntent({
	name: "remove_worktree",
	label: "Remove worktree",
	description: "Remove a daemon-managed worktree; force discards uncommitted or unmerged work",
	category: "host",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: worktreesManage,
	whileBusy: "run",
	confirm: { destructive: true },
	available: workspaceAvailability("removeWorktree"),
	async run(ctx, input) {
		const removed = await workspaceService(ctx, "removeWorktree").operation(input.worktreeId, input.force === true);
		return {
			worktreeId: input.worktreeId,
			removed: true as const,
			stoppedRuntimeCount: removed.stoppedRuntimeCount,
			closedStreamCount: removed.closedStreamCount,
		};
	},
	accept: (result) => ({ result }),
});

export const preparePrReviewIntent = defineIntent({
	name: "prepare_pr_review",
	label: "Prepare pull request review",
	description: "Check out a pull request in an isolated worktree session for review",
	category: "review",
	scope: "host",
	fence: "none",
	remote: "safe",
	requires: ["conversation.control.v1", "worktrees.manage.v1"],
	whileBusy: "run",
	available: workspaceAvailability("preparePrReview"),
	run: (ctx, input) => workspaceService(ctx, "preparePrReview").operation(input),
	accept: (result) => ({ result }),
});

// ============================================================================
// MCP servers
// ============================================================================

/** The MCP manager of the conversation's host, or an error when MCP is not configured. */
export function mcpManagerOf(ctx: IntentContext): McpManager {
	const manager = ctx.target?.session.getMcpManager();
	if (!manager) throw new Error("MCP is not configured");
	return manager;
}

const mcp = {
	category: "mcp",
	scope: "host",
	fence: "none",
	requires: integrations,
	whileBusy: "run",
} as const;

export const mcpConnectIntent = defineIntent({
	...mcp,
	name: "mcp.connect",
	label: "Connect MCP server",
	remote: "safe",
	async run(ctx, input) {
		return { server: (await mcpManagerOf(ctx).connectServer(input.server)).server };
	},
	accept: (result) => ({ result }),
});

export const mcpRefreshIntent = defineIntent({
	...mcp,
	name: "mcp.refresh",
	label: "Refresh MCP server",
	remote: "safe",
	async run(ctx, input) {
		return { server: (await mcpManagerOf(ctx).connectServer(input.server)).server };
	},
	accept: (result) => ({ result }),
});

export const mcpDisconnectIntent = defineIntent({
	...mcp,
	name: "mcp.disconnect",
	label: "Disconnect MCP server",
	remote: "safe",
	async run(ctx, input) {
		return { server: (await mcpManagerOf(ctx).disconnectServer(input.server)).server };
	},
	accept: (result) => ({ result }),
});

export const mcpSetEnabledIntent = defineIntent({
	...mcp,
	name: "mcp.set_enabled",
	label: "Enable MCP server",
	remote: "safe",
	async run(ctx, input) {
		const result = await mcpManagerOf(ctx).setServerEnabled(input.server, input.enabled);
		return { server: result.server, ...(result.persisted ? { persisted: result.persisted } : {}) };
	},
	accept: (result) => ({ result }),
});

/** Device-code sign-in: the user approves on any device, so remote clients may start it. */
export const mcpAuthStartDeviceIntent = defineIntent({
	...mcp,
	name: "mcp.auth_start_device",
	label: "Sign in to MCP server (device code)",
	remote: "safe",
	run: (ctx, input) => mcpManagerOf(ctx).startServerAuth(input.server, { flow: "device" }),
	accept: (result) => ({ result: result as never }),
});

/** Browser sign-in redirects to a callback on the host, so only local clients start it. */
export const mcpAuthStartBrowserIntent = defineIntent({
	...mcp,
	name: "mcp.auth_start_browser",
	label: "Sign in to MCP server (browser)",
	remote: "unsafe",
	run: (ctx, input) =>
		mcpManagerOf(ctx).startServerAuth(input.server, {
			flow: "browser",
			...(input.redirectUrl === undefined ? {} : { redirectUrl: input.redirectUrl }),
		}),
	accept: (result) => ({ result: result as never }),
});

export const mcpAuthCompleteIntent = defineIntent({
	...mcp,
	name: "mcp.auth_complete",
	label: "Complete MCP sign-in",
	remote: "unsafe",
	run: (ctx, input) =>
		mcpManagerOf(ctx).completeServerBrowserAuth(input.server, {
			redirectUrl: input.redirectUrl,
			code: input.code,
			state: input.state,
		}),
	accept: (result) => ({ result: result as never }),
});

export const mcpAuthPollIntent = defineIntent({
	...mcp,
	name: "mcp.auth_poll",
	label: "Check MCP sign-in",
	remote: "safe",
	run: (ctx, input) => mcpManagerOf(ctx).pollServerAuth(input.server),
	accept: (result) => ({ result: result as never }),
});

export const mcpAuthCancelIntent = defineIntent({
	...mcp,
	name: "mcp.auth_cancel",
	label: "Cancel MCP sign-in",
	remote: "safe",
	run: async (ctx, input) => mcpManagerOf(ctx).cancelServerAuth(input.server),
	accept: (result) => ({ result: result as never }),
});

export const mcpLogoutIntent = defineIntent({
	...mcp,
	name: "mcp.logout",
	label: "Sign out of MCP server",
	remote: "safe",
	confirm: { destructive: true },
	run: (ctx, input) => mcpManagerOf(ctx).logoutServer(input.server),
	accept: (result) => ({ result: result as never }),
});
