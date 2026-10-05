/**
 * Conversation intents: input, run control, the conversation's own settings
 * (entries on its branch), agent mode and plans, and structural moves.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import type { AgentSession } from "../../agent-session.ts";
import { executePlan } from "../../host/plan-handoff.ts";
import { openFork, openNewSession, openStoredSessionById } from "../../host/session-intents.ts";
import { acknowledgeReviewRun, appendReviewRun, getCanonicalReviewRun } from "../../review-state.ts";
import { SessionManager } from "../../session-manager.ts";
import type { SessionWriter } from "../../session-writer.ts";
import { agentModeState, fastModeAvailability, fastModeState } from "./state.ts";
import { defineIntent, INTENT_ENABLED, type IntentContext, IntentRejectedError, type IntentTarget } from "./types.ts";

const control = ["conversation.control.v1"] as const;
const modelSelect = ["model.select.v1"] as const;

/** The target of a conversation-scope intent; the registry admits those only with one. */
export function targetOf(ctx: IntentContext): IntentTarget {
	if (!ctx.target) throw new IntentRejectedError("unavailable", "This intent needs a conversation");
	return ctx.target;
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
					source: "rpc",
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
	async run(ctx) {
		const abortRun = ctx.services.abortRun;
		if (!abortRun) throw new Error("Cancelling a run is not available in this host");
		await abortRun(targetOf(ctx).session);
	},
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
		return targetOf(ctx).session.executeBash(input.command, undefined, {
			excludeFromContext: input.excludeFromContext,
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
		await session.setModel(model, { persistDefault: false });
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
		await targetOf(ctx).session.setSessionName(name);
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
	async run(ctx, input) {
		const { host, client, session } = targetOf(ctx);
		const preservedReviewRun = input.preserveReviewRunId
			? await getCanonicalReviewRun(session.sessionManager, input.preserveReviewRunId)
			: undefined;
		if (input.preserveReviewRunId && !preservedReviewRun) {
			throw new Error(`Unknown review run: ${input.preserveReviewRunId}`);
		}
		let parentSessionRef =
			input.parentSessionId === session.sessionId ? session.sessionManager.getSessionRef() : undefined;
		if (input.parentSessionId && !parentSessionRef) {
			const candidates = await SessionManager.listAll(session.sessionManager.getSessionDir(), undefined, {
				includeMessageFreeDurable: true,
			});
			parentSessionRef = candidates.find((candidate) => candidate.id === input.parentSessionId)?.ref;
			if (!parentSessionRef) throw new Error(`Unknown parent session: ${input.parentSessionId}`);
		}
		return openNewSession(host, client, {
			...(input.preserveReviewRunId ? { preserveReviewRunId: input.preserveReviewRunId } : {}),
			...(input.replaceReviewGeneral ? { replaceReviewGeneral: true } : {}),
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
			...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
		});
	},
	accept: acceptMove,
});

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
	run(ctx, input) {
		const { host, client } = targetOf(ctx);
		return openStoredSessionById(host, client, input.sessionId, {
			...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
		});
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
