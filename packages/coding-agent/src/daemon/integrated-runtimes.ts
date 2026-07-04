import { rm } from "node:fs/promises";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
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
import type { IrohRemoteHostHandshakeFailureOutcome } from "../core/remote/iroh/protocol.ts";
import type { IrohRemoteWorkspace } from "../core/remote/iroh/state.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import {
	createIrohRemoteAgentRuntimeWithSessionSelection,
	type IrohRemoteAgentRuntimeConversationTarget,
	type IrohRemoteSubagentRuntimeCreatedEvent,
} from "../modes/rpc/iroh-remote-agent-runtime.ts";
import {
	type DetachedRuntimeRetentionHandle,
	scheduleDetachedRuntimeRetention,
} from "../remote/integrated-runtime-retention.ts";
import type { IntegratedConversationSessionSelection } from "./handshake-responses.ts";

export interface IntegratedRuntimeSubscriber {
	id: string;
	attachedAt: number;
}

interface IntegratedWorkflowState {
	workflowEvent: Record<string, unknown> | undefined;
	activeTools: Map<string, Record<string, unknown>>;
}

export interface IntegratedRuntimeEntry {
	key: string;
	clientNodeId: string;
	workspaceName: string;
	sessionId: string;
	runtime: AgentSessionRuntime;
	recordedSessionId: string;
	previousSessionIds: Set<string>;
	activeWorkflows: Map<string, IntegratedWorkflowState>;
	subscribers: Set<IntegratedRuntimeSubscriber>;
	detachedAt: number | undefined;
	detachedRuntimeRetention: DetachedRuntimeRetentionHandle | undefined;
	parentSessionId?: string;
	subagentId?: string;
}

export interface IntegratedRuntimeStreamWriter {
	sessionId: string;
	write?(value: object): Promise<void> | void;
}

export interface IntegratedRuntimeRegistryOptions {
	agentDir?: string;
	profile?: string;
	/** Injectable runtime factory (tests); defaults to the real iroh remote runtime. */
	createRuntime?: typeof createIrohRemoteAgentRuntimeWithSessionSelection;
	auditLogger: IrohRemoteAuditLogger;
	stateManager: IrohRemoteHostStateManager;
	activeStreams: IrohRemoteActiveStreamRegistry;
	detachedRuntimeTtlMs: () => number;
	getAllowTools: (workspace: IrohRemoteWorkspace) => string | undefined;
	getProjectTrustedForWorkspace: (workspace: IrohRemoteWorkspace) => boolean;
	setClientLastSessionId: IrohRemoteHostEngine["setClientLastSessionId"];
	/** Lease-broker seam: invoked when a runtime's session id changes (rekey). */
	onRuntimeRekeyed?: (workspaceName: string, previousSessionId: string, sessionId: string) => void;
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
		return { target: "new" };
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
	if (hello.conversation.target === "session") {
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
	requestedSessionId: string = entry.sessionId,
): IntegratedConversationSessionSelection {
	if (requestedSessionId !== entry.sessionId) {
		return {
			kind: "session_rekeyed",
			requestedSessionId,
			sessionId: entry.sessionId,
		};
	}
	return {
		kind: "resumed",
		requestedSessionId: entry.sessionId,
		sessionId: entry.sessionId,
	};
}

let integratedRuntimeSubscriberSequence = 0;

export class IntegratedRuntimeRegistry {
	private readonly options: IntegratedRuntimeRegistryOptions;
	private readonly entries = new Map<string, IntegratedRuntimeEntry>();

	constructor(options: IntegratedRuntimeRegistryOptions) {
		this.options = options;
	}

	/** The conversation runtime key: one runtime per (workspaceName, sessionId). */
	getRegistryKey(workspaceName: string, sessionId: string): string {
		return `${workspaceName}\0${sessionId}`;
	}

	get size(): number {
		return this.entries.size;
	}

	values(): IntegratedRuntimeEntry[] {
		return Array.from(this.entries.values());
	}

	findOwner(workspaceName: string, sessionId: string): IntegratedRuntimeEntry | undefined {
		const direct = this.entries.get(this.getRegistryKey(workspaceName, sessionId));
		if (direct) {
			return direct;
		}
		for (const entry of this.entries.values()) {
			if (entry.workspaceName === workspaceName && entry.previousSessionIds.has(sessionId)) {
				return entry;
			}
		}
		return undefined;
	}

	async getOrCreateEntry(
		handshake: { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess },
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<{
		entry: IntegratedRuntimeEntry;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		const targetSessionId = getResolvedTargetSessionId(handshake.hello, authorization);
		if (targetSessionId !== undefined) {
			// One runtime per conversation: any paired client attaches to an existing
			// runtime for the target (conversation_in_use is retired; single-user model).
			const existing = this.findOwner(authorization.workspace.name, targetSessionId);
			if (existing) {
				if (!shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization(authorization)) {
					// Reattach recognized: cancel the pending detached-runtime TTL sweep
					// synchronously, before the caller's multi-await commit window. The
					// broker flips to daemon-active immediately (commitDaemonRuntime) but
					// attachSubscriber (which normally cancels retention) only runs after
					// several awaits; if the TTL timer elapsed in that window it would
					// dispose this very runtime mid-reattach (use-after-dispose + split
					// lease/registry ownership). detachedAt stays set so attachSubscriber
					// still logs the reattach and a pre-subscriber failure re-arms retention.
					this.cancelRetention(existing);
					const requestedSessionId =
						handshake.hello.mode === "conversation" && handshake.hello.conversation.target === "session"
							? targetSessionId
							: existing.sessionId;
					return {
						entry: existing,
						created: false,
						sessionSelection: createConversationSessionSelectionFromEntry(existing, requestedSessionId),
					};
				}
				await this.stopEntry(existing, "fresh_pairing_replaced_runtime");
			}
		}
		return this.createEntry(handshake, authorization);
	}

	private async createEntry(
		handshake: { hello: IrohRemoteHello },
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<{
		entry: IntegratedRuntimeEntry;
		created: boolean;
		sessionSelection: IntegratedConversationSessionSelection;
	}> {
		let runtime: AgentSessionRuntime | undefined;
		let sessionSelection: IntegratedConversationSessionSelection | undefined;
		try {
			const runtimeResult = await (this.options.createRuntime ?? createIrohRemoteAgentRuntimeWithSessionSelection)({
				agentDir: this.options.agentDir,
				allowTools: this.options.getAllowTools(authorization.workspace) ?? authorization.allowTools,
				conversationTarget: createIrohRuntimeConversationTarget(handshake.hello, authorization),
				cwd: authorization.workspace.path,
				onSubagentRuntimeCreated: (event) => this.registerSubagentRuntime(event, authorization),
				profile: this.options.profile,
				projectTrusted: this.options.getProjectTrustedForWorkspace(authorization.workspace),
			});
			runtime = runtimeResult.runtime;
			sessionSelection = runtimeResult.sessionSelection;
			const sessionId = runtime.session.sessionId;
			const owner = this.findOwner(authorization.workspace.name, sessionId);
			if (owner) {
				await cleanupUncommittedRuntime(runtime, sessionSelection);
				return {
					entry: owner,
					created: false,
					sessionSelection: createConversationSessionSelectionFromEntry(owner),
				};
			}
			const entry = this.createEntryRecord({
				clientNodeId: authorization.client.nodeId,
				workspaceName: authorization.workspace.name,
				sessionId,
				runtime,
			});
			return { entry, created: true, sessionSelection };
		} catch (error) {
			if (runtime) {
				await cleanupUncommittedRuntime(runtime, sessionSelection);
			}
			throw error;
		}
	}

	private createEntryRecord(options: {
		clientNodeId: string;
		workspaceName: string;
		sessionId: string;
		runtime: AgentSessionRuntime;
		parentSessionId?: string;
		subagentId?: string;
	}): IntegratedRuntimeEntry {
		return {
			key: this.getRegistryKey(options.workspaceName, options.sessionId),
			clientNodeId: options.clientNodeId,
			workspaceName: options.workspaceName,
			sessionId: options.sessionId,
			runtime: options.runtime,
			recordedSessionId: options.sessionId,
			previousSessionIds: new Set(),
			activeWorkflows: new Map(),
			subscribers: new Set(),
			detachedAt: undefined,
			detachedRuntimeRetention: undefined,
			...(options.parentSessionId === undefined ? {} : { parentSessionId: options.parentSessionId }),
			...(options.subagentId === undefined ? {} : { subagentId: options.subagentId }),
		};
	}

	private async registerSubagentRuntime(
		event: IrohRemoteSubagentRuntimeCreatedEvent,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		const parentEntry = this.findOwner(authorization.workspace.name, event.parentSessionId);
		if (!parentEntry) {
			throw new Error(`Parent runtime is not active for subagent session ${event.sessionId}`);
		}
		const owner = this.findOwner(authorization.workspace.name, event.sessionId);
		if (owner) {
			return;
		}
		const entry = this.createEntryRecord({
			clientNodeId: authorization.client.nodeId,
			workspaceName: authorization.workspace.name,
			sessionId: event.sessionId,
			runtime: event.runtime,
			parentSessionId: event.parentSessionId,
			subagentId: event.id,
		});
		entry.detachedAt = Date.now();
		this.entries.set(entry.key, entry);
		await this.logEntryAudit(entry, "remote_runtime_started", {
			parentSessionId: event.parentSessionId,
			reason: "subagent_created",
			subagentId: event.id,
		});
		this.scheduleRetention(entry, "subagent_created");
	}

	async commitEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
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
		if (inserted) {
			this.entries.set(entry.key, entry);
		}

		try {
			await this.options.setClientLastSessionId(
				authorization.client.nodeId,
				authorization.workspace.name,
				entry.sessionId,
			);
			await this.logSessionSelection(sessionSelection, authorization);
			if (inserted) {
				await this.logAudit({
					type: "runtime_started",
					clientNodeId: authorization.client.nodeId,
					workspace: authorization.workspace.name,
					success: true,
					details: this.getEntryDetails(entry),
				});
				await this.logEntryAudit(entry, "remote_runtime_started", { reason: "created" });
			}
		} catch (error) {
			if (inserted && this.entries.get(entry.key) === entry) {
				this.entries.delete(entry.key);
			}
			throw error;
		}
	}

	async cleanupUncommittedEntry(
		entry: IntegratedRuntimeEntry,
		sessionSelection: IntegratedConversationSessionSelection | undefined,
	): Promise<void> {
		if (this.entries.get(entry.key) === entry) {
			this.entries.delete(entry.key);
		}
		this.cancelRetention(entry);
		entry.subscribers.clear();
		await cleanupUncommittedRuntime(entry.runtime, sessionSelection);
	}

	async attachSubscriber(entry: IntegratedRuntimeEntry): Promise<IntegratedRuntimeSubscriber> {
		const wasDetached = entry.subscribers.size === 0 && entry.detachedAt !== undefined;
		this.cancelRetention(entry);
		const subscriber: IntegratedRuntimeSubscriber = {
			id: `subscriber-${++integratedRuntimeSubscriberSequence}`,
			attachedAt: Date.now(),
		};
		entry.subscribers.add(subscriber);
		if (wasDetached) {
			entry.detachedAt = undefined;
			await this.logEntryAudit(entry, "remote_runtime_reattached", {
				reason: "subscriber_attached",
				subscriberId: subscriber.id,
			});
		}
		await this.logEntryAudit(entry, "remote_subscriber_attached", { subscriberId: subscriber.id });
		return subscriber;
	}

	async detachSubscriber(
		entry: IntegratedRuntimeEntry,
		subscriber: IntegratedRuntimeSubscriber,
		reason: string,
		error?: unknown,
	): Promise<void> {
		if (!entry.subscribers.delete(subscriber)) {
			return;
		}
		const errorMessage = error instanceof Error ? error.message : error ? String(error) : undefined;
		await this.logEntryAudit(
			entry,
			"remote_subscriber_detached",
			{ reason, subscriberId: subscriber.id },
			errorMessage === undefined,
			errorMessage,
		);
		if (entry.subscribers.size > 0) {
			return;
		}
		entry.detachedAt = Date.now();
		await this.logEntryAudit(entry, "remote_runtime_detached", { detachedAt: entry.detachedAt, reason });
		this.scheduleRetention(entry, reason);
	}

	async detachWithoutSubscriber(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		if (this.entries.get(entry.key) !== entry || entry.subscribers.size > 0) {
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
		entry.detachedAt = Date.now();
		await this.logEntryAudit(entry, "remote_runtime_detached", { detachedAt: entry.detachedAt, reason });
		this.scheduleRetention(entry, reason);
	}

	async stopEntry(entry: IntegratedRuntimeEntry, reason: string): Promise<void> {
		if (this.entries.get(entry.key) !== entry) {
			// Stale reference: the key may now belong to a replacement runtime, and
			// deleting by key alone would evict that runtime from the registry while
			// leaving it running unmanaged.
			return;
		}
		this.cancelRetention(entry);
		this.entries.delete(entry.key);
		entry.subscribers.clear();
		entry.activeWorkflows.clear();
		entry.detachedAt = undefined;
		const wasActive = entry.runtime.session.isStreaming;
		const removedLiveActivityCount = await this.options.stateManager.removeClientLiveActivitiesForSession(
			entry.clientNodeId,
			entry.workspaceName,
			entry.sessionId,
		);
		let stopSuccess = true;
		let stopError: string | undefined;
		try {
			await entry.runtime.dispose();
		} catch (error) {
			stopSuccess = false;
			stopError = error instanceof Error ? error.message : String(error);
		}
		await this.logAudit({
			type: "runtime_stopped",
			clientNodeId: entry.clientNodeId,
			workspace: entry.workspaceName,
			success: stopSuccess,
			error: stopError,
			details: this.getEntryDetails(entry, { active: wasActive, reason, removedLiveActivityCount }),
		});
		await this.logEntryAudit(
			entry,
			"remote_runtime_stopped",
			{ active: wasActive, reason, removedLiveActivityCount },
			stopSuccess,
			stopError,
		);
		this.options.onRuntimeDisposed?.(entry, reason);
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

	async handleSessionChanged(
		entry: IntegratedRuntimeEntry,
		activeStreamEntry: IntegratedRuntimeStreamWriter | undefined,
		session: { sessionId: string },
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		if (session.sessionId !== entry.sessionId) {
			await this.rekeyEntry(entry, activeStreamEntry, session.sessionId);
		}
		if (session.sessionId === entry.recordedSessionId) {
			return;
		}
		entry.recordedSessionId = session.sessionId;
		await this.recordSessionChange(session.sessionId, authorization);
	}

	private async rekeyEntry(
		entry: IntegratedRuntimeEntry,
		activeStreamEntry: IntegratedRuntimeStreamWriter | undefined,
		nextSessionId: string,
	): Promise<void> {
		const previousSessionId = entry.sessionId;
		const previousKey = entry.key;
		const nextKey = this.getRegistryKey(entry.workspaceName, nextSessionId);
		const existing = this.entries.get(nextKey);
		if (existing && existing !== entry) {
			await this.stopEntry(existing, "session_change_replaced_runtime");
		}
		if (this.entries.get(previousKey) === entry) {
			this.entries.delete(previousKey);
		}
		entry.previousSessionIds.add(previousSessionId);
		entry.sessionId = nextSessionId;
		entry.key = nextKey;
		this.entries.set(nextKey, entry);
		// Re-key EVERY stream bound to the old conversation id, not just the one
		// that drove this session change. Workflow-event fan-out matches streams by
		// the runtime's current sessionId, so a co-attached device left on the stale
		// id would be silently dropped from all future events.
		for (const stream of this.options.activeStreams.entriesForConversationKey(
			entry.workspaceName,
			previousSessionId,
		)) {
			stream.sessionId = nextSessionId;
		}
		if (activeStreamEntry) {
			// Defensive: the driving stream is normally already in the registry, but
			// keep it consistent even if this runs before it was registered.
			activeStreamEntry.sessionId = nextSessionId;
		}
		await this.logEntryAudit(entry, "remote_runtime_session_changed", {
			previousSessionId,
			sessionId: nextSessionId,
		});
		this.options.onRuntimeRekeyed?.(entry.workspaceName, previousSessionId, nextSessionId);
	}

	private async recordSessionChange(
		sessionId: string,
		authorization: IrohRemoteClientAuthorizationSuccess,
	): Promise<void> {
		try {
			const client = await this.options.setClientLastSessionId(
				authorization.client.nodeId,
				authorization.workspace.name,
				sessionId,
			);
			await this.logAudit({
				type: "session_changed",
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: client !== undefined,
				error: client ? undefined : "client not found",
				details: { reason: "remote_rpc_session_change", sessionId },
			});
		} catch (error) {
			await this.logAudit({
				type: "session_changed",
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				details: { reason: "remote_rpc_session_change", sessionId },
			});
		}
	}

	// ==========================================================================
	// Workflow event replay
	// ==========================================================================

	recordWorkflowEvent(entry: IntegratedRuntimeEntry, event: Record<string, unknown>): void {
		const workflowId = getWorkflowEventId(event);
		if (!workflowId) {
			return;
		}
		if (event.type === "workflow_start" || event.type === "workflow_update") {
			const state = entry.activeWorkflows.get(workflowId) ?? { workflowEvent: undefined, activeTools: new Map() };
			state.workflowEvent = event;
			entry.activeWorkflows.set(workflowId, state);
			return;
		}
		if (event.type === "workflow_end") {
			entry.activeWorkflows.delete(workflowId);
			return;
		}
		if (event.type === "tool_execution_start") {
			const toolCallId = getWorkflowToolCallId(event);
			if (!toolCallId) {
				return;
			}
			const state = entry.activeWorkflows.get(workflowId) ?? { workflowEvent: undefined, activeTools: new Map() };
			state.activeTools.set(toolCallId, event);
			entry.activeWorkflows.set(workflowId, state);
			return;
		}
		if (event.type === "tool_execution_end") {
			const toolCallId = getWorkflowToolCallId(event);
			if (!toolCallId) {
				return;
			}
			entry.activeWorkflows.get(workflowId)?.activeTools.delete(toolCallId);
		}
	}

	async handleWorkflowEvent(
		entry: IntegratedRuntimeEntry,
		event: Record<string, unknown>,
		excludedActiveStreamEntry: IntegratedRuntimeStreamWriter | undefined,
	): Promise<void> {
		this.recordWorkflowEvent(entry, event);
		// Fan out across every co-attached device on this conversation, not just the
		// runtime creator's clientNodeId — the runtime is shared by (workspace, session),
		// so a second paired device must also receive live workflow events.
		const activeStreams = this.options.activeStreams.entriesForConversationKey(entry.workspaceName, entry.sessionId);
		await Promise.allSettled(
			activeStreams
				.filter((activeStream) => activeStream !== excludedActiveStreamEntry && activeStream.write)
				.map((activeStream) => Promise.resolve(activeStream.write?.(event))),
		);
	}

	async replayWorkflowEvents(
		activeStreamEntry: IntegratedRuntimeStreamWriter,
		entry: IntegratedRuntimeEntry,
	): Promise<void> {
		for (const state of entry.activeWorkflows.values()) {
			if (state.workflowEvent) {
				await Promise.resolve(activeStreamEntry.write?.(state.workflowEvent)).catch(() => {});
			}
			for (const toolEvent of state.activeTools.values()) {
				await Promise.resolve(activeStreamEntry.write?.(toolEvent)).catch(() => {});
			}
		}
	}

	// ==========================================================================
	// Retention
	// ==========================================================================

	cancelRetention(entry: IntegratedRuntimeEntry): void {
		if (!entry.detachedRuntimeRetention) {
			return;
		}
		entry.detachedRuntimeRetention.cancel();
		entry.detachedRuntimeRetention = undefined;
	}

	isDetached(entry: IntegratedRuntimeEntry): boolean {
		return this.entries.get(entry.key) === entry && entry.subscribers.size === 0 && entry.detachedAt !== undefined;
	}

	scheduleRetention(entry: IntegratedRuntimeEntry, detachReason: string, ttlOverrideMs?: number): void {
		this.cancelRetention(entry);
		// A re-arm for an already-detached entry (reattach cancelled retention then
		// aborted before attach) honors the ORIGINAL detach deadline via an override
		// rather than restarting a full TTL, so a flaky reconnect-then-abort loop
		// cannot keep resetting the clock and pin a detached runtime open forever.
		const ttlMs = ttlOverrideMs ?? this.options.detachedRuntimeTtlMs();
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs,
			isDetached: () => this.isDetached(entry),
			isActive: () => entry.runtime.session.isStreaming,
			waitForIdle: () => entry.runtime.session.waitForIdle(),
			onExpire: async () => {
				if (!this.isDetached(entry) || entry.runtime.session.isStreaming) {
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
				if (
					!this.isDetached(entry) ||
					entry.runtime.session.isStreaming ||
					entry.detachedRuntimeRetention !== handle
				) {
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
					false,
					error instanceof Error ? error.message : String(error),
				);
			},
		});
		entry.detachedRuntimeRetention = handle;
	}

	// ==========================================================================
	// Audit helpers
	// ==========================================================================

	getEntryDetails(entry: IntegratedRuntimeEntry, extraDetails: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			runtime: "integrated-volt",
			sessionId: entry.sessionId,
			subscriberCount: entry.subscribers.size,
			active: entry.runtime.session.isStreaming,
			...extraDetails,
		};
	}

	async logEntryAudit(
		entry: IntegratedRuntimeEntry,
		type: string,
		details: Record<string, unknown> = {},
		success = true,
		error?: string,
	): Promise<void> {
		await this.logAudit({
			type,
			clientNodeId: entry.clientNodeId,
			workspace: entry.workspaceName,
			success,
			error,
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
		if (selection.kind === "session_rekeyed") {
			await this.logAudit({
				...common,
				type: "session_rekeyed",
				success: true,
				details: { requestedSessionId: selection.requestedSessionId, sessionId: selection.sessionId },
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

async function cleanupUncommittedRuntime(
	runtime: AgentSessionRuntime,
	sessionSelection: IntegratedConversationSessionSelection | undefined,
): Promise<void> {
	const sessionFile = runtime.session.sessionFile;
	await runtime.dispose().catch(() => {});
	if (sessionSelection?.kind === "resumed") {
		return;
	}
	if (typeof sessionFile === "string" && sessionFile.length > 0) {
		await rm(sessionFile, { force: true }).catch(() => {});
	}
}

function getWorkflowEventId(event: Record<string, unknown>): string | undefined {
	return typeof event.workflowId === "string" && event.workflowId.trim() ? event.workflowId.trim() : undefined;
}

function getWorkflowToolCallId(event: Record<string, unknown>): string | undefined {
	return typeof event.toolCallId === "string" && event.toolCallId.trim() ? event.toolCallId.trim() : undefined;
}
