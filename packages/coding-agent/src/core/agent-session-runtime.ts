import { randomUUID } from "node:crypto";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type { ProjectTrustContext, ReplacedSessionContext, SessionStartEvent } from "./extensions/index.ts";
import { ClientScope } from "./host/client-scope.ts";
import { ConversationHost, type OpenConversationResult, PinnedConversationError } from "./host/conversation-host.ts";
import type {
	CreateAgentSessionRuntimeFactory,
	HostedConversation,
	SubagentRuntimeContext,
} from "./host/hosted-conversation.ts";
import {
	listWorkspaceSessions,
	sameFilesystemLocation,
	type WorkspaceSessionSummary,
} from "./host/session-summaries.ts";
import type { ConversationTarget, HostClient } from "./host/targets.ts";
import {
	clonePlanState,
	createPlanExecutionPrompt,
	PLAN_EXECUTION_CUSTOM_TYPE,
	type PlanExecution,
	type PlanExecutionStrategy,
	type PlanningState,
	StalePlanRevisionError,
} from "./planning.ts";
import { PR_CHECKOUT_CHANGED, readPrReviewBinding } from "./pr-review-binding.ts";
import { registerReviewHandoffAliases } from "./review-anchors.ts";
import type { ReviewDiscussionService } from "./review-discussions.ts";
import { prepareReviewGeneralReplacement } from "./review-general.ts";
import { captureReviewStateForHandoff, listReviewRuns, restoreReviewStateFromHandoff } from "./review-state.ts";
import type { ReviewWorkflowManager } from "./review-workflows.ts";
import { ConversationProjectionFeed } from "./rpc/conversation-projection-feed.ts";
import {
	assertValidSessionId,
	findSessionInfoById,
	getDefaultSessionDir,
	SessionManager,
	type SessionReference,
} from "./session-manager.ts";
import type { SessionWriter } from "./session-writer.ts";

export { SessionImportFileNotFoundError } from "./host/conversation-host.ts";
export {
	type ConversationTranscriptCommittedEvent,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	isConversationTranscriptCommittedEvent,
	type SubagentRuntimeContext,
} from "./host/hosted-conversation.ts";
export type { WorkspaceSessionSummary } from "./host/session-summaries.ts";

export interface AgentSessionSwitchOptions {
	cwdOverride?: string;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	/** Internal remote mutation lease revalidated at every awaited replacement boundary. */
	assertConversationGenerationCurrent?: () => void;
}

export interface AgentSessionReplacementTransaction {
	commit(): Promise<void>;
	/** Finish host ownership before replacement callbacks and any durable publication barrier. */
	finalize?(): Promise<void>;
	rollback(): Promise<void>;
	dispose(): Promise<void>;
}

export interface AgentSessionReplacementTarget {
	previousSessionId: string;
	sessionId: string;
	cwd?: string;
}

/**
 * Result of a structural session operation (`newSession`, `fork`,
 * `switchSession`, `switchSessionById`).
 *
 * - `cancelled: true` — an extension cancelled the operation; the current
 *   session is unchanged and no `withSession` callback ran.
 * - `seeded` — the requested `withSession` callback ran to completion against
 *   the new session. Always `false` when no callback was requested, and
 *   `false` for no-op switches that target the current session. When
 *   `cancelled` is `false`, a callback was requested, and the session
 *   changed, `seeded: false` means the recovered-client-input gate failed
 *   and skipped the callback: the new session and its durable queue remain
 *   authoritative, but nothing was seeded into it. Callers that treat a
 *   non-cancelled result as "the seed landed" must check `seeded`.
 */
export interface AgentSessionReplacementResult {
	cancelled: boolean;
	seeded: boolean;
}

export interface AgentSessionNewSessionOptions {
	parentSessionRef?: SessionReference;
	preserveReviewRunId?: string;
	replaceReviewGeneral?: boolean;
	/** RPC request correlated with the new session's bootstrap, when any. */
	rebindRequestId?: string;
	/** Override the new session's cwd (e.g. a daemon-managed worktree checkout). */
	cwd?: string;
	/** Override the session dir (e.g. the parent workspace's default dir for worktree sessions). */
	sessionDir?: string;
	/** Host-owned workspace display name for the new session's Git context. */
	workspaceName?: string;
	/** Trusted managed-worktree base ref for the new session's Git context. */
	baseRef?: string;
	/** Write the new session before it opens, through its log writer. */
	setup?: (writer: SessionWriter) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	/** Internal remote mutation lease revalidated at every awaited replacement boundary. */
	assertConversationGenerationCurrent?: () => void;
}

function sessionRefsEqual(left: SessionReference, right: SessionReference): boolean {
	return (
		resolvePath(left.sessionDirectory) === resolvePath(right.sessionDirectory) &&
		left.storeId === right.storeId &&
		left.sessionId === right.sessionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

/** Roll back a host replacement transaction that no move took over; returns the error to report. */
async function rollbackPreparedReplacement(
	transaction: AgentSessionReplacementTransaction | undefined,
	error: unknown,
): Promise<unknown> {
	if (!transaction) return error;
	try {
		await transaction.rollback();
		return error;
	} catch (rollbackError) {
		return new AggregateError(
			[error, rollbackError],
			"Session replacement failed and its host transaction could not be rolled back",
		);
	}
}

/** How a committed move hands the runtime's modes over to the new conversation. */
interface Handover {
	readonly transaction: AgentSessionReplacementTransaction | undefined;
	readonly rebindRequestId: string | undefined;
	/** The projection publishes the new identity only after the durable publication step. */
	readonly deferProjection: boolean;
}

type MoveOutcome =
	| { readonly cancelled: true }
	| {
			readonly cancelled: false;
			/** The conversation moved to; absent for a no-op switch to the current session. */
			readonly to?: HostedConversation;
			/** Whether a requested `withSession` may run: the recovered-input gate passed. */
			readonly seedable: boolean;
			/** Set when `withSession` already ran inside the move, before a durable publication. */
			readonly seeded?: boolean;
			readonly selectedText?: string;
	  };

/**
 * One client's view of a `ConversationHost`, for modes that still bind through
 * session-replacement hooks. Every structural operation opens another
 * conversation before the current one closes, so an open that fails leaves
 * the runtime on its current session. A committed move then fires the hooks
 * modes bind through: the before-invalidate hook, the projection rebind, the
 * will-project listeners, the rebind hook, and the replaced listeners, after
 * which the previous conversation closes with its `session_shutdown`.
 *
 * Structural operations run one at a time; one admitted for a session that is
 * no longer current fails as stale. A failure after the move committed ends
 * the runtime.
 */
export class AgentSessionRuntime {
	private readonly host: ConversationHost;
	private current: HostedConversation;
	private readonly client: HostClient;
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private prepareSessionReplacement?: (
		target: AgentSessionReplacementTarget,
	) => Promise<AgentSessionReplacementTransaction | undefined>;
	private readonly sessionWillProjectListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private readonly sessionReplacementListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private beforeSessionInvalidate?: () => void;
	private detachProjectionEvents: () => void;
	private handover: Handover | undefined;
	private moveTail: Promise<void> = Promise.resolve();
	/** Set by disposal and by a failed handover: no further structural operations. */
	private ended = false;
	/** Set by a failed handover, which closed every conversation. */
	private failed = false;
	private disposePromise?: Promise<void>;
	private recoveredClientInputsEnabled = false;
	private readonly lostSignal = Promise.withResolvers<Error>();
	/**
	 * Resolves once, when the runtime's current session loses its log: a commit
	 * it could not confirm (a fence conflict, a missing session, or an outcome
	 * that could not be resolved) means it may no longer be the log's only
	 * writer. The runtime ends: the session has cancelled its work and its
	 * detached reviews are aborted. The host disposes the runtime, which releases
	 * the session's lock, and reports the error; reopening the session with
	 * `/resume` continues from what was saved. A loss of a session the runtime
	 * has already moved away from does not end it. Never rejects.
	 */
	readonly lost: Promise<Error> = this.lostSignal.promise;
	readonly conversationProjectionFeed: ConversationProjectionFeed;
	/** Installed only by a daemon with sibling runtime ownership. */
	reviewDiscussions?: ReviewDiscussionService;

	/** Over a conversation the host opened. */
	constructor(host: ConversationHost, conversation: HostedConversation);
	/** Over a session created outside a host, in a host of its own that opens later sessions through `createRuntime`. */
	constructor(
		session: AgentSession,
		services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		diagnostics?: AgentSessionRuntimeDiagnostic[],
		modelFallbackMessage?: string,
		subagentContext?: SubagentRuntimeContext,
	);
	constructor(
		first: ConversationHost | AgentSession,
		second: HostedConversation | AgentSessionServices,
		createRuntime?: CreateAgentSessionRuntimeFactory,
		diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		modelFallbackMessage?: string,
		subagentContext?: SubagentRuntimeContext,
	) {
		if (first instanceof ConversationHost) {
			this.host = first;
			this.current = second as HostedConversation;
		} else {
			const services = second as AgentSessionServices;
			if (!createRuntime) throw new Error("A runtime over a session needs a runtime factory");
			this.host = new ConversationHost({ factory: createRuntime, agentDir: services.agentDir });
			this.current = this.host.adoptSession(
				{ session: first, services, diagnostics, modelFallbackMessage },
				subagentContext === undefined ? {} : { subagentContext },
			);
		}
		if (this.current.closed) throw new Error("Cannot create an agent session runtime over a closed conversation");
		this.client = {
			id: randomUUID(),
			anchor: true,
			move: { kind: "in_place", onMoved: (to, from) => this.handOver(to, from) },
		};
		// Without a surface the attachment registers synchronously; the modes attach their own extension clients.
		void this.host.attach(this.client, this.current).catch(() => undefined);
		this.conversationProjectionFeed = new ConversationProjectionFeed(this.current.projectionSource);
		this.detachProjectionEvents = this.relayProjectionEvents(this.current);
		this.observeLoss(this.current);
	}

	private relayProjectionEvents(conversation: HostedConversation): () => void {
		return conversation.subscribeProjectionEvents((event) => {
			this.conversationProjectionFeed.publishExternal(event);
		});
	}

	/** End the runtime when `conversation` loses its log while it is still the runtime's conversation. */
	private observeLoss(conversation: HostedConversation): void {
		void conversation.lost.then(async (error) => {
			// A move in progress settles which conversation the runtime keeps.
			await this.moveTail;
			if (this.current !== conversation || this.ended) return;
			this.lostSignal.resolve(error);
		});
	}

	get services(): AgentSessionServices {
		return this.current.services;
	}

	get session(): AgentSession {
		return this.current.session;
	}

	get cwd(): string {
		return this.current.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this.current.diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this.current.modelFallbackMessage;
	}

	/**
	 * Detached review workflows of the current conversation. Events are
	 * published through the runtime conversation projection feed so they
	 * survive client detach/reattach; closing the conversation aborts every
	 * active review.
	 */
	get reviewWorkflows(): ReviewWorkflowManager {
		return this.current.reviewWorkflows;
	}

	/** Host-only creation: opens a review discussion beside this runtime without moving it. */
	async createReviewDiscussionSibling(manager: SessionManager): Promise<AgentSessionRuntime> {
		if (
			this.session.isReviewDiscussion ||
			!manager.getReviewDiscussion() ||
			!sameFilesystemLocation(manager.getCwd(), this.cwd)
		) {
			await manager.closePersistence();
			throw new Error("Review sibling requires an exact source cwd and a durable child binding");
		}
		const opened = await this.host.open(
			{ kind: "adopt", sessionManager: manager, cwd: this.cwd },
			{
				profile: this.services.settingsManager.getRequestedProfile(),
				...(this.services.workspaceName === undefined ? {} : { workspaceName: this.services.workspaceName }),
				...(this.services.baseRef === undefined ? {} : { baseRef: this.services.baseRef }),
			},
		);
		if (opened.cancelled) throw new Error("Review sibling open was cancelled");
		return new AgentSessionRuntime(this.host, opened.conversation);
	}

	/**
	 * Start the one-shot recovery of durable queued remote input. The projection
	 * source is already bound when this is called, so recovered transcript and
	 * queue events remain observable even though runtime attachment does not wait
	 * for the provider turn to drain. Later sessions recover theirs when the
	 * runtime moves to them.
	 */
	startRecoveredClientInputs(): Promise<void> {
		this.recoveredClientInputsEnabled = true;
		if (this.ended) {
			return Promise.reject(new Error("Cannot recover client input after the agent runtime was invalidated"));
		}
		return this.current.startRecoveredClientInputs();
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	setPrepareSessionReplacement(
		prepare?: (target: AgentSessionReplacementTarget) => Promise<AgentSessionReplacementTransaction | undefined>,
	): void {
		this.prepareSessionReplacement = prepare;
	}

	/** The currently installed rebind handler, so a temporary owner can restore it. */
	getRebindSession(): ((session: AgentSession) => Promise<void>) | undefined {
		return this.rebindSession;
	}

	/**
	 * Observe every session the runtime moves to without taking ownership of
	 * the runtime's primary rebind hook. Co-attached RPC frontends use this so
	 * one subscriber cannot overwrite another's lifecycle callback.
	 */
	subscribeSessionReplaced(listener: (session: AgentSession) => Promise<void> | void): () => void {
		this.sessionReplacementListeners.add(listener);
		return () => {
			this.sessionReplacementListeners.delete(listener);
		};
	}

	/**
	 * Register a host-ownership barrier for moves. The new source is already
	 * bound and reducing state, but its cursor-zero generation remains
	 * unpublished until every listener has atomically rekeyed runtime/lease state.
	 */
	subscribeSessionWillProject(listener: (session: AgentSession) => Promise<void> | void): () => void {
		this.sessionWillProjectListeners.add(listener);
		return () => {
			this.sessionWillProjectListeners.delete(listener);
		};
	}

	/**
	 * Set a synchronous callback for host-owned UI teardown that must not yield
	 * to the event loop, such as detaching extension-provided TUI components
	 * before the old extension context becomes stale. A move runs it once the
	 * move committed, before the new session's extensions start; disposal runs
	 * it after `session_shutdown`.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	/** Publish a canonical conversation reducer event to every attached subscriber. */
	publishConversationProjectionEvent(event: object): void {
		this.conversationProjectionFeed.publishExternal(event);
	}

	getCurrentSessionSummary(): WorkspaceSessionSummary {
		return this.current.summary();
	}

	listSessions(): Promise<WorkspaceSessionSummary[]> {
		return listWorkspaceSessions(this.session, this.cwd);
	}

	/**
	 * Run a structural operation against the current conversation, after any
	 * earlier one. An operation whose conversation or branch changed while it
	 * waited fails as stale.
	 */
	private runMove(
		operation: (source: HostedConversation) => Promise<MoveOutcome>,
		assertConversationGenerationCurrent?: () => void,
	): Promise<MoveOutcome> {
		const source = this.current;
		if (source.session.isReviewDiscussion) {
			return Promise.reject(
				new Error("Finding discussion identity is source-linked; reset context from the source review"),
			);
		}
		if (this.ended) {
			return Promise.reject(new Error("Agent session runtime is no longer accepting structural operations"));
		}
		if (source.lifetime === "owner") return Promise.reject(new PinnedConversationError());
		const generation = source.session.conversationGenerationRevision;
		const run = async (): Promise<MoveOutcome> => {
			assertConversationGenerationCurrent?.();
			if (this.ended || this.current !== source || source.session.conversationGenerationRevision !== generation) {
				throw new Error("Stale agent session structural operation");
			}
			source.assertNotBusy();
			return operation(source);
		};
		const result = this.moveTail.then(run, run);
		this.moveTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/** Run `withSession` against the conversation a move reached, if the runtime is still on it. */
	private async seed(
		outcome: MoveOutcome,
		withSession: ((ctx: ReplacedSessionContext) => Promise<void>) | undefined,
	): Promise<AgentSessionReplacementResult & { selectedText?: string }> {
		if (outcome.cancelled) return { cancelled: true, seeded: false };
		const selectedText = outcome.selectedText === undefined ? {} : { selectedText: outcome.selectedText };
		if (outcome.seeded !== undefined) return { cancelled: false, seeded: outcome.seeded, ...selectedText };
		const to = outcome.to;
		if (!withSession || !to || !outcome.seedable || this.current !== to || this.ended) {
			return { cancelled: false, seeded: false, ...selectedText };
		}
		await withSession(to.session.createReplacedSessionContext());
		return { cancelled: false, seeded: true, ...selectedText };
	}

	/**
	 * Open `target` from `source` and move this runtime there. Until the move
	 * commits, any failure closes what was opened and leaves the runtime on
	 * `source`. The host transaction is prepared before an existing session
	 * opens (the host may be what frees its lock), else once the new session
	 * exists; it commits as the move's first step.
	 */
	private async replace(
		source: HostedConversation,
		target: ConversationTarget,
		options: {
			assertConversationGenerationCurrent?: () => void;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
			rebindRequestId?: string;
			/** The stored session being opened, when the target is one. */
			existingSession?: SessionReference & { cwdOverride?: string };
			/**
			 * The last durable step, after the move and `withSession`; the projection
			 * publishes the new identity after it. Any failure before it ends the runtime.
			 */
			commitPublication?: (to: HostedConversation) => Promise<void>;
			/** Runs inside the move only before a durable publication; otherwise the caller seeds after the move. */
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		} = {},
	): Promise<MoveOutcome> {
		const prepare = this.prepareSessionReplacement;
		let transaction: AgentSessionReplacementTransaction | undefined;
		let opened: OpenConversationResult;
		try {
			opened = await this.host.open(target, {
				from: source,
				...(options.projectTrustContextFactory ? { projectTrustContext: options.projectTrustContextFactory } : {}),
				onOpening: async () => {
					options.assertConversationGenerationCurrent?.();
					const existing = options.existingSession;
					if (!existing || !prepare) return;
					const cwd =
						existing.cwdOverride ??
						(await findSessionInfoById(existing.sessionDirectory, existing.sessionId))?.cwd;
					transaction = await prepare({ previousSessionId: source.id, sessionId: existing.sessionId, cwd });
					options.assertConversationGenerationCurrent?.();
				},
			});
		} catch (error) {
			throw await rollbackPreparedReplacement(transaction, error);
		}
		if (opened.cancelled) return { cancelled: true };
		const to = opened.conversation;
		let releaseSource: (() => void) | undefined;
		const abandonOpen = async (error: unknown): Promise<never> => {
			releaseSource?.();
			const errors = [await rollbackPreparedReplacement(transaction, error)];
			await this.host.discard(to).catch((closeError: unknown) => errors.push(closeError));
			if (errors.length > 1) throw new AggregateError(errors, "Session open failed and could not be cleaned up");
			throw errors[0];
		};
		try {
			options.assertConversationGenerationCurrent?.();
			// Nothing new starts in the source from here; it closes once the move commits.
			releaseSource = source.holdForLeave();
			transaction ??= await prepare?.({
				previousSessionId: source.id,
				sessionId: to.id,
				cwd: to.session.sessionManager.getCwd(),
			});
			options.assertConversationGenerationCurrent?.();
		} catch (error) {
			return await abandonOpen(error);
		}

		this.handover = {
			transaction,
			rebindRequestId: options.rebindRequestId,
			deferProjection: options.commitPublication !== undefined,
		};
		try {
			await this.host.move(this.client, to);
		} catch (error) {
			// A move that never left the source is a failed open: the runtime stays where it was.
			if (this.host.conversationOf(this.client) === source) return await abandonOpen(error);
			return await this.failHandover(error, to, transaction);
		} finally {
			this.handover = undefined;
		}

		let seedable = true;
		if (this.recoveredClientInputsEnabled) {
			// Admit and drain older durable input before post-move callbacks can
			// submit fresh work. Recovery failures are already diagnosed and leave
			// their exact queue visible; they do not undo the move. Skip the
			// callbacks until a later attach explicitly retries and drains recovery.
			try {
				// Recovered turns belong to no client, whoever asked for the move.
				await ClientScope.exit(() => to.startRecoveredClientInputs());
			} catch {
				seedable = false;
			}
		}
		const commitPublication = options.commitPublication;
		if (commitPublication) {
			let seeded = false;
			try {
				if (options.withSession && seedable) {
					await options.withSession(to.session.createReplacedSessionContext());
					seeded = true;
				}
				const generation = to.session.conversationGenerationRevision;
				const assertPublicationCurrent = (boundary: "before" | "during"): void => {
					if (this.ended || this.current !== to || to.session.conversationGenerationRevision !== generation) {
						throw new Error(`Agent session replacement changed ${boundary} durable publication`);
					}
				};
				assertPublicationCurrent("before");
				await commitPublication(to);
				assertPublicationCurrent("during");
				this.conversationProjectionFeed.commitSourceRebind(options.rebindRequestId);
			} catch (error) {
				return await this.failHandover(error, to, undefined);
			}
			return {
				cancelled: false,
				to,
				seedable,
				seeded,
				...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
			};
		}
		return {
			cancelled: false,
			to,
			seedable,
			...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
		};
	}

	/**
	 * The committed move: the host transaction commits, the modes leave `from`
	 * and bind to `to`, then the host closes `from`.
	 */
	private async handOver(to: HostedConversation, from: HostedConversation | undefined): Promise<void> {
		const handover = this.handover;
		if (!handover) throw new Error("Agent session runtime moved without a handover");
		this.current = to;
		await handover.transaction?.commit();
		this.beforeSessionInvalidate?.();
		// The modes' extension clients moved: the source's session_shutdown reaches none of their UI.
		from?.session.detachExtensionClients();
		this.detachProjectionEvents();
		this.detachProjectionEvents = () => {};
		// Fence the old generation before subscription. A source may synchronously
		// replay while attaching; it must reduce only inside the unpublished generation.
		this.conversationProjectionFeed.beginSourceRebind(to.projectionSource);
		this.detachProjectionEvents = this.relayProjectionEvents(to);
		this.observeLoss(to);
		try {
			for (const listener of [...this.sessionWillProjectListeners]) {
				await listener(to.session);
			}
		} catch (error: unknown) {
			this.conversationProjectionFeed.failSourceRebind(error instanceof Error ? error : new Error(String(error)));
			throw error;
		}
		// An ordinary move publishes before extension callbacks so their input and
		// UI interactions can stream. A durable destination move instead commits
		// its routing record before clients can adopt the new identity.
		if (!handover.deferProjection) this.conversationProjectionFeed.commitSourceRebind(handover.rebindRequestId);
		await handover.transaction?.finalize?.();
		if (this.rebindSession) {
			await this.rebindSession(to.session);
		}
		for (const listener of [...this.sessionReplacementListeners]) {
			await listener(to.session);
		}
	}

	/** A committed move failed: the runtime ends, closing both conversations. */
	private async failHandover(
		error: unknown,
		to: HostedConversation,
		transaction: AgentSessionReplacementTransaction | undefined,
	): Promise<never> {
		this.ended = true;
		this.failed = true;
		const failure = error instanceof Error ? error : new Error(String(error));
		const cleanupErrors: unknown[] = [];
		this.conversationProjectionFeed.failSourceRebind(failure);
		this.conversationProjectionFeed.dispose();
		this.detachProjectionEvents();
		this.detachProjectionEvents = () => {};
		for (const conversation of this.host.list()) {
			if (conversation !== to && conversation !== this.current) continue;
			try {
				await this.host.close(conversation);
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		if (transaction) {
			try {
				await transaction.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[failure, ...cleanupErrors],
				"Session replacement failed and cleanup did not complete",
			);
		}
		throw failure;
	}

	async switchSessionById(
		sessionId: string,
		options?: AgentSessionSwitchOptions,
	): Promise<AgentSessionReplacementResult> {
		const outcome = await this.runMove(async (source) => {
			assertValidSessionId(sessionId);
			if (sessionId === source.id) return { cancelled: false, seedable: false };
			const sessionDir = source.session.sessionManager.getSessionDir() || getDefaultSessionDir(source.cwd);
			const target = await findSessionInfoById(sessionDir, sessionId);
			if (this.current !== source) throw new Error("Stale agent session structural operation");
			if (!target || (target.cwd && !sameFilesystemLocation(target.cwd, source.cwd))) {
				throw new Error(`Session not found in current workspace: ${sessionId}`);
			}
			return this.switchWithin(source, target.ref, target.cwd ? options : { ...options, cwdOverride: source.cwd });
		}, options?.assertConversationGenerationCurrent);
		const { cancelled, seeded } = await this.seed(outcome, options?.withSession);
		return { cancelled, seeded };
	}

	async switchSession(
		sessionRef: SessionReference,
		options?: AgentSessionSwitchOptions,
	): Promise<AgentSessionReplacementResult> {
		const outcome = await this.runMove(
			(source) => this.switchWithin(source, sessionRef, options),
			options?.assertConversationGenerationCurrent,
		);
		const { cancelled, seeded } = await this.seed(outcome, options?.withSession);
		return { cancelled, seeded };
	}

	/**
	 * Resume a stored session. A cwd override ("continue in current cwd") lives
	 * only in memory; the store keeps the original, possibly missing, cwd. The
	 * session opens for writing, taking its lock while this runtime still holds
	 * the current one; locks never wait, so holding both cannot deadlock.
	 */
	private switchWithin(
		source: HostedConversation,
		sessionRef: SessionReference,
		options: AgentSessionSwitchOptions | undefined,
	): Promise<MoveOutcome> {
		const currentSessionRef = source.session.sessionRef;
		if (currentSessionRef !== undefined && sessionRefsEqual(sessionRef, currentSessionRef)) {
			// Nothing changes, so a requested withSession callback never runs.
			return Promise.resolve({ cancelled: false, seedable: false });
		}
		return this.replace(
			source,
			{
				kind: "session",
				ref: sessionRef,
				...(options?.cwdOverride === undefined ? {} : { cwdOverride: options.cwdOverride }),
			},
			{
				...(options?.assertConversationGenerationCurrent
					? { assertConversationGenerationCurrent: options.assertConversationGenerationCurrent }
					: {}),
				...(options?.projectTrustContextFactory
					? { projectTrustContextFactory: options.projectTrustContextFactory }
					: {}),
				// A reference reusing the current session ID is rejected by the host; it needs no host lease.
				...(sessionRef.sessionId === source.id
					? {}
					: {
							existingSession: {
								...sessionRef,
								...(options?.cwdOverride === undefined ? {} : { cwdOverride: options.cwdOverride }),
							},
						}),
			},
		);
	}

	async newSession(options?: AgentSessionNewSessionOptions): Promise<AgentSessionReplacementResult> {
		const outcome = await this.runMove(async (source) => {
			if (options?.replaceReviewGeneral && !options.preserveReviewRunId)
				throw new Error("replaceReviewGeneral requires preserveReviewRunId");
			const sourceManager = source.session.sessionManager;
			const cwd = options?.cwd ?? source.cwd;
			let generalReplacement: Awaited<ReturnType<typeof prepareReviewGeneralReplacement>> | undefined;
			try {
				return await this.replace(
					source,
					{
						kind: "new",
						cwd,
						...(options?.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
						...(options?.parentSessionRef === undefined ? {} : { parentSessionRef: options.parentSessionRef }),
						...(options?.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
						...(options?.baseRef === undefined ? {} : { baseRef: options.baseRef }),
						seed: async (writer) => {
							if (options?.replaceReviewGeneral) {
								generalReplacement = await prepareReviewGeneralReplacement(
									sourceManager,
									options.preserveReviewRunId!,
								);
							}
							await options?.setup?.(writer);
							const targetManager = writer.sessionManager;
							await registerReviewHandoffAliases(
								sourceManager,
								targetManager,
								listReviewRuns(targetManager, { limit: 50 })
									.runs.map((run) => run.runId)
									.filter((runId) => !generalReplacement || runId !== options?.preserveReviewRunId),
							);
							// Persist the trusted handoff's binding before publication: subsequent runs
							// are canonical here and must not depend on retained aliases for enforcement.
							// General replacement grants its alias only at publication, so resolve from
							// the already-authorized source while preparing that replacement.
							const binding = generalReplacement
								? await readPrReviewBinding(sourceManager, options?.preserveReviewRunId)
								: await readPrReviewBinding(targetManager);
							if (binding) {
								if (!sameFilesystemLocation(cwd, binding.cwd)) throw new Error(PR_CHECKOUT_CHANGED);
								await writer.recordPrReviewBinding(binding);
							}
						},
					},
					{
						...(options?.assertConversationGenerationCurrent
							? { assertConversationGenerationCurrent: options.assertConversationGenerationCurrent }
							: {}),
						...(options?.rebindRequestId === undefined ? {} : { rebindRequestId: options.rebindRequestId }),
						...(options?.replaceReviewGeneral
							? {
									commitPublication: async (to: HostedConversation) => {
										if (!generalReplacement) throw new Error("Review General replacement was not prepared");
										await generalReplacement.commit(to.session.sessionManager);
									},
									// A durable destination finishes seeding before it publishes.
									...(options.withSession ? { withSession: options.withSession } : {}),
								}
							: {}),
					},
				);
			} finally {
				await generalReplacement?.dispose();
			}
		}, options?.assertConversationGenerationCurrent);
		const { cancelled, seeded } = await this.seed(outcome, options?.withSession);
		return { cancelled, seeded };
	}

	/**
	 * Approve and start one exact ready-plan revision. The execution snapshot is
	 * durable before provider work begins, so retries observe the same execution
	 * identity instead of starting a second run.
	 */
	async executePlan(
		planId: string,
		expectedRevision: number,
		strategy: PlanExecutionStrategy,
		assertConversationGenerationCurrent?: () => void,
	): Promise<{ planning: PlanningState; selectedSessionId: string; started: boolean }> {
		if (this.session.isReviewDiscussion && strategy === "new_session") {
			throw new Error("Finding discussions execute plans in the current context; reset through the source review");
		}
		const sourceSession = this.session;
		const sourcePlanning = sourceSession.planningState;
		const sourcePlan = sourcePlanning.plan;
		if (
			sourcePlan?.id === planId &&
			sourcePlan.execution?.approvedRevision === expectedRevision &&
			sourcePlan.execution.strategy === strategy
		) {
			return {
				planning: sourcePlanning,
				selectedSessionId: sourcePlan.execution.targetSessionId,
				started: false,
			};
		}
		if (!sourcePlan || sourcePlan.id !== planId || sourcePlan.revision !== expectedRevision) {
			throw new StalePlanRevisionError();
		}
		if (sourcePlan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		assertConversationGenerationCurrent?.();

		if (strategy === "retain_context") {
			const execution: PlanExecution = {
				id: randomUUID(),
				approvedRevision: expectedRevision,
				strategy,
				sourceSessionId: sourceSession.sessionId,
				targetSessionId: sourceSession.sessionId,
			};
			const result = await sourceSession.activatePlan(planId, expectedRevision, execution);
			if (result.activated) {
				void sourceSession
					.sendCustomMessage(
						{
							customType: PLAN_EXECUTION_CUSTOM_TYPE,
							content: createPlanExecutionPrompt(result.planning.plan!),
							display: true,
						},
						{ triggerTurn: true },
					)
					.catch(() => undefined);
			}
			return {
				planning: result.planning,
				selectedSessionId: sourceSession.sessionId,
				started: result.activated,
			};
		}

		const sourceSessionId = sourceSession.sessionId;
		const sourceSessionRef = sourceSession.sessionRef;
		const sourceManager = sourceSession.sessionManager;
		const sourceModel = sourceSession.model;
		const sourceThinking = sourceSession.thinkingLevel;
		const sourceFastMode = sourceSession.fastModeEnabled;
		const sourceReviewState = captureReviewStateForHandoff(sourceManager);
		let execution: PlanExecution | undefined;
		const replacement = await this.newSession({
			...(sourceSessionRef ? { parentSessionRef: sourceSessionRef } : {}),
			setup: async (writer) => {
				await restoreReviewStateFromHandoff(writer, sourceReviewState);
				execution = {
					id: randomUUID(),
					approvedRevision: expectedRevision,
					strategy,
					sourceSessionId,
					targetSessionId: writer.sessionManager.getSessionId(),
				};
				await writer.appendPlanningState({
					mode: "build",
					plan: {
						...clonePlanState(sourcePlan),
						revision: sourcePlan.revision + 1,
						phase: "active",
						execution,
					},
				});
				if (sourceModel) {
					await writer.appendModelChange(sourceModel.provider, sourceModel.id);
				}
				await writer.appendThinkingLevelChange(sourceThinking);
				if (sourceFastMode) {
					await writer.appendFastModeChange(true);
				}
			},
			withSession: async (context) => {
				if (!execution) {
					throw new Error("Plan execution session was not initialized");
				}
				// The source conversation closed before this post-move handoff
				// callback. Reopen persisted sources as the new exclusive writer;
				// in-memory sources remain reusable.
				const handoffManager = sourceSessionRef ? await SessionManager.open(sourceSessionRef) : sourceManager;
				try {
					await handoffManager.logWriter.appendPlanningState({
						mode: "build",
						plan: {
							...clonePlanState(sourcePlan),
							revision: sourcePlan.revision + 1,
							phase: "handed_off",
							execution,
						},
					});
				} catch (error) {
					if (sourceSessionRef) {
						try {
							await handoffManager.closePersistence();
						} catch (closeError) {
							throw new AggregateError(
								[error, closeError],
								"Plan handoff failed and its source manager could not be closed",
							);
						}
					}
					throw error;
				}
				if (sourceSessionRef) await handoffManager.closePersistence();
				const activePlan = this.session.planningState.plan;
				if (!activePlan || activePlan.phase !== "active") {
					throw new Error("Plan execution session did not restore its active plan");
				}
				void context
					.sendMessage(
						{
							customType: PLAN_EXECUTION_CUSTOM_TYPE,
							content: createPlanExecutionPrompt(activePlan),
							display: true,
						},
						{ triggerTurn: true },
					)
					.catch(() => undefined);
			},
			...(assertConversationGenerationCurrent ? { assertConversationGenerationCurrent } : {}),
		});
		if (replacement.cancelled || !replacement.seeded || !execution) {
			throw new Error("Plan execution session was not created");
		}
		return {
			planning: this.session.planningState,
			selectedSessionId: execution.targetSessionId,
			started: true,
		};
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<AgentSessionReplacementResult & { selectedText?: string }> {
		const outcome = await this.runMove((source) =>
			this.replace(source, { kind: "fork", source, entryId, position: options?.position ?? "before" }),
		);
		return this.seed(outcome, options?.withSession);
	}

	/**
	 * Import a session JSONL file and move the runtime to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const outcome = await this.runMove((source) =>
			this.replace(source, {
				kind: "import",
				path: inputPath,
				...(cwdOverride === undefined ? {} : { cwdOverride }),
			}),
		);
		return { cancelled: outcome.cancelled };
	}

	/**
	 * Close the runtime's conversation (`session_shutdown` with reason quit,
	 * then the before-invalidate hook, then disposal) after any structural
	 * operation already admitted. Every caller joins one disposal.
	 */
	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		this.ended = true;
		this.disposePromise = this.moveTail.then(async () => {
			this.prepareSessionReplacement = undefined;
			this.sessionWillProjectListeners.clear();
			this.sessionReplacementListeners.clear();
			this.detachProjectionEvents();
			this.detachProjectionEvents = () => {};
			this.conversationProjectionFeed.dispose();
			if (this.failed) return;
			await this.host.close(this.current, {
				reason: "quit",
				beforeDispose: () => this.beforeSessionInvalidate?.(),
			});
		});
		return this.disposePromise;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The runtime's host keeps the factory and reuses it for later /new,
 * /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
		profile?: string;
		subagentContext?: SubagentRuntimeContext;
		workspaceName?: string;
		baseRef?: string;
	},
): Promise<AgentSessionRuntime> {
	const host = new ConversationHost({ factory: createRuntime, agentDir: options.agentDir });
	const opened = await host.open(
		{ kind: "adopt", sessionManager: options.sessionManager, cwd: options.cwd },
		{
			...(options.sessionStartEvent === undefined ? {} : { sessionStartEvent: options.sessionStartEvent }),
			...(Object.hasOwn(options, "profile") ? { profile: options.profile } : {}),
			...(options.subagentContext === undefined ? {} : { subagentContext: options.subagentContext }),
			...(options.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
			...(options.baseRef === undefined ? {} : { baseRef: options.baseRef }),
		},
	);
	if (opened.cancelled) throw new Error("Agent session runtime creation was cancelled");
	return new AgentSessionRuntime(host, opened.conversation);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
