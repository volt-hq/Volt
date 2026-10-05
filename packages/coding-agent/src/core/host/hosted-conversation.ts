/**
 * One conversation a `ConversationHost` opened. It serves one log for its
 * whole life: its session, the cwd-bound services the session was created
 * with, its live state, its work registry, its detached reviews, the
 * one-shot recovery of durable queued input, and its managed-worktree pin
 * are fixed until it closes.
 */

import { releaseLocalSessionWorktree } from "../../daemon/session-worktree.ts";
import type { AgentSession } from "../agent-session.ts";
import type { AgentSessionDiagnostic, AgentSessionServices } from "../agent-session-services.ts";
import type { ProjectTrustContext, SessionShutdownEvent, SessionStartEvent } from "../extensions/index.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import { ReviewWorkflowManager } from "../review-workflows.ts";
import type { CreateAgentSessionResult } from "../sdk.ts";
import { wakingInputRecovery } from "../session/client-inputs.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SubagentDelegationScope } from "../subagents/delegation-scope.ts";
import type { SubagentRegistry } from "../subagents/registry.ts";
import type { WorkRegistry } from "../work/registry.ts";
import { feedLiveState, type LiveFeed } from "./live-feed.ts";
import type { LiveState } from "./live-state.ts";
import { listWorkspaceSessions, summarizeOpenSession, type WorkspaceSessionSummary } from "./session-summaries.ts";

/**
 * Result returned by the conversation factory: the created session, its
 * cwd-bound services, and all diagnostics collected during setup.
 */
export interface ConversationFactoryResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionDiagnostic[];
}

export interface SubagentRuntimeContext {
	depth: number;
	agentName: string;
	/** This runtime's own id in the session-wide delegation registry. */
	subagentId: string;
	path: string[];
	delegationScope: SubagentDelegationScope;
	/** Session-wide registry of delegated runs, shared by every runtime in the tree. */
	registry: SubagentRegistry;
	allowedSubagents?: string[];
	maxSubagentDepth?: number;
	maxChildAgents?: number;
}

/**
 * Creates a conversation's session and cwd-bound services for a target cwd
 * and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession. The host retains
 * manager-close ownership until this callback returns a session; callbacks
 * should use createAgentSessionFromServices, which borrows that ownership
 * rather than closing the manager independently.
 */
export type ConversationFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	profile?: string;
	subagentContext?: SubagentRuntimeContext;
	workspaceName?: string;
	baseRef?: string;
}) => Promise<ConversationFactoryResult>;

/**
 * How long a conversation lives: while it has clients (the default), or as
 * long as its owner keeps it open. An owner-lifetime conversation, such as a
 * subagent's, is pinned: no client can move away from it.
 */
export type ConversationLifetime = "clients" | "owner";

/** Why a conversation opened, as its `session_start` reports. */
export type ConversationOpenReason = SessionStartEvent["reason"];

interface RecoveredClientInputsTask {
	readonly promise: Promise<void>;
	settled: boolean;
	succeeded: boolean;
	cancellationRequested: boolean;
}

/** Finalize what a conversation owns besides its session's teardown, collecting every failure. */
async function finalizeConversationSession(
	session: AgentSession,
	finalizeSession: () => void | Promise<void>,
	message: string,
	initialErrors: readonly unknown[] = [],
): Promise<void> {
	const errors = [...initialErrors];
	try {
		await session.disposeSubagentToolManager();
	} catch (error) {
		errors.push(error);
	}
	try {
		await finalizeSession();
	} catch (error) {
		errors.push(error);
	}
	try {
		await releaseLocalSessionWorktree(session.sessionManager);
	} catch (error) {
		errors.push(error);
	}
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}

/** What a conversation is built from: a created session and the services it was created with. */
export type HostedConversationSession = Pick<
	ConversationFactoryResult,
	"session" | "services" | "diagnostics" | "modelFallbackMessage"
>;

export interface HostedConversationOptions {
	readonly openedAs: ConversationOpenReason;
	readonly lifetime: ConversationLifetime;
	readonly subagentContext?: SubagentRuntimeContext;
}

export class HostedConversation {
	readonly session: AgentSession;
	readonly services: AgentSessionServices;
	readonly diagnostics: AgentSessionDiagnostic[];
	readonly modelFallbackMessage: string | undefined;
	readonly subagentContext: SubagentRuntimeContext | undefined;
	readonly lifetime: ConversationLifetime;
	/** Why the conversation opened. */
	readonly openedAs: ConversationOpenReason;
	private readonly lostSignal = Promise.withResolvers<Error>();
	/**
	 * Resolves once, when the conversation's session loses its log while the
	 * conversation is open: a commit it could not confirm means it may no
	 * longer be the log's only writer. Its detached reviews are aborted; the
	 * host closes the conversation, which releases the lock. Never rejects.
	 */
	readonly lost: Promise<Error> = this.lostSignal.promise;
	/** Feeds the live state from the session until the conversation closes. */
	private readonly liveFeed: LiveFeed;
	private _reviewWorkflows?: ReviewWorkflowManager;
	private recovery?: RecoveredClientInputsTask;
	/** Operations the conversation stays open for: closing waits for them. */
	private readonly holds = new Set<Promise<void>>();
	private closePromise?: Promise<void>;

	constructor(created: HostedConversationSession, options: HostedConversationOptions) {
		this.session = created.session;
		this.services = created.services;
		this.diagnostics = created.diagnostics;
		this.modelFallbackMessage = created.modelFallbackMessage;
		this.subagentContext = options.subagentContext;
		this.lifetime = options.lifetime;
		this.openedAs = options.openedAs;
		this.liveFeed = feedLiveState(this.session);
		void this.session.lost.then((error) => {
			if (this.closePromise) return;
			// Reviews persist through the lost session's manager and cannot finish; the session stops its work.
			void this._reviewWorkflows?.abortAll().catch(() => undefined);
			this.lostSignal.resolve(error);
		});
	}

	/**
	 * The conversation's work (RFC §7): its session's work registry. The host
	 * reconciles the work a previous runtime left when it opens the
	 * conversation; closing stops every executor.
	 */
	get work(): WorkRegistry {
		return this.session.work;
	}

	/**
	 * The conversation's live state: extension status, widgets, and title,
	 * dialogs, approvals, MCP authorization flows, the run phase, Git and
	 * prompt-cache status, token use, intent availability, work progress,
	 * review workflows, and what streams. The host attaches each client's
	 * `live` view when the client joins; it closes with the session.
	 */
	get liveState(): LiveState {
		return this.session.liveState;
	}

	/** The conversation id: its log's session id. */
	get id(): string {
		return this.session.sessionId;
	}

	get cwd(): string {
		return this.services.cwd;
	}

	/** Whether the conversation is closing or closed. */
	get closed(): boolean {
		return this.closePromise !== undefined;
	}

	/**
	 * Detached review workflows of this conversation. Their progress is the
	 * live state's `workflow/<id>` value, so it survives client detach and
	 * reattach; closing the conversation aborts every active review.
	 */
	get reviewWorkflows(): ReviewWorkflowManager {
		this._reviewWorkflows ??= new ReviewWorkflowManager({
			publishEvent: (event) => this.liveFeed.workflowEvent(event),
		});
		return this._reviewWorkflows;
	}

	/**
	 * Run `operation` against the session while the conversation stays open: a
	 * close requested meanwhile, such as a lease handoff disposing the runtime,
	 * starts only once the operation settles. Rejects once the conversation is
	 * closing. The operation must not wait for this conversation to close.
	 */
	whileOpen<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
		if (this.closePromise) return Promise.reject(new Error("The conversation is closed"));
		const running = (async () => operation(this.session))();
		const held = running.then(
			() => undefined,
			() => undefined,
		);
		this.holds.add(held);
		void held.then(() => this.holds.delete(held));
		return running;
	}

	private async waitForHolds(): Promise<void> {
		while (this.holds.size > 0) await Promise.all([...this.holds]);
	}

	/** The conversation's summary, read from its open log. */
	summary(): WorkspaceSessionSummary {
		return summarizeOpenSession(this.session, this.cwd);
	}

	/** The stored sessions of the conversation's workspace, with this conversation's live summary. */
	listSessions(): Promise<WorkspaceSessionSummary[]> {
		return listWorkspaceSessions(this.session, this.cwd);
	}

	/**
	 * Start the one-shot recovery of durable queued input. A successful
	 * recovery is not repeated; a failed attempt is diagnosed, leaves its queue
	 * visible, and may be retried, never overlapping another attempt.
	 */
	startRecoveredClientInputs(): Promise<void> {
		if (this.recovery) return this.recovery.promise;
		if (this.closePromise) {
			return Promise.reject(new Error("Cannot recover client input after the conversation closed"));
		}
		const session = this.session;
		let state!: RecoveredClientInputsTask;
		const promise = session
			.resumeRecoveredClientInputs()
			.then(() => {
				state.succeeded = true;
			})
			.catch((error: unknown) => {
				if (!state.cancellationRequested && !this.closePromise) this.diagnoseRecoveryFailure();
				throw error;
			})
			.finally(() => {
				state.settled = true;
				if (!state.succeeded && this.recovery === state) this.recovery = undefined;
			});
		state = { promise, settled: false, succeeded: false, cancellationRequested: false };
		// Joined by callers and by close; observed here so a background failure is never unhandled.
		void promise.catch(() => undefined);
		this.recovery = state;
		return promise;
	}

	private diagnoseRecoveryFailure(): void {
		const recovery = wakingInputRecovery(this.session.sessionManager.getConversationState());
		const message =
			recovery.kind === "blocked"
				? `Client input ${JSON.stringify(recovery.blocker.clientMessageId)} has an ambiguous post-restart outcome; later durable queued input remains visible but fenced from automatic replay.`
				: recovery.records.length > 0
					? "Recovered client input replay failed; its durable queued input remains available for an explicit retry or daemon restart."
					: "Recovered client input processing failed after its durable dispatch boundary; it was not automatically replayed.";
		if (!this.diagnostics.some((diagnostic) => diagnostic.type === "warning" && diagnostic.message === message)) {
			this.diagnostics.push({ type: "warning", message });
			console.warn(message);
		}
	}

	/** Throws while a turn, bash run, or session mutation is active. */
	assertNotBusy(): void {
		const session = this.session;
		if (session.hasActiveSessionMutation) {
			throw new Error("Cannot change sessions while a session mutation is active; wait for it to finish");
		}
		if (session.isStreaming) {
			throw new Error("Cannot change sessions while an agent run is active; abort or wait for it to finish");
		}
		if (session.isBashRunning) {
			throw new Error("Cannot change sessions while a bash run is active; abort or wait for it to finish");
		}
	}

	/**
	 * Throws when a client may not leave the conversation for another one: a
	 * turn, bash run, or session mutation is active, a detached review runs, or
	 * durable queued input is still to be delivered or has an ambiguous outcome.
	 */
	assertCanLeave(): void {
		this.assertNotBusy();
		const session = this.session;
		if (this._reviewWorkflows?.hasActiveWorkflows) {
			throw new Error("Cannot change sessions while a detached review is active; cancel or wait for it to finish");
		}
		const recovery = wakingInputRecovery(session.sessionManager.getConversationState());
		if (recovery.kind === "blocked") {
			throw new Error("Cannot replace the session while a durable client input outcome is ambiguous");
		}
		if (recovery.kind === "replay") {
			throw new Error("Cannot replace the session while durable client input is still queued");
		}
	}

	/**
	 * Fence the conversation for a client leaving it: it must be idle
	 * (`assertCanLeave`), and its admission stays suspended until the returned
	 * release runs, so no turn, bash run, or background job starts meanwhile.
	 * A conversation that closes after the client left never releases it.
	 */
	holdForLeave(): () => void {
		this.assertCanLeave();
		return this.session.suspendAdmission();
	}

	/**
	 * Close the conversation: wait for the operations it stays open for, stop
	 * its work, abort its detached reviews and input recovery, emit
	 * `session_shutdown`, then dispose its session, which releases the log's
	 * lock. A conversation its clients moved away from (`reason` other than
	 * quit) does not wait for the session's admitted prompt work, which may be
	 * the extension command that moved them. Every caller joins one close.
	 */
	close(event: {
		reason: SessionShutdownEvent["reason"];
		targetSessionRef?: SessionShutdownEvent["targetSessionRef"];
		/** Runs after `session_shutdown`, before the session is disposed. */
		beforeDispose?: () => void;
	}): Promise<void> {
		this.closePromise ??= this.performClose(event);
		return this.closePromise;
	}

	private async performClose(event: {
		reason: SessionShutdownEvent["reason"];
		targetSessionRef?: SessionShutdownEvent["targetSessionRef"];
		beforeDispose?: () => void;
	}): Promise<void> {
		const moved = event.reason !== "quit";
		await this.waitForHolds();
		await this.work.cancelAll("closed").catch(() => undefined);
		await this._reviewWorkflows?.abortAll().catch(() => undefined);
		await this.abortRecovery(moved ? "session_replacement" : "disposal");
		this.liveFeed.close();
		const shutdownErrors: unknown[] = [];
		try {
			await emitSessionShutdownEvent(this.session.extensionRunner, {
				type: "session_shutdown",
				reason: event.reason,
				...(event.targetSessionRef === undefined ? {} : { targetSessionRef: event.targetSessionRef }),
			});
			event.beforeDispose?.();
		} catch (error) {
			shutdownErrors.push(error);
		}
		const session = this.session;
		await finalizeConversationSession(
			session,
			async () => {
				session.dispose(moved ? "session_replacement" : "disposal", { leavePromptWork: moved });
				await session.waitForClosed();
			},
			"Conversation cleanup did not complete",
			shutdownErrors,
		);
	}

	/** Close a conversation no client ever joined: no `session_shutdown`, its session is disposed. */
	discard(): Promise<void> {
		this.closePromise ??= (async () => {
			await this.waitForHolds();
			await this.work.cancelAll("closed").catch(() => undefined);
			this.liveFeed.close();
			const session = this.session;
			await finalizeConversationSession(
				session,
				async () => {
					session.dispose("disposal");
					await session.waitForClosed();
				},
				"Conversation cleanup did not complete",
			);
		})();
		return this.closePromise;
	}

	private async abortRecovery(source: "session_replacement" | "disposal"): Promise<void> {
		const recovery = this.recovery;
		if (!recovery || recovery.settled) return;
		recovery.cancellationRequested = true;
		await this.session.abort(source).catch(() => undefined);
		await recovery.promise.catch(() => undefined);
	}
}
