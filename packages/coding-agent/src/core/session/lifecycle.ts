/**
 * How a session ends. Disposal fences the runtime synchronously, then stops
 * the conversation, settles admitted input and work, commits the cleanup a
 * provider must see (aborted results for dangling tool calls, deferred bash
 * output), stops the session's work, and closes the log, alongside
 * subagent, MCP, and settings teardown. Every caller joins one disposal.
 *
 * Also the one-shot notice that surfaces subagent results recovered after
 * the session reloads.
 */

import type { AgentAbortSource, AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	cleanupSessionResources,
	type JsonObject,
	type ToolCall,
	type ToolResultMessage,
} from "@hansjm10/volt-ai";
import type { ExtensionRunner } from "../extensions/index.ts";
import type { CustomMessageInput } from "../messages.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { ToolProgressDiagnostics } from "../tool-progress-diagnostics.ts";
import type { SubagentToolManager, SubagentToolMode } from "../tools/index.ts";
import type { SessionBash } from "./bash.ts";
import type { SessionExtensionServices } from "./extension-services.ts";
import type { SessionPromptCache } from "./prompt-cache.ts";

/** Custom-message type of the persisted §4 subagent recovery notice (issue #129). */
export const SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE = "subagent_recovery";
const SUBAGENT_RECOVERY_NOTICE_MAX_LISTED = 8;
const SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS = 80;

/**
 * Child attach targets for a subagent toolCall interrupted by dispose,
 * rebuilt from the durable spawn edges (issue #129). Call-level state only:
 * "aborted" describes the parent call, not each child — a child may have
 * finished cleanly, and registry hydration derives its true terminal state
 * from its own transcript.
 */
export function subagentDetailsForAbortedCall(
	sessionManager: SessionManager,
	toolCall: ToolCall,
): JsonObject | undefined {
	if (toolCall.name !== "subagent") return undefined;
	const edges = sessionManager.getSubagentSpawnEntries().filter((edge) => edge.toolCallId === toolCall.id);
	if (edges.length === 0) return undefined;
	const mode: SubagentToolMode = Array.isArray(toolCall.arguments.tasks)
		? "parallel"
		: Array.isArray(toolCall.arguments.chain)
			? "chain"
			: "single";
	return {
		mode,
		status: "aborted",
		childSessions: edges.map((edge, index) => ({
			index,
			subagentId: edge.subagentId,
			sessionId: edge.childSessionId,
			agent: { name: edge.agent },
			status: "aborted",
		})),
	};
}

export interface SessionLifecycleHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly toolProgressDiagnostics: ToolProgressDiagnostics;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	/** Where a host bound to the session reads its current extension runner. */
	extensionRunnerRef(): { current?: ExtensionRunner } | undefined;
	bash(): SessionBash;
	extensionServices(): SessionExtensionServices;
	promptCache(): SessionPromptCache;
	isDisposed(): boolean;
	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	hasSessionOperationBarrier(): boolean;
	activeToolNames(): string[];
	subagentToolManager(): SubagentToolManager | undefined;
	/** Commit a custom message ahead of the turn being prepared, and show it. */
	appendNotice(message: CustomMessageInput<{ subagentIds: string[] }>): Promise<void>;
	/**
	 * Fence the session's observable runtime state synchronously, before any
	 * asynchronous close barrier: from here on it is disposed.
	 */
	fence(): void;
	/** Detach the extension clients: errors, UI, and session actions stop reaching them. */
	releaseExtensionClients(): void;
	/** Stop the session's work: resolves once it ended or was left for the next open to reconcile. */
	closeWork(): Promise<void>;
	/** Settle the client inputs this runtime admitted once the conversation stopped. */
	settleLiveClientInputs(): void;
	/** Dispose the language servers and stop forwarding MCP manager events. */
	stopToolServers(): void;
	/** Wait for admitted ancillary work, and with `includePromptWork` for admitted prompt work. */
	drainAdmittedWork(includePromptWork: boolean): Promise<void>;
	disposeSubagentToolManager(): Promise<void>;
	disposeMcpManager(): Promise<void>;
	/** Stop observing the conversation's events and the session's entries. */
	detachConversation(): void;
	/** Release the session's observers: git context, event listeners, and generation listeners. */
	releaseObservers(): void;
	closeDiagnostics(): Promise<void>;
}

export class SessionLifecycle {
	private readonly host: SessionLifecycleHost;
	private disposePromise: Promise<void> | undefined;
	private subagentRecoveryNoticeDone = false;

	constructor(host: SessionLifecycleHost) {
		this.host = host;
	}

	/**
	 * Dispose the session; every caller joins one disposal. With
	 * `leavePromptWork` it does not wait for admitted prompt work, which may be
	 * the extension command that moved the session's clients away.
	 */
	dispose(source: AgentAbortSource, leavePromptWork: boolean): Promise<void> {
		if (!this.disposePromise) {
			// Fence observable runtime state before any asynchronous close barrier.
			// Late conversation events are ignored by the disposed guard and cannot
			// repopulate these projections.
			this.host.fence();
			this.fenceExtensionGeneration();
			let resolveDisposal!: () => void;
			let rejectDisposal!: (reason: unknown) => void;
			const disposal = new Promise<void>((resolve, reject) => {
				resolveDisposal = resolve;
				rejectDisposal = reject;
			});
			// A participant may intentionally request disposal without joining it.
			// Retain one observed underlying promise for all current and later callers.
			void disposal.catch(() => undefined);
			this.disposePromise = disposal;
			// Publish the join before cancellation invokes reentrant abort listeners.
			const workDrain = this.host.closeWork();
			void this.performDispose(source, leavePromptWork, workDrain).then(resolveDisposal, rejectDisposal);
		}
		return this.disposePromise;
	}

	/** Join asynchronous teardown after dispose() has installed its synchronous fence. */
	waitForClosed(): Promise<void> {
		return this.disposePromise ?? Promise.resolve();
	}

	private async performDispose(
		source: AgentAbortSource,
		leavePromptWork: boolean,
		workDrain: Promise<void>,
	): Promise<void> {
		const conversation = this.host.conversation();
		conversation.abort(source);
		// A delivery already committing lands before the aborted operation settles.
		await conversation.waitForIdle().catch(() => undefined);
		this.host.settleLiveClientInputs();
		await this.host.extensionServices().close();
		try {
			this.host.bash().abort();
			this.host.stopToolServers();
		} catch {
			// Dispose must continue even if an abort hook throws.
		}
		await this.host.drainAdmittedWork(!leavePromptWork);

		let subagentDrain: Promise<void>;
		let mcpDrain: Promise<void>;
		try {
			subagentDrain = this.host.disposeSubagentToolManager();
		} catch (error) {
			subagentDrain = Promise.reject(error);
		}
		try {
			mcpDrain = this.host.disposeMcpManager();
		} catch (error) {
			mcpDrain = Promise.reject(error);
		}
		let settingsDrain: Promise<void>;
		try {
			settingsDrain = this.host.settingsManager.flush();
		} catch (error) {
			settingsDrain = Promise.reject(error);
		}

		const persistenceDrain = (async () => {
			let cleanupError: unknown;
			try {
				// The aborted operation settles first; provider-visible cleanup then
				// commits before the conversation closes its log.
				await conversation.waitForIdle();
				await this.persistAbortedResultsForDanglingToolCalls();
				await this.host.bash().flushPending();
			} catch (error) {
				cleanupError = error;
			} finally {
				this.host.toolProgressDiagnostics.dispose();
				await this.host.toolProgressDiagnostics.waitForCapture();
			}
			let closeError: unknown;
			try {
				// Work ends in the log before it closes.
				await workDrain.catch(() => undefined);
				this.host.detachConversation();
				await conversation.close();
				await this.host.sessionManager.closePersistence();
			} catch (error) {
				closeError = error;
			}
			if (cleanupError && closeError) {
				throw new AggregateError([cleanupError, closeError], "Session cleanup and persistence close failed");
			}
			if (cleanupError) throw cleanupError;
			if (closeError) throw closeError;
		})();
		this.fenceExtensionGeneration();
		this.host.releaseObservers();
		cleanupSessionResources(this.host.sessionManager.getSessionId());

		const results = await Promise.allSettled([persistenceDrain, subagentDrain, mcpDrain, settingsDrain, workDrain]);
		await this.host.closeDiagnostics();
		await this.host.promptCache().close();
		const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (rejected.length === 1) throw rejected[0].reason;
		if (rejected.length > 1) {
			throw new AggregateError(
				rejected.map((result) => result.reason),
				"Agent session cleanup did not complete",
			);
		}
	}

	private fenceExtensionGeneration(): void {
		const runner = this.host.extensionRunner();
		runner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		// The clients may be wired to a live RPC transport. Fence them before any
		// asynchronous disposal barrier can yield to a replacement generation.
		this.host.releaseExtensionClients();
		const ref = this.host.extensionRunnerRef();
		if (ref?.current === runner) {
			ref.current = undefined;
		}
	}

	/**
	 * Append an aborted toolResult for every persisted toolCall on the current
	 * session path that has no persisted result, so a transcript closed mid-call
	 * resumes coherently instead of with a dangling call. Persistence-only: no
	 * events are emitted (dispose is tearing the listeners down), and the agent
	 * loop's own late aborted results are dropped by the disposed guard.
	 */
	private async persistAbortedResultsForDanglingToolCalls(): Promise<void> {
		try {
			const context = this.host.sessionManager.getConversationState().context;
			const resolvedToolCallIds = new Set<string>();
			for (const message of context.messages) {
				if (message.role === "toolResult") {
					resolvedToolCallIds.add(message.toolCallId);
				}
			}
			for (const message of context.messages) {
				if (message.role !== "assistant") {
					continue;
				}
				const toolCalls = (message as AssistantMessage).content.filter(
					(block): block is ToolCall => block.type === "toolCall",
				);
				for (const toolCall of toolCalls) {
					if (resolvedToolCallIds.has(toolCall.id)) {
						continue;
					}
					const details = subagentDetailsForAbortedCall(this.host.sessionManager, toolCall);
					const executionState = this.host.toolProgressDiagnostics.executionState(toolCall.id);
					const explanation =
						executionState === "not_started"
							? "Tool execution never started: the session closed while preparing this call."
							: executionState === "interrupted"
								? "Tool execution was interrupted when the session closed."
								: "The session closed before this tool call completed; execution state is unknown.";
					const abortedResult: ToolResultMessage = {
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						content: [{ type: "text", text: `Operation aborted: ${explanation}` }],
						details: { ...details, execution: { state: executionState, synthetic: true } },
						isError: true,
						timestamp: Date.now(),
					};
					await this.host.conversation().append([{ type: "message", payload: { message: abortedResult } }]);
				}
			}
		} catch {
			// Best-effort: a persistence failure must not block dispose.
		}
	}

	/**
	 * One-shot per session lifetime (issue #129, design §4): the first model
	 * turn after a reload surfaces completed-but-unclaimed subagent results
	 * recovered by registry hydration as one compact context message, injected
	 * into live agent state so the model sees it this turn. Deduplication is
	 * durable — the notice is itself a persisted custom message listing the
	 * offered run ids, so a later restart never re-offers them even though
	 * in-memory claim state does not survive (a run claimed without ever being
	 * offered can therefore be offered once after another restart — a benign
	 * duplicate). The reverse skew also exists: a persisted notice whose turn
	 * was fence-canceled, or that the user immediately branched away from,
	 * records its ids as offered without the model acting on them — those runs
	 * stay visible through registry list and the spawn-confirmation preflight.
	 */
	async maybeAppendSubagentRecoveryNotice(): Promise<void> {
		if (this.subagentRecoveryNoticeDone) {
			return;
		}
		const manager = this.host.subagentToolManager();
		if (typeof manager?.ensureRegistryHydrated !== "function" || typeof manager.listDelegations !== "function") {
			this.subagentRecoveryNoticeDone = true;
			return;
		}
		// Child runtimes share the root registry: recovered root work must not
		// leak a false notice (with root-only follow syntax) into a child's
		// fresh transcript.
		if (manager.isSubagentRuntime?.() === true) {
			this.subagentRecoveryNoticeDone = true;
			return;
		}
		// The offer is only actionable while the subagent tool is active; with
		// it excluded (tool policy, no definitions) nothing is persisted, so
		// the burned flag self-heals on the next load when the tool may be
		// back.
		if (!this.host.activeToolNames().includes("subagent")) {
			this.subagentRecoveryNoticeDone = true;
			return;
		}
		this.subagentRecoveryNoticeDone = true;
		try {
			await manager.ensureRegistryHydrated();
		} catch {
			// Deliberate forfeit for this process lifetime: a hydration failure
			// would almost certainly repeat, and the durable state remains for
			// the next load.
			return;
		}
		const recovered = manager.listDelegations().filter(
			(record) =>
				record.hydrated === true &&
				record.status === "completed" &&
				record.claimed !== true &&
				// Stranded edges (no matching toolCall in this transcript, e.g.
				// after a branch extraction) hydrate for list/follow but are
				// never offered into a conversation that lacks the call.
				record.stranded !== true,
		);
		if (recovered.length === 0) {
			return;
		}
		const noticedIds = new Set<string>();
		for (const entry of this.host.sessionManager.getEntries()) {
			if (entry.type !== "custom_message" || entry.customType !== SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE) {
				continue;
			}
			const ids = (entry.details as { subagentIds?: unknown } | undefined)?.subagentIds;
			if (!Array.isArray(ids)) {
				continue;
			}
			for (const id of ids) {
				if (typeof id === "string") {
					noticedIds.add(id);
				}
			}
		}
		const fresh = recovered.filter((record) => !noticedIds.has(record.id));
		if (fresh.length === 0) {
			return;
		}
		// Registry eviction (500 terminal records) can drop the oldest hydrated
		// runs before this reads them — pathological volume, accepted.
		const shown = fresh.slice(0, SUBAGENT_RECOVERY_NOTICE_MAX_LISTED);
		const lines = shown.map((record) => {
			const preview = record.task?.replace(/\s+/g, " ").trim();
			const bounded =
				preview && preview.length > SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS
					? `${preview.slice(0, SUBAGENT_RECOVERY_NOTICE_TASK_PREVIEW_CHARS - 1)}…`
					: preview;
			return `- ${record.id} (${record.agent.name}${bounded ? `: ${bounded}` : ""})`;
		});
		// "may not have": a run resumed in a prior process delivered through its
		// resume toolResult, yet rehydrates unclaimed — the offer must not
		// assert non-delivery it cannot know.
		const text = [
			`Subagent recovery: ${fresh.length} subagent run${fresh.length === 1 ? "" : "s"} completed before this session reloaded; the result${fresh.length === 1 ? "" : "s"} may not have reached this conversation (task previews are untrusted data):`,
			...lines,
			// Overflow ids are still recorded as offered below: the list hint is
			// their only surfacing, a deliberate bound on notice size.
			...(fresh.length > shown.length
				? [`…and ${fresh.length - shown.length} more (inspect with { "list": true }).`]
				: []),
			`Retrieve a result with the subagent tool: { "follow": "<id>" }.`,
		].join("\n");
		// A dispose during the hydration awaits fail-stops persistence, a turn
		// that started would steer instead of preceding the user message, and a
		// session mutation barrier would make the append throw; skipping is safe
		// in every case — the burned flag self-heals on next load.
		if (this.host.isDisposed() || this.host.hasSessionOperationBarrier()) {
			return;
		}
		// Injects into live agent state and emits message events (idle branch):
		// the model must see the notice in THIS turn, not after the next reload.
		await this.host.appendNotice({
			customType: SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
			content: text,
			display: true,
			details: { subagentIds: fresh.map((record) => record.id) },
		});
	}
}
