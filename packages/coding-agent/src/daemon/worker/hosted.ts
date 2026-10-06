/**
 * The conversations a worker hosts (Phase 7 plan §1, D1): its primary, and
 * those that must share its writer or process, each claimed from the
 * daemon's registry (`worker_hosts`) before it opens and released once it
 * closed: the children of its subagents, review finding discussions and the
 * review sources they write through (siblings), and the targets of moves an
 * extension starts for a client of the worker (moved). A claim for a
 * conversation another worker hosts is refused; a stored session an
 * extension switches to is then left to that worker. Each hosted
 * conversation's Git state is reported to the daemon for change association,
 * and its settings and credentials are watched for changes other processes
 * write (D12).
 */

import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { GitContextObservationBinding } from "../../core/git-context-provider.ts";
import type { ConversationHost } from "../../core/host/conversation-host.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { sameFilesystemLocation } from "../../core/host/session-summaries.ts";
import type { HostedRedirect, RedirectTarget } from "../../core/host/targets.ts";
import { HostReviewDiscussionService, type ReviewDiscussionService } from "../../core/review-discussions.ts";
import { SessionManager, type SessionReference } from "../../core/session-manager.ts";
import type { SubagentRuntimeRegistration } from "../../core/subagents/index.ts";
import type { WorkerHostKind } from "../control-protocol.ts";
import type { DaemonLogger } from "../log.ts";
import { observeCompactionFailures } from "./compaction-failure-log.ts";
import type { IrohRemoteSubagentRuntimeCreatedEvent } from "./conversation-factory.ts";
import { type WorkerDaemonClient, WorkerRequestError } from "./daemon-client.ts";
import { watchConversationSettings } from "./settings-watcher.ts";

/** How long a sibling claim waits for the worker that hosted the conversation to exit. */
const SIBLING_CLAIM_WAIT_MS = 15_000;
const SIBLING_CLAIM_RETRY_MS = 200;

/** A hosted conversation, in the host it opened in. */
export interface WorkerConversation {
	readonly host: ConversationHost;
	readonly conversation: HostedConversation;
	readonly kind: "primary" | WorkerHostKind;
}

/** The branch Git state the daemon associates changes with; null when there is none to associate. */
function branchContext(gitContext: RpcGitContext | null | undefined): {
	repository: string;
	branch: string;
	headOid: string;
	baseRef?: string;
} | null {
	if (!gitContext || gitContext.stale || gitContext.head.kind !== "branch") return null;
	return {
		repository: gitContext.repository,
		branch: gitContext.head.name,
		headOid: gitContext.head.oid,
		...(gitContext.base === null ? {} : { baseRef: gitContext.base.ref }),
	};
}

function sameRef(ref: SessionReference, other: SessionReference | undefined): boolean {
	return (
		other !== undefined &&
		other.storeId === ref.storeId &&
		other.sessionId === ref.sessionId &&
		other.sessionGeneration === ref.sessionGeneration
	);
}

export class WorkerConversations {
	private readonly client: WorkerDaemonClient;
	private readonly workspaceName: string;
	private readonly log: ReturnType<DaemonLogger["child"]>;
	private readonly onCatalogChanged: (conversation: HostedConversation, catalog: "settings" | "models") => void;
	private readonly projectTrusted: (cwd: string) => boolean;
	private readonly hosted = new Map<string, WorkerConversation>();
	private readonly observations = new Map<string, GitContextObservationBinding>();
	/** Sessions claimed and not yet open here: released if they never open. */
	private readonly pendingClaims = new Set<string>();
	private readonly reviews: HostReviewDiscussionService;
	private primaryConversation: WorkerConversation | undefined;
	private stopping = false;

	constructor(options: {
		client: WorkerDaemonClient;
		workspaceName: string;
		/** Where failed compactions are recorded: clients only see them while connected. */
		log: ReturnType<DaemonLogger["child"]>;
		/** Settings or credentials another process wrote changed what a hosted conversation's clients see. */
		onCatalogChanged: (conversation: HostedConversation, catalog: "settings" | "models") => void;
		/** Whether the project in `cwd` is trusted now: a project's settings reload only while it is. */
		projectTrusted: (cwd: string) => boolean;
	}) {
		this.client = options.client;
		this.workspaceName = options.workspaceName;
		this.log = options.log;
		this.onCatalogChanged = options.onCatalogChanged;
		this.projectTrusted = options.projectTrusted;
		this.reviews = new HostReviewDiscussionService({
			findRuntime: (ref, requester) => {
				if (!this.isHosted(requester)) throw new Error("Review requester runtime is unavailable");
				return [...this.hosted.values()].find((hosted) => sameRef(ref, hosted.conversation.session.sessionRef))
					?.conversation;
			},
			assertCurrent: (runtime) => {
				if (!this.isHosted(runtime) || this.stopping) throw new Error("Review runtime ownership changed");
			},
			// An unloaded source is claimed for the write, so no other worker opens it meanwhile.
			withSourceWrite: async (requester, ref, write) => {
				if (!this.isHosted(requester)) throw new Error("Review source writer authority changed");
				await this.claim(ref.sessionId, "sibling", requester.id);
				try {
					return await write();
				} finally {
					this.pendingClaims.delete(ref.sessionId);
					await this.client.released(ref.sessionId).catch(() => undefined);
				}
			},
			createSibling: (source, ref, assertCurrent) => this.openSibling(source, ref, assertCurrent),
		});
	}

	/** The worker's primary conversation, once it opened. */
	get primary(): WorkerConversation {
		if (!this.primaryConversation) throw new Error("The worker's primary conversation is not open");
		return this.primaryConversation;
	}

	/** Host `conversation`, the worker's primary. */
	adoptPrimary(host: ConversationHost, conversation: HostedConversation): void {
		this.primaryConversation = { host, conversation, kind: "primary" };
		this.track(this.primaryConversation);
	}

	/** The open conversation `sessionId` this worker hosts. */
	get(sessionId: string): WorkerConversation | undefined {
		const hosted = this.hosted.get(sessionId);
		return hosted && !hosted.conversation.closed ? hosted : undefined;
	}

	/** Every open conversation this worker hosts. */
	list(): WorkerConversation[] {
		return [...this.hosted.values()].filter((hosted) => !hosted.conversation.closed);
	}

	/** Whether any hosted conversation is active (RFC §7.3): a turn, running work, or a hold. */
	active(): boolean {
		return this.list().some((hosted) => hosted.conversation.isActive());
	}

	reviewDiscussions(conversation: HostedConversation): ReviewDiscussionService {
		return this.reviews.forRuntime(conversation);
	}

	/** The worker stops: review effects fail from here, and nothing more is claimed. */
	beginStopping(): void {
		this.stopping = true;
	}

	private isHosted(conversation: HostedConversation): boolean {
		return this.hosted.get(conversation.id)?.conversation === conversation && !conversation.closed;
	}

	/**
	 * Claim `sessionId` from the daemon before it opens here. Rejects with code
	 * `claimed` when another worker hosts it. A sibling claim waits while the
	 * daemon retires a detached, idle worker that hosted it (`retiring`).
	 */
	private async claim(
		sessionId: string,
		kind: WorkerHostKind,
		parentSessionId: string,
		inMemory = false,
	): Promise<void> {
		const deadline = Date.now() + SIBLING_CLAIM_WAIT_MS;
		for (;;) {
			if (this.stopping) throw new Error("The worker is stopping");
			try {
				await this.client.hosts(sessionId, kind, parentSessionId, inMemory);
				break;
			} catch (error) {
				if (!(error instanceof WorkerRequestError) || error.code !== "retiring" || Date.now() >= deadline)
					throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, SIBLING_CLAIM_RETRY_MS));
		}
		this.pendingClaims.add(sessionId);
	}

	/**
	 * Track a hosted conversation: report its Git state, record its failed
	 * compactions, close it once it lost its log (a reconnecting client opens
	 * it again from the store), and release its claim once it closed.
	 */
	private track(hosted: WorkerConversation): void {
		const sessionId = hosted.conversation.id;
		const stopCompactionLog = observeCompactionFailures(hosted.conversation, this.workspaceName, this.log);
		const stopWatching = watchConversationSettings(
			hosted.conversation,
			(catalog) => this.onCatalogChanged(hosted.conversation, catalog),
			this.projectTrusted,
		);
		void hosted.conversation.lost.then(() => {
			if (!hosted.conversation.closed) void hosted.host.close(hosted.conversation).catch(() => undefined);
		});
		this.pendingClaims.delete(sessionId);
		this.hosted.set(sessionId, hosted);
		const binding = new GitContextObservationBinding(
			(observation) => {
				if (observation.status !== "definitive" || this.observations.get(sessionId) !== binding) return;
				void this.client
					.changeObserve(this.workspaceName, sessionId, branchContext(observation.gitContext))
					.catch(() => undefined);
			},
			{ monitor: true },
		);
		this.observations.set(sessionId, binding);
		binding.bind(hosted.conversation.session.gitContextProvider);
		void hosted.conversation.whenClosed().then(() => {
			stopCompactionLog();
			stopWatching();
			binding.dispose();
			if (this.observations.get(sessionId) === binding) this.observations.delete(sessionId);
			if (this.hosted.get(sessionId) !== hosted) return;
			this.hosted.delete(sessionId);
			// The primary closes with the worker; the daemon drops it then. A claimed one's
			// observation ends before its claim does: the daemon accepts it only from its host.
			if (hosted.kind !== "primary") {
				void this.client
					.changeObserve(this.workspaceName, sessionId, null)
					.catch(() => undefined)
					.then(() => this.client.released(sessionId))
					.catch(() => undefined);
			}
		});
	}

	/**
	 * A subagent of a hosted conversation created its child: claim it, so a
	 * phone opening the child reaches this worker. The child stays open until
	 * the worker stops.
	 */
	async registerChild(event: IrohRemoteSubagentRuntimeCreatedEvent): Promise<SubagentRuntimeRegistration> {
		const parent = this.hosted.get(event.parentSessionId);
		if (!parent || parent.conversation.closed) {
			throw new Error(`Parent conversation is not hosted for subagent session ${event.sessionId}`);
		}
		// The child of an in-memory conversation is in memory too.
		await this.claim(
			event.sessionId,
			"child",
			event.parentSessionId,
			event.conversation.session.sessionRef === undefined,
		);
		let state: "prepared" | "committed" | "rolled-back" = "prepared";
		return {
			commit: () => {
				if (state !== "prepared") return;
				state = "committed";
				this.track({ host: event.host, conversation: event.conversation, kind: "child" });
			},
			rollback: async () => {
				if (state === "rolled-back") return;
				const committed = state === "committed";
				state = "rolled-back";
				if (committed) {
					await event.host.close(event.conversation);
					return;
				}
				this.pendingClaims.delete(event.sessionId);
				await event.host.close(event.conversation).catch(() => undefined);
				await this.client.released(event.sessionId).catch(() => undefined);
			},
		};
	}

	/**
	 * Open a review finding discussion beside `source`, in its host, without
	 * moving any client: claimed first; it must share the source's exact cwd
	 * and carry a durable child binding.
	 */
	private async openSibling(
		source: HostedConversation,
		ref: SessionReference,
		assertCurrent: () => void,
	): Promise<HostedConversation> {
		const existing = this.get(ref.sessionId);
		if (existing) {
			if (!sameRef(ref, existing.conversation.session.sessionRef)) {
				throw new Error("Review child runtime identity changed");
			}
			return existing.conversation;
		}
		const sourceHosted = this.hosted.get(source.id);
		if (!sourceHosted || sourceHosted.conversation !== source) throw new Error("Review source runtime unavailable");
		await this.claim(ref.sessionId, "sibling", source.id);
		let manager: SessionManager | undefined;
		try {
			assertCurrent();
			manager = await SessionManager.open(ref);
			if (
				source.session.isReviewDiscussion ||
				!manager.getReviewDiscussion() ||
				!sameFilesystemLocation(manager.getCwd(), source.cwd)
			) {
				throw new Error("Review sibling requires an exact source cwd and a durable child binding");
			}
			const services = source.services;
			const opened = await sourceHosted.host.open(
				{ kind: "adopt", sessionManager: manager, cwd: source.cwd },
				{
					profile: services.settingsManager.getRequestedProfile(),
					...(services.workspaceName === undefined ? {} : { workspaceName: services.workspaceName }),
					...(services.baseRef === undefined ? {} : { baseRef: services.baseRef }),
				},
			);
			manager = undefined;
			if (opened.cancelled) throw new Error("Review sibling open was cancelled");
			if (!sameRef(ref, opened.conversation.session.sessionRef)) {
				await sourceHosted.host.close(opened.conversation).catch(() => undefined);
				throw new Error("Review child initialization changed identity");
			}
			this.track({ host: sourceHosted.host, conversation: opened.conversation, kind: "sibling" });
			return opened.conversation;
		} catch (error) {
			await manager?.closePersistence().catch(() => undefined);
			if (this.pendingClaims.delete(ref.sessionId)) await this.client.released(ref.sessionId).catch(() => undefined);
			throw error;
		}
	}

	/**
	 * The target of a move an extension started for a client on `from`
	 * (`HostClientMove` `hostTarget`): a conversation that opened here is
	 * claimed and hosted; a stored one is claimed before it opens, and left to
	 * the worker hosting it when the claim is refused (undefined).
	 */
	async hostMoved(from: HostedConversation, target: RedirectTarget): Promise<HostedRedirect | undefined> {
		if (!this.isHosted(from)) throw new Error("The conversation the client left is not hosted here");
		try {
			// A target the move opened here follows its source's storage: in memory for an in-memory source.
			await this.claim(
				target.sessionId,
				"moved",
				from.id,
				target.conversation !== undefined && target.conversation.session.sessionRef === undefined,
			);
		} catch (error) {
			if (target.conversation === undefined && error instanceof WorkerRequestError && error.code === "claimed") {
				return undefined;
			}
			throw error;
		}
		const host = this.hosted.get(from.id)?.host;
		if (!host) throw new Error("The conversation the client left is not hosted here");
		const sessionId = target.sessionId;
		return {
			commit: async () => {
				const conversation = target.conversation ?? host.get(sessionId);
				if (conversation && !conversation.closed) this.track({ host, conversation, kind: "moved" });
			},
			abort: async () => {
				if (this.pendingClaims.delete(sessionId)) await this.client.released(sessionId).catch(() => undefined);
			},
		};
	}
}
