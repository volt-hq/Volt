import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { HostedConversation } from "../core/host/hosted-conversation.ts";
import { sameFilesystemLocation } from "../core/host/session-summaries.ts";
import type { HostedRedirect, RedirectTarget } from "../core/host/targets.ts";
import type { IrohRemoteActiveStreamRegistry } from "../core/remote/iroh/active-stream-registry.ts";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import type { IrohRemoteHostEngine } from "../core/remote/iroh/engine.ts";
import {
	IrohRemoteHandshakeError,
	type IrohRemoteHandshakeSuccess,
	type IrohRemoteHello,
	isIrohRemoteSessionId,
} from "../core/remote/iroh/handshake.ts";
import { shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization } from "../core/remote/iroh/host-policy.ts";
import {
	type IrohRemoteHostHandshakeFailureOutcome,
	type IrohRemoteRuntimeToolPolicy,
	isIrohRemoteRuntimeToolPolicyWithin,
	resolveIrohRemoteRuntimeToolPolicy,
} from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import { HostReviewDiscussionService, type ReviewDiscussionService } from "../core/review-discussions.ts";
import { getDefaultSessionDir, SessionManager, type SessionReference } from "../core/session-manager.ts";
import type { SessionWriter } from "../core/session-writer.ts";
import type { SubagentRuntimeRegistration } from "../core/subagents/index.ts";
import {
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteAgentRuntime,
	type IrohRemoteAgentRuntimeConversationTarget,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "../modes/rpc/iroh-remote-agent-runtime.ts";
import {
	type DetachedRuntimeRetentionHandle,
	scheduleDetachedRuntimeRetention,
} from "../remote/integrated-runtime-retention.ts";
import {
	assertConversationClientNodeId,
	type ConversationAttachClaim,
	type ConversationCoordinator,
	ConversationCoordinatorRegistry,
	type ConversationSubscriber,
} from "./conversation-coordinator.ts";
import type { IntegratedConversationSessionSelection } from "./handshake-responses.ts";
import type { DaemonRuntimeOwnerCapability } from "./lease-broker.ts";
import type { ReviewSiblingAdmission } from "./review-sibling-admission.ts";
import { isPathInside, resolveWorkspaceDirectory, type WorkspaceDirectoryResolution } from "./workspace-directory.ts";
import { getRegisteredWorkingDirectoryForWorktree, type WorktreeRuntimePreparation } from "./worktree-manager.ts";

export type IntegratedRuntimeSubscriber = ConversationSubscriber;

export type IntegratedRuntimeAttachClaim = ConversationAttachClaim;

export interface IntegratedRuntimeEntry {
	readonly coordinator: ConversationCoordinator;
	readonly key: string;
	clientNodeId: string;
	workspaceName: string;
	readonly workspaceGeneration?: number;
	readonly projectTrusted: boolean;
	readonly sessionId: string;
	/** The conversation, in the host it opened in. */
	runtime: IrohRemoteAgentRuntime;
	/** Review discussions authorize through this entry's conversation. */
	reviewDiscussions?: ReviewDiscussionService;
	readonly lifecycle: "prepared" | "active" | "retiring" | "retired";
	/** Monotonic ownership generation; retirement invalidates captured attaches. */
	readonly generation: number;
	/** Exactly-one terminal owner; concurrent cleanup paths join this promise. */
	readonly retirementPromise?: Promise<void>;
	/** Capability-scoped broker ownership for this exact runtime generation. */
	readonly leaseOwner?: DaemonRuntimeOwnerCapability;
	/** Attaches whose stream/subscriber/feed ownership is still publishing. */
	readonly attachClaims: ReadonlySet<IntegratedRuntimeAttachClaim>;
	readonly subscribers: ReadonlySet<IntegratedRuntimeSubscriber>;
	readonly detachedAt: number | undefined;
	readonly detachedRuntimeRetention: DetachedRuntimeRetentionHandle | undefined;
	parentSessionId?: string;
	subagentId?: string;
	/** Held until prepared runtime ownership is inserted into the registry. */
	worktreePreparation?: WorktreeRuntimePreparation;
	/** Set when the runtime cwd is a daemon-managed worktree checkout. */
	worktreeId?: string;
	/** Host-local checkout path (sanitizer root); never sent on the wire. */
	worktreePath?: string;
	/** Registered-workspace-relative git source root for nested repo worktrees. */
	worktreeSourceRootRelativePath?: string;
	/** POSIX-style path relative to the registered workspace root. Omitted for root. */
	workingDirectory?: string;
	/** Immutable tool policy used to create this shared runtime. */
	toolPolicy: IrohRemoteRuntimeToolPolicy;
}

export interface IntegratedRuntimeRegistryOptions {
	agentDir?: string;
	profile?: string;
	/** Injectable runtime factory (tests); defaults to the real iroh remote runtime. */
	createRuntime?: typeof createIrohRemoteAgentRuntimeWithSessionSelection;
	auditLogger: IrohRemoteAuditLogger;
	stateManager: IrohRemoteHostStateManager;
	activeStreams: IrohRemoteActiveStreamRegistry;
	/** Stable per-conversation authorities shared with relay and stream ownership. */
	coordinators?: ConversationCoordinatorRegistry;
	detachedRuntimeTtlMs: () => number;
	/** Resolve the effective daemon-owned runtime policy. The client grant must remain the ceiling. */
	getToolPolicy?: (workspace: IrohRemoteWorkspace, clientAllowTools: string) => IrohRemoteRuntimeToolPolicy;
	/** Legacy workspace-policy seam. It is intersected with the client grant, never used as a replacement. */
	getAllowTools?: (workspace: IrohRemoteWorkspace) => string | undefined;
	getProjectTrustedForWorkspace: (workspace: IrohRemoteWorkspace) => boolean;
	setClientLastSessionId: IrohRemoteHostEngine["setClientLastSessionId"];
	/**
	 * Worktree resolution seam (wired to the daemon's WorktreeManager). Must
	 * throw a conversation-open error for an unknown/unavailable worktree.
	 */
	resolveWorktree?: (
		workspaceName: string,
		hello: IrohRemoteHello,
		targetSessionId: string | undefined,
	) => Promise<IrohRemoteWorkspaceWorktree | undefined>;
	/** Resolve/validate a selected working directory before creating a runtime. */
	resolveWorkingDirectory?: (options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}) => Promise<WorkspaceDirectoryResolution>;
	/** Reserve the worktree before runtime initialization and atomically publish or release it. */
	prepareWorktreeRuntime?: (
		workspaceName: string,
		worktreeId: string,
		sessionId?: string,
	) => Promise<WorktreeRuntimePreparation>;
	/** Validate a prepared PR before session creation; persist its binding before publication. */
	preparePrReviewSession?: (
		authorization: IrohRemoteClientAuthorizationSuccess,
		hello: IrohRemoteHello,
		signal?: AbortSignal,
	) => Promise<((writer: SessionWriter) => Promise<void>) | undefined>;
	/** Persist the sessionId → worktree binding after a created worktree conversation. */
	bindWorktreeSession?: (workspaceName: string, worktreeId: string, sessionId: string) => Promise<void>;
	/** Retire and await every stream/subscriber owner before low-level runtime disposal. */
	beforeRuntimeStop?: (entry: IntegratedRuntimeEntry, reason: string) => Promise<void>;
	/**
	 * Host-owned broker/shutdown admission for a sibling runtime the daemon
	 * publishes without a phone attach: a review discussion, or the
	 * conversation a phone's structural intent opened.
	 */
	beginReviewSiblingAdmission?: (parent: IntegratedRuntimeEntry, sessionId: string) => ReviewSiblingAdmission;
	withReviewSourceWrite?: <T>(
		parent: IntegratedRuntimeEntry,
		source: SessionReference,
		write: () => Promise<T>,
	) => Promise<T>;
	/** Whether a stream's authorization still matches persisted client and workspace authority. */
	isAuthorizationCurrent?: (authorization: IrohRemoteClientAuthorizationSuccess) => Promise<boolean>;
	/** Called exactly once after a newly-created runtime is published in the registry. */
	onRuntimePublished?: (entry: IntegratedRuntimeEntry) => void;
	/** Called once a conversation a phone's structural intent opened from `source` is published as `target`. */
	onConversationMoved?: (source: IntegratedRuntimeEntry, target: IntegratedRuntimeEntry) => void;
	onRuntimeDisposed?: (entry: IntegratedRuntimeEntry, reason: string) => void;
}

export function createConversationOpenError(
	outcome: IrohRemoteHostHandshakeFailureOutcome,
	message: string,
	details: Record<string, unknown> = {},
): IrohRemoteHandshakeError {
	const error = new IrohRemoteHandshakeError(outcome, message);
	Object.assign(error, details);
	return error;
}

export function createIrohRuntimeConversationTarget(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
): IrohRemoteAgentRuntimeConversationTarget {
	if (hello.mode !== "conversation") {
		throw new Error("integrated runtime requires a conversation stream");
	}
	if (hello.conversation.target === "new") {
		return { target: "new", sessionId: hello.conversation.sessionId };
	}
	if (hello.conversation.target === "session") {
		return { target: "session", sessionId: hello.conversation.sessionId };
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return previousSessionId === undefined ? { target: "last" } : { target: "last", resumeSessionId: previousSessionId };
}

export function getResolvedTargetSessionId(
	hello: IrohRemoteHello,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	if (hello.mode !== "conversation") {
		return undefined;
	}
	if (hello.conversation.target === "session" || hello.conversation.target === "new") {
		return hello.conversation.sessionId;
	}
	if (hello.conversation.target !== "last") {
		return undefined;
	}
	const previousSessionId = authorization.client.lastSessionIdByWorkspace?.[authorization.workspace.name];
	return isIrohRemoteSessionId(previousSessionId) ? previousSessionId : undefined;
}

export function createConversationSessionSelectionFromEntry(
	entry: IntegratedRuntimeEntry,
): IntegratedConversationSessionSelection {
	return {
		kind: "resumed",
		requestedSessionId: entry.sessionId,
		sessionId: entry.sessionId,
	};
}

let integratedRuntimeSubscriberSequence = 0;

function getRequestedWorkingDirectory(hello: IrohRemoteHello): string | undefined {
	return hello.mode === "conversation" && hello.conversation.target === "new"
		? hello.conversation.workingDirectory
		: undefined;
}

async function resolveRuntimeWorkingDirectory(rootPath: string, cwd: string): Promise<WorkspaceDirectoryResolution> {
	let rootReal: string;
	let cwdReal: string;
	try {
		rootReal = await realpath(rootPath);
		cwdReal = await realpath(cwd);
	} catch {
		throw createConversationOpenError("session_unavailable", "session working directory is unavailable");
	}
	if (!isPathInside(rootReal, cwdReal)) {
		throw createConversationOpenError(
			"session_unavailable",
			"stored session working directory is outside the authorized workspace",
		);
	}
	const relativePath = relative(rootReal, cwdReal).split(sep).join("/");
	return {
		absolutePath: cwdReal,
		...(relativePath.length === 0 ? {} : { relativePath }),
	};
}

function createAttachAdmissionCancelledError(): Error {
	return new Error("Conversation attach cancelled because daemon admission closed");
}

function assertAttachAdmissionOpen(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw createAttachAdmissionCancelledError();
	}
}

/**
 * Observe an uncancellable external operation without letting it retain daemon
 * admission after shutdown. A late successful resource result is handed to an
 * explicit disposer so cancellation cannot turn eventual settlement into a
 * leaked runtime. The disposer owns reporting because the cancellation caller
 * has already settled before a late result exists.
 */
function waitForAttachAdmission<T>(
	operation: Promise<T>,
	signal: AbortSignal | undefined,
	onLateSuccess?: (value: T) => Promise<void> | void,
): Promise<T> {
	if (!signal) {
		return operation;
	}
	let decided = false;
	let detachAbort = () => {};
	const disposeLate = (value: T): void => {
		if (!onLateSuccess) return;
		void Promise.resolve(onLateSuccess(value)).catch(() => {});
	};
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			if (decided) return;
			decided = true;
			detachAbort();
			reject(createAttachAdmissionCancelledError());
		};
		detachAbort = () => signal.removeEventListener("abort", onAbort);
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener("abort", onAbort, { once: true });
		}
		operation.then(
			(value) => {
				if (decided) {
					disposeLate(value);
					return;
				}
				decided = true;
				detachAbort();
				resolve(value);
			},
			(error: unknown) => {
				if (decided) return;
				decided = true;
				detachAbort();
				reject(error);
			},
		);
	});
}

export class IntegratedRuntimeRegistry {
	private readonly options: IntegratedRuntimeRegistryOptions;
	readonly coordinators: ConversationCoordinatorRegistry;
	private readonly entries = new Map<string, IntegratedRuntimeEntry>();
	private readonly reviewDiscussions: HostReviewDiscussionService;
	private readonly reviewSiblingCreations = new Map<string, Promise<HostedConversation>>();
	private readonly reviewSourceWrites = new Map<string, Promise<unknown>>();
	private readonly revokedReviewAuthorities = new WeakSet<HostedConversation>();
	private readonly namedSessionCreations = new Map<
		string,
		{
			entry?: IntegratedRuntimeEntry;
			published: Promise<void>;
			resolvePublished(): void;
			rejectPublished(error: unknown): void;
		}
	>();

	constructor(options: IntegratedRuntimeRegistryOptions) {
		this.options = options;
		this.coordinators = options.coordinators ?? new ConversationCoordinatorRegistry();
		const exactOwner = (conversation: HostedConversation) =>
			this.revokedReviewAuthorities.has(conversation)
				? undefined
				: this.values().find(
						(entry) => entry.runtime.conversation === conversation && entry.lifecycle === "active",
					);
		this.reviewDiscussions = new HostReviewDiscussionService({
			findRuntime: (ref, requester) => {
				const source = exactOwner(requester);
				if (!source) throw new Error("Review requester runtime is unavailable");
				return this.values().find((entry) => {
					const current = entry.runtime.conversation.session.sessionRef;
					return (
						entry.lifecycle === "active" &&
						entry.workspaceName === source.workspaceName &&
						entry.workspaceGeneration === source.workspaceGeneration &&
						current?.storeId === ref.storeId &&
						current.sessionId === ref.sessionId &&
						current.sessionGeneration === ref.sessionGeneration
					);
				})?.runtime.conversation;
			},
			assertCurrent: (runtime) => {
				if (!exactOwner(runtime)) throw new Error("Review runtime ownership changed");
			},
			withSourceWrite: <T>(requester: HostedConversation, ref: SessionReference, write: () => Promise<T>) => {
				const parent = exactOwner(requester);
				if (!parent || !this.options.withReviewSourceWrite)
					return Promise.reject(new Error("Canonical source writer is unavailable"));
				const generation = parent.generation;
				const key = this.getRegistryKey(parent.workspaceName, ref.sessionId);
				const operation = (this.reviewSourceWrites.get(key) ?? Promise.resolve())
					.catch(() => undefined)
					.then(() => {
						if (exactOwner(requester) !== parent || parent.generation !== generation)
							throw new Error("Review source writer authority changed");
						return this.options.withReviewSourceWrite!(parent, ref, write);
					});
				this.reviewSourceWrites.set(key, operation);
				void operation
					.finally(() => {
						if (this.reviewSourceWrites.get(key) === operation) this.reviewSourceWrites.delete(key);
					})
					.catch(() => undefined);
				return operation;
			},
			createSibling: (runtime, manager, assertCurrent) => this.createReviewSibling(runtime, manager, assertCurrent),
		});
	}

	private async createReviewSibling(
		conversation: HostedConversation,
		ref: SessionReference,
		assertCurrent: () => void,
	): Promise<HostedConversation> {
		const parent = this.values().find(
			(entry) => entry.runtime.conversation === conversation && entry.lifecycle === "active",
		);
		if (!parent) throw new Error("Review source runtime unavailable");
		const key = this.getRegistryKey(parent.workspaceName, ref.sessionId);
		const pending = this.reviewSiblingCreations.get(key);
		if (pending) {
			const child = await pending;
			assertCurrent();
			return child;
		}
		const operation = this.publishReviewSibling(parent, ref, assertCurrent);
		this.reviewSiblingCreations.set(key, operation);
		void operation
			.finally(() => {
				if (this.reviewSiblingCreations.get(key) === operation) this.reviewSiblingCreations.delete(key);
			})
			.catch(() => undefined);
		return operation;
	}

	private async publishReviewSibling(
		parent: IntegratedRuntimeEntry,
		ref: SessionReference,
		assertCurrent: () => void,
	): Promise<HostedConversation> {
		const generation = parent.generation;
		let manager: SessionManager | undefined;
		let coordinator: ConversationCoordinator | undefined;
		let admission: ReviewSiblingAdmission | undefined;
		let preparation: WorktreeRuntimePreparation | undefined;
		let child: IrohRemoteAgentRuntime | undefined;
		let entry: IntegratedRuntimeEntry | undefined;
		let claim: IntegratedRuntimeAttachClaim | undefined;
		let transferred = false;
		let published = false;
		const assertParent = () => {
			assertCurrent();
			admission?.assertCurrent();
			if (
				parent.generation !== generation ||
				parent.lifecycle !== "active" ||
				this.entries.get(parent.key) !== parent
			) {
				throw new Error("Review source ownership changed");
			}
		};
		try {
			assertParent();
			const existing = this.findOwner(parent.workspaceName, ref.sessionId);
			if (existing) {
				const current = existing.runtime.conversation.session.sessionRef;
				if (
					existing.lifecycle !== "active" ||
					existing.workspaceGeneration !== parent.workspaceGeneration ||
					current?.storeId !== ref.storeId ||
					current.sessionId !== ref.sessionId ||
					current.sessionGeneration !== ref.sessionGeneration
				) {
					throw new Error("Review child runtime identity changed");
				}
				return existing.runtime.conversation;
			}
			admission = this.options.beginReviewSiblingAdmission?.(parent, ref.sessionId);
			if (parent.coordinator.hasLeaseBroker && !admission)
				throw new Error("Review sibling daemon lease admission is unavailable");
			// Hold exclusive producer admission before any manager is opened or SDK context is seeded.
			coordinator = this.coordinators.reserveRuntime(parent.workspaceName, ref.sessionId);
			claim = coordinator.createAttachClaim(parent.clientNodeId);
			admission?.commit(coordinator);
			await admission?.validate();
			assertParent();
			if (parent.worktreeId) {
				if (!this.options.bindWorktreeSession || !this.options.prepareWorktreeRuntime)
					throw new Error("Review worktree service unavailable");
				preparation = await waitForAttachAdmission(
					this.options.prepareWorktreeRuntime(parent.workspaceName, parent.worktreeId, ref.sessionId),
					admission?.signal,
					(late) => late.release(),
				);
				assertParent();
				await waitForAttachAdmission(
					this.options.bindWorktreeSession(parent.workspaceName, parent.worktreeId, ref.sessionId),
					admission?.signal,
				);
				assertParent();
			}
			manager = await SessionManager.open(ref);
			assertParent();
			transferred = true;
			// Keep the provisional lease until initialization settles, including on cancellation;
			// releasing it early would let a new owner race late SDK persistence.
			child = await openReviewDiscussionSibling(parent.runtime, manager);
			assertParent();
			await admission?.validate();
			assertParent();
			if (this.findOwner(parent.workspaceName, child.conversation.session.sessionId))
				throw new Error("Review child runtime already active");
			const childRef = child.conversation.session.sessionRef;
			if (
				childRef?.storeId !== ref.storeId ||
				childRef.sessionId !== ref.sessionId ||
				childRef.sessionGeneration !== ref.sessionGeneration
			)
				throw new Error("Review child initialization changed identity");
			entry = this.createEntryRecord({
				coordinator,
				clientNodeId: parent.clientNodeId,
				workspaceName: parent.workspaceName,
				workspaceGeneration: parent.workspaceGeneration,
				projectTrusted: parent.projectTrusted,
				sessionId: child.conversation.session.sessionId,
				runtime: child,
				worktreePreparation: preparation,
				worktreeId: parent.worktreeId,
				worktreePath: parent.worktreePath,
				worktreeSourceRootRelativePath: parent.worktreeSourceRootRelativePath,
				workingDirectory: parent.workingDirectory,
				toolPolicy: parent.toolPolicy,
			});
			preparation = undefined;
			const candidate = entry;
			const publish = () => {
				assertParent();
				this.assertAttachClaimCurrent(candidate, claim!);
				if (this.findOwner(candidate.workspaceName, candidate.sessionId))
					throw new Error("Review publication lost ownership");
				candidate.coordinator.activateRuntime();
				candidate.coordinator.markDetached();
				this.entries.set(candidate.key, candidate);
				published = true;
				admission?.finalize();
				this.options.onRuntimePublished?.(candidate);
			};
			if (entry.worktreePreparation) await entry.worktreePreparation.publish(publish);
			else publish();
			delete entry.worktreePreparation;
			assertParent();
			this.scheduleRetention(entry, "review_discussion_created");
			return child.conversation;
		} catch (error) {
			try {
				await preparation?.release();
				if (entry && published) await this.stopEntry(entry, "review_sibling_publication_failed");
				else if (entry && claim) await this.abortPreparedEntry(entry, undefined, claim);
				else if (coordinator)
					await coordinator.beginRuntimeRetirement("review_initialization_failed", async () => {
						if (child) await cleanupUncommittedRuntime(child);
						else if (!transferred) await manager?.closePersistence();
					}).settled;
				else if (child) await cleanupUncommittedRuntime(child);
				else if (!transferred) await manager?.closePersistence();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Review sibling admission and cleanup failed");
			} finally {
				admission?.rollback();
			}
			throw error;
		} finally {
			claim?.release();
			admission?.release();
		}
	}

	/**
	 * How one phone stream follows its structural intents as a client of
	 * `entry`'s conversation: by redirect, staying on the conversation. A
	 * structural intent of the phone moves the phone alone: the conversation a
	 * new session, fork, or import opens is published as a detached runtime
	 * with this entry's tool policy and placement (`hostRedirectTarget`), the
	 * phone's last session becomes the one it moves to, and the stream then ends
	 * with `conversation_moved`. Phones co-attached to the conversation stay on
	 * it.
	 */
	streamRedirect(
		entry: IntegratedRuntimeEntry,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): { hostTarget: (target: RedirectTarget) => Promise<HostedRedirect> } {
		return { hostTarget: (target) => this.hostRedirectTarget(entry, authorization, target) };
	}

	/**
	 * Host the conversation a phone on `source` is being redirected to. A
	 * conversation that opened for it is prepared as a detached runtime here,
	 * before the move writes anything through the source, and published on
	 * commit, which also records it as the phone's last session in the
	 * workspace, so `target:"last"` lands there. Abort releases what was
	 * prepared; the phone stays on `source`.
	 */
	private async hostRedirectTarget(
		source: IntegratedRuntimeEntry,
		authorization: IrohRemoteClientAuthorizationSuccess,
		target: RedirectTarget,
	): Promise<HostedRedirect> {
		if (source.lifecycle !== "active" || this.entries.get(source.key) !== source) {
			throw new Error("Conversation runtime ownership changed before the session change");
		}
		const prepared = target.conversation
			? await this.prepareMovedConversation(source, authorization, {
					host: source.runtime.host,
					conversation: target.conversation,
				})
			: undefined;
		return {
			commit: async () => {
				await prepared?.publish();
				try {
					await this.options.setClientLastSessionId(
						authorization.client.nodeId,
						source.workspaceName,
						target.sessionId,
					);
				} catch (error) {
					// The phone reconnects to the target it is told; only `target:"last"` misses it.
					await this.logAudit({
						type: "session_changed",
						clientNodeId: authorization.client.nodeId,
						workspace: source.workspaceName,
						success: false,
						error: error instanceof Error ? error.message : String(error),
						details: { reason: "conversation_moved", sessionId: target.sessionId, lastSessionUpdated: false },
					});
					return;
				}
				await this.logAudit({
					type: "session_changed",
					clientNodeId: authorization.client.nodeId,
					workspace: source.workspaceName,
					success: true,
					details: {
						reason: "conversation_moved",
						previousSessionId: source.sessionId,
						sessionId: target.sessionId,
					},
				});
			},
			abort: async () => {
				await prepared?.abort();
			},
		};
	}

	/**
	 * Prepare `runtime`, which a structural intent on `source` opened in the
	 * source's host, as a detached runtime of its own: the source's tool policy, trust,
	 * and worktree placement, with the session bound to that worktree, under a
	 * daemon lease. Publishing it rechecks the phone's authorization; it then
	 * follows retention until the redirected phone attaches. Exactly one of
	 * `publish` and `abort` must run; a failed publish cleans up itself.
	 */
	private async prepareMovedConversation(
		source: IntegratedRuntimeEntry,
		authorization: IrohRemoteClientAuthorizationSuccess,
		runtime: IrohRemoteAgentRuntime,
	): Promise<{ publish(): Promise<void>; abort(): Promise<void> }> {
		const sessionId = runtime.conversation.session.sessionId;
		const generation = source.generation;
		let coordinator: ConversationCoordinator | undefined;
		let admission: ReviewSiblingAdmission | undefined;
		let preparation: WorktreeRuntimePreparation | undefined;
		let entry: IntegratedRuntimeEntry | undefined;
		let claim: IntegratedRuntimeAttachClaim | undefined;
		let published = false;
		const assertSource = () => {
			admission?.assertCurrent();
			if (
				source.generation !== generation ||
				source.lifecycle !== "active" ||
				this.entries.get(source.key) !== source
			) {
				throw new Error("Conversation runtime ownership changed before the session change");
			}
		};
		const release = () => {
			claim?.release();
			admission?.release();
		};
		const cleanUp = async (error: unknown): Promise<never> => {
			try {
				await preparation?.release();
				if (entry && published) await this.stopEntry(entry, "conversation_move_publication_failed");
				else if (entry && claim) await this.abortPreparedEntry(entry, undefined, claim);
				else if (coordinator)
					await coordinator.beginRuntimeRetirement("conversation_move_failed", () =>
						cleanupUncommittedRuntime(runtime),
					).settled;
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Conversation move publication and cleanup failed");
			} finally {
				admission?.rollback();
				release();
			}
			throw error;
		};
		try {
			assertSource();
			if (this.findOwner(source.workspaceName, sessionId)) {
				throw new Error(`Conversation runtime already active for ${source.workspaceName}/${sessionId}`);
			}
			// The new conversation stays inside the workspace or worktree its source was authorized for.
			const directory = await resolveRuntimeWorkingDirectory(
				source.worktreePath ?? authorization.workspace.path,
				runtime.conversation.cwd,
			);
			const workingDirectory =
				source.worktreeId === undefined
					? directory.relativePath
					: getRegisteredWorkingDirectoryForWorktree(
							{ sourceRootRelativePath: source.worktreeSourceRootRelativePath },
							directory.relativePath,
						);
			admission = this.options.beginReviewSiblingAdmission?.(source, sessionId);
			if (source.coordinator.hasLeaseBroker && !admission) {
				throw new Error("Conversation lease admission is unavailable");
			}
			coordinator = this.coordinators.reserveRuntime(source.workspaceName, sessionId);
			claim = coordinator.createAttachClaim(authorization.client.nodeId);
			admission?.commit(coordinator);
			await admission?.validate();
			assertSource();
			if (source.worktreeId !== undefined && this.options.prepareWorktreeRuntime) {
				preparation = await waitForAttachAdmission(
					this.options.prepareWorktreeRuntime(source.workspaceName, source.worktreeId, sessionId),
					admission?.signal,
					(late) => late.release(),
				);
				assertSource();
			}
			if (source.worktreeId !== undefined && this.options.bindWorktreeSession) {
				// A daemon restart resumes the session in its worktree checkout (#83).
				await waitForAttachAdmission(
					this.options.bindWorktreeSession(source.workspaceName, source.worktreeId, sessionId),
					admission?.signal,
				);
				assertSource();
			}
			entry = this.createEntryRecord({
				coordinator,
				clientNodeId: authorization.client.nodeId,
				workspaceName: source.workspaceName,
				...(source.workspaceGeneration === undefined ? {} : { workspaceGeneration: source.workspaceGeneration }),
				projectTrusted: source.projectTrusted,
				sessionId,
				runtime,
				...(preparation === undefined ? {} : { worktreePreparation: preparation }),
				...(source.worktreeId === undefined ? {} : { worktreeId: source.worktreeId }),
				...(source.worktreePath === undefined ? {} : { worktreePath: source.worktreePath }),
				...(source.worktreeSourceRootRelativePath === undefined
					? {}
					: { worktreeSourceRootRelativePath: source.worktreeSourceRootRelativePath }),
				...(workingDirectory === undefined ? {} : { workingDirectory }),
				toolPolicy: source.toolPolicy,
			});
			preparation = undefined;
		} catch (error) {
			return await cleanUp(error);
		}
		const candidate = entry;
		let settled = false;
		return {
			publish: async () => {
				if (settled) throw new Error("Conversation move was already settled");
				settled = true;
				try {
					// A client revoked or narrowed during the move publishes nothing.
					if (this.options.isAuthorizationCurrent && !(await this.options.isAuthorizationCurrent(authorization))) {
						throw new Error("Client access changed during the session change; reconnect");
					}
					const publish = () => {
						assertSource();
						this.assertAttachClaimCurrent(candidate, claim!);
						if (this.findOwner(candidate.workspaceName, candidate.sessionId)) {
							throw new Error("Conversation runtime publication lost ownership");
						}
						candidate.coordinator.activateRuntime();
						candidate.coordinator.markDetached();
						this.entries.set(candidate.key, candidate);
						published = true;
						admission?.finalize();
						this.options.onRuntimePublished?.(candidate);
					};
					if (candidate.worktreePreparation) await candidate.worktreePreparation.publish(publish);
					else publish();
					delete candidate.worktreePreparation;
				} catch (error) {
					return await cleanUp(error);
				}
				release();
				await this.logAudit({
					type: "runtime_started",
					clientNodeId: authorization.client.nodeId,
					workspace: candidate.workspaceName,
					success: true,
					details: this.getEntryDetails(candidate, { previousSessionId: source.sessionId }),
				});
				await this.logEntryAudit(candidate, "remote_runtime_started", {
					reason: "conversation_moved",
					previousSessionId: source.sessionId,
				});
				this.options.onConversationMoved?.(source, candidate);
				this.scheduleRetention(candidate, "conversation_moved");
			},
			abort: async () => {
				if (settled) return;
				settled = true;
				await cleanUp(new Error("Conversation move was abandoned")).catch((error: unknown) => {
					if (error instanceof AggregateError) throw error;
				});
			},
		};
	}

	/** Revoke pending review effects before waiting for affected stream lifecycles to drain. */
	fenceReviewOperations(entries: Iterable<IntegratedRuntimeEntry>): void {
		for (const entry of entries) this.revokedReviewAuthorities.add(entry.runtime.conversation);
	}

	/** The conversation runtime key: one runtime per (workspaceName, sessionId). */
	getRegistryKey(workspaceName: string, sessionId: string): string {
		return this.coordinators.getRegistryKey(workspaceName, sessionId);
	}

	get size(): number {
		return this.entries.size;
	}

	values(): IntegratedRuntimeEntry[] {
		return Array.from(this.entries.values());
	}

	findOwner(workspaceName: string, sessionId: string): IntegratedRuntimeEntry | undefined {
		return this.entries.get(this.getRegistryKey(workspaceName, sessionId));
	}

	private createAttachRetryError(entry: IntegratedRuntimeEntry, message: string): IrohRemoteHandshakeError {
		return createConversationOpenError("duplicate_conversation_connection", message, {
			workspace: entry.workspaceName,
			sessionId: entry.sessionId,
			retryAfterMs: 500,
		});
	}

	private createAttachClaim(entry: IntegratedRuntimeEntry, clientNodeId: string): IntegratedRuntimeAttachClaim {
		return entry.coordinator.createAttachClaim(clientNodeId);
	}

	private assertAttachClaimCurrent(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		this.assertAttachClaimBelongsToEntry(entry, claim);
		if (!entry.coordinator.isAttachClaimCurrent(claim)) {
			throw this.createAttachRetryError(entry, "conversation attach claim is stale");
		}
	}

	private assertAttachClaimBelongsToEntry(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		if (claim.coordinator !== entry.coordinator) {
			throw this.createAttachRetryError(entry, "conversation attach claim belongs to another runtime");
		}
	}

	/** Validate a claim immediately before attach side effects. */
	assertEntryAttachable(entry: IntegratedRuntimeEntry, claim: IntegratedRuntimeAttachClaim): void {
		this.assertAttachClaimCurrent(entry, claim);
		if (entry.lifecycle !== "active" || this.entries.get(entry.key) !== entry) {
			throw this.createAttachRetryError(entry, "conversation runtime ownership changed during attach");
		}
	}

	private resolveToolPolicy(authorization: IrohRemoteClientAuthorizationSuccess): IrohRemoteRuntimeToolPolicy {
		return (
			this.options.getToolPolicy?.(authorization.workspace, authorization.allowTools) ??
			resolveIrohRemoteRuntimeToolPolicy({
				clientAllowTools: authorization.allowTools,
				workspaceAllowTools: this.options.getAllowTools?.(authorization.workspace),
				daemonAllowTools: null,
			})
		);
	}

	async getOrCreateEntry(
		handshake: { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess },
		authorization: IrohRemoteClientAuthorizationSuccess,
		options: { signal?: AbortSignal } = {},
	): Promise<{
		entry: IntegratedRuntimeEntry;
		attachClaim: IntegratedRuntimeAttachClaim;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		assertAttachAdmissionOpen(options.signal);
		assertConversationClientNodeId(authorization.client.nodeId);
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		if (targetSessionId !== undefined) {
			const targetKey = this.getRegistryKey(authorization.workspace.name, targetSessionId);
			const sourceWrite = this.reviewSourceWrites.get(targetKey);
			if (sourceWrite) {
				await waitForAttachAdmission(sourceWrite, options.signal);
				return this.getOrCreateEntry(handshake, authorization, options);
			}
			const siblingCreation = this.reviewSiblingCreations.get(targetKey);
			if (siblingCreation) {
				await waitForAttachAdmission(siblingCreation, options.signal);
				return this.getOrCreateEntry(handshake, authorization, options);
			}
			// One runtime per conversation: any paired client attaches to an existing
			// runtime for the target (conversation_in_use is retired; single-user model).
			const existing = this.findOwner(authorization.workspace.name, targetSessionId);
			if (existing) {
				if (existing.lifecycle !== "active") {
					throw this.createAttachRetryError(existing, "conversation runtime is retiring");
				}
				if (handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "new") {
					if (
						handshake.hello.conversation.worktreeId !== existing.worktreeId ||
						handshake.hello.conversation.workingDirectory !== existing.workingDirectory
					) {
						throw createConversationOpenError(
							"invalid_conversation_target",
							"session id is already bound to different placement",
							{ workspace: authorization.workspace.name, sessionId: targetSessionId },
						);
					}
				}
				if (
					(handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "new") ||
					!shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization(authorization)
				) {
					assertAttachAdmissionOpen(options.signal);
					const attachingPolicy = this.resolveToolPolicy(authorization);
					if (!isIrohRemoteRuntimeToolPolicyWithin(existing.toolPolicy, attachingPolicy)) {
						throw createConversationOpenError(
							"conversation_in_use",
							"conversation is using tools outside this client's persisted grant",
							{ workspace: authorization.workspace.name, sessionId: targetSessionId },
						);
					}
					// Reattach recognized: cancel the pending detached-runtime TTL sweep
					// synchronously, before the caller's multi-await commit window. The
					// broker flips to daemon-active immediately (commitDaemonRuntime) but
					// attachSubscriber (which normally cancels retention) only runs after
					// several awaits; if the TTL timer elapsed in that window it would
					// dispose this very runtime mid-reattach (use-after-dispose + split
					// lease/registry ownership). detachedAt stays set so attachSubscriber
					// still logs the reattach and a pre-subscriber failure re-arms retention.
					this.cancelRetention(existing);
					return {
						entry: existing,
						attachClaim: this.createAttachClaim(existing, authorization.client.nodeId),
						created: false,
						sessionSelection: createConversationSessionSelectionFromEntry(existing),
					};
				}
				await waitForAttachAdmission(this.stopEntry(existing, "fresh_pairing_replaced_runtime"), options.signal);
			}
		}
		if (handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "new") {
			const key = this.getRegistryKey(authorization.workspace.name, handshake.hello.conversation.sessionId);
			const pending = this.namedSessionCreations.get(key);
			if (pending) {
				await waitForAttachAdmission(pending.published, options.signal);
				return this.getOrCreateEntry(handshake, authorization, options);
			}
			let resolvePublished = () => {};
			let rejectPublished = (_error: unknown) => {};
			const published = new Promise<void>((resolve, reject) => {
				resolvePublished = resolve;
				rejectPublished = reject;
			});
			void published.catch(() => undefined);
			const reservation: {
				entry?: IntegratedRuntimeEntry;
				published: Promise<void>;
				resolvePublished(): void;
				rejectPublished(error: unknown): void;
			} = { published, resolvePublished, rejectPublished };
			this.namedSessionCreations.set(key, reservation);
			try {
				const created = await this.createEntry(handshake, authorization, options);
				reservation.entry = created.entry;
				return created;
			} catch (error) {
				if (this.namedSessionCreations.get(key) === reservation) {
					this.namedSessionCreations.delete(key);
					reservation.rejectPublished(error);
				}
				throw error;
			}
		}
		return this.createEntry(handshake, authorization, options);
	}

	private async resolveInitialWorkingDirectory(options: {
		workspace: IrohRemoteWorkspace;
		rootPath: string;
		workingDirectory?: string;
		worktree?: IrohRemoteWorkspaceWorktree;
	}): Promise<WorkspaceDirectoryResolution> {
		if (this.options.resolveWorkingDirectory) {
			return this.options.resolveWorkingDirectory(options);
		}
		const resolved = await resolveWorkspaceDirectory(options.rootPath, options.workingDirectory);
		if (!resolved.ok) {
			throw createConversationOpenError("invalid_conversation_target", resolved.error, {
				workspace: options.workspace.name,
			});
		}
		return resolved.value;
	}

	private async createEntry(
		handshake: { hello: IrohRemoteHello },
		authorization: IrohRemoteClientAuthorizationSuccess,
		options: { signal?: AbortSignal },
	): Promise<{
		entry: IntegratedRuntimeEntry;
		attachClaim: IntegratedRuntimeAttachClaim;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		let runtime: IrohRemoteAgentRuntime | undefined;
		let sessionSelection: IntegratedConversationSessionSelection | undefined;
		let worktreePreparation: WorktreeRuntimePreparation | undefined;
		try {
			// Resolve any worktree binding first: explicit worktreeId on "new", or a
			// persisted sessionId binding on resume. Trust and allowTools stay pinned
			// to the PARENT workspace; only cwd changes. The session dir is ALWAYS
			// parent-keyed so worktree sessions stay listed under the workspace.
			assertAttachAdmissionOpen(options.signal);
			const worktree = this.options.resolveWorktree
				? await waitForAttachAdmission(
						this.options.resolveWorktree(
							authorization.workspace.name,
							handshake.hello,
							getResolvedTargetSessionId(handshake.hello, authorization),
						),
						options.signal,
					)
				: undefined;
			const bindPrReview = await this.options.preparePrReviewSession?.(
				authorization,
				handshake.hello,
				options.signal,
			);
			assertAttachAdmissionOpen(options.signal);
			if (worktree !== undefined && this.options.prepareWorktreeRuntime) {
				worktreePreparation = await waitForAttachAdmission(
					this.options.prepareWorktreeRuntime(
						authorization.workspace.name,
						worktree.id,
						getResolvedTargetSessionId(handshake.hello, authorization),
					),
					options.signal,
					(latePreparation) => latePreparation.release(),
				);
			}
			const rootPath = worktree?.path ?? authorization.workspace.path;
			const requestedWorkingDirectory = getRequestedWorkingDirectory(handshake.hello);
			assertAttachAdmissionOpen(options.signal);
			const initialDirectory = await waitForAttachAdmission(
				this.resolveInitialWorkingDirectory({
					workspace: authorization.workspace,
					rootPath,
					workingDirectory: requestedWorkingDirectory,
					...(worktree === undefined ? {} : { worktree }),
				}),
				options.signal,
			);
			const toolPolicy = this.resolveToolPolicy(authorization);
			const projectTrusted = this.options.getProjectTrustedForWorkspace(authorization.workspace);
			assertAttachAdmissionOpen(options.signal);
			const runtimeOperation = (this.options.createRuntime ?? createIrohRemoteAgentRuntimeWithSessionSelection)({
				agentDir: this.options.agentDir,
				toolPolicy,
				conversationTarget: createIrohRuntimeConversationTarget(handshake.hello, authorization),
				cwd: initialDirectory.absolutePath,
				projectCwd: rootPath,
				workspaceName: authorization.workspace.name,
				baseRef: worktree?.baseRef,
				sessionDir: getDefaultSessionDir(authorization.workspace.path, this.options.agentDir),
				validateCwd: async (cwd) => {
					await resolveRuntimeWorkingDirectory(rootPath, cwd);
				},
				onSubagentRuntimeCreated: (event) => this.registerSubagentRuntime(event, authorization),
				profile: this.options.profile,
				projectTrusted,
			});
			const runtimeResult = await waitForAttachAdmission(runtimeOperation, options.signal, async (lateResult) => {
				try {
					await cleanupUncommittedRuntime(lateResult.runtime);
				} catch (error) {
					await this.logAudit({
						type: "runtime_start_cleanup_failed",
						clientNodeId: authorization.client.nodeId,
						workspace: authorization.workspace.name,
						success: false,
						error: error instanceof Error ? error.message : String(error),
						details: {
							reason: "attach_cancelled",
							sessionId: lateResult.sessionSelection.sessionId,
						},
					});
				}
			});
			runtime = runtimeResult.runtime;
			sessionSelection = runtimeResult.sessionSelection;
			assertAttachAdmissionOpen(options.signal);
			await bindPrReview?.(runtime.conversation.session.sessionWriter);
			assertAttachAdmissionOpen(options.signal);
			const runtimeDirectory = await waitForAttachAdmission(
				resolveRuntimeWorkingDirectory(rootPath, runtime.conversation.cwd),
				options.signal,
			);
			const remoteWorkingDirectory =
				worktree === undefined
					? runtimeDirectory.relativePath
					: getRegisteredWorkingDirectoryForWorktree(worktree, runtimeDirectory.relativePath);
			if (
				handshake.hello.mode === "conversation" &&
				handshake.hello.conversation.target === "new" &&
				sessionSelection.kind === "resumed" &&
				requestedWorkingDirectory !== remoteWorkingDirectory
			) {
				throw createConversationOpenError(
					"invalid_conversation_target",
					"session id is already bound to a different working directory",
					{ workspace: authorization.workspace.name, sessionId: runtime.conversation.session.sessionId },
				);
			}
			const echoedWorkingDirectory =
				handshake.hello.mode === "conversation" &&
				handshake.hello.conversation.target === "new" &&
				requestedWorkingDirectory === undefined
					? undefined
					: remoteWorkingDirectory;
			const sessionId = runtime.conversation.session.sessionId;
			const owner = this.findOwner(authorization.workspace.name, sessionId);
			if (owner) {
				const runtimeToDispose = runtime;
				runtime = undefined;
				await cleanupUncommittedRuntime(runtimeToDispose);
				assertAttachAdmissionOpen(options.signal);
				if (owner.lifecycle !== "active") {
					throw this.createAttachRetryError(owner, "conversation runtime is retiring");
				}
				if (!isIrohRemoteRuntimeToolPolicyWithin(owner.toolPolicy, toolPolicy)) {
					throw createConversationOpenError(
						"conversation_in_use",
						"conversation is using tools outside this client's persisted grant",
						{ workspace: authorization.workspace.name, sessionId },
					);
				}
				return {
					entry: owner,
					attachClaim: this.createAttachClaim(owner, authorization.client.nodeId),
					created: false,
					sessionSelection: createConversationSessionSelectionFromEntry(owner),
				};
			}
			// Bind EVERY session actually created under the worktree root, not just
			// the initial "new"-target one: a session created for a bound-but-vanished
			// resume target must stay resumable after a daemon restart too (#83).
			// Resumed sessions were bound when they were created.
			if (worktree !== undefined && sessionSelection.kind !== "resumed") {
				if (this.options.bindWorktreeSession) {
					assertAttachAdmissionOpen(options.signal);
					await waitForAttachAdmission(
						this.options.bindWorktreeSession(authorization.workspace.name, worktree.id, sessionId),
						options.signal,
					);
				}
			}
			assertAttachAdmissionOpen(options.signal);
			const entry = this.createEntryRecord({
				clientNodeId: authorization.client.nodeId,
				workspaceName: authorization.workspace.name,
				...(authorization.workspaceGeneration === undefined
					? {}
					: { workspaceGeneration: authorization.workspaceGeneration }),
				projectTrusted,
				sessionId,
				runtime: runtime!,
				...(worktreePreparation === undefined ? {} : { worktreePreparation }),
				...(worktree === undefined
					? {}
					: {
							worktreeId: worktree.id,
							worktreePath: worktree.path,
							...(worktree.sourceRootRelativePath === undefined
								? {}
								: { worktreeSourceRootRelativePath: worktree.sourceRootRelativePath }),
						}),
				...(echoedWorkingDirectory === undefined ? {} : { workingDirectory: echoedWorkingDirectory }),
				toolPolicy,
			});
			worktreePreparation = undefined;
			return {
				entry,
				attachClaim: this.createAttachClaim(entry, authorization.client.nodeId),
				created: true,
				sessionSelection,
			};
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			try {
				await worktreePreparation?.release();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (runtime) {
				const runtimeToDispose = runtime;
				runtime = undefined;
				try {
					await cleanupUncommittedRuntime(runtimeToDispose);
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Conversation runtime creation failed and cleanup did not complete",
				);
			}
			throw error;
		}
	}

	private createEntryRecord(options: {
		coordinator?: ConversationCoordinator;
		clientNodeId: string;
		workspaceName: string;
		workspaceGeneration?: number;
		projectTrusted: boolean;
		sessionId: string;
		runtime: IrohRemoteAgentRuntime;
		parentSessionId?: string;
		subagentId?: string;
		worktreePreparation?: WorktreeRuntimePreparation;
		worktreeId?: string;
		worktreePath?: string;
		worktreeSourceRootRelativePath?: string;
		workingDirectory?: string;
		toolPolicy: IrohRemoteRuntimeToolPolicy;
	}): IntegratedRuntimeEntry {
		const coordinator =
			options.coordinator ?? this.coordinators.reserveRuntime(options.workspaceName, options.sessionId);
		if (
			coordinator.workspaceName !== options.workspaceName ||
			coordinator.sessionId !== options.sessionId ||
			coordinator.runtimeLifecycle !== "prepared"
		)
			throw new Error("Runtime coordinator reservation changed");
		const entry: IntegratedRuntimeEntry = {
			coordinator,
			get key() {
				return `${coordinator.workspaceName}\0${coordinator.sessionId}`;
			},
			clientNodeId: options.clientNodeId,
			workspaceName: options.workspaceName,
			...(options.workspaceGeneration === undefined ? {} : { workspaceGeneration: options.workspaceGeneration }),
			projectTrusted: options.projectTrusted,
			get sessionId() {
				return coordinator.sessionId;
			},
			runtime: options.runtime,
			get lifecycle() {
				const lifecycle = coordinator.runtimeLifecycle;
				if (lifecycle === undefined) throw new Error("integrated runtime lost its coordinator lifecycle");
				return lifecycle;
			},
			get generation() {
				return coordinator.generation;
			},
			get retirementPromise() {
				return coordinator.retirement?.settled;
			},
			get leaseOwner() {
				return coordinator.leaseOwner;
			},
			get attachClaims() {
				return coordinator.attachClaims;
			},
			get subscribers() {
				return coordinator.subscribers;
			},
			get detachedAt() {
				return coordinator.detachedAt;
			},
			get detachedRuntimeRetention() {
				return coordinator.detachedRuntimeRetention;
			},
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			...(options.subagentId === undefined ? {} : { subagentId: options.subagentId }),
			...(options.worktreePreparation === undefined ? {} : { worktreePreparation: options.worktreePreparation }),
			...(options.worktreeId === undefined ? {} : { worktreeId: options.worktreeId }),
			...(options.worktreePath === undefined ? {} : { worktreePath: options.worktreePath }),
			...(options.worktreeSourceRootRelativePath === undefined
				? {}
				: { worktreeSourceRootRelativePath: options.worktreeSourceRootRelativePath }),
			...(options.workingDirectory === undefined ? {} : { workingDirectory: options.workingDirectory }),
			toolPolicy: {
				tools: [...options.toolPolicy.tools],
				allowUnlistedExtensionTools: options.toolPolicy.allowUnlistedExtensionTools,
			},
		};
		entry.reviewDiscussions = this.reviewDiscussions.forRuntime(entry.runtime.conversation);
		return entry;
	}

	async registerSubagentRuntime(
		event: IrohRemoteSubagentRuntimeCreatedEvent,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<SubagentRuntimeRegistration> {
		const workspaceName = authorization.workspace.name;
		const parentEntry = this.findOwner(workspaceName, event.parentSessionId);
		if (!parentEntry || parentEntry.lifecycle !== "active") {
			throw new Error(`Parent runtime is not active for subagent session ${event.sessionId}`);
		}
		if (this.findOwner(workspaceName, event.sessionId)) {
			throw new Error(`Subagent session ${event.sessionId} is already active`);
		}
		if (parentEntry.worktreeId !== undefined) {
			if (!this.options.bindWorktreeSession) {
				throw new Error(`Worktree binding is unavailable for subagent session ${event.sessionId}`);
			}
			await this.options.bindWorktreeSession(workspaceName, parentEntry.worktreeId, event.sessionId);
		}
		const entry = this.createEntryRecord({
			clientNodeId: authorization.client.nodeId,
			workspaceName,
			...(parentEntry.workspaceGeneration === undefined
				? {}
				: { workspaceGeneration: parentEntry.workspaceGeneration }),
			projectTrusted: parentEntry.projectTrusted,
			sessionId: event.sessionId,
			runtime: { host: event.host, conversation: event.conversation },
			parentSessionId: event.parentSessionId,
			subagentId: event.id,
			...(parentEntry.worktreeId === undefined ? {} : { worktreeId: parentEntry.worktreeId }),
			...(parentEntry.worktreePath === undefined ? {} : { worktreePath: parentEntry.worktreePath }),
			...(parentEntry.worktreeSourceRootRelativePath === undefined
				? {}
				: { worktreeSourceRootRelativePath: parentEntry.worktreeSourceRootRelativePath }),
			...(parentEntry.workingDirectory === undefined ? {} : { workingDirectory: parentEntry.workingDirectory }),
			toolPolicy: parentEntry.toolPolicy,
		});
		let state: "prepared" | "committed" | "rolled-back" = "prepared";
		return {
			commit: () => {
				if (state !== "prepared") return;
				if (this.findOwner(workspaceName, event.parentSessionId)?.lifecycle !== "active") {
					throw new Error(`Parent runtime is not active for subagent session ${event.sessionId}`);
				}
				if (this.findOwner(workspaceName, event.sessionId)) {
					throw new Error(`Subagent session ${event.sessionId} is already active`);
				}
				state = "committed";
				entry.coordinator.activateRuntime();
				entry.coordinator.markDetached();
				this.entries.set(entry.key, entry);
				this.options.onRuntimePublished?.(entry);
				this.scheduleRetention(entry, "subagent_created");
				void this.logEntryAudit(entry, "remote_runtime_started", {
					parentSessionId: event.parentSessionId,
					reason: "subagent_created",
					subagentId: event.id,
				});
			},
			rollback: async () => {
				if (state === "rolled-back") return;
				if (state === "committed") {
					state = "rolled-back";
					await this.stopEntry(entry, "subagent_start_rolled_back");
					return;
				}
				state = "rolled-back";
				await entry.coordinator.beginRuntimeRetirement("subagent_start_rolled_back", () =>
					event.host.close(event.conversation),
				).settled;
			},
		};
	}

	async commitEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
		attachClaim: IntegratedRuntimeAttachClaim,
		signal?: AbortSignal,
	): Promise<void> {
		assertAttachAdmissionOpen(signal);
		this.assertAttachClaimCurrent(entry, attachClaim);
		if (attachClaim.clientNodeId !== authorization.client.nodeId) {
			throw this.createAttachRetryError(entry, "conversation attach client identity changed before commit");
		}
		if (entry.lifecycle !== "prepared" && entry.lifecycle !== "active") {
			throw this.createAttachRetryError(entry, "conversation runtime ownership changed before commit");
		}
		const initialLifecycle = entry.lifecycle;
		if (entry.lifecycle === "active") {
			this.assertEntryAttachable(entry, attachClaim);
		}
		const owner = this.findOwner(authorization.workspace.name, entry.sessionId);
		if (owner && owner !== entry) {
			// Two attaches raced to create the same conversation runtime; the loser
			// retries and attaches to the winner.
			throw createConversationOpenError("duplicate_conversation_connection", "conversation runtime already active", {
				workspace: authorization.workspace.name,
				sessionId: entry.sessionId,
				retryAfterMs: 500,
			});
		}

		const inserted = this.entries.get(entry.key) !== entry;
		assertAttachAdmissionOpen(signal);
		if (inserted) {
			if (entry.worktreePreparation) {
				await entry.worktreePreparation.publish(() => {
					assertAttachAdmissionOpen(signal);
					this.entries.set(entry.key, entry);
				});
				delete entry.worktreePreparation;
			} else {
				this.entries.set(entry.key, entry);
			}
		}

		try {
			if (entry.parentSessionId === undefined) {
				await waitForAttachAdmission(
					this.options.setClientLastSessionId(
						authorization.client.nodeId,
						authorization.workspace.name,
						entry.sessionId,
					),
					signal,
				);
			}
			await waitForAttachAdmission(this.logSessionSelection(sessionSelection, authorization), signal);
			if (inserted) {
				await waitForAttachAdmission(
					this.logAudit({
						type: "runtime_started",
						clientNodeId: authorization.client.nodeId,
						workspace: authorization.workspace.name,
						success: true,
						details: this.getEntryDetails(entry),
					}),
					signal,
				);
				await waitForAttachAdmission(
					this.logEntryAudit(entry, "remote_runtime_started", { reason: "created" }),
					signal,
				);
			}
			// stopEntry fences claims and advances the generation before its first
			// await. Revalidate after every persistence/audit await and immediately
			// before publishing `active`, otherwise a paused commit could resurrect a
			// runtime that has already entered retirement.
			assertAttachAdmissionOpen(signal);
			this.assertAttachClaimCurrent(entry, attachClaim);
			if (entry.lifecycle !== initialLifecycle || this.entries.get(entry.key) !== entry) {
				throw this.createAttachRetryError(entry, "conversation runtime ownership changed during commit");
			}
			if (entry.lifecycle === "active") {
				this.assertEntryAttachable(entry, attachClaim);
			}
			entry.coordinator.activateRuntime();
			if (inserted) this.options.onRuntimePublished?.(entry);
			const namedCreation = this.namedSessionCreations.get(entry.key);
			if (namedCreation?.entry === entry) {
				this.namedSessionCreations.delete(entry.key);
				namedCreation.resolvePublished();
			}
		} catch (error) {
			// A concurrent stop owns a retiring entry until disposal completes. Do
			// not remove it here or stopEntry would return early and leak its runtime.
			if (
				inserted &&
				entry.worktreeId === undefined &&
				entry.lifecycle === "prepared" &&
				this.entries.get(entry.key) === entry
			) {
				this.entries.delete(entry.key);
			}
			throw error;
		}
	}

	async abortPreparedEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection | undefined,
		attachClaim: IntegratedRuntimeAttachClaim,
	): Promise<void> {
		if (entry.coordinator.retirement) {
			await entry.coordinator.retirement.settled;
			return;
		}
		if (entry.lifecycle === "retiring" || entry.lifecycle === "retired") {
			return;
		}
		this.assertAttachClaimCurrent(entry, attachClaim);
		if (entry.lifecycle !== "prepared") {
			throw new Error("Cannot abort a conversation runtime after ownership publication");
		}
		await entry.coordinator.beginRuntimeRetirement("prepared_attach_aborted", () =>
			this.finishPreparedEntryAbort(entry, sessionSelection),
		).settled;
	}

	private async finishPreparedEntryAbort(
		entry: IntegratedRuntimeEntry,
		_sessionSelection: IntegratedConversationSessionSelection | undefined,
	): Promise<void> {
		if (entry.subscribers.size !== 0) {
			throw new Error("Cannot abort a prepared conversation runtime with attached subscribers");
		}
		this.cancelRetention(entry);
		const cleanupErrors: unknown[] = [];
		try {
			await entry.worktreePreparation?.release();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		delete entry.worktreePreparation;
		try {
			await cleanupUncommittedRuntime(entry.runtime);
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		if (cleanupErrors.length > 0) {
			throw new AggregateError(cleanupErrors, "Prepared conversation runtime cleanup did not complete");
		}
		const namedCreation = this.namedSessionCreations.get(entry.key);
		if (namedCreation?.entry === entry) {
			this.namedSessionCreations.delete(entry.key);
			namedCreation.rejectPublished(new Error("caller-named session creation was aborted before publication"));
		}
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
		}
	}

	async attachSubscriber(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
	): Promise<IntegratedRuntimeSubscriber> {
		this.assertEntryAttachable(entry, attachClaim);
		const wasDetached = entry.subscribers.size === 0 && entry.detachedAt !== undefined;
		const previousDetachedAt = entry.detachedAt;
		this.cancelRetention(entry);
		const subscriber: IntegratedRuntimeSubscriber = {
			id: `subscriber-${++integratedRuntimeSubscriberSequence}`,
			clientNodeId: attachClaim.clientNodeId,
			attachedAt: Date.now(),
		};
		entry.coordinator.addSubscriber(subscriber);
		try {
			if (wasDetached) {
				entry.coordinator.markAttached();
				await this.logEntryAudit(
					entry,
					"remote_runtime_reattached",
					{
						reason: "subscriber_attached",
						subscriberId: subscriber.id,
					},
					{ clientNodeId: subscriber.clientNodeId },
				);
			}
			await this.logEntryAudit(
				entry,
				"remote_subscriber_attached",
				{ subscriberId: subscriber.id },
				{ clientNodeId: subscriber.clientNodeId },
			);
			// The caller cannot detach until this promise resolves, so an attach
			// fenced during audit publication must roll its provisional subscriber
			// back internally before surfacing the retry.
			this.assertEntryAttachable(entry, attachClaim);
			return subscriber;
		} catch (error) {
			entry.coordinator.removeSubscriber(subscriber);
			if (
				wasDetached &&
				previousDetachedAt !== undefined &&
				entry.lifecycle === "active" &&
				this.entries.get(entry.key) === entry &&
				entry.subscribers.size === 0
			) {
				entry.coordinator.markDetached(previousDetachedAt);
				const remainingTtlMs = Math.max(0, this.options.detachedRuntimeTtlMs() - (Date.now() - previousDetachedAt));
				this.scheduleRetention(entry, "subscriber_attach_failed", remainingTtlMs);
			}
			throw error;
		}
	}

	/**
	 * Start durable input recovery only for the published runtime generation that
	 * owns this fully admitted subscriber. The iroh service calls this after the
	 * ordered projection feed is bound, closing the loser-runtime dispatch race.
	 */
	startRecoveredClientInputs(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
		subscriber: IntegratedRuntimeSubscriber,
	): Promise<void> {
		this.assertEntryAttachable(entry, attachClaim);
		if (!entry.subscribers.has(subscriber) || subscriber.clientNodeId !== attachClaim.clientNodeId) {
			throw this.createAttachRetryError(entry, "conversation subscriber is not owned by this attach");
		}
		return entry.runtime.conversation.startRecoveredClientInputs();
	}

	/**
	 * Detach a stream's subscriber. A runtime left without subscribers follows
	 * retention: it stops once idle for `retainMs`, the configured detached TTL
	 * by default.
	 */
	async detachSubscriber(
		entry: IntegratedRuntimeEntry,
		subscriber: IntegratedRuntimeSubscriber,
		reason: string,
		error?: unknown,
		options: { readonly retainMs?: number } = {},
	): Promise<void> {
		if (!entry.coordinator.removeSubscriber(subscriber)) {
			return;
		}
		const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
		await this.logEntryAudit(
			entry,
			"remote_subscriber_detached",
			{ reason, subscriberId: subscriber.id },
			{
				clientNodeId: subscriber.clientNodeId,
				success: errorMessage === undefined,
				error: errorMessage,
			},
		);
		if (entry.subscribers.size > 0) {
			return;
		}
		if (entry.lifecycle === "retiring" || entry.lifecycle === "retired") {
			return;
		}
		entry.coordinator.markDetached();
		await this.logEntryAudit(
			entry,
			"remote_runtime_detached",
			{ detachedAt: entry.detachedAt, reason },
			{ clientNodeId: subscriber.clientNodeId },
		);
		this.scheduleRetention(entry, reason, options.retainMs);
	}

	async detachWithoutSubscriber(
		entry: IntegratedRuntimeEntry,
		attachClaim: IntegratedRuntimeAttachClaim,
		reason: string,
	): Promise<void> {
		// Cleanup can run after retirement fenced/released the claim, but the
		// claim's captured actor identity remains immutable and authoritative.
		this.assertAttachClaimBelongsToEntry(entry, attachClaim);
		if (entry.lifecycle !== "active" || this.entries.get(entry.key) !== entry || entry.subscribers.size > 0) {
			return;
		}
		if (entry.detachedAt !== undefined) {
			// Already detached. A reattach that cancelled retention but then failed
			// before attachSubscriber ran can leave a detached entry with no timer;
			// re-arm so it is still swept rather than lingering forever. Honor the
			// ORIGINAL detach deadline (remaining TTL from detachedAt) instead of a
			// fresh full TTL, so repeated reconnect-then-abort cycles cannot keep
			// resetting the retention clock.
			if (!entry.detachedRuntimeRetention) {
				const remainingTtlMs = Math.max(0, this.options.detachedRuntimeTtlMs() - (Date.now() - entry.detachedAt));
				this.scheduleRetention(entry, reason, remainingTtlMs);
			}
			return;
		}
		entry.coordinator.markDetached();
		await this.logEntryAudit(
			entry,
			"remote_runtime_detached",
			{ detachedAt: entry.detachedAt, reason },
			{ clientNodeId: attachClaim.clientNodeId },
		);
		this.scheduleRetention(entry, reason);
	}

	async stopEntry(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		if (entry.coordinator.retirement) {
			await entry.coordinator.retirement.settled;
			return;
		}
		if (this.entries.get(entry.key) !== entry) {
			// Stale reference: the key may now belong to a replacement runtime, and
			// deleting by key alone would evict that runtime from the registry while
			// leaving it running unmanaged.
			return;
		}
		if (entry.lifecycle === "retired") {
			return;
		}
		if (entry.lifecycle === "retiring") {
			return;
		}
		await entry.coordinator.beginRuntimeRetirement(reason, () => this.finishEntryStop(entry, reason)).settled;
	}

	private async finishEntryStop(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		await this.options.beforeRuntimeStop?.(entry, reason);
		if (this.entries.get(entry.key) !== entry) {
			return;
		}
		if (entry.subscribers.size !== 0) {
			throw new Error(
				`Cannot stop conversation runtime ${entry.workspaceName}/${entry.sessionId} with attached subscribers`,
			);
		}
		if (this.options.activeStreams.entriesForConversationKey(entry.workspaceName, entry.sessionId).length !== 0) {
			throw new Error(
				`Cannot stop conversation runtime ${entry.workspaceName}/${entry.sessionId} with active streams`,
			);
		}
		const wasActive = entry.runtime.conversation.session.isBusy;
		let stopSuccess = true;
		const stopErrors: string[] = [];
		// Closing waits for operations holding the conversation open (a review
		// reset or source write). Keep registry/lease reservations intact until
		// they have settled.
		try {
			await entry.runtime.host.close(entry.runtime.conversation);
		} catch (error) {
			stopSuccess = false;
			stopErrors.push(`runtime disposal: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (this.entries.get(entry.key) !== entry) {
			return;
		}
		this.cancelRetention(entry);
		this.entries.delete(entry.key);
		const stopError = stopErrors.length === 0 ? undefined : stopErrors.join("; ");
		try {
			await this.logAudit({
				type: "runtime_stopped",
				clientNodeId: entry.clientNodeId,
				workspace: entry.workspaceName,
				success: stopSuccess,
				error: stopError,
				details: this.getEntryDetails(entry, { active: wasActive, reason }),
			});
			await this.logEntryAudit(
				entry,
				"remote_runtime_stopped",
				{ active: wasActive, reason },
				{ success: stopSuccess, error: stopError },
			);
		} finally {
			this.options.onRuntimeDisposed?.(entry, reason);
		}
	}

	async stopAll(reason: string): Promise<void> {
		for (const entry of this.values()) {
			await this.stopEntry(entry, reason);
		}
	}

	async stopForClient(clientNodeId: string, reason: string): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.clientNodeId !== clientNodeId) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	async stopForWorkspace(
		workspaceName: string,
		reason: string,
		excludeEntry?: IntegratedRuntimeEntry,
	): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.workspaceName !== workspaceName || entry === excludeEntry) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	async stopForClientWorkspace(clientNodeId: string, workspaceName: string, reason: string): Promise<number> {
		let stoppedCount = 0;
		for (const entry of this.values()) {
			if (entry.clientNodeId !== clientNodeId || entry.workspaceName !== workspaceName) {
				continue;
			}
			await this.stopEntry(entry, reason);
			stoppedCount++;
		}
		return stoppedCount;
	}

	// ==========================================================================
	// Retention
	// ==========================================================================

	cancelRetention(entry: IntegratedRuntimeEntry): void {
		if (!entry.detachedRuntimeRetention) {
			return;
		}
		entry.coordinator.cancelDetachedRuntimeRetention();
	}

	isDetached(entry: IntegratedRuntimeEntry): boolean {
		return (
			entry.lifecycle === "active" &&
			this.entries.get(entry.key) === entry &&
			entry.subscribers.size === 0 &&
			entry.detachedAt !== undefined
		);
	}

	scheduleRetention(entry: IntegratedRuntimeEntry, detachReason: string, ttlOverrideMs?: number): void {
		this.cancelRetention(entry);
		// A re-arm for an already-detached entry (reattach cancelled retention then
		// aborted before attach) honors the ORIGINAL detach deadline via an override
		// rather than restarting a full TTL, so a flaky reconnect-then-abort loop
		// cannot keep resetting the clock and pin a detached runtime open forever.
		const ttlMs = ttlOverrideMs ?? this.options.detachedRuntimeTtlMs();
		// Running work, reviews included, counts as activity: it must pin the
		// runtime until it reaches a terminal state.
		const conversation = entry.runtime.conversation;
		const isEntryActive = () =>
			conversation.session.isBusy ||
			conversation.session.hasRunningWork ||
			this.reviewDiscussions.hasPendingWork(conversation);
		// Each wait must block while its own activity check above is true.
		const waitForEntryIdle = async () => {
			await conversation.session.waitForNotBusy();
			await conversation.work.waitForIdle();
			await this.reviewDiscussions.waitForIdle(conversation);
		};
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs,
			isDetached: () => this.isDetached(entry),
			isActive: isEntryActive,
			waitForIdle: waitForEntryIdle,
			onExpire: async () => {
				if (!this.isDetached(entry) || isEntryActive()) {
					return;
				}
				await this.logEntryAudit(entry, "remote_runtime_retention_expired", {
					detachedAt: entry.detachedAt,
					detachReason,
					reason: "detached_runtime_ttl_expired",
					ttlMs,
				});
				// A reattach handshake can commit during the audit-write await above,
				// clearing detachedAt / adding a subscriber, or cancel and replace this
				// retention. Re-check (and confirm this retention is still the active
				// one) before disposing, so the sweep never tears down a runtime that
				// was just reattached.
				if (!this.isDetached(entry) || isEntryActive() || entry.detachedRuntimeRetention !== handle) {
					return;
				}
				await this.stopEntry(entry, "detached_runtime_ttl_expired");
			},
			onError: (error) => {
				void this.logEntryAudit(
					entry,
					"remote_runtime_retention_expired",
					{
						detachedAt: entry.detachedAt,
						detachReason,
						reason: "detached_runtime_ttl_error",
						ttlMs,
					},
					{ success: false, error: error instanceof Error ? error.message : String(error) },
				);
			},
		});
		entry.coordinator.setDetachedRuntimeRetention(handle);
	}

	// ==========================================================================
	// Audit helpers
	// ==========================================================================

	getEntryDetails(entry: IntegratedRuntimeEntry, extraDetails: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			runtime: "integrated-volt",
			sessionId: entry.sessionId,
			subscriberCount: entry.subscribers.size,
			active: entry.runtime.conversation.session.isBusy,
			...extraDetails,
		};
	}

	async logEntryAudit(
		entry: IntegratedRuntimeEntry,
		type: string,
		details: Record<string, unknown> = {},
		outcome: { clientNodeId?: string; success?: boolean; error?: string } = {},
	): Promise<void> {
		await this.logAudit({
			type,
			clientNodeId: outcome.clientNodeId ?? entry.clientNodeId,
			workspace: entry.workspaceName,
			success: outcome.success ?? true,
			error: outcome.error,
			details: this.getEntryDetails(entry, details),
		});
	}

	private async logSessionSelection(
		selection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		const common = {
			clientNodeId: authorization.client.nodeId,
			workspace: authorization.workspace.name,
		};
		if (selection.kind === "resumed") {
			await this.logAudit({
				...common,
				type: "session_resumed",
				success: true,
				details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
			});
			return;
		}
		if (selection.kind === "created_after_missing") {
			await this.logAudit({
				...common,
				type: "session_missing_on_resume",
				success: false,
				error: "session not found",
				details: { requestedSessionId: selection.requestedSessionId },
			});
			await this.logAudit({
				...common,
				type: "session_created",
				success: true,
				details: { reason: "missing_on_resume", sessionId: selection.sessionId },
			});
			return;
		}
		await this.logAudit({
			...common,
			type: "session_created",
			success: true,
			details: { reason: "new_client_connection", sessionId: selection.sessionId },
		});
	}

	private async logAudit(event: Parameters<IrohRemoteAuditLogger["log"]>[0]): Promise<void> {
		try {
			await this.options.auditLogger.log(event);
		} catch {
			// Audit logging is best-effort and must not change remote runtime behavior.
		}
	}
}

async function cleanupUncommittedRuntime(runtime: IrohRemoteAgentRuntime): Promise<void> {
	await runtime.host.close(runtime.conversation);
}

/**
 * Open a review discussion beside `source`'s conversation, in its host,
 * without moving any client. The discussion must share the source's exact cwd
 * and carry a durable child binding; `manager` is owned from the call.
 */
async function openReviewDiscussionSibling(
	source: IrohRemoteAgentRuntime,
	manager: SessionManager,
): Promise<IrohRemoteAgentRuntime> {
	const conversation = source.conversation;
	if (
		conversation.session.isReviewDiscussion ||
		!manager.getReviewDiscussion() ||
		!sameFilesystemLocation(manager.getCwd(), conversation.cwd)
	) {
		await manager.closePersistence();
		throw new Error("Review sibling requires an exact source cwd and a durable child binding");
	}
	const services = conversation.services;
	const opened = await source.host.open(
		{ kind: "adopt", sessionManager: manager, cwd: conversation.cwd },
		{
			profile: services.settingsManager.getRequestedProfile(),
			...(services.workspaceName === undefined ? {} : { workspaceName: services.workspaceName }),
			...(services.baseRef === undefined ? {} : { baseRef: services.baseRef }),
		},
	);
	if (opened.cancelled) throw new Error("Review sibling open was cancelled");
	return { host: source.host, conversation: opened.conversation };
}
