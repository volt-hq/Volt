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
import { type Api, estimateToolDefinitionTokens, type Model } from "@hansjm10/volt-ai";
import type { ActiveCompaction, AgentSessionConfig, AgentSessionEvent, CompactionReason } from "../agent-session.ts";
import { formatNoModelSelectedMessage } from "../auth-guidance.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import { compactContext } from "../compaction/context-compaction.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	estimateMessagesTokens,
	prepareCompaction,
	type SummarizationRetryOptions,
} from "../compaction/index.ts";
import type { ExtensionRunner, SessionBeforeCompactResult } from "../extensions/index.ts";
import { withoutExtensionWork } from "../extensions/work-runtime.ts";
import { PLAN_CHECKPOINT_CUSTOM_TYPE } from "../planning.ts";
import { getLatestCompactionEntry, type SessionEntry, type SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { writeToolProgressCapture } from "../tool-progress-capture.ts";
import type { SessionBackgroundContinuation } from "./background-continuation.ts";
import { checkResponseCompaction, latestCompactionTime, shouldCompactBeforeContinuing } from "./compaction-policy.ts";
import type { SessionExtensionBinding } from "./extension-binding.ts";
import type { ModelSettings } from "./model-settings.ts";
import type { SessionPlanning } from "./planning.ts";

const MAX_COMPACTION_SUMMARY_RETRIES = 2;
const MAX_COMPACTION_RETRY_DELAY_MS = 30_000;

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
	background(): SessionBackgroundContinuation;
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

	private generate(
		preparation: CompactionPreparation,
		model: Model<Api>,
		pathEntries: SessionEntry[],
		messages: readonly AgentMessage[],
		operation: { readonly stream: StreamFn; readonly signal: AbortSignal },
		customInstructions?: string,
	): Promise<CompactionResult> {
		const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
		const retainedCount = pathEntries
			.slice(firstKeptIndex)
			.filter(
				(entry) =>
					entry.type === "message" ||
					entry.type === "custom_message" ||
					(entry.type === "branch_summary" && entry.summary),
			).length;
		// Keep the full rebuilt conversation warm, including the latest response.
		// Describe the retained suffix only in the appended checkpoint instruction.
		return compactContext(preparation, model, {
			sourceMessageCount: messages.length,
			retainedMessageCount: retainedCount,
			context: async (signal) => {
				const transformed = await withoutExtensionWork(() =>
					this.host.extensionRunner().emitContext(cloneCanonicalData([...messages], "Agent message delivery")),
				);
				signal.throwIfAborted();
				const llmMessages = await this.host.convertToLlm(transformed);
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
			// Written before the error surfaces so the record exists when the user sees it.
			onFailure: (report) =>
				writeToolProgressCapture(
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
				),
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
		// A branch of settings entries alone (its model selection) has nothing to compact.
		const preparation =
			this.host.conversation().state.context.messages.length === 0
				? undefined
				: prepareCompaction(pathEntries, branchMessages, settings, {
						tools: this.host.conversation().activeTools,
						contextWindow: model.contextWindow,
					});
		if (!preparation) {
			if (reason !== "manual") throw new Error("Auto-compaction could not find a safe compaction boundary");
			if (pathEntries.at(-1)?.type === "compaction") throw new Error("Already compacted");
			throw new Error("Nothing to compact (session too small)");
		}

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
		const compaction =
			extensionCompaction ??
			(await this.generate(
				preparation,
				model,
				pathEntries,
				branchMessages,
				{ stream: request.stream, signal: request.signal },
				request.instructions,
			));
		if (request.signal.aborted) throw new Error("Compaction cancelled");
		this.compactionSummary = {
			result: {
				summary: compaction.summary,
				firstKeptEntryId: compaction.firstKeptEntryId,
				tokensBefore: compaction.tokensBefore,
				...(compaction.details === undefined ? {} : { details: compaction.details }),
			},
			fromExtension: extensionCompaction !== undefined,
		};
		const planningCheckpoint = this.host.planning().createCheckpointMessage(this.host.planning().current);
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
			this.host.background().readinessChanged();
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
		try {
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
		} finally {
			this.host.background().schedule();
		}
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
		const settings = this.host.settingsManager.getCompactionSettings(check.model);
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
