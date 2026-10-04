import { randomUUID } from "node:crypto";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionIntentResult,
	SessionStartEvent,
} from "./extensions/index.ts";
import { ClientScope } from "./host/client-scope.ts";
import { ConversationHost, type OpenConversationResult, PinnedConversationError } from "./host/conversation-host.ts";
import type {
	CreateAgentSessionRuntimeFactory,
	HostedConversation,
	SubagentRuntimeContext,
} from "./host/hosted-conversation.ts";
import { createPlanHandoff } from "./host/plan-handoff.ts";
import {
	listWorkspaceSessions,
	sameFilesystemLocation,
	type WorkspaceSessionSummary,
} from "./host/session-summaries.ts";
import type { ConversationTarget, HostClient } from "./host/targets.ts";
import {
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
import { listReviewRuns } from "./review-state.ts";
import type { ReviewWorkflowManager } from "./review-workflows.ts";
import { ConversationProjectionFeed } from "./rpc/conversation-projection-feed.ts";
import {
	assertValidSessionId,
	findSessionInfoById,
	getDefaultSessionDir,
	type SessionManager,
	type SessionReference,
} from "./session-manager.ts";
import type { LogWriter } from "./session-writer.ts";

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

export interface AgentSessionNewSessionOptions {
	parentSessionRef?: SessionReference;
	preserveReviewRunId?: string;
	replaceReviewGeneral?: boolean;
	/** Override the new session's cwd (e.g. a daemon-managed worktree checkout). */
	cwd?: string;
	/** Override the session dir (e.g. the parent workspace's default dir for worktree sessions). */
	sessionDir?: string;
	/** Host-owned workspace display name for the new session's Git context. */
	workspaceName?: string;
	/** Trusted managed-worktree base ref for the new session's Git context. */
	baseRef?: string;
	/** Write the new session before it opens, through its log writer. */
	setup?: (writer: LogWriter) => Promise<void>;
	/**
	 * Runs once the new session opened, before the runtime leaves the current
	 * one, which is still open and admits no new work: a handoff writes its
	 * acknowledgement through the source's own writer here. A failure keeps the
	 * runtime on the current session and discards the new one.
	 */
	beforeMove?: (source: HostedConversation) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	/** Internal remote mutation lease revalidated at every awaited replacement boundary. */
	assertConversationGenerationCurrent?: () => void;
}

/**
 * How a redirect view's client left its conversation: redirected to another
 * conversation by one of its structural intents, or its conversation closed.
 */
export type RuntimeClientDetachment =
	| { readonly kind: "redirected"; readonly sessionId: string }
	| { readonly kind: "closed" };

/**
 * The conversation a redirect view's structural intent leads its client to:
 * see `RedirectViewOptions.hostTarget`.
 */
export interface RedirectTarget {
	readonly sessionId: string;
	/**
	 * The conversation the intent opened in the view's host, over a runtime of
	 * its own that the callee takes over; absent for a switch to a stored
	 * conversation, which opens wherever the client reconnects.
	 */
	readonly runtime?: AgentSessionRuntime;
}

/**
 * A redirect target a host took: prepared before the move writes anything
 * through the source, committed once those writes are done, or aborted.
 */
export interface HostedRedirect {
	/** Make the target the client's to reconnect to. A failure keeps the client where it was. */
	commit(): Promise<void>;
	/** Release what was prepared for a target that will not be used. */
	abort(): Promise<void>;
}

export interface RedirectViewOptions {
	/**
	 * Host the conversations the view's structural intents lead its client to,
	 * before the client is redirected there. A new, forked, or imported
	 * conversation opens in this runtime's host, which need not fence the
	 * source, since the view's conversation stays open for its other clients;
	 * a switch opens nothing. The host prepares the target before the move
	 * writes through the source (a handoff) and commits it after; a failure
	 * keeps the client where it was and discards what opened. Without it, the
	 * target's log is written and closed for the host the client reconnects
	 * through to open.
	 */
	readonly hostTarget?: (target: RedirectTarget) => Promise<HostedRedirect>;
}

/** Marks a runtime as a redirect view: see `AgentSessionRuntime.attachRedirectClient`. */
interface RedirectView {
	readonly redirect: true;
	readonly hostTarget?: RedirectViewOptions["hostTarget"];
}

function sessionRefsEqual(left: SessionReference, right: SessionReference): boolean {
	return (
		resolvePath(left.sessionDirectory) === resolvePath(right.sessionDirectory) &&
		left.storeId === right.storeId &&
		left.sessionId === right.sessionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

type MoveOutcome =
	| { readonly cancelled: true }
	| {
			readonly cancelled: false;
			/** The conversation the runtime is on: the one moved to, or the current one for a no-op switch. */
			readonly sessionId: string;
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
 * modes bind through: the before-invalidate hook, the will-project listeners,
 * the rebind hook, and the replaced listeners, after which the previous
 * conversation closes with its `session_shutdown`. The runtime's projection
 * feed serves one conversation: a move replaces it, ending its subscriptions.
 *
 * Structural operations run one at a time; one admitted for a session that is
 * no longer current fails as stale. A failure after the move committed ends
 * the runtime.
 *
 * A redirect view (`attachRedirectClient`) instead stays on its conversation:
 * its structural operations redirect its client to the new conversation, which
 * the view's host opens (`RedirectViewOptions.hostTarget`) or whose log is
 * written for another host to open.
 */
export class AgentSessionRuntime {
	private readonly host: ConversationHost;
	private current: HostedConversation;
	private readonly client: HostClient;
	private readonly redirects: boolean;
	private readonly hostTarget: RedirectViewOptions["hostTarget"];
	private readonly clientDetachedListeners = new Set<(detachment: RuntimeClientDetachment) => void>();
	private clientDetachment: RuntimeClientDetachment | undefined;
	private stopObservingClose: () => void = () => {};
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private readonly sessionWillProjectListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private readonly sessionReplacementListeners = new Set<(session: AgentSession) => Promise<void> | void>();
	private beforeSessionInvalidate?: () => void;
	private projectionFeed: ConversationProjectionFeed;
	private detachProjectionEvents: () => void;
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
	/** Installed only by a daemon with sibling runtime ownership. */
	reviewDiscussions?: ReviewDiscussionService;

	/** Over a conversation the host opened; a redirect view when `view` says so. */
	constructor(host: ConversationHost, conversation: HostedConversation, view?: RedirectView);
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
		third?: CreateAgentSessionRuntimeFactory | RedirectView,
		diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		modelFallbackMessage?: string,
		subagentContext?: SubagentRuntimeContext,
	) {
		if (first instanceof ConversationHost) {
			this.host = first;
			this.current = second as HostedConversation;
			this.redirects = typeof third === "object";
			this.hostTarget = typeof third === "object" ? third.hostTarget : undefined;
		} else {
			const services = second as AgentSessionServices;
			if (typeof third !== "function") throw new Error("A runtime over a session needs a runtime factory");
			this.host = new ConversationHost({ factory: third, agentDir: services.agentDir });
			this.current = this.host.adoptSession(
				{ session: first, services, diagnostics, modelFallbackMessage },
				subagentContext === undefined ? {} : { subagentContext },
			);
			this.redirects = false;
			this.hostTarget = undefined;
		}
		if (this.current.closed) throw new Error("Cannot create an agent session runtime over a closed conversation");
		this.client = this.redirects
			? {
					id: randomUUID(),
					move: {
						kind: "redirect",
						redirect: (sessionId) => this.detachClient({ kind: "redirected", sessionId }),
					},
				}
			: {
					id: randomUUID(),
					anchor: true,
					move: { kind: "in_place", onMoved: (to, from) => this.handOver(to, from) },
				};
		// Without a surface the attachment registers synchronously; the modes attach their own extension clients.
		void this.host.attach(this.client, this.current).catch(() => undefined);
		if (this.redirects) {
			const conversation = this.current;
			this.stopObservingClose = this.host.onClosed((closed) => {
				if (closed === conversation) this.detachClient({ kind: "closed" });
			});
		}
		this.projectionFeed = new ConversationProjectionFeed(this.current.projectionSource);
		this.detachProjectionEvents = this.relayProjectionEvents(this.current);
		this.observeLoss(this.current);
	}

	/**
	 * Attach one more client to the current conversation, viewed through a
	 * runtime of its own that stays on it: the client's structural operations
	 * redirect the client to the new conversation (`onClientDetached`) instead
	 * of moving this runtime. A phone is served this way, relayed through the
	 * TUI or on a daemon-hosted conversation. Disposing the view detaches its
	 * client.
	 */
	attachRedirectClient(options: RedirectViewOptions = {}): AgentSessionRuntime {
		return new AgentSessionRuntime(this.host, this.current, {
			redirect: true,
			...(options.hostTarget === undefined ? {} : { hostTarget: options.hostTarget }),
		});
	}

	/**
	 * Observe a redirect view's client leaving its conversation: redirected by
	 * one of its structural operations, or the conversation closed. Fires at
	 * most once; a listener added afterwards hears it at once. Never fires for
	 * a runtime that moves in place.
	 */
	onClientDetached(listener: (detachment: RuntimeClientDetachment) => void): () => void {
		if (this.clientDetachment) {
			listener(this.clientDetachment);
			return () => {};
		}
		this.clientDetachedListeners.add(listener);
		return () => {
			this.clientDetachedListeners.delete(listener);
		};
	}

	private detachClient(detachment: RuntimeClientDetachment): void {
		if (this.clientDetachment || this.disposePromise) return;
		this.clientDetachment = detachment;
		// A client that left its conversation has no structural operations left.
		this.ended = true;
		this.stopObservingClose();
		for (const listener of [...this.clientDetachedListeners]) listener(detachment);
		this.clientDetachedListeners.clear();
	}

	/** Observe every conversation this runtime's host closes, by session id, once it closed and released its log. */
	onConversationClosed(listener: (sessionId: string) => void): () => void {
		return this.host.onClosed((conversation) => listener(conversation.id));
	}

	private relayProjectionEvents(conversation: HostedConversation): () => void {
		return conversation.subscribeProjectionEvents((event) => {
			this.projectionFeed.publishExternal(event);
		});
	}

	/**
	 * The ordered projection of the runtime's conversation for remote
	 * subscribers. It serves that one conversation: a move replaces it, and the
	 * subscriptions of the one it replaced end.
	 */
	get conversationProjectionFeed(): ConversationProjectionFeed {
		return this.projectionFeed;
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
	 * Observe every session the runtime moves to before its rebind hook and
	 * replaced listeners run, once the source's extension clients left it.
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

	/**
	 * Run `operation` against the current session while its conversation stays
	 * open: disposal, or a move closing it, waits until the operation settles.
	 */
	whileOpen<T>(operation: (session: AgentSession) => Promise<T> | T): Promise<T> {
		return this.current.whileOpen(operation);
	}

	/** Publish a canonical conversation reducer event to every attached subscriber. */
	publishConversationProjectionEvent(event: object): void {
		this.projectionFeed.publishExternal(event);
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
			// A redirect view's conversation stays open for its other clients.
			if (!this.redirects) source.assertNotBusy();
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
	): Promise<SessionIntentResult> {
		if (outcome.cancelled) return { cancelled: true };
		const { sessionId } = outcome;
		if (outcome.seeded !== undefined) return { cancelled: false, sessionId, seeded: outcome.seeded };
		const to = outcome.to;
		if (!withSession || !to || !outcome.seedable || this.current !== to || this.ended) {
			return { cancelled: false, sessionId, seeded: false };
		}
		await withSession(to.session.createReplacedSessionContext());
		return { cancelled: false, sessionId, seeded: true };
	}

	/**
	 * Open `target` from `source` and move this runtime there. Until the move
	 * commits, any failure closes what was opened and leaves the runtime on
	 * `source`.
	 */
	private async replace(
		source: HostedConversation,
		target: ConversationTarget,
		options: {
			assertConversationGenerationCurrent?: () => void;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
			/**
			 * The last durable step, after the move and `withSession`, with the target's
			 * log. Any failure in it ends the runtime.
			 */
			commitPublication?: (target: SessionManager) => Promise<void>;
			/** Runs inside the move only before a durable publication; otherwise the caller seeds after the move. */
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			/** Runs once the target opened and the source is fenced, right before the move. */
			beforeMove?: (source: HostedConversation) => Promise<void>;
		} = {},
	): Promise<MoveOutcome> {
		if (this.redirects) return this.redirectTo(target, options);
		const opened: OpenConversationResult = await this.host.open(target, {
			from: source,
			...(options.projectTrustContextFactory ? { projectTrustContext: options.projectTrustContextFactory } : {}),
			onOpening: async () => {
				options.assertConversationGenerationCurrent?.();
			},
		});
		if (opened.cancelled) return { cancelled: true };
		const to = opened.conversation;
		let releaseSource: (() => void) | undefined;
		const abandonOpen = async (error: unknown): Promise<never> => {
			releaseSource?.();
			try {
				await this.host.discard(to);
			} catch (closeError) {
				throw new AggregateError([error, closeError], "Session open failed and could not be cleaned up");
			}
			throw error;
		};
		try {
			options.assertConversationGenerationCurrent?.();
			// Nothing new starts in the source from here; it closes once the move commits.
			releaseSource = source.holdForLeave();
			// The last step before the move: what it writes through the source stays true only if the move happens.
			await options.beforeMove?.(source);
			options.assertConversationGenerationCurrent?.();
		} catch (error) {
			return await abandonOpen(error);
		}

		try {
			await this.host.move(this.client, to);
		} catch (error) {
			// A move that never left the source is a failed open: the runtime stays where it was.
			if (this.host.conversationOf(this.client) === source) return await abandonOpen(error);
			return await this.failHandover(error, to);
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
				await commitPublication(to.session.sessionManager);
				assertPublicationCurrent("during");
			} catch (error) {
				return await this.failHandover(error, to);
			}
			return {
				cancelled: false,
				sessionId: to.id,
				to,
				seedable,
				seeded,
				...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
			};
		}
		return {
			cancelled: false,
			sessionId: to.id,
			to,
			seedable,
			...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
		};
	}

	/**
	 * A redirect view's structural operation: redirect the client to `target`;
	 * this runtime stays on its conversation. With `hostTarget`, a new
	 * conversation opens in this host and is handed over before the redirect;
	 * otherwise its log is written for the host the client reconnects through.
	 * `withSession` cannot run, since no client of this host joins the new
	 * conversation.
	 */
	private async redirectTo(
		target: ConversationTarget,
		options: {
			assertConversationGenerationCurrent?: () => void;
			commitPublication?: (target: SessionManager) => Promise<void>;
			beforeMove?: (source: HostedConversation) => Promise<void>;
		},
	): Promise<MoveOutcome> {
		if (target.kind === "adopt") throw new Error("A redirect view cannot adopt a conversation");
		options.assertConversationGenerationCurrent?.();
		const { beforeMove, commitPublication } = options;
		const hostTarget = this.hostTarget;
		if (hostTarget && target.kind !== "session") {
			const opened = await this.host.openFor(this.client, target, {
				beforeMove: async (from, to) => {
					options.assertConversationGenerationCurrent?.();
					const runtime = new AgentSessionRuntime(this.host, to);
					// The target closes without its extensions having started.
					const discard = async () => {
						await this.host.discard(to).catch(() => undefined);
						await runtime.dispose().catch(() => undefined);
					};
					let hosted: HostedRedirect;
					try {
						hosted = await hostTarget({ sessionId: to.id, runtime });
					} catch (error) {
						await discard();
						throw error;
					}
					// What can fail is prepared before anything is written through the source.
					try {
						options.assertConversationGenerationCurrent?.();
						if (from) await beforeMove?.(from);
						await commitPublication?.(to.session.sessionManager);
					} catch (error) {
						await hosted.abort().catch(() => undefined);
						await discard();
						throw error;
					}
					try {
						await hosted.commit();
					} catch (error) {
						await discard();
						throw error;
					}
				},
			});
			if (opened.cancelled) return { cancelled: true };
			return {
				cancelled: false,
				sessionId: opened.sessionId,
				seedable: false,
				...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
			};
		}
		const redirected = await this.host.redirectFor(this.client, target, {
			beforeMove: async (from) => {
				options.assertConversationGenerationCurrent?.();
				const hosted =
					hostTarget && target.kind === "session"
						? await hostTarget({ sessionId: target.ref.sessionId })
						: undefined;
				try {
					await beforeMove?.(from);
				} catch (error) {
					await hosted?.abort().catch(() => undefined);
					throw error;
				}
				await hosted?.commit();
			},
			...(commitPublication === undefined ? {} : { publish: commitPublication }),
		});
		if (redirected.cancelled) return { cancelled: true };
		return {
			cancelled: false,
			sessionId: redirected.sessionId,
			seedable: false,
			...(redirected.selectedText === undefined ? {} : { selectedText: redirected.selectedText }),
		};
	}

	/**
	 * The committed move: the modes leave `from` and bind to `to`, whose
	 * projection feed replaces `from`'s, then the host closes `from`.
	 */
	private async handOver(to: HostedConversation, from: HostedConversation | undefined): Promise<void> {
		this.current = to;
		this.beforeSessionInvalidate?.();
		// The modes' extension clients moved: the source's session_shutdown reaches none of their UI.
		from?.session.detachExtensionClients();
		this.detachProjectionEvents();
		this.detachProjectionEvents = () => {};
		// A stream never follows a move: the feed serves one conversation.
		this.projectionFeed.dispose();
		this.projectionFeed = new ConversationProjectionFeed(to.projectionSource);
		this.detachProjectionEvents = this.relayProjectionEvents(to);
		this.observeLoss(to);
		for (const listener of [...this.sessionWillProjectListeners]) {
			await listener(to.session);
		}
		if (this.rebindSession) {
			await this.rebindSession(to.session);
		}
		for (const listener of [...this.sessionReplacementListeners]) {
			await listener(to.session);
		}
	}

	/** A committed move failed: the runtime ends, closing both conversations. */
	private async failHandover(error: unknown, to: HostedConversation): Promise<never> {
		this.ended = true;
		this.failed = true;
		const failure = error instanceof Error ? error : new Error(String(error));
		const cleanupErrors: unknown[] = [];
		this.projectionFeed.dispose();
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
		if (cleanupErrors.length > 0) {
			throw new AggregateError(
				[failure, ...cleanupErrors],
				"Session replacement failed and cleanup did not complete",
			);
		}
		throw failure;
	}

	async switchSessionById(sessionId: string, options?: AgentSessionSwitchOptions): Promise<SessionIntentResult> {
		const outcome = await this.runMove(async (source) => {
			assertValidSessionId(sessionId);
			if (sessionId === source.id) return { cancelled: false, sessionId: source.id, seedable: false };
			const sessionDir = source.session.sessionManager.getSessionDir() || getDefaultSessionDir(source.cwd);
			const target = await findSessionInfoById(sessionDir, sessionId);
			if (this.current !== source) throw new Error("Stale agent session structural operation");
			if (!target || (target.cwd && !sameFilesystemLocation(target.cwd, source.cwd))) {
				throw new Error(`Session not found in current workspace: ${sessionId}`);
			}
			return this.switchWithin(source, target.ref, target.cwd ? options : { ...options, cwdOverride: source.cwd });
		}, options?.assertConversationGenerationCurrent);
		return this.seed(outcome, options?.withSession);
	}

	async switchSession(
		sessionRef: SessionReference,
		options?: AgentSessionSwitchOptions,
	): Promise<SessionIntentResult> {
		const outcome = await this.runMove(
			(source) => this.switchWithin(source, sessionRef, options),
			options?.assertConversationGenerationCurrent,
		);
		return this.seed(outcome, options?.withSession);
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
			return Promise.resolve({ cancelled: false, sessionId: source.id, seedable: false });
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
			},
		);
	}

	async newSession(options?: AgentSessionNewSessionOptions): Promise<SessionIntentResult> {
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
						...(options?.beforeMove === undefined ? {} : { beforeMove: options.beforeMove }),
						...(options?.replaceReviewGeneral
							? {
									commitPublication: async (target: SessionManager) => {
										if (!generalReplacement) throw new Error("Review General replacement was not prepared");
										await generalReplacement.commit(target);
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
		return this.seed(outcome, options?.withSession);
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

		// The new session is written before it opens; the source records the handoff while still open.
		const handoff = createPlanHandoff(sourceSession, sourcePlan, expectedRevision);
		const sourceSessionRef = sourceSession.sessionRef;
		// A redirected client's new conversation opens for it elsewhere or later:
		// its log queues the execution turn, which starts when it recovers its durable input.
		const redirected = this.redirects;
		const replacement = await this.newSession({
			...(sourceSessionRef ? { parentSessionRef: sourceSessionRef } : {}),
			setup: async (writer) => {
				await handoff.setup(writer);
				if (redirected) await handoff.queueStart(writer);
			},
			beforeMove: (source) => handoff.beforeMove(source),
			...(redirected ? {} : { withSession: (context) => handoff.start(this.session, context) }),
			...(assertConversationGenerationCurrent ? { assertConversationGenerationCurrent } : {}),
		});
		if (replacement.cancelled || (!redirected && !replacement.seeded)) {
			throw new Error("Plan execution session was not created");
		}
		return {
			planning: this.session.planningState,
			selectedSessionId: replacement.sessionId,
			started: true,
		};
	}

	/** A fork before a user message also returns that message's text. */
	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: true } | { cancelled: false; sessionId: string; seeded: boolean; selectedText?: string }> {
		const outcome = await this.runMove((source) =>
			this.replace(source, { kind: "fork", source, entryId, position: options?.position ?? "before" }),
		);
		const result = await this.seed(outcome, options?.withSession);
		if (result.cancelled || outcome.cancelled || outcome.selectedText === undefined) return result;
		return { ...result, selectedText: outcome.selectedText };
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
	 * operation already admitted. A redirect view only detaches its client.
	 * Every caller joins one disposal.
	 */
	dispose(): Promise<void> {
		if (this.disposePromise) {
			return this.disposePromise;
		}
		this.ended = true;
		this.disposePromise = this.moveTail.then(async () => {
			this.sessionWillProjectListeners.clear();
			this.sessionReplacementListeners.clear();
			this.detachProjectionEvents();
			this.detachProjectionEvents = () => {};
			this.projectionFeed.dispose();
			this.stopObservingClose();
			this.clientDetachedListeners.clear();
			if (this.redirects) {
				await this.host.detach(this.client);
				return;
			}
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
