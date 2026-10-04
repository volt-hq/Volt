/**
 * Authorization parity between the intent and query registries and the
 * remote access rules the legacy wire enforces today: every command and UI
 * action a paired device can send keeps exactly its capability requirements
 * and remote safety. An intent or query is allowed for a remote profile iff it
 * is remote-safe and its `requires` is within the grant.
 *
 * The oracle is a frozen copy of the legacy rules (access-grant.ts,
 * rpc-command-filter.ts, and host-actions.ts at 31ad0fe83). The test also
 * checks that the live legacy filters still equal the copy, so the registry,
 * the copy, and the production filters agree until the protocol cut-over
 * deletes the filters.
 */

import {
	type BuiltinIntentName,
	INTENT_SCHEMAS,
	QUERY_NAMES,
	REMOTE_CAPABILITIES,
	type RemoteCapability,
	type RemoteGrant,
	RPC_COMMAND_SCHEMAS,
} from "@hansjm10/volt-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	IDLE_INTENT_STATE,
	type IntentContext,
	IntentRejectedError,
	type IntentTarget,
	intentRegistry,
} from "../../src/core/protocol/intents/index.ts";
import {
	type DeferredQueryName,
	QueryRejectedError,
	queryRegistry,
	type RegisteredQueryName,
} from "../../src/core/protocol/queries/index.ts";
import {
	createIrohRemoteRpcGrant,
	getIrohRemoteRpcCommandCapabilities,
} from "../../src/core/remote/iroh/access-grant.ts";
import {
	getIrohRemoteRpcFilterResult,
	getStaticIrohRemoteRpcFilterResult,
	IROH_REMOTE_RPC_PASSTHROUGH_TYPES,
} from "../../src/core/remote/iroh/rpc-command-filter.ts";
import {
	isReviewDiscussionHostActionAllowed,
	REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE,
} from "../../src/core/review-discussion-policy.ts";
import {
	getBuiltinUiActionIntent,
	isRemoteSafeBuiltinUiAction,
	listBuiltinUiActionIds,
} from "../../src/core/rpc/ui-actions.ts";
import { handleRpcCommand, type RpcCommandDispatcherContext } from "../../src/modes/rpc/rpc-command-dispatcher.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";

// ============================================================================
// Frozen oracle: the legacy remote access rules
// ============================================================================

const OBSERVE: RemoteCapability = "conversation.observe.v1";
const CONTROL: RemoteCapability = "conversation.control.v1";

const LEGACY_BASELINE = new Set(["register_push_target"]);
const LEGACY_OBSERVE = new Set([
	"list_jobs",
	"read_job",
	"get_state",
	"get_transcript",
	"get_session_tree",
	"get_review_result",
	"resolve_pr_review",
	"get_review_general",
	"list_review_workflows",
	"list_review_discussions",
	"get_review_discussion_source",
	"report_stream_discontinuity",
	"get_message_images",
	"get_transcript_entry_text",
	"get_ui_capabilities",
	"get_ui_actions",
	"get_ui_action_completions",
	"list_sessions",
	"get_session_contexts",
	"list_worktrees",
	"list_workspace_directories",
	"get_keep_awake",
]);
const LEGACY_CONTROL = new Set([
	"cancel_job",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"switch_session_by_id",
	"invoke_ui_action",
	"cancel_workflow",
	"open_review_session",
	"start_review_discussions",
	"reset_review_discussion",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"extension_ui_response",
]);
const LEGACY_MCP = new Set([
	"get_mcp_capabilities",
	"list_mcp_servers",
	"get_mcp_server",
	"connect_mcp_server",
	"refresh_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_recent_calls",
	"list_mcp_tools",
	"get_mcp_tool",
	"list_mcp_resources",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
	"disconnect_mcp_server",
	"start_mcp_server_auth",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"set_web_search_key",
	"get_web_search_status",
]);
const LEGACY_HOST = new Set([
	"get_pending_host_actions",
	"get_subscription_usage",
	"host_action_response",
	"set_keep_awake",
]);

function legacyRequires(command: Record<string, unknown> & { type: string }): readonly RemoteCapability[] | undefined {
	if (command.type === "set_client_capabilities") {
		return Array.isArray(command.features) && command.features.includes("host_action_requests.v1")
			? ["host.manage.v1"]
			: [];
	}
	if (LEGACY_BASELINE.has(command.type)) return [];
	if (LEGACY_OBSERVE.has(command.type)) return [OBSERVE];
	if (LEGACY_CONTROL.has(command.type)) return [CONTROL];
	if (LEGACY_MCP.has(command.type)) return ["integrations.manage.v1"];
	if (LEGACY_HOST.has(command.type)) return ["host.manage.v1"];
	if (command.type === "get_available_models") return ["model.select.v1"];
	if (command.type === "set_model" || command.type === "set_thinking_level") {
		return command.persistDefault === false ? ["model.select.v1"] : ["model.select.v1", "host.manage.v1"];
	}
	if (command.type === "prepare_pr_review") return [CONTROL, "worktrees.manage.v1"];
	if (command.type === "create_worktree" || command.type === "remove_worktree") return ["worktrees.manage.v1"];
	if (command.type === "get_agent_options") return ["model.select.v1"];
	if (command.type === "unregister_workspace") return ["workspace.manage.v1"];
	if (command.type === "upload_device_logs") return ["diagnostics.upload.v1"];
	return undefined;
}

/** Conversation-stream commands the legacy filter passes through to the host. */
const LEGACY_PASSTHROUGH = [
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"cancel_job",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"set_client_capabilities",
	"report_stream_discontinuity",
	"get_pending_host_actions",
	"host_action_response",
	"get_state",
	"list_jobs",
	"read_job",
	"get_transcript",
	"get_subscription_usage",
	"get_message_images",
	"get_transcript_entry_text",
	"get_mcp_capabilities",
	"list_mcp_servers",
	"get_mcp_server",
	"connect_mcp_server",
	"refresh_mcp_server",
	"set_mcp_server_enabled",
	"list_mcp_recent_calls",
	"list_mcp_tools",
	"get_mcp_tool",
	"list_mcp_resources",
	"read_mcp_resource",
	"list_mcp_prompts",
	"get_mcp_prompt",
	"disconnect_mcp_server",
	"poll_mcp_server_auth",
	"cancel_mcp_server_auth",
	"logout_mcp_server",
	"get_ui_capabilities",
	"get_ui_actions",
	"cancel_workflow",
	"get_review_result",
	"get_review_general",
	"list_review_workflows",
	"open_review_session",
	"start_review_discussions",
	"list_review_discussions",
	"reset_review_discussion",
	"get_review_discussion_source",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"list_sessions",
	"get_session_contexts",
	"switch_session_by_id",
	"register_push_target",
	"unregister_workspace",
	"create_worktree",
	"list_worktrees",
	"set_keep_awake",
	"get_keep_awake",
	"set_web_search_key",
	"get_web_search_status",
	"upload_device_logs",
	"extension_ui_response",
	"get_available_models",
	"set_model",
	"set_thinking_level",
];

/** Commands only workspace discovery and management streams serve, each gated by its capability. */
const LEGACY_WORKSPACE_STREAM_COMMANDS = [
	"get_agent_options",
	"get_session_contexts",
	"resolve_pr_review",
	"list_sessions",
	"unregister_workspace",
	"list_workspace_directories",
	"create_worktree",
	"list_worktrees",
	"remove_worktree",
	"prepare_pr_review",
];

const LEGACY_REMOTE_SAFE_UI_ACTIONS = new Set([
	"context.auto_compaction",
	"context.compaction_threshold",
	"session.new",
	"run.cancel",
	"thinking.fast_mode",
	"agent.mode",
	"plan.execute",
	"plan.change",
	"plan.discard",
	"review.uncommitted",
	"review.branch",
	"review.pr",
	"review.commit",
	"review.fix",
	"review.feedback",
	"review.rerun",
	"review.publish",
]);
const LEGACY_LOCAL_UI_ACTIONS = ["context.compact", "session.rename", "review.export_feedback"];

/** Remote commands that required generation-bound conversation authority. */
const LEGACY_AUTHORITY_COMMANDS = new Set([
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"cancel_job",
	"new_session",
	"set_agent_mode",
	"plan_execute",
	"plan_change",
	"plan_discard",
	"switch_session_by_id",
	"set_model",
	"set_thinking_level",
	"invoke_ui_action",
	"open_review_session",
	"start_review_discussions",
	"reset_review_discussion",
	"acknowledge_review",
]);

/** Commands a review discussion leaves to its source review. */
const LEGACY_SOURCE_OWNED_COMMANDS = new Set([
	"new_session",
	"switch_session",
	"switch_session_by_id",
	"fork",
	"clone",
	"open_review_session",
	"acknowledge_review",
	"record_review_finding_outcome",
	"rerun_review",
	"publish_review",
	"export_review_feedback",
]);

// ============================================================================
// The mapping from legacy commands to intents and queries
// ============================================================================

type Mapping =
	| { readonly intents: readonly BuiltinIntentName[] }
	| { readonly queries: readonly RegisteredQueryName[] }
	/** Served later from the projected log; the requirement the query will carry. */
	| { readonly deferred: DeferredQueryName; readonly requires: readonly RemoteCapability[] }
	/** Replaced by a frame, the subscription, or a catalog field; never an intent or query. */
	| { readonly removed: string };

const intents = (...names: BuiltinIntentName[]): Mapping => ({ intents: names });
const queries = (...names: RegisteredQueryName[]): Mapping => ({ queries: names });
const removed = (replacement: string): Mapping => ({ removed: replacement });

/** Every legacy command a client can send, by type; command-sensitive commands map per variant below. */
const LEGACY_COMMANDS: Readonly<Record<string, Mapping>> = {
	prompt: intents("prompt"),
	steer: intents("steer"),
	follow_up: intents("follow_up"),
	abort: intents("abort"),
	new_session: intents("new_session"),
	set_agent_mode: intents("set_agent_mode"),
	plan_execute: intents("plan_execute"),
	plan_change: intents("plan_change"),
	plan_discard: intents("plan_discard"),
	set_client_capabilities: removed("hello.accepts"),
	get_pending_host_actions: removed("host request replay"),
	report_stream_discontinuity: removed("resume by ordinal"),
	get_ui_capabilities: removed("welcome"),
	get_ui_actions: queries("intents"),
	get_ui_action_completions: queries("intent_completions"),
	invoke_ui_action: removed("the action's intent (checked per action below)"),
	resolve_pr_review: queries("pr_review"),
	prepare_pr_review: intents("prepare_pr_review"),
	start_review_discussions: intents("review_start_discussions"),
	list_review_discussions: queries("review.discussions"),
	reset_review_discussion: intents("review_reset_discussion"),
	get_review_discussion_source: queries("review.discussion_source"),
	get_review_general: queries("review.general"),
	cancel_workflow: intents("review_cancel_workflow"),
	get_review_result: queries("review.result"),
	list_review_workflows: queries("review.workflows"),
	open_review_session: intents("review_open_session"),
	acknowledge_review: intents("review_acknowledge"),
	record_review_finding_outcome: intents("review_record_finding_outcome"),
	rerun_review: intents("review_rerun"),
	publish_review: intents("review_publish"),
	export_review_feedback: intents("review_export_feedback"),
	register_push_target: intents("register_push_target"),
	unregister_workspace: intents("unregister_workspace"),
	set_keep_awake: intents("set_keep_awake"),
	get_keep_awake: queries("host_status"),
	set_web_search_key: intents("set_web_search_key"),
	get_web_search_status: queries("web_search_status"),
	get_agent_options: queries("agent_options"),
	get_session_contexts: queries("session_contexts"),
	upload_device_logs: intents("upload_device_logs"),
	get_mcp_capabilities: queries("mcp.capabilities"),
	list_mcp_servers: queries("mcp.servers"),
	get_mcp_server: queries("mcp.server"),
	connect_mcp_server: intents("mcp.connect"),
	disconnect_mcp_server: intents("mcp.disconnect"),
	refresh_mcp_server: intents("mcp.refresh"),
	start_mcp_server_auth: removed("mcp.auth_start_device or mcp.auth_start_browser (checked per flow below)"),
	complete_mcp_server_auth: intents("mcp.auth_complete"),
	poll_mcp_server_auth: intents("mcp.auth_poll"),
	cancel_mcp_server_auth: intents("mcp.auth_cancel"),
	logout_mcp_server: intents("mcp.logout"),
	set_mcp_server_enabled: intents("mcp.set_enabled"),
	list_mcp_tools: queries("mcp.tools"),
	get_mcp_tool: queries("mcp.tool"),
	list_mcp_resources: queries("mcp.resources"),
	read_mcp_resource: queries("mcp.resource"),
	list_mcp_prompts: queries("mcp.prompts"),
	get_mcp_prompt: queries("mcp.prompt"),
	list_mcp_recent_calls: queries("mcp.recent_calls"),
	get_state: removed("snapshot"),
	get_transcript: removed("snapshot and history"),
	get_session_tree: removed("snapshot"),
	get_message_images: { deferred: "content", requires: [OBSERVE] },
	get_transcript_entry_text: { deferred: "content", requires: [OBSERVE] },
	list_jobs: removed("live jobs"),
	read_job: queries("job_output"),
	cancel_job: intents("cancel_job"),
	list_subagents: queries("subagent_definitions"),
	subagent_start: intents("subagent_start"),
	subagent_abort: intents("subagent_abort"),
	subagent_get_state: removed("subscribe to the child conversation"),
	subagent_get_transcript: removed("subscribe to the child conversation"),
	subagent_dispose: intents("subagent_dispose"),
	set_model: removed("set_model and set_default_model (checked per persistDefault below)"),
	cycle_model: removed("models.cycleScope and set_model"),
	get_available_models: queries("models"),
	set_thinking_level: removed("set_thinking_level and set_default_thinking_level (checked per persistDefault below)"),
	cycle_thinking_level: removed("models availableThinkingLevels and set_thinking_level"),
	set_steering_mode: intents("set_steering_mode"),
	set_follow_up_mode: intents("set_follow_up_mode"),
	compact: intents("compact"),
	set_auto_compaction: intents("set_auto_compaction"),
	set_auto_retry: intents("set_auto_retry"),
	abort_retry: intents("abort_retry"),
	bash: intents("bash"),
	abort_bash: intents("abort_bash"),
	get_session_stats: removed("live usage"),
	get_subscription_usage: queries("subscription_usage"),
	list_sessions: queries("sessions"),
	export_html: intents("export_html"),
	switch_session: intents("switch_session"),
	switch_session_by_id: intents("switch_session"),
	fork: intents("fork"),
	clone: intents("clone"),
	get_fork_messages: removed("snapshot"),
	get_last_assistant_text: removed("snapshot"),
	set_session_name: intents("set_session_name"),
	get_messages: removed("snapshot"),
	get_commands: removed("the intents query's dynamic descriptors"),
	// Remote-only commands outside the RPC contract.
	create_worktree: intents("create_worktree"),
	list_worktrees: queries("worktrees"),
	remove_worktree: intents("remove_worktree"),
	list_workspace_directories: queries("workspace_directories"),
	extension_ui_response: removed("host_response"),
	host_action_response: removed("host_response"),
};

/** Command variants whose mapping depends on their payload. */
const VARIANTS: ReadonlyArray<{ command: Record<string, unknown> & { type: string }; mapping: Mapping }> = [
	{ command: { type: "set_model", persistDefault: false }, mapping: intents("set_model") },
	{ command: { type: "set_model", persistDefault: true }, mapping: intents("set_model", "set_default_model") },
	{ command: { type: "set_model" }, mapping: intents("set_model", "set_default_model") },
	{ command: { type: "set_thinking_level", persistDefault: false }, mapping: intents("set_thinking_level") },
	{
		command: { type: "set_thinking_level", persistDefault: true },
		mapping: intents("set_thinking_level", "set_default_thinking_level"),
	},
	{ command: { type: "set_thinking_level" }, mapping: intents("set_thinking_level", "set_default_thinking_level") },
	{ command: { type: "start_mcp_server_auth", flow: "device" }, mapping: intents("mcp.auth_start_device") },
	{ command: { type: "start_mcp_server_auth", flow: "browser" }, mapping: intents("mcp.auth_start_browser") },
	{ command: { type: "start_mcp_server_auth" }, mapping: intents("mcp.auth_start_browser") },
];

/**
 * Typed aliases merged into an intent another legacy command already reached
 * remotely with the same handler and requirements: the alias name itself was
 * not passed through.
 */
const MERGED_ALIASES: Readonly<Record<string, string>> = { switch_session: "switch_session_by_id" };

/**
 * Typed commands whose intent is remote-safe only with input the typed
 * command cannot carry: a remote `set_auto_compaction` must name the model and
 * settings profile it targets, as the UI action always did.
 */
const GUARDED_INTENTS: ReadonlySet<string> = new Set(["set_auto_compaction"]);

// ============================================================================
// Registry decisions
// ============================================================================

function mappedRequires(mapping: Mapping): readonly RemoteCapability[] | undefined {
	if ("intents" in mapping) return unionRequires(mapping.intents.map((name) => intentRegistry.get(name).requires));
	if ("queries" in mapping) return unionRequires(mapping.queries.map((name) => queryRegistry.get(name).requires));
	if ("deferred" in mapping) return mapping.requires;
	return undefined;
}

function unionRequires(lists: readonly (readonly RemoteCapability[])[]): RemoteCapability[] {
	const union: RemoteCapability[] = [];
	for (const list of lists) for (const capability of list) if (!union.includes(capability)) union.push(capability);
	return union;
}

function mappedRemoteSafe(mapping: Mapping): boolean | undefined {
	if ("intents" in mapping) return mapping.intents.every((name) => intentRegistry.get(name).remote === "safe");
	if ("queries" in mapping) return mapping.queries.every((name) => queryRegistry.get(name).remote === "safe");
	if ("deferred" in mapping) return true;
	return undefined;
}

function remoteContext(grant: RemoteGrant): IntentContext {
	return { services: {}, profile: { name: "remote", grant } };
}

/** The registry's profile admission for a mapping: allowed, or the first missing capability. */
async function registryDecision(
	mapping: Mapping,
	grant: RemoteGrant,
): Promise<"allowed" | RemoteCapability | "unsafe"> {
	const ctx = remoteContext(grant);
	const names = "intents" in mapping ? mapping.intents : "queries" in mapping ? mapping.queries : [];
	for (const name of names) {
		try {
			if ("intents" in mapping) {
				intentRegistry.prepareFrame(ctx, name, {});
			} else {
				await queryRegistry.runFrame(ctx, name, {});
			}
		} catch (error) {
			if (
				(error instanceof IntentRejectedError || error instanceof QueryRejectedError) &&
				error.code === "not_allowed"
			) {
				return error.requiredCapability ?? "unsafe";
			}
		}
	}
	return "allowed";
}

/** The legacy decision: the conversation-stream filter, or the capability gate of workspace streams. */
function legacyDecision(
	command: Record<string, unknown> & { type: string },
	grant: RemoteGrant,
): "allowed" | RemoteCapability | "unsafe" {
	if (LEGACY_WORKSPACE_STREAM_COMMANDS.includes(command.type)) {
		const required = legacyRequires(command) ?? [];
		return required.find((capability) => !grant.capabilities.includes(capability)) ?? "allowed";
	}
	const result = getIrohRemoteRpcFilterResult(JSON.stringify({ id: "parity", ...command }), grant);
	if (result.allowed) return "allowed";
	const error = result.response.error;
	return typeof error === "object" ? error.requiredCapability : "unsafe";
}

/** Every grant: each subset of the remote capabilities. */
function everyGrant(): RemoteGrant[] {
	const grants: RemoteGrant[] = [];
	for (let mask = 0; mask < 1 << REMOTE_CAPABILITIES.length; mask++) {
		grants.push(
			createIrohRemoteRpcGrant(REMOTE_CAPABILITIES.filter((_capability, index) => (mask & (1 << index)) !== 0)),
		);
	}
	return grants;
}

const mapped = (type: string): Mapping => {
	const mapping = LEGACY_COMMANDS[type];
	if (!mapping) throw new Error(`No mapping for legacy command ${type}`);
	return mapping;
};

const remoteCommands = [...new Set([...LEGACY_PASSTHROUGH, ...LEGACY_WORKSPACE_STREAM_COMMANDS])];

// ============================================================================
// Tests
// ============================================================================

describe("intent and query registries cover the protocol", () => {
	it("defines every built-in intent and every query but the projected-log reads", () => {
		expect(intentRegistry.names().sort()).toEqual(Object.keys(INTENT_SCHEMAS).sort());
		expect(queryRegistry.names().sort()).toEqual(
			QUERY_NAMES.filter((name) => name !== "history" && name !== "content").sort(),
		);
	});

	it("maps every legacy command, and nothing else", () => {
		const legacyTypes = [
			...Object.keys(RPC_COMMAND_SCHEMAS),
			"create_worktree",
			"list_worktrees",
			"remove_worktree",
			"list_workspace_directories",
			"extension_ui_response",
			"host_action_response",
		];
		expect(Object.keys(LEGACY_COMMANDS).sort()).toEqual([...new Set(legacyTypes)].sort());
	});
});

describe("the live legacy filters still equal the frozen oracle", () => {
	it("keeps the passthrough allowlist", () => {
		expect([...IROH_REMOTE_RPC_PASSTHROUGH_TYPES]).toEqual(LEGACY_PASSTHROUGH);
	});

	it("keeps every command's capability classification", () => {
		const commands = [
			...Object.keys(LEGACY_COMMANDS).map((type) => ({ type })),
			...VARIANTS.map((variant) => variant.command),
			{ type: "set_client_capabilities", features: ["host_action_requests.v1"] },
		];
		for (const command of commands) {
			expect(getIrohRemoteRpcCommandCapabilities(command), command.type).toEqual(legacyRequires(command));
		}
	});

	it("keeps the remote-safe built-in UI actions", () => {
		for (const action of [...LEGACY_REMOTE_SAFE_UI_ACTIONS, ...LEGACY_LOCAL_UI_ACTIONS]) {
			const result = getStaticIrohRemoteRpcFilterResult(
				JSON.stringify({ id: `${action}-1`, type: "invoke_ui_action", action }),
			);
			expect(result.allowed, action).toBe(LEGACY_REMOTE_SAFE_UI_ACTIONS.has(action));
		}
	});
});

describe("commands keep their capability requirements", () => {
	it("requires exactly the legacy capabilities for every command an intent or query serves", () => {
		for (const [type, mapping] of Object.entries(LEGACY_COMMANDS)) {
			const requires = mappedRequires(mapping);
			if (requires === undefined) continue;
			const legacy = legacyRequires({ type });
			if (legacy === undefined) {
				// Never classified because never served remotely: its intent stays local.
				if (!(type in MERGED_ALIASES) && !GUARDED_INTENTS.has(type))
					expect(mappedRemoteSafe(mapping), type).toBe(false);
				continue;
			}
			expect(requires, type).toEqual(legacy);
		}
		for (const { command, mapping } of VARIANTS) {
			expect(mappedRequires(mapping), JSON.stringify(command)).toEqual(legacyRequires(command));
		}
	});

	it("requires control for every built-in UI action, as invoke_ui_action did", () => {
		for (const action of listBuiltinUiActionIds()) {
			const intent = getBuiltinUiActionIntent(action);
			expect(intent, action).toBeDefined();
			expect(intentRegistry.get(intent as BuiltinIntentName).requires, action).toEqual(
				legacyRequires({ type: "invoke_ui_action" }),
			);
		}
	});
});

describe("commands keep their remote safety", () => {
	it("serves a command remotely iff the legacy filter passed it", () => {
		for (const type of Object.keys(LEGACY_COMMANDS)) {
			const safe = mappedRemoteSafe(mapped(type));
			if (safe === undefined || type in MERGED_ALIASES || GUARDED_INTENTS.has(type)) continue;
			// Completions passed per action id, like invocations.
			expect(safe, type).toBe(remoteCommands.includes(type) || type === "get_ui_action_completions");
		}
		for (const { command, mapping } of VARIANTS) {
			const legacyAllowed = getStaticIrohRemoteRpcFilterResult(JSON.stringify({ id: "v", ...command })).allowed;
			expect(mappedRemoteSafe(mapping), JSON.stringify(command)).toBe(legacyAllowed);
		}
	});

	it("merges a denied alias only into an intent its allowed twin reached", () => {
		for (const [alias, twin] of Object.entries(MERGED_ALIASES)) {
			expect(remoteCommands.includes(alias), alias).toBe(false);
			expect(remoteCommands.includes(twin), twin).toBe(true);
			expect(mapped(alias)).toEqual(mapped(twin));
			expect(legacyRequires({ type: alias })).toBeUndefined();
		}
	});

	it("rejects a guarded intent remotely without the target the typed command cannot carry", () => {
		const full = createIrohRemoteRpcGrant(REMOTE_CAPABILITIES);
		const view = { state: IDLE_INTENT_STATE, services: {}, profile: { name: "remote" as const, grant: full } };
		const definition = intentRegistry.get("set_auto_compaction");
		expect(remoteCommands.includes("set_auto_compaction")).toBe(false);
		expect(intentRegistry.availability(definition, view, { enabled: true })).toMatchObject({
			enabled: false,
			code: "invalid_input",
		});
		expect(
			intentRegistry.availability(definition, { ...view, profile: { name: "local" } }, { enabled: true }),
		).toEqual({ enabled: true });
	});

	it("keeps every built-in UI action's remote safety", () => {
		expect(listBuiltinUiActionIds().sort()).toEqual(
			[...LEGACY_REMOTE_SAFE_UI_ACTIONS, ...LEGACY_LOCAL_UI_ACTIONS].sort(),
		);
		for (const action of listBuiltinUiActionIds()) {
			expect(isRemoteSafeBuiltinUiAction(action), action).toBe(LEGACY_REMOTE_SAFE_UI_ACTIONS.has(action));
		}
	});
});

describe("the remote profile decides exactly as the legacy filters", () => {
	it("allows or denies every remote command for every grant, naming the same missing capability", async () => {
		const grants = everyGrant();
		const cases = [
			...remoteCommands
				.filter((type) => !VARIANTS.some((variant) => variant.command.type === type))
				.map((type) => ({ command: { type }, mapping: mapped(type) })),
			...VARIANTS,
		].filter(({ mapping }) => "intents" in mapping || "queries" in mapping);
		expect(cases.length).toBeGreaterThan(60);
		for (const { command, mapping } of cases) {
			for (const grant of grants) {
				expect(await registryDecision(mapping, grant), `${JSON.stringify(command)} ${grant.capabilities}`).toEqual(
					legacyDecision(command, grant),
				);
			}
		}
	});

	it("decides every built-in UI action for every grant as invoke_ui_action did", async () => {
		for (const action of listBuiltinUiActionIds()) {
			const mapping = intents(getBuiltinUiActionIntent(action) as BuiltinIntentName);
			for (const grant of everyGrant()) {
				expect(await registryDecision(mapping, grant), `${action} ${grant.capabilities}`).toEqual(
					legacyDecision({ type: "invoke_ui_action", action }, grant),
				);
			}
		}
	});

	it("decides completions of every built-in UI action for every grant as get_ui_action_completions did", async () => {
		// A conversation with an empty extension, prompt, and skill catalog.
		const target = {
			session: {
				sessionManager: { getCwd: () => "/nonexistent-volt-parity" },
				extensionRunner: { getRegisteredCommands: () => [] },
				promptTemplates: [],
				resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
			},
		} as unknown as IntentTarget;
		for (const action of listBuiltinUiActionIds()) {
			const intent = getBuiltinUiActionIntent(action) as BuiltinIntentName;
			for (const grant of everyGrant()) {
				let decision: "allowed" | RemoteCapability | "unsafe" = "allowed";
				try {
					await queryRegistry.run(
						{ target, services: {}, profile: { name: "remote", grant } },
						"intent_completions",
						{
							intent,
							field: "base",
						},
					);
				} catch (error) {
					if (!(error instanceof IntentRejectedError || error instanceof QueryRejectedError)) throw error;
					decision = error.requiredCapability ?? "unsafe";
				}
				const legacy = legacyDecision({ type: "get_ui_action_completions", action, argument: "base" }, grant);
				// The completion query's own capability is checked before the intent's remote safety.
				if (legacy === "unsafe") expect(decision, `${action} ${grant.capabilities}`).not.toBe("allowed");
				else expect(decision, `${action} ${grant.capabilities}`).toEqual(legacy);
			}
		}
	});
});

describe("branch fences and review-discussion boundaries carry over", () => {
	it("fences every remote-safe conversation intent a legacy path fenced, and no other", () => {
		const fencedByLegacy = new Set<BuiltinIntentName>();
		for (const type of LEGACY_AUTHORITY_COMMANDS) {
			const mapping = mapped(type);
			if ("intents" in mapping) for (const name of mapping.intents) fencedByLegacy.add(name);
		}
		for (const { command, mapping } of VARIANTS) {
			if (LEGACY_AUTHORITY_COMMANDS.has(command.type) && "intents" in mapping) {
				for (const name of mapping.intents) fencedByLegacy.add(name);
			}
		}
		// invoke_ui_action required authority for every action.
		for (const action of LEGACY_REMOTE_SAFE_UI_ACTIONS)
			fencedByLegacy.add(getBuiltinUiActionIntent(action) as BuiltinIntentName);
		for (const name of intentRegistry.names()) {
			const definition = intentRegistry.get(name);
			if (definition.remote !== "safe" || definition.scope === "host") {
				if (definition.scope === "host") expect(definition.fence, name).toBe("none");
				continue;
			}
			expect(definition.fence, name).toBe(fencedByLegacy.has(name) ? "branch" : "none");
		}
	});

	it("leaves exactly the source-owned lifecycle operations to a review discussion's source", () => {
		const sourceOwned = (name: BuiltinIntentName, input?: unknown): boolean => {
			const availability = intentRegistry.availability(
				intentRegistry.get(name),
				{ state: { ...IDLE_INTENT_STATE, isReviewDiscussion: true }, services: {}, profile: { name: "local" } },
				input,
			);
			return !availability.enabled && availability.reason === REVIEW_DISCUSSION_SOURCE_ACTION_MESSAGE;
		};
		for (const [type, mapping] of Object.entries(LEGACY_COMMANDS)) {
			if (!("intents" in mapping) || type === "plan_execute") continue;
			for (const name of mapping.intents) {
				expect(sourceOwned(name, {}), `${type} -> ${name}`).toBe(LEGACY_SOURCE_OWNED_COMMANDS.has(type));
			}
		}
		for (const action of listBuiltinUiActionIds()) {
			if (action === "plan.execute") continue;
			const name = getBuiltinUiActionIntent(action) as BuiltinIntentName;
			expect(sourceOwned(name, {}), action).toBe(!isReviewDiscussionHostActionAllowed(action, {}));
		}
		expect(sourceOwned("plan_execute", { strategy: "new_session" })).toBe(true);
		expect(sourceOwned("plan_execute", { strategy: "retain_context" })).toBe(false);
	});
});

describe("the dispatcher runs each command through the intents and queries the parity rests on", () => {
	/** A minimal valid payload for every command the RPC dispatcher serves through the registries. */
	const SAMPLES: ReadonlyArray<Record<string, unknown> & { type: string }> = [
		{ type: "prompt", clientMessageId: "c", message: "m" },
		{ type: "steer", clientMessageId: "c", message: "m" },
		{ type: "follow_up", clientMessageId: "c", message: "m" },
		{ type: "abort" },
		{ type: "new_session" },
		{ type: "set_agent_mode", mode: "plan" },
		{ type: "plan_execute", planId: "p", expectedRevision: 1, strategy: "retain_context" },
		{ type: "plan_change", planId: "p", expectedRevision: 1 },
		{ type: "plan_discard", planId: "p", expectedRevision: 1 },
		{ type: "start_review_discussions", runId: "r", findingIds: ["f"], requestId: "q" },
		{ type: "list_review_discussions", runId: "r" },
		{ type: "reset_review_discussion", discussionId: "d", expectedSessionId: "s", requestId: "q" },
		{ type: "get_review_discussion_source" },
		{ type: "get_review_general", runId: "r" },
		{ type: "cancel_workflow", workflowId: "w" },
		{ type: "get_review_result", runId: "r" },
		{ type: "list_review_workflows" },
		{ type: "open_review_session", runId: "r" },
		{ type: "acknowledge_review", runId: "r" },
		{ type: "record_review_finding_outcome", runId: "r", findingId: "f", status: "accepted" },
		{ type: "rerun_review", runId: "r" },
		{ type: "publish_review", runId: "r", confirmed: true },
		{ type: "export_review_feedback" },
		{
			type: "register_push_target",
			args: { provider: "fcm", platform: "ios", pushTargetId: "t", pushTargetAuthToken: "a", enabled: true },
		},
		{ type: "get_mcp_capabilities" },
		{ type: "list_mcp_servers" },
		{ type: "get_mcp_server", server: "s" },
		{ type: "connect_mcp_server", server: "s" },
		{ type: "disconnect_mcp_server", server: "s" },
		{ type: "refresh_mcp_server", server: "s" },
		{ type: "complete_mcp_server_auth", server: "s", redirectUrl: "u", code: "c" },
		{ type: "poll_mcp_server_auth", server: "s" },
		{ type: "cancel_mcp_server_auth", server: "s" },
		{ type: "logout_mcp_server", server: "s" },
		{ type: "set_mcp_server_enabled", server: "s", enabled: true },
		{ type: "list_mcp_tools", server: "s" },
		{ type: "get_mcp_tool", server: "s", tool: "t" },
		{ type: "list_mcp_resources", server: "s" },
		{ type: "read_mcp_resource", server: "s", resourceUri: "u" },
		{ type: "list_mcp_prompts", server: "s" },
		{ type: "get_mcp_prompt", server: "s", prompt: "p" },
		{ type: "list_mcp_recent_calls" },
		{ type: "read_job", jobId: "j" },
		{ type: "cancel_job", jobId: "j" },
		{ type: "list_subagents" },
		{ type: "subagent_start", agent: "a", prompt: "p" },
		{ type: "subagent_abort", subagentId: "s" },
		{ type: "subagent_dispose", subagentId: "s" },
		{ type: "get_available_models" },
		{ type: "set_steering_mode", mode: "all" },
		{ type: "set_follow_up_mode", mode: "all" },
		{ type: "compact" },
		{ type: "set_auto_compaction", enabled: true },
		{ type: "set_auto_retry", enabled: true },
		{ type: "abort_retry" },
		{ type: "bash", command: "ls" },
		{ type: "abort_bash" },
		{ type: "get_subscription_usage" },
		{ type: "list_sessions" },
		{ type: "export_html" },
		{ type: "switch_session", sessionId: "s" },
		{ type: "switch_session_by_id", sessionId: "s" },
		{ type: "fork", entryId: "e" },
		{ type: "clone" },
		{ type: "set_session_name", name: "n" },
	];
	/** Variants whose payload picks the intents. */
	const VARIANT_SAMPLES: ReadonlyArray<Record<string, unknown> & { type: string }> = [
		{ type: "set_model", provider: "p", modelId: "m", persistDefault: false },
		{ type: "set_model", provider: "p", modelId: "m", persistDefault: true },
		{ type: "set_model", provider: "p", modelId: "m" },
		{ type: "set_thinking_level", level: "low", persistDefault: false },
		{ type: "set_thinking_level", level: "low", persistDefault: true },
		{ type: "set_thinking_level", level: "low" },
		{ type: "start_mcp_server_auth", server: "s", flow: "device" },
		{ type: "start_mcp_server_auth", server: "s", flow: "browser" },
		{ type: "start_mcp_server_auth", server: "s" },
	];

	/** The intents and queries a command reached, in order, without running any of them. */
	async function reached(
		command: Record<string, unknown> & { type: string },
		state: Record<string, unknown> = {},
	): Promise<string[]> {
		const names: string[] = [];
		const stop = new Error("parity: stop before running");
		const prepared = { run: () => Promise.reject(stop) };
		const spies = [
			vi.spyOn(intentRegistry, "prepare").mockImplementation((_ctx, name) => {
				names.push(name);
				return prepared as never;
			}),
			vi.spyOn(intentRegistry, "invoke").mockImplementation(async (_ctx, name) => {
				names.push(name);
				throw stop;
			}),
			vi.spyOn(queryRegistry, "run").mockImplementation(async (_ctx, name) => {
				names.push(name);
				throw stop;
			}),
		];
		const session = { sessionId: "s", isReviewDiscussion: false, thinkingLevel: "off", ...state };
		try {
			await handleRpcCommand(
				{ id: "parity", ...command } as RpcCommand,
				{
					session,
					conversation: {},
					options: { allowUiActionInvocation: true },
					services: {},
					output: () => {},
					assertConversationGenerationCurrent: () => {},
				} as unknown as RpcCommandDispatcherContext,
			);
			// Commands that answer once their admitted run settles.
			await new Promise((resolve) => setImmediate(resolve));
		} catch (error) {
			if (error !== stop) throw error;
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		return names;
	}

	it("reaches exactly the mapped intents or queries for every command", async () => {
		for (const command of SAMPLES) {
			const mapping = mapped(command.type);
			const expected = "intents" in mapping ? mapping.intents : "queries" in mapping ? mapping.queries : [];
			expect(await reached(command), command.type).toEqual(expected);
		}
		for (const { command, mapping } of VARIANTS) {
			const sample = VARIANT_SAMPLES.find(
				(candidate) =>
					candidate.type === command.type &&
					candidate.persistDefault === command.persistDefault &&
					candidate.flow === command.flow,
			);
			expect(sample, JSON.stringify(command)).toBeDefined();
			const expected = "intents" in mapping ? mapping.intents : [];
			expect(await reached(sample!), JSON.stringify(command)).toEqual(expected);
		}
		const served = new Set([...SAMPLES, ...VARIANT_SAMPLES].map((command) => command.type));
		const dispatcherMapped = Object.entries(LEGACY_COMMANDS)
			.filter(([, mapping]) => "intents" in mapping || "queries" in mapping)
			.map(([type]) => type)
			.filter((type) => !LEGACY_WORKSPACE_STREAM_COMMANDS.includes(type) || LEGACY_PASSTHROUGH.includes(type))
			.filter((type) => !DAEMON_ONLY_COMMANDS.has(type));
		expect(dispatcherMapped.filter((type) => !served.has(type))).toEqual([]);
	});

	it("invokes each built-in UI action through its intent", async () => {
		const model = { provider: "p", id: "m" };
		const settingsManager = {
			getActiveProfile: () => undefined,
			getCompactionEnabled: () => true,
			getCompactionThresholdTokens: () => 0,
			getCompactionWriteDisabledReason: () => undefined,
		};
		const target = { provider: "p", modelId: "m", expectedProfile: "" };
		const plan = { planId: "p", expectedRevision: 1 };
		const samples: Record<string, { args: Record<string, unknown>; state?: Record<string, unknown> }> = {
			"agent.mode": { args: { mode: "plan" } },
			"plan.execute": {
				args: { ...plan, strategy: "retain_context" },
				state: { planningState: { mode: "plan", plan: { phase: "ready" } } },
			},
			"plan.change": { args: plan, state: { planningState: { mode: "plan", plan: { phase: "ready" } } } },
			"plan.discard": { args: plan, state: { planningState: { mode: "plan", plan: { phase: "draft" } } } },
			"session.new": { args: {} },
			"run.cancel": { args: {}, state: { isBusy: true } },
			"context.auto_compaction": { args: { enabled: false, ...target }, state: { model, settingsManager } },
			"context.compaction_threshold": { args: { tokens: 0, ...target }, state: { model, settingsManager } },
			"context.compact": { args: {} },
			"session.rename": { args: { name: "n" } },
			"thinking.fast_mode": { args: { enabled: false } },
			"review.uncommitted": { args: {} },
			"review.branch": { args: {} },
			"review.pr": { args: {} },
			"review.commit": { args: { ref: "HEAD" } },
			"review.fix": { args: { runId: "r" } },
			"review.feedback": { args: { runId: "r", findingId: "f", status: "accepted" } },
			"review.rerun": { args: { runId: "r" } },
			"review.publish": { args: { runId: "r" } },
			"review.export_feedback": { args: { path: "feedback.json" } },
		};
		expect(Object.keys(samples).sort()).toEqual(listBuiltinUiActionIds().sort());
		for (const action of listBuiltinUiActionIds()) {
			const { args, state } = samples[action]!;
			expect(await reached({ type: "invoke_ui_action", action, args }, state), action).toEqual([
				getBuiltinUiActionIntent(action),
			]);
		}
	});
});

/** Commands the daemon serves on its own streams or before the RPC mode, never through the dispatcher. */
const DAEMON_ONLY_COMMANDS: ReadonlySet<string> = new Set([
	"set_keep_awake",
	"get_keep_awake",
	"set_web_search_key",
	"get_web_search_status",
	"upload_device_logs",
	"unregister_workspace",
	"create_worktree",
	"list_worktrees",
	"remove_worktree",
	"list_workspace_directories",
	"get_agent_options",
	"get_session_contexts",
	"resolve_pr_review",
	"prepare_pr_review",
	"get_ui_actions",
	"get_ui_action_completions",
]);
