/**
 * The conversations a worker hosts (Phase 7 plan §1, D1, D11 revised): its
 * top-level conversations, each the daemon sent it (`worker_open`) and each
 * in a host of its own, and with each the conversations that must share its
 * writer or process, its group: each claimed from the daemon's registry
 * (`worker_hosts`) before it opens, into the group of the conversation it
 * belongs to: the children of its subagents, review finding discussions and
 * the review sources they write through (siblings), and the targets of moves
 * an extension starts for a client (moved). A claim for a conversation
 * another worker hosts is refused; a stored session an extension switches
 * to is then left to that worker. Every hosted conversation is released
 * once it closed; a group closes as one, what it claimed first and its
 * top-level conversation last, which also closes the group when it closes
 * on its own (it lost its log). Each hosted conversation's Git state is
 * reported to the daemon for change association, and its settings and
 * credentials are watched for changes other processes write (D12).
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
import type { WorkerHostKind, WorkerSpawnSpec } from "../control-protocol.ts";
import type { DaemonLogger } from "../log.ts";
import { observeCompactionFailures } from "./compaction-failure-log.ts";
import type { IrohRemoteAgentRuntime, IrohRemoteSubagentRuntimeCreatedEvent } from "./conversation-factory.ts";
import { type WorkerDaemonClient, WorkerRequestError } from "./daemon-client.ts";
import { watchConversationSettings } from "./settings-watcher.ts";

/** How long a sibling claim waits for the group that hosted the conversation to close. */
const SIBLING_CLAIM_WAIT_MS = 15_000;
const SIBLING_CLAIM_RETRY_MS = 200;
/** How long a top-level conversation's release waits for its group's pending claims to settle. */
const GROUP_RELEASE_WAIT_MS = 15_000;

/** A hosted conversation, in the host it opened in. */
export interface WorkerConversation {
	readonly host: ConversationHost;
	readonly conversation: HostedConversation;
	/** `conversation`: a top-level conversation, heading its group. */
	readonly kind: "conversation" | WorkerHostKind;
	/** The top-level conversation whose group it is in (its own id for one). */
	readonly top: string;
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
	private readonly hosted = new Map<string, WorkerConversation>();
	/** What each top-level conversation was opened from, by its id. */
	private readonly specs = new Map<string, WorkerSpawnSpec>();
	/** Whether a project is trusted now for each top-level conversation's group, by its id: its settings reload only while it is. */
	private readonly trust = new Map<string, (cwd: string) => boolean>();
	/** Settles once a hosted conversation closed and was released, by its id. */
	private readonly releases = new Map<string, Promise<void>>();
	private readonly observations = new Map<string, GitContextObservationBinding>();
	/** Sessions claimed and not yet open here: released if they never open. */
	private readonly pendingClaims = new Set<string>();
	private readonly reviews: HostReviewDiscussionService;
	private stopping = false;

	constructor(options: {
		client: WorkerDaemonClient;
		workspaceName: string;
		/** Where failed compactions are recorded: clients only see them while connected. */
		log: ReturnType<DaemonLogger["child"]>;
		/** Settings or credentials another process wrote changed what a hosted conversation's clients see. */
		onCatalogChanged: (conversation: HostedConversation, catalog: "settings" | "models") => void;
	}) {
		this.client = options.client;
		this.workspaceName = options.workspaceName;
		this.log = options.log;
		this.onCatalogChanged = options.onCatalogChanged;
		this.reviews = new HostReviewDiscussionService({
			findRuntime: (ref, requester) => {
				if (!this.isHosted(requester)) throw new Error("Review requester runtime is unavailable");
				return [...this.hosted.values()].find((hosted) => sameRef(ref, hosted.conversation.session.sessionRef))
					?.conversation;
			},
			assertCurrent: (runtime) => {
				if (!this.isHosted(runtime) || this.stopping) throw new Error("Review runtime ownership changed");
			},
			// An unloaded source is claimed for the write, so no other worker opens it meanwhile. One open here
			// under another reference (another group's) is that conversation's to write, not this one's.
			withSourceWrite: async (requester, ref, write) => {
				if (!this.isHosted(requester)) throw new Error("Review source writer authority changed");
				if (this.hosted.has(ref.sessionId)) {
					throw new WorkerRequestError("claimed", "another conversation in this worker hosts that source");
				}
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

	/** Host `opened`, a top-level conversation opened from `spec` in a host of its own. */
	adoptTop(spec: WorkerSpawnSpec, opened: IrohRemoteAgentRuntime): void {
		const { host, conversation } = opened;
		this.specs.set(conversation.id, spec);
		this.trust.set(conversation.id, opened.projectTrusted);
		this.track({ host, conversation, kind: "conversation", top: conversation.id });
	}

	/** What the group of `conversation` was opened from; undefined once it is not hosted. */
	specOf(conversation: HostedConversation): WorkerSpawnSpec | undefined {
		const top = this.hosted.get(conversation.id)?.top;
		return top === undefined ? undefined : this.specs.get(top);
	}

	/** The open top-level conversation `sessionId`. */
	top(sessionId: string): WorkerConversation | undefined {
		const hosted = this.get(sessionId);
		return hosted?.kind === "conversation" ? hosted : undefined;
	}

	/** The open conversations of the group of the top-level conversation `top`, it included. */
	group(top: string): WorkerConversation[] {
		return this.list().filter((hosted) => hosted.top === top);
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

	/** The hosted conversations that are active, by id. */
	activeIds(): string[] {
		return this.list()
			.filter((hosted) => hosted.conversation.isActive())
			.map((hosted) => hosted.conversation.id);
	}

	/**
	 * Close the group of the top-level conversation `top`: what it claimed
	 * first, then it (its release follows theirs), then its host. Resolves once
	 * the group closed and was released.
	 */
	async closeGroup(top: string): Promise<void> {
		const head = this.hosted.get(top);
		if (!head || head.kind !== "conversation") return;
		await this.closeMembers(head);
		await head.host.close(head.conversation).catch(() => undefined);
		await this.releases.get(top);
	}

	/**
	 * The worker stops: close every group, their claims first, without
	 * releasing anything (the daemon drops what the worker hosted at its exit).
	 */
	async closeAll(): Promise<void> {
		this.stopping = true;
		const entries = [...this.hosted.values()];
		const results = await Promise.allSettled([
			...entries
				.filter((entry) => entry.kind !== "conversation")
				.map((entry) => entry.host.close(entry.conversation, { reason: "quit" })),
		]);
		const disposed = await Promise.allSettled(
			entries.filter((entry) => entry.kind === "conversation").map((entry) => entry.host.dispose()),
		);
		const errors = [...results, ...disposed].flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "The worker's conversations did not close");
	}

	/** Close the conversations `head`'s group claimed, and wait for their release. */
	private async closeMembers(head: WorkerConversation): Promise<void> {
		const members = [...this.hosted.values()].filter((entry) => entry.top === head.top && entry !== head);
		await Promise.allSettled(
			members.map((entry) => (entry.conversation.closed ? undefined : entry.host.close(entry.conversation))),
		);
		await Promise.allSettled(members.map((entry) => this.releases.get(entry.conversation.id)));
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
	 * it again from the store), and release it once it closed; a top-level
	 * conversation closes its group first, and goes last.
	 */
	private track(hosted: WorkerConversation): void {
		const sessionId = hosted.conversation.id;
		const projectTrusted = this.trust.get(hosted.top);
		if (!projectTrusted) throw new Error("A hosted conversation belongs to no top-level conversation");
		const stopCompactionLog = observeCompactionFailures(hosted.conversation, this.workspaceName, this.log);
		const stopWatching = watchConversationSettings(
			hosted.conversation,
			(catalog) => this.onCatalogChanged(hosted.conversation, catalog),
			projectTrusted,
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
		const released = hosted.conversation.whenClosed().then(async () => {
			stopCompactionLog();
			stopWatching();
			binding.dispose();
			if (this.observations.get(sessionId) === binding) this.observations.delete(sessionId);
			if (this.hosted.get(sessionId) !== hosted) return;
			if (hosted.kind === "conversation") {
				// The group closes with its head, what it claimed released first.
				await this.closeMembers(hosted);
				await hosted.host.dispose().catch(() => undefined);
				this.specs.delete(sessionId);
				this.trust.delete(sessionId);
			}
			this.hosted.delete(sessionId);
			// A stopping worker releases nothing: the daemon drops what it hosted at its exit. Otherwise
			// the observation ends before the claim does: the daemon accepts it only from its host.
			if (this.stopping) return;
			await this.client.changeObserve(this.workspaceName, sessionId, null).catch(() => undefined);
			await this.release(sessionId, hosted.kind === "conversation");
		});
		this.releases.set(sessionId, released);
		void released.finally(() => {
			if (this.releases.get(sessionId) === released) this.releases.delete(sessionId);
		});
	}

	/**
	 * Release `sessionId`; a top-level conversation's release waits while a
	 * claim of its group is still pending (the daemon releases a group's head last).
	 */
	private async release(sessionId: string, top: boolean): Promise<void> {
		const deadline = Date.now() + GROUP_RELEASE_WAIT_MS;
		for (;;) {
			try {
				await this.client.released(sessionId);
				return;
			} catch (error) {
				if (
					!top ||
					this.stopping ||
					!(error instanceof WorkerRequestError) ||
					error.code !== "group_open" ||
					Date.now() >= deadline
				) {
					return;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, SIBLING_CLAIM_RETRY_MS));
		}
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
				this.track({ host: event.host, conversation: event.conversation, kind: "child", top: parent.top });
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
			this.track({
				host: sourceHosted.host,
				conversation: opened.conversation,
				kind: "sibling",
				top: sourceHosted.top,
			});
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
		// A stored target another group here hosts stays in its group: the client is redirected to it.
		if (target.conversation === undefined && this.hosted.has(target.sessionId)) return undefined;
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
		const source = this.hosted.get(from.id);
		if (!source) throw new Error("The conversation the client left is not hosted here");
		const { host, top } = source;
		const sessionId = target.sessionId;
		return {
			commit: async () => {
				const conversation = target.conversation ?? host.get(sessionId);
				if (conversation && !conversation.closed) this.track({ host, conversation, kind: "moved", top });
			},
			abort: async () => {
				if (this.pendingClaims.delete(sessionId)) await this.client.released(sessionId).catch(() => undefined);
			},
		};
	}
}
