/**
 * Conversation intents: input, run control, the conversation's own settings
 * (entries on its branch), agent mode and plans, and structural moves.
 */

import { statSync } from "node:fs";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { WithdrawnInput } from "@hansjm10/volt-protocol";
import { resolvePath } from "../../../utils/paths.ts";
import type { AgentSession } from "../../agent-session.ts";
import { executePlan } from "../../host/plan-handoff.ts";
import { findStoredSession, openFork, openNewSession, openStoredSessionById } from "../../host/session-intents.ts";
import { acknowledgeReviewRun, appendReviewRun, getCanonicalReviewRun } from "../../review-state.ts";
import { QueueClearPersistenceError } from "../../session/client-inputs.ts";
import { MissingSessionCwdError } from "../../session-cwd.ts";
import { SessionManager } from "../../session-manager.ts";
import type { SessionWriter } from "../../session-writer.ts";
import { agentModeState, fastModeAvailability, fastModeState } from "./state.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	IntentRejectedError,
	type IntentTarget,
	type IntentView,
} from "./types.ts";

const control = ["conversation.control.v1"] as const;
const modelSelect = ["model.select.v1"] as const;

/** The target of a conversation-scope intent; the registry admits those only with one. */
export function targetOf(ctx: IntentContext): IntentTarget {
	if (!ctx.target) throw new IntentRejectedError("unavailable", "This intent needs a conversation");
	return ctx.target;
}

/**
 * Availability that refuses a remote profile the input fields only local
 * clients may send: host paths and the host's own records.
 */
export function localOnlyInput<I extends object>(
	fields: readonly (keyof I & string)[],
): (view: IntentView, input?: I) => IntentAvailability {
	return (view, input) => {
		if (view.profile.name !== "remote" || input === undefined) return INTENT_ENABLED;
		const field = fields.find((name) => input[name] !== undefined);
		return field === undefined
			? INTENT_ENABLED
			: { enabled: false, code: "not_allowed", reason: `${field} is not available over remote host` };
	};
}

/** `path`, resolved against `cwd`, when it names an existing directory; rejected `invalid_input` otherwise. */
export function existingDirectory(path: string, cwd: string): string {
	const resolved = resolvePath(path, cwd);
	let directory = false;
	try {
		directory = statSync(resolved).isDirectory();
	} catch {
		directory = false;
	}
	if (!directory) throw new IntentRejectedError("invalid_input", `Not a directory: ${resolved}`);
	return resolved;
}

/** An open that failed on a missing cwd is rejected `unavailable`: the client may ask for another and retry. */
export async function rejectingMissingCwd<T>(open: () => Promise<T>): Promise<T> {
	try {
		return await open();
	} catch (error) {
		if (error instanceof MissingSessionCwdError) throw new IntentRejectedError("unavailable", error.message);
		throw error;
	}
}

/**
 * Take the conversation's queued input back, steering first. When the
 * withdrawal could not be recorded, the input is still taken back: the
 * error carries its text, the only copy left.
 */
export async function withdrawQueuedInput(session: AgentSession): Promise<WithdrawnInput[]> {
	try {
		return await session.withdrawQueue();
	} catch (error) {
		if (!(error instanceof QueueClearPersistenceError)) throw error;
		return [...error.steering, ...error.followUp].map((text) => ({ text }));
	}
}

// ============================================================================
// Input
// ============================================================================

function promptExtensionCommandName(message: string): string | undefined {
	if (!message.startsWith("/")) return undefined;
	const spaceIndex = message.indexOf(" ");
	const name = spaceIndex === -1 ? message.slice(1) : message.slice(1, spaceIndex);
	return name.length > 0 ? name : undefined;
}

/** How a prompt was taken: admitted to run or queue, or completed by an earlier delivery of the same input. */
export interface PromptOutcome {
	readonly clientMessageId: string;
	readonly outcome: "admitted" | "completed";
	/** Present when a canonical identified user entry completed this input. */
	readonly canonicalEntryId?: string;
}

function requireClientMessageId(ctx: IntentContext): string {
	if (ctx.intentId === undefined) {
		throw new IntentRejectedError("invalid_input", "Input intents carry their clientMessageId as the intent id");
	}
	return ctx.intentId;
}

export const promptIntent = defineIntent({
	name: "prompt",
	label: "Prompt",
	description: "Send a message; while the agent runs it is queued as steering or follow-up input",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "queue",
	/** A remote prompt may not run an extension command that is not remote-safe. */
	available(view, input) {
		if (view.profile.name !== "remote" || !input || !view.target) return INTENT_ENABLED;
		const commandName = promptExtensionCommandName(input.message);
		const command = commandName ? view.target.session.extensionRunner.getCommand(commandName) : undefined;
		return command && command.remoteSafe !== true
			? {
					enabled: false,
					code: "not_allowed",
					reason: `Extension command is not available over remote host: /${commandName}`,
				}
			: INTENT_ENABLED;
	},
	run(ctx, input): Promise<PromptOutcome> {
		const { session } = targetOf(ctx);
		const clientMessageId = requireClientMessageId(ctx);
		// Accepted once the prompt passes admission; a failure after that belongs to the run.
		return new Promise((resolve, reject) => {
			let admitted = false;
			void session
				.prompt(input.message, {
					images: input.images,
					streamingBehavior: input.streamingBehavior,
					clientMessageId,
					source: ctx.inputSource ?? "rpc",
					...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
					preflightResult: (result) => {
						if (!result.success || admitted) return;
						admitted = true;
						const record = session.sessionManager.getClientInput(clientMessageId);
						resolve({
							clientMessageId,
							outcome: result.outcome,
							...(record?.canonicalEntryId === undefined ? {} : { canonicalEntryId: record.canonicalEntryId }),
						});
					},
				})
				.catch((error: unknown) => {
					if (!admitted) reject(error);
				});
		});
	},
});

export const steerIntent = defineIntent({
	name: "steer",
	label: "Steer",
	description: "Interrupt the running agent with a message",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	async run(ctx, input) {
		await targetOf(ctx).session.steer(input.message, input.images, requireClientMessageId(ctx));
	},
});

export const followUpIntent = defineIntent({
	name: "follow_up",
	label: "Follow up",
	description: "Queue a message for when the agent finishes",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "queue",
	async run(ctx, input) {
		await targetOf(ctx).session.followUp(input.message, input.images, requireClientMessageId(ctx));
	},
});

// ============================================================================
// Run control
// ============================================================================

/**
 * With `operation`, only a compaction or a tree navigation's branch summary
 * stops. With `withdrawQueued` (local clients), the queued input is taken
 * back before the stop, which then has none to deliver.
 */
export const abortIntent = defineIntent({
	name: "abort",
	label: "Cancel run",
	description: "Abort the current agent operation and cancel the work it runs",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	presentation: { kind: "button", group: "Session" },
	available: localOnlyInput(["withdrawQueued"]),
	async run(ctx, input): Promise<{ messages: WithdrawnInput[] } | undefined> {
		const { session } = targetOf(ctx);
		const abortRun = ctx.services.abortRun;
		if (input.operation === undefined && !abortRun) throw new Error("Cancelling a run is not available in this host");
		const withdrawn = input.withdrawQueued === true ? { messages: await withdrawQueuedInput(session) } : undefined;
		if (input.operation === "compaction") session.abortCompaction();
		else if (input.operation === "navigation") session.abortBranchSummary();
		else await abortRun?.(session);
		return withdrawn;
	},
	accept: (withdrawn) => (withdrawn === undefined ? {} : { result: withdrawn }),
});

export const withdrawQueuedIntent = defineIntent({
	name: "withdraw_queued",
	label: "Edit queued messages",
	description: "Take the queued steering and follow-up messages back without stopping the run",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	async run(ctx) {
		return { messages: await withdrawQueuedInput(targetOf(ctx).session) };
	},
	accept: (result) => ({ result }),
});

export const abortRetryIntent = defineIntent({
	name: "abort_retry",
	label: "Cancel retry",
	description: "Stop the turn waiting to retry",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	async run(ctx) {
		targetOf(ctx).session.abortRetry();
	},
});

/**
 * A user shell command, run on the host: extensions see `user_bash` first and
 * may return its result or the operations it runs with; the live `bash` value
 * shows it until its entry commits.
 */
export const bashIntent = defineIntent({
	name: "bash",
	label: "Run shell command",
	category: "advanced",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	run(ctx, input) {
		return targetOf(ctx).session.runUserBash(input.command, {
			...(input.excludeFromContext === undefined ? {} : { excludeFromContext: input.excludeFromContext }),
		});
	},
	accept: (result) => ({ result }),
});

export const abortBashIntent = defineIntent({
	name: "abort_bash",
	label: "Cancel shell command",
	category: "advanced",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	async run(ctx) {
		targetOf(ctx).session.abortBash();
	},
});

export const compactIntent = defineIntent({
	name: "compact",
	label: "Compact context",
	description: "Summarize the current session context",
	category: "context",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "palette", group: "Context" },
	slash: { name: "compact", example: "/compact" },
	run(ctx, input) {
		return targetOf(ctx).session.compact(input.customInstructions, ctx.assertCurrent);
	},
	accept: (result) => ({ result }),
});

// ============================================================================
// Conversation settings
// ============================================================================

/** The available model a selection names, or an error naming it. */
export async function findAvailableModel(
	session: AgentSession,
	provider: string,
	modelId: string,
	assertCurrent?: () => void,
): Promise<Model<Api>> {
	const models = await session.modelRegistry.getAvailable();
	assertCurrent?.();
	const model = models.find((candidate) => candidate.provider === provider && candidate.id === modelId);
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
	return model;
}

export const setModelIntent = defineIntent({
	name: "set_model",
	label: "Model",
	description: "Select the model for this conversation",
	category: "model",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: modelSelect,
	whileBusy: "run",
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const model = await findAvailableModel(session, input.provider, input.modelId, ctx.assertCurrent);
		await session.setModel(model, {
			persistDefault: false,
			...(input.source === undefined ? {} : { source: input.source }),
		});
		return model;
	},
});

export const setThinkingLevelIntent = defineIntent({
	name: "set_thinking_level",
	label: "Thinking level",
	description: "Set the thinking level for this conversation",
	category: "model",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: modelSelect,
	whileBusy: "run",
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		await session.setThinkingLevel(input.level, { persistDefault: false });
		await session.settingsManager.flush();
		return session.thinkingLevel;
	},
});

export const setFastModeIntent = defineIntent({
	name: "set_fast_mode",
	label: "Fast mode",
	description: "Request premium low-latency inference capacity for the current session.",
	category: "model",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "toggle", group: "Model", priority: 100 },
	slash: { name: "fast", example: "/fast [on|off]" },
	state: fastModeState,
	available: fastModeAvailability,
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const wasEnabled = session.fastModeEnabled === true;
		await session.setFastModeEnabled(input.enabled);
		return { requested: input.enabled, wasEnabled, enabled: session.fastModeEnabled === true };
	},
});

/**
 * `sessionId` renames another session: one open in this host through its
 * own log, a stored one of any session directory the `sessions` query lists
 * by writing its log.
 */
export const setSessionNameIntent = defineIntent({
	name: "set_session_name",
	label: "Rename session",
	description: "Set the current session display name",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: control,
	whileBusy: "run",
	presentation: { kind: "palette", group: "Session" },
	slash: { name: "name", example: "/name <name>" },
	async run(ctx, input) {
		const name = input.name.trim();
		if (!name) throw new Error("Session name cannot be empty");
		const { conversation, host } = targetOf(ctx);
		const sessionId = input.sessionId ?? conversation.id;
		const open = host.get(sessionId);
		if (open) {
			await open.whileOpen((session) => session.setSessionName(name));
			return name;
		}
		const stored = await findStoredSession(conversation, sessionId, "all");
		if (!stored) throw new IntentRejectedError("invalid_input", `Session not found: ${sessionId}`);
		const manager = await SessionManager.open(stored.ref);
		try {
			await manager.logWriter.appendSessionInfo(name);
		} finally {
			await manager.closePersistence();
		}
		return name;
	},
});

// ============================================================================
// Agent mode and plans
// ============================================================================

export const setAgentModeIntent = defineIntent({
	name: "set_agent_mode",
	label: "Agent mode",
	description: "Switch between Build and read-only Plan mode",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "picker", group: "Session", priority: 110 },
	state: agentModeState,
	run(ctx, input) {
		ctx.assertCurrent?.();
		return targetOf(ctx).session.setAgentMode(input.mode);
	},
});

export const planExecuteIntent = defineIntent({
	name: "plan_execute",
	label: "Execute Plan",
	description: "Approve the exact ready plan revision and begin execution",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "detail", group: "Plan", priority: 100 },
	sourceOwned: (input) => input.strategy === "new_session",
	async run(ctx, input) {
		const { host, client, session } = targetOf(ctx);
		const sourceSessionId = session.sessionId;
		const result = await executePlan(
			host,
			client,
			input.planId,
			input.expectedRevision,
			input.strategy,
			ctx.assertCurrent,
		);
		return { ...result, sourceSessionId };
	},
	accept: (outcome) => ({
		...(outcome.selectedSessionId === outcome.sourceSessionId ? {} : { conversation: outcome.selectedSessionId }),
		result: { started: outcome.started },
	}),
});

export const planChangeIntent = defineIntent({
	name: "plan_change",
	label: "Change Plan",
	description: "Return the exact ready plan revision to draft",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "detail", group: "Plan", priority: 90 },
	run(ctx, input) {
		ctx.assertCurrent?.();
		return targetOf(ctx).session.changePlan(input.planId, input.expectedRevision);
	},
});

export const planDiscardIntent = defineIntent({
	name: "plan_discard",
	label: "Discard plan",
	description: "Discard the exact current plan revision",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	confirm: { destructive: true },
	presentation: { kind: "detail", group: "Plan", priority: 80 },
	run(ctx, input) {
		ctx.assertCurrent?.();
		return targetOf(ctx).session.discardPlan(input.planId, input.expectedRevision);
	},
});

// ============================================================================
// Structural
// ============================================================================

/** A structural intent's acceptance: the conversation the client moved to, or a cancelled result. */
function acceptMove<O extends { cancelled: true } | { cancelled: false; sessionId: string }>(outcome: O) {
	return outcome.cancelled ? { result: { cancelled: true as const } } : { conversation: outcome.sessionId };
}

/**
 * `cwd` (an existing directory; local clients only) starts the session
 * there, with `workspaceName` and `baseRef` for its Git context.
 * `parentSessionId` names a stored session of the conversation's store for a
 * local client; a remote one names only a session of the conversation's cwd.
 */
export const newSessionIntent = defineIntent({
	name: "new_session",
	label: "New session",
	description: "Start a new session",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "palette", group: "Session" },
	slash: { name: "clear", example: "/clear" },
	sourceOwned: true,
	available: localOnlyInput(["cwd", "workspaceName", "baseRef"]),
	async run(ctx, input) {
		const { host, client, session, conversation } = targetOf(ctx);
		const cwd = input.cwd === undefined ? undefined : existingDirectory(input.cwd, session.sessionManager.getCwd());
		const preservedReviewRun = input.preserveReviewRunId
			? await getCanonicalReviewRun(session.sessionManager, input.preserveReviewRunId)
			: undefined;
		if (input.preserveReviewRunId && !preservedReviewRun) {
			throw new Error(`Unknown review run: ${input.preserveReviewRunId}`);
		}
		let parentSessionRef =
			input.parentSessionId === session.sessionId ? session.sessionManager.getSessionRef() : undefined;
		if (input.parentSessionId && !parentSessionRef) {
			parentSessionRef = (
				await findStoredSession(
					conversation,
					input.parentSessionId,
					ctx.profile.name === "local" ? "all" : "workspace",
				)
			)?.ref;
			if (!parentSessionRef) throw new Error(`Unknown parent session: ${input.parentSessionId}`);
		}
		return openNewSession(host, client, {
			...(input.preserveReviewRunId ? { preserveReviewRunId: input.preserveReviewRunId } : {}),
			...(input.replaceReviewGeneral ? { replaceReviewGeneral: true } : {}),
			...(ctx.services.reviewDiscussions ? { reviewSourceWriter: ctx.services.reviewDiscussions.writeSource } : {}),
			...(parentSessionRef ? { parentSessionRef } : {}),
			...(preservedReviewRun
				? {
						setup: async (writer: SessionWriter) => {
							await appendReviewRun(writer, preservedReviewRun);
							if (preservedReviewRun.acknowledgedAt !== undefined) {
								await acknowledgeReviewRun(writer, preservedReviewRun.runId, preservedReviewRun.acknowledgedAt);
							}
						},
					}
				: {}),
			...(cwd === undefined ? {} : { cwd }),
			...(input.workspaceName === undefined ? {} : { workspaceName: input.workspaceName }),
			...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
			...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
		});
	},
	accept: acceptMove,
});

/**
 * A local client opens a stored session of any session directory the
 * `sessions` query lists; a remote one only its workspace's. A session whose
 * cwd is gone is rejected `unavailable` unless `cwdOverride` (local clients
 * only) names an existing directory to run it in.
 */
export const switchSessionIntent = defineIntent({
	name: "switch_session",
	label: "Switch session",
	description: "Open a stored session of this workspace",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	sourceOwned: true,
	available: localOnlyInput(["cwdOverride"]),
	run(ctx, input) {
		const { host, client, session } = targetOf(ctx);
		const cwdOverride =
			input.cwdOverride === undefined
				? undefined
				: existingDirectory(input.cwdOverride, session.sessionManager.getCwd());
		return rejectingMissingCwd(() =>
			openStoredSessionById(host, client, input.sessionId, {
				scope: ctx.profile.name === "local" ? "all" : "workspace",
				...(cwdOverride === undefined ? {} : { cwdOverride }),
				...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
			}),
		);
	},
	accept: acceptMove,
});

export const forkIntent = defineIntent({
	name: "fork",
	label: "Fork",
	description: "Continue in a new session from before a previous user message",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	sourceOwned: true,
	run(ctx, input) {
		const { host, client } = targetOf(ctx);
		return openFork(host, client, input.entryId);
	},
	accept: (outcome) =>
		outcome.cancelled
			? { result: { cancelled: true as const } }
			: { conversation: outcome.sessionId, result: { text: outcome.selectedText ?? "" } },
});

export const cloneIntent = defineIntent({
	name: "clone",
	label: "Clone session",
	description: "Duplicate the current session at the current position",
	category: "session",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	sourceOwned: true,
	run(ctx) {
		const { host, client, session } = targetOf(ctx);
		const leafId = session.sessionManager.getLeafId();
		if (!leafId) return Promise.reject(new Error("Cannot clone session: no current entry selected"));
		return openFork(host, client, leafId, { position: "at" });
	},
	accept: acceptMove,
});

export const exportHtmlIntent = defineIntent({
	name: "export_html",
	label: "Export HTML",
	description: "Write the session as an HTML file",
	category: "session",
	scope: "conversation",
	fence: "none",
	remote: "unsafe",
	requires: ["conversation.observe.v1"],
	whileBusy: "run",
	async run(ctx, input) {
		return { path: await targetOf(ctx).session.exportToHtml(input.outputPath) };
	},
	accept: (result) => ({ result }),
});
