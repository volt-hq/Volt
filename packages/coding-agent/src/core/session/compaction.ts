/**
 * The session's compaction ({@link SessionCompaction}): the summarizer the
 * conversation compacts with (the compaction boundary, the
 * `session_before_compact` hook, the summary, and the plan checkpoint that
 * commits with it), the automatic compaction policy decided inside a turn,
 * manual compaction, and the compaction events the session publishes.
 */

import { join } from "node:path";
import type {
	AgentMessage,
	AgentTool,
	Conversation,
	ConversationCompactionCause,
	ConversationCompactionCheck,
	ConversationCompactionDecision,
	ConversationCompactionRequest,
	ConversationCompactionSummary,
	StreamFn,
	ThinkingLevel,
} from "@hansjm10/volt-agent-core";
import { type Api, applyReplayPolicy, estimateToolDefinitionTokens, type Model, type Tool } from "@hansjm10/volt-ai";
import type { ActiveCompaction, AgentSessionConfig, AgentSessionEvent, CompactionReason } from "../agent-session.ts";
import { formatNoModelSelectedMessage } from "../auth-guidance.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import {
	type CompactionBudgetSnapshot,
	compactionResponseReserve,
	compactionTriggerReserve,
	maxComposedCheckpointChars,
	maxInstalledCheckpointTokens,
} from "../compaction/budget.ts";
import { userMessageRecord } from "../compaction/checkpoint.ts";
import {
	COMPACTION_REQUEST_TIMEOUT_MS,
	COMPACTION_TOTAL_TIMEOUT_MS,
	type CompactionFailureReport,
	compactContext,
} from "../compaction/context-compaction.ts";
import {
	type CompactionDetails,
	type CompactionPreparation,
	type CompactionRequestUsage,
	type CompactionResult,
	estimateMessagesTokens,
	estimateRequestTokens,
	estimateTokens,
	prepareCompaction,
	type SummarizationRetryOptions,
} from "../compaction/index.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../extensions/index.ts";
import { withoutExtensionServices } from "../extensions/services-runtime.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, type CustomMessage } from "../messages.ts";
import { PLAN_CHECKPOINT_CUSTOM_TYPE } from "../planning.ts";
import { getLatestCompactionEntry, type SessionEntry, type SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { writeToolProgressCapture } from "../tool-progress-capture.ts";
import { checkResponseCompaction, latestCompactionTime, shouldCompactBeforeContinuing } from "./compaction-policy.ts";
import type { SessionExtensionBinding } from "./extension-binding.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionPlanning } from "./planning.ts";

const MAX_COMPACTION_SUMMARY_RETRIES = 2;
const MAX_COMPACTION_RETRY_DELAY_MS = 30_000;

export type CompactionAdmissionCode = "cannot_fit" | "context_too_large" | "above_trigger" | "checkpoint_too_large";

/** A compaction whose result would not fit. Nothing is committed and the original context stays. */
export class CompactionAdmissionError extends Error {
	readonly code: CompactionAdmissionCode;

	constructor(code: CompactionAdmissionCode, message: string) {
		super(message);
		this.name = "CompactionAdmissionError";
		this.code = code;
	}
}

function formatTokens(value: number): string {
	return value.toLocaleString("en-US");
}

/** What a compaction keeps beside its checkpoint, measured before the summary exists. */
interface CompactionFootprint {
	readonly contextWindow: number;
	readonly reserveTokens: number;
	/** Context messages the compacted context keeps verbatim. */
	readonly retainedCount: number;
	readonly retainedTokens: number;
	/**
	 * Tokens of messages compaction may choose to keep: what fits below the
	 * automatic trigger beside the system prompt, tools, plan checkpoint and
	 * largest checkpoint. Only the newest indivisible suffix is kept beyond it.
	 */
	readonly retainedAllowance: number;
	/** The context size automatic compaction triggers above; 0 or less when every response triggers it. */
	readonly triggerTokens: number;
	readonly systemPrompt: string;
	readonly tools: readonly Tool[];
	/** System prompt and tool definitions. */
	readonly baseTokens: number;
}

/** Entries from the first kept entry onward that contribute a context message, as the fold counts them. */
function retainedMessageCount(pathEntries: readonly SessionEntry[], firstKeptEntryId: string): number {
	const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === firstKeptEntryId);
	if (firstKeptIndex < 0) return 0;
	return pathEntries
		.slice(firstKeptIndex)
		.filter(
			(entry) =>
				entry.type === "message" ||
				entry.type === "custom_message" ||
				(entry.type === "branch_summary" && entry.summary),
		).length;
}

/** A summary request stream that runs at the branch's inference speed, as its turns do. */
export function withInferenceSpeed(stream: StreamFn, fastModeEnabled: () => boolean): StreamFn {
	return (model, context, options) =>
		stream(model, context, { ...options, inferenceSpeed: fastModeEnabled() ? "fast" : "standard" });
}

export interface SessionCompactionHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelSettings: ModelSettings;
	/** Global config directory: the latest compaction failure is captured under it. */
	readonly agentDir: string;
	readonly convertToLlm: AgentSessionConfig["convertToLlm"];
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	extensions(): SessionExtensionBinding;
	planning(): SessionPlanning;
	isDisposed(): boolean;
	/** Rejects once the session is disposed. */
	assertNotDisposed(): void;
	isBashRunning(): boolean;
	/** A turn holds the conversation, a prompt's reservation included. */
	turnActive(): boolean;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	thinkingLevel(): ThinkingLevel;
	fastModeEnabled(): boolean;
	systemPrompt(): string;
	/** The active branch's messages. */
	messages(): AgentMessage[];
	/** A branch-local mutation lease, optionally layered over transport authority. */
	captureGenerationAssertion(assertExternalAuthorityCurrent?: () => void): () => void;
	/** Record a fatal error of the running turn: the prompt that ran it rejects with it. */
	recordTurnFatalError(error: Error): void;
	emit(event: AgentSessionEvent): void;
}

export class SessionCompaction {
	private readonly host: SessionCompactionHost;
	/** The turn operation that made a provider request; compaction before it checks the context's tail. */
	private requestedOperationId: string | undefined;
	/** The turn operation that compacted to recover from a context overflow. */
	private overflowRecovered: string | undefined;
	/** The automatic compaction a policy decision started; a retry drops the response it retries from its request. */
	private pendingCompaction:
		| { reason: CompactionReason; willRetry: boolean; dropTrailing?: "error" | "length" }
		| undefined;
	/** The summary the summarizer produced, reported once its compaction commits. */
	private compactionSummary: { result: CompactionResult; fromExtension: boolean } | undefined;
	/** The latest committed compaction's result, for the manual compaction that ran it. */
	private lastCompactionResult: CompactionResult | undefined;
	private active: ActiveCompaction | undefined = undefined;

	constructor(host: SessionCompactionHost) {
		this.host = host;
	}

	/** The running compaction, if any. */
	get activeCompaction(): ActiveCompaction | undefined {
		return this.active;
	}

	/** The turn operation that compacted to recover from a context overflow. */
	get overflowRecoveredOperationId(): string | undefined {
		return this.overflowRecovered;
	}

	/** A turn operation made a provider request. */
	recordRequest(operationId: string | undefined): void {
		this.requestedOperationId = operationId;
	}

	private summarizationRetryOptions(): SummarizationRetryOptions {
		const settings = this.host.settingsManager.getRetrySettings();
		return {
			maxRetries: settings.enabled ? Math.min(MAX_COMPACTION_SUMMARY_RETRIES, Math.max(0, settings.maxRetries)) : 0,
			baseDelayMs: Math.max(0, settings.baseDelayMs),
			maxDelayMs: Math.min(
				MAX_COMPACTION_RETRY_DELAY_MS,
				Math.max(0, this.host.settingsManager.getProviderRetrySettings().maxRetryDelayMs),
			),
		};
	}

	/** Written before the error surfaces so the record exists when the user sees it. */
	private captureFailure(report: CompactionFailureReport): Promise<void> {
		return writeToolProgressCapture(
			join(this.host.agentDir, "debug", "compaction-latest.json"),
			JSON.stringify(
				{
					sessionId: this.host.sessionManager.getSessionId(),
					capturedAt: Date.now(),
					thinkingLevel: this.host.thinkingLevel(),
					...report,
				},
				null,
				2,
			),
		);
	}

	/** Reject a compaction that cannot be admitted: capture the failure, then throw. Nothing commits. */
	private async reject(
		error: CompactionAdmissionError,
		phase: string,
		budget: CompactionBudgetSnapshot,
		requests: readonly CompactionRequestUsage[] = [],
	): Promise<never> {
		try {
			await this.captureFailure({
				error: error.message,
				phase,
				elapsedMs: Math.max(0, Date.now() - (this.active?.startedAt ?? Date.now())),
				requestTimeoutMs: COMPACTION_REQUEST_TIMEOUT_MS,
				totalTimeoutMs: COMPACTION_TOTAL_TIMEOUT_MS,
				requests: [...requests],
				budget,
			});
		} catch {
			// Failure diagnostics must never replace the compaction error.
		}
		throw error;
	}

	/**
	 * Fail before any request when what the compaction must keep cannot fit:
	 * the retained messages, system prompt, tools, plan checkpoint and response
	 * reserve, plus room for the checkpoint itself when one is generated.
	 */
	private async assertCanFit(
		footprint: CompactionFootprint,
		planTokens: number,
		checkpointTokens: number,
	): Promise<void> {
		const { contextWindow, reserveTokens, retainedTokens, baseTokens } = footprint;
		const fixedTokens = baseTokens + planTokens;
		const needed = retainedTokens + fixedTokens + checkpointTokens + reserveTokens;
		if (!(contextWindow > 0) || needed <= contextWindow) return;
		const checkpoint = checkpointTokens > 0 ? `, the checkpoint (up to ~${formatTokens(checkpointTokens)})` : "";
		await this.reject(
			new CompactionAdmissionError(
				"cannot_fit",
				`Compaction cannot fit the context window: the recent messages it must keep (~${formatTokens(retainedTokens)} tokens), the system prompt, tools and plan (~${formatTokens(fixedTokens)})${checkpoint}, and the ${formatTokens(reserveTokens)}-token response reserve need ~${formatTokens(needed)} of ${formatTokens(contextWindow)} tokens; original context was kept`,
			),
			"preflight",
			{ contextWindow, reserveTokens, retainedTokens, fixedTokens },
		);
	}

	/**
	 * Admit a checkpoint before it commits: the rebuilt context (the wrapped
	 * checkpoint, retained messages, plan checkpoint, system prompt and tools)
	 * plus the response reserve must fit the window, an automatic compaction
	 * must land below its trigger, and a built-in checkpoint must respect its
	 * composed size limit. Extension summaries are admitted the same way.
	 */
	private async admit(
		compaction: CompactionResult,
		builtIn: CompactionRequestUsage[] | undefined,
		footprint: CompactionFootprint,
		planningCheckpoint: CustomMessage | undefined,
		cause: ConversationCompactionCause,
		model: Model<Api>,
	): Promise<void> {
		const { contextWindow, reserveTokens, retainedTokens, baseTokens } = footprint;
		const fixedTokens = baseTokens + (planningCheckpoint ? estimateTokens(planningCheckpoint) : 0);
		const summaryTokens = Math.ceil(
			(COMPACTION_SUMMARY_PREFIX.length + compaction.summary.length + COMPACTION_SUMMARY_SUFFIX.length) / 4,
		);
		const compactedTokens = summaryTokens + retainedTokens + fixedTokens;
		const budget: CompactionBudgetSnapshot = {
			contextWindow,
			reserveTokens,
			retainedTokens,
			fixedTokens,
			compactedTokens,
		};
		const requests = builtIn ?? [];
		const maxChars = maxComposedCheckpointChars(contextWindow);
		if (builtIn && compaction.summary.length > maxChars) {
			await this.reject(
				new CompactionAdmissionError(
					"checkpoint_too_large",
					`Compaction checkpoint (${formatTokens(compaction.summary.length)} characters) exceeds the ${formatTokens(maxChars)}-character limit; original context was kept`,
				),
				"admission",
				budget,
				requests,
			);
		}
		if (contextWindow > 0 && compactedTokens + reserveTokens > contextWindow) {
			await this.reject(
				new CompactionAdmissionError(
					"context_too_large",
					`Compacted context (~${formatTokens(compactedTokens)} tokens) and the ${formatTokens(reserveTokens)}-token response reserve would exceed the ${formatTokens(contextWindow)}-token context window; original context was kept`,
				),
				"admission",
				budget,
				requests,
			);
		}
		// Landing below the trigger is required only when compaction chose what to keep. When the newest
		// indivisible suffix alone exceeds the allowance, the next compaction summarizes it instead.
		if (cause === "manual" || footprint.retainedTokens > footprint.retainedAllowance) return;
		const { triggerTokens } = footprint;
		if (contextWindow > 0 && triggerTokens > 0 && compactedTokens > triggerTokens) {
			await this.reject(
				new CompactionAdmissionError(
					"above_trigger",
					`Compacted context (~${formatTokens(compactedTokens)} tokens) would still be above the ${formatTokens(triggerTokens)}-token auto-compaction trigger; lower compaction.keepRecentTokens or use a model with a larger context window; original context was kept`,
				),
				"admission",
				{ ...budget, triggerTokens },
				requests,
			);
		}
		const threshold = this.host.settingsManager.getCompactionSettings(model).thresholdTokens ?? 0;
		if (threshold > 0 && compactedTokens >= threshold) {
			await this.reject(
				new CompactionAdmissionError(
					"above_trigger",
					`Compacted context (~${formatTokens(compactedTokens)} tokens) would still reach the ${formatTokens(threshold)}-token compaction threshold for ${model.provider}/${model.id}; raise the threshold or lower compaction.keepRecentTokens; original context was kept`,
				),
				"admission",
				{ ...budget, triggerTokens: threshold },
				requests,
			);
		}
	}

	private generate(
		preparation: CompactionPreparation,
		model: Model<Api>,
		messages: readonly AgentMessage[],
		retainedCount: number,
		footprint: CompactionFootprint,
		userMessages: string | undefined,
		operation: { readonly stream: StreamFn; readonly signal: AbortSignal },
		customInstructions?: string,
	): Promise<CompactionResult<CompactionDetails> & { details: CompactionDetails }> {
		// Keep the full rebuilt conversation warm, including the latest response.
		// Describe the retained suffix only in the appended checkpoint instruction. The history gets the
		// replay policy a turn's request gets, so dropped errored turns leave no unmatched tool calls.
		return compactContext(preparation, model, {
			sourceMessageCount: messages.length,
			retainedMessageCount: retainedCount,
			estimatedContextTokens: estimateRequestTokens({
				messages,
				tools: footprint.tools,
				systemPrompt: footprint.systemPrompt,
			}),
			...(userMessages === undefined ? {} : { userMessages }),
			context: async (signal) => {
				const transformed = await withoutExtensionServices(() =>
					this.host.extensionRunner().emitContext(cloneCanonicalData([...messages], "Agent message delivery")),
				);
				signal.throwIfAborted();
				const llmMessages = applyReplayPolicy(await this.host.convertToLlm(transformed));
				signal.throwIfAborted();
				return {
					systemPrompt: this.host.systemPrompt(),
					tools: [...this.host.conversation().activeTools],
					messages: llmMessages,
				};
			},
			streamFn: withInferenceSpeed(operation.stream, () => this.host.fastModeEnabled()),
			signal: operation.signal,
			thinkingLevel: this.host.thinkingLevel(),
			thinkingBudgets: this.host.modelSettings.streamOptions.thinkingBudgets,
			retry: this.summarizationRetryOptions(),
			customInstructions,
			onFailure: (report) => this.captureFailure(report),
		});
	}

	/**
	 * The conversation's summarizer for compaction. A turn whose automatic
	 * compaction fails reports the failure to its prompt.
	 */
	async summarize(request: ConversationCompactionRequest): Promise<ConversationCompactionSummary | undefined> {
		try {
			return await this.summarizeCompaction(request);
		} catch (error) {
			// A turn whose automatic compaction fails reports the failure to its prompt.
			if (request.cause !== "manual" && !request.signal.aborted) {
				const message = error instanceof Error ? error.message : String(error);
				this.host.recordTurnFatalError(
					new Error(
						request.cause === "overflow"
							? `Context overflow recovery failed: ${message}`
							: `Auto-compaction failed: ${message}`,
						{ cause: error },
					),
				);
			}
			throw error;
		}
	}

	/**
	 * The conversation's summarizer for manual and automatic compaction: the
	 * compaction boundary, the `session_before_compact` hook (which may cancel
	 * or supply the summary), the summary itself, and the plan checkpoint that
	 * commits with it. The conversation commits the result and resumes the turn.
	 */
	private async summarizeCompaction(
		request: ConversationCompactionRequest,
	): Promise<ConversationCompactionSummary | undefined> {
		const reason = request.cause;
		const willRetry = reason === "manual" ? false : (this.pendingCompaction?.willRetry ?? false);
		// The summary runs before the session observes the compaction's start event.
		this.active ??= { reason, startedAt: Date.now() };
		this.compactionSummary = undefined;
		const model = request.model;
		const pathEntries = this.host.sessionManager.getBranch();
		const branchMessages = this.host.sessionManager.getConversationState().context.messages;
		const settings = this.host.settingsManager.getCompactionSettings();
		const contextWindow = model.contextWindow;
		const tools = this.host.conversation().activeTools;
		const systemPrompt = this.host.systemPrompt();
		const baseTokens = Math.ceil(systemPrompt.length / 4) + estimateToolDefinitionTokens(tools);
		const plannedCheckpoint = this.host.planning().createCheckpointMessage(this.host.planning().current);
		const planTokensBefore = plannedCheckpoint ? estimateTokens(plannedCheckpoint) : 0;
		const triggerReserve = compactionTriggerReserve(
			model,
			settings.reserveTokens,
			this.host.thinkingLevel(),
			this.host.modelSettings.streamOptions.thinkingBudgets,
		);
		// Retained messages leave room below the trigger for the system prompt, plan checkpoint and
		// largest checkpoint, so a compaction does not trigger the next one by itself.
		const fixedTokens =
			Math.ceil(systemPrompt.length / 4) +
			planTokensBefore +
			maxInstalledCheckpointTokens(contextWindow) +
			(triggerReserve - settings.reserveTokens);
		const retainedAllowance =
			contextWindow > 0
				? Math.min(
						settings.keepRecentTokens,
						Math.max(
							0,
							contextWindow - settings.reserveTokens - estimateToolDefinitionTokens(tools) - fixedTokens,
						),
					)
				: settings.keepRecentTokens;
		const footprint = (firstKeptEntryId: string): CompactionFootprint => {
			const retainedCount = retainedMessageCount(pathEntries, firstKeptEntryId);
			return {
				contextWindow,
				reserveTokens: compactionResponseReserve(contextWindow, settings.reserveTokens),
				retainedCount,
				retainedTokens: estimateMessagesTokens(
					branchMessages.slice(Math.max(0, branchMessages.length - retainedCount)),
				),
				retainedAllowance,
				triggerTokens: contextWindow - triggerReserve,
				systemPrompt,
				tools,
				baseTokens,
			};
		};
		// A branch of settings entries alone (its model selection) has nothing to compact.
		const preparation =
			this.host.conversation().state.context.messages.length === 0
				? undefined
				: prepareCompaction(pathEntries, branchMessages, settings, { tools, contextWindow, fixedTokens });
		if (!preparation) {
			if (reason !== "manual") throw new Error("Auto-compaction could not find a safe compaction boundary");
			if (pathEntries.at(-1)?.type === "compaction") throw new Error("Already compacted");
			throw new Error("Nothing to compact (session too small)");
		}
		const prepared = footprint(preparation.firstKeptEntryId);
		await this.assertCanFit(prepared, planTokensBefore, 0);

		let extensionCompaction: CompactionResult | undefined;
		if (this.host.extensionRunner().hasHandlers("session_before_compact")) {
			const result = (await this.host.extensionRunner().emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				...(reason === "manual" ? { customInstructions: request.instructions } : {}),
				reason,
				willRetry,
				signal: request.signal,
			})) as SessionBeforeCompactResult | undefined;
			if (result?.cancel) {
				throw new Error(
					reason === "manual" ? "Compaction cancelled" : "Auto-compaction was cancelled by an extension",
				);
			}
			extensionCompaction = result?.compaction;
		}
		let compaction: CompactionResult;
		let builtInRequests: CompactionRequestUsage[] | undefined;
		if (extensionCompaction) {
			compaction = extensionCompaction;
		} else {
			await this.assertCanFit(prepared, planTokensBefore, maxInstalledCheckpointTokens(contextWindow));
			const generated = await this.generate(
				preparation,
				model,
				branchMessages,
				prepared.retainedCount,
				prepared,
				userMessageRecord(pathEntries, preparation.firstKeptEntryId, contextWindow),
				{ stream: request.stream, signal: request.signal },
				request.instructions,
			);
			compaction = generated;
			builtInRequests = generated.details.requests ?? [];
		}
		if (request.signal.aborted) throw new Error("Compaction cancelled");
		const planningCheckpoint = this.host.planning().createCheckpointMessage(this.host.planning().current);
		await this.admit(
			compaction,
			builtInRequests,
			compaction.firstKeptEntryId === preparation.firstKeptEntryId
				? prepared
				: footprint(compaction.firstKeptEntryId),
			planningCheckpoint,
			reason,
			model,
		);
		this.compactionSummary = {
			result: {
				summary: compaction.summary,
				firstKeptEntryId: compaction.firstKeptEntryId,
				tokensBefore: compaction.tokensBefore,
				...(compaction.details === undefined ? {} : { details: compaction.details }),
			},
			fromExtension: extensionCompaction !== undefined,
		};
		return {
			summary: compaction.summary,
			firstKeptEntryId: compaction.firstKeptEntryId,
			tokensBefore: compaction.tokensBefore,
			...(compaction.details === undefined ? {} : { details: compaction.details }),
			...(extensionCompaction === undefined ? {} : { fromHook: true }),
			...(planningCheckpoint === undefined ? {} : { messages: [planningCheckpoint] }),
		};
	}

	/** A compaction started. */
	started(cause: ConversationCompactionCause): void {
		this.active ??= { reason: cause, startedAt: Date.now() };
		this.host.emit({ type: "compaction_start", reason: cause });
	}

	/**
	 * A compaction ended. A committed one is reported to extensions
	 * (`session_compact`) with its result, then to session observers.
	 */
	async ended(
		reason: ConversationCompactionCause,
		status: "compacted" | "skipped" | "aborted" | "failed",
		error: string | undefined,
	): Promise<void> {
		const willRetry = reason === "manual" ? false : (this.pendingCompaction?.willRetry ?? false);
		const dropTrailing = reason === "manual" ? undefined : this.pendingCompaction?.dropTrailing;
		this.pendingCompaction = undefined;
		const summary = this.compactionSummary;
		this.compactionSummary = undefined;
		this.active = undefined;
		if (status === "compacted" && summary) {
			// The retried request leaves out the response it retries (behind a plan checkpoint, if any).
			const messages = [...this.host.messages()];
			const tail = messages.at(-1);
			const lastIndex =
				tail?.role === "custom" && tail.customType === PLAN_CHECKPOINT_CUSTOM_TYPE
					? messages.length - 2
					: messages.length - 1;
			const candidate = messages[lastIndex];
			if (dropTrailing !== undefined && candidate?.role === "assistant" && candidate.stopReason === dropTrailing) {
				messages.splice(lastIndex, 1);
			}
			const result: CompactionResult = {
				...summary.result,
				estimatedTokensAfter:
					estimateMessagesTokens(messages) + estimateToolDefinitionTokens(this.host.conversation().activeTools),
			};
			this.lastCompactionResult = result;
			const compactionEntry = getLatestCompactionEntry(this.host.sessionManager.getBranch());
			const extensionRunner = this.host.extensionRunner();
			if (compactionEntry && extensionRunner) {
				await extensionRunner.emit({
					type: "session_compact",
					compactionEntry,
					fromExtension: summary.fromExtension,
					reason,
					willRetry,
				});
			}
			this.host.emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			return;
		}
		const cancelled = error === "Compaction cancelled";
		const aborted = status === "aborted" || (reason === "manual" && cancelled);
		this.host.emit({
			type: "compaction_end",
			reason,
			aborted,
			willRetry: false,
			...(aborted || error === undefined
				? {}
				: {
						errorMessage:
							reason === "manual"
								? `Compaction failed: ${error}`
								: reason === "overflow"
									? `Context overflow recovery failed: ${error}`
									: `Auto-compaction failed: ${error}`,
					}),
		});
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(
		customInstructions?: string,
		assertConversationGenerationCurrent?: () => void,
	): Promise<CompactionResult> {
		if (this.host.extensions().reloading || this.host.isBashRunning()) {
			throw new Error("Cannot compact while another session mutation or bash run is active");
		}
		const assertConversationCurrent = this.host.captureGenerationAssertion(assertConversationGenerationCurrent);
		assertConversationCurrent();
		if (!this.host.model()) throw new Error(formatNoModelSelectedMessage());
		this.lastCompactionResult = undefined;
		// Compaction preempts a running turn; the stop is attributed to whoever asked for it.
		if (this.host.turnActive())
			this.host
				.conversation()
				.abort(this.host.extensions().invokingMode === "rpc" ? "remote_request" : "host_action");
		const outcome = await this.host
			.conversation()
			.compact(customInstructions === undefined ? {} : { instructions: customInstructions });
		// The compaction's events, its result included, are published before it resolves.
		await this.host.conversation().waitForIdle();
		const result = this.lastCompactionResult;
		if (outcome.status !== "compacted" || !result) {
			// A compaction the session's disposal interrupted reports the disposal.
			this.host.assertNotDisposed();
			throw new Error("Compaction cancelled");
		}
		return result;
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abort(): void {
		if (this.active) this.host.conversation().abort("host_action");
	}

	/**
	 * The compaction policy, consulted inside a turn. Before the turn's first
	 * request it checks the context's tail (an earlier turn's overflow, abort,
	 * or large response, aborted responses included); between requests it
	 * stops a continuing turn at the threshold to compact mid-task; after the
	 * turn's final response it checks overflow and the threshold. An overflow
	 * compacts once and retries; a tool-free length stop retries without the
	 * truncated response.
	 */
	decision(
		cause: Exclude<ConversationCompactionCause, "manual">,
		check: ConversationCompactionCheck,
	): ConversationCompactionDecision | undefined {
		if (this.host.isDisposed()) return undefined;
		const operationId = this.host.conversation().operation?.id;
		const requested = operationId !== undefined && this.requestedOperationId === operationId;
		// Trigger early enough that the native compaction request fits beside the conversation.
		const configured = this.host.settingsManager.getCompactionSettings(check.model);
		const settings = {
			...configured,
			reserveTokens: compactionTriggerReserve(
				check.model,
				configured.reserveTokens,
				this.host.thinkingLevel(),
				this.host.modelSettings.streamOptions.thinkingBudgets,
			),
		};
		const messages = check.state.context.messages;
		const tools = this.host.conversation().activeTools;
		let decision: ConversationCompactionDecision;
		let willRetry: boolean;
		let dropTrailing: "error" | "length" | undefined;
		if (requested && check.continuing) {
			if (
				!shouldCompactBeforeContinuing({
					message: check.message,
					continuing: true,
					messages,
					tools,
					model: check.model,
					settings,
				})
			) {
				return undefined;
			}
			decision = {};
			willRetry = true;
		} else {
			const compaction = checkResponseCompaction({
				message: check.message,
				includeAborted: !requested,
				model: check.model,
				settings,
				overflowRecoveryAttempted: false,
				compactedAt: () => latestCompactionTime(check.state),
				context: () => ({ messages, tools }),
			});
			if (compaction.kind === "none" || compaction.kind === "overflow_exhausted") return undefined;
			// A length stop over the window overflowed silently: it retries without its response, as a
			// provider overflow does. A complete response over the window only compacts.
			const lengthStop = check.message.stopReason === "length";
			const retry =
				(compaction.kind === "overflow" && (lengthStop || check.message.stopReason === "error")) ||
				(compaction.kind === "threshold" && compaction.continueAfterCompaction);
			decision = retry ? { resume: "retry" } : {};
			willRetry = retry;
			if (retry) dropTrailing = lengthStop ? "length" : "error";
		}
		if (cause === "overflow") {
			this.overflowRecovered = operationId;
			willRetry = true;
			dropTrailing = "error";
		}
		this.pendingCompaction = { reason: cause, willRetry, ...(dropTrailing === undefined ? {} : { dropTrailing }) };
		return decision;
	}
}
