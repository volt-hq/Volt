/**
 * Completion notifications for paired devices: when a run a device's own
 * prompt started settles, or a review it can see completes, the host pushes a
 * notification through the device's push target. Delivery history is kept per
 * conversation and device, so one device's streams to a conversation share
 * it: an event is pushed at most once, and an event whose push failed is
 * retried when the device reconnects.
 */

import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES } from "@hansjm10/volt-protocol/push";
import type { AgentSession } from "../../agent-session.ts";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import type { AgentMode, PlanPhase } from "../../planning.ts";
import type { ReviewWorkflowResultRecord } from "../../review-workflows.ts";
import {
	type IrohRemotePushNotificationDelivery,
	type IrohRemotePushNotificationIntent,
	sanitizeIrohRemoteNotificationMetadata,
	sanitizeIrohRemoteNotificationTarget,
	sanitizeIrohRemoteNotificationText,
	sanitizeIrohRemoteNotificationWorkspace,
	sanitizeIrohRemotePushNotificationIntent,
} from "./push.ts";

export type IrohRemoteNotificationKind = "conversation_completed" | "plan_ready" | "review_completed" | "host_notice";

type RunTerminalOutcome = "completed" | "failed" | "aborted";

/** What a completion notification compares before and after a run. */
export interface IrohRemoteCompletionState {
	sessionId: string;
	runId?: string;
	terminalOutcome?: RunTerminalOutcome;
	planningMode: AgentMode;
	planPhase?: PlanPhase;
	planId?: string;
	planTitle?: string;
}

/** Recent delivery history kept per conversation and device. */
const MAX_DELIVERED_EVENT_IDS = 512;
const MAX_PENDING_EVENT_IDS = 512;

export interface CompletionNotificationsOptions {
	/** The host's Iroh node id, bound into every notification. */
	readonly hostNodeId: string;
	/** The device; its streams to a conversation share delivery history. */
	readonly clientNodeId?: string;
	readonly workspaceName?: string;
	/** The device's push delivery; without it nothing is sent. */
	readonly delivery?: IrohRemotePushNotificationDelivery;
}

/** One stream's attachment to its conversation's notifications. */
export interface CompletionNotifications {
	/** The device's own input was accepted: notify when the run it started settles. */
	inputAccepted(): void;
	detach(): void;
}

const anonymousClient = Symbol("anonymous-iroh-notification-client");
type ClientKey = string | typeof anonymousClient;

const reconcilersBySession = new WeakMap<AgentSession, Map<ClientKey, NotificationReconciler>>();

class NotificationReconciler {
	private readonly delivered = new Set<string>();
	private readonly pending = new Map<string, IrohRemotePushNotificationIntent>();
	private readonly conversation: HostedConversation;
	private readonly hostNodeId: string;
	private delivery: IrohRemotePushNotificationDelivery | undefined;
	private workspaceName: string | undefined;
	private queue: Promise<void> = Promise.resolve();

	constructor(conversation: HostedConversation, hostNodeId: string) {
		this.conversation = conversation;
		this.hostNodeId = hostNodeId;
		conversation.reviewWorkflows.attachSink((event) => {
			if (event.type !== "workflow_end" || event.kind !== "review" || event.status !== "completed") return;
			const record = conversation.reviewWorkflows.get(event.workflowId);
			if (record?.status !== "completed") return;
			const notification = reviewCompletion(record, conversation.session.sessionId, hostNodeId, this.workspaceName);
			if (notification) void this.deliver(notification);
		});
	}

	attach(options: CompletionNotificationsOptions): void {
		if (options.hostNodeId !== this.hostNodeId) {
			throw new Error("Notification host identity changed for a retained runtime");
		}
		this.workspaceName = options.workspaceName;
		this.delivery = options.delivery;
		for (const descriptor of this.conversation.reviewWorkflows.list()) {
			if (descriptor.status !== "completed") continue;
			const record = this.conversation.reviewWorkflows.get(descriptor.workflowId);
			if (record?.status !== "completed") continue;
			const notification = reviewCompletion(
				record,
				this.conversation.session.sessionId,
				this.hostNodeId,
				this.workspaceName,
			);
			if (notification) this.enqueue(notification);
		}
		void this.flushLater();
	}

	deliver(notification: IrohRemotePushNotificationIntent): Promise<void> {
		this.enqueue(notification);
		return this.flushLater();
	}

	private enqueue(notification: IrohRemotePushNotificationIntent): void {
		const bounded = sanitizeIrohRemotePushNotificationIntent(notification);
		if (!bounded || this.delivered.has(bounded.eventId) || this.pending.has(bounded.eventId)) return;
		while (this.pending.size >= MAX_PENDING_EVENT_IDS) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) break;
			this.pending.delete(oldest);
		}
		this.pending.set(bounded.eventId, bounded);
	}

	private flushLater(): Promise<void> {
		const flush = this.queue.then(() => this.flush());
		this.queue = flush.catch(() => {});
		return flush;
	}

	private async flush(): Promise<void> {
		const delivery = this.delivery;
		if (!delivery) return;
		for (const [eventId, notification] of [...this.pending]) {
			if (this.delivered.has(eventId)) {
				this.pending.delete(eventId);
				continue;
			}
			try {
				const status = await delivery.deliverNotification(notification);
				if (status === "sent" || status === "duplicate") this.markDelivered(eventId);
			} catch {
				// Kept pending: retried when the device reconnects.
			}
		}
	}

	private markDelivered(eventId: string): void {
		this.pending.delete(eventId);
		while (this.delivered.size >= MAX_DELIVERED_EVENT_IDS) {
			const oldest = this.delivered.values().next().value;
			if (oldest === undefined) break;
			this.delivered.delete(oldest);
		}
		this.delivered.add(eventId);
	}
}

/** Attach a stream to its conversation's notifications for its device. */
export function attachCompletionNotifications(
	conversation: HostedConversation,
	options: CompletionNotificationsOptions,
): CompletionNotifications {
	let reconcilers = reconcilersBySession.get(conversation.session);
	if (!reconcilers) {
		reconcilers = new Map();
		reconcilersBySession.set(conversation.session, reconcilers);
	}
	const key = options.clientNodeId ?? anonymousClient;
	let reconciler = reconcilers.get(key);
	if (!reconciler) {
		reconciler = new NotificationReconciler(conversation, options.hostNodeId);
		reconcilers.set(key, reconciler);
	}
	const attached = reconciler;
	attached.attach(options);
	let detached = false;
	return {
		inputAccepted() {
			if (detached) return;
			const session = conversation.session;
			const initial = completionState(session);
			// The run continues when the stream detaches; its notification is still pushed.
			void session
				.waitForIdle()
				.then(() => {
					const notification = runCompletion(initial, completionState(session), options);
					if (notification) return attached.deliver(notification);
					return undefined;
				})
				.catch(() => undefined);
		},
		detach() {
			detached = true;
		},
	};
}

export function completionState(session: AgentSession): IrohRemoteCompletionState {
	const planning = session.getPlanningState?.() ?? { mode: "build" as const, plan: null };
	const planId = sanitizeIrohRemoteNotificationMetadata(planning.plan?.id);
	const planTitle =
		planning.plan?.title === undefined
			? undefined
			: sanitizeIrohRemoteNotificationText(planning.plan.title, MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES);
	return {
		sessionId: session.sessionId,
		runId: session.sessionManager.getLeafId() ?? undefined,
		terminalOutcome: terminalOutcome(session.messages),
		planningMode: planning.mode,
		...(planning.plan === null ? {} : { planPhase: planning.plan.phase }),
		...(planId === undefined ? {} : { planId }),
		...(planTitle === undefined ? {} : { planTitle }),
	};
}

function terminalOutcome(messages: readonly AgentMessage[]): RunTerminalOutcome {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		if (message.stopReason === "error") return "failed";
		if (message.stopReason === "aborted") return "aborted";
		return "completed";
	}
	return "completed";
}

/** The notification for a run that settled, if the run changed the conversation. */
export function runCompletion(
	initial: IrohRemoteCompletionState | undefined,
	final: IrohRemoteCompletionState,
	options: Pick<CompletionNotificationsOptions, "hostNodeId" | "workspaceName">,
): IrohRemotePushNotificationIntent | undefined {
	if (!final.runId) return undefined;
	if (initial?.sessionId === final.sessionId && initial.runId === final.runId) return undefined;
	const runId = final.runId;
	const outcome = final.terminalOutcome ?? "completed";
	const workspaceName = sanitizeIrohRemoteNotificationWorkspace(options.workspaceName);
	const workspace = workspaceName === undefined ? {} : { workspaceName };
	switch (outcome) {
		case "failed":
			return {
				eventId: `conversation:${final.sessionId}:${runId}:failed`,
				hostNodeId: options.hostNodeId,
				kind: "host_notice",
				title: workspaceName === undefined ? "Volt needs attention" : `Volt needs attention in ${workspaceName}`,
				body: "Open Volt to view the error.",
				sessionId: final.sessionId,
				...workspace,
			};
		case "aborted":
			return undefined;
		case "completed":
			if (final.planningMode === "plan" && final.planPhase === "ready") {
				if (!final.planId) return undefined;
				return {
					eventId: `plan:${final.sessionId}:${runId}:ready`,
					hostNodeId: options.hostNodeId,
					kind: "plan_ready",
					title: "Your plan is ready",
					body: "Open Volt to review and approve it.",
					sessionId: final.sessionId,
					...workspace,
					planId: final.planId,
				};
			}
			return {
				eventId: `conversation:${final.sessionId}:${runId}:completed`,
				hostNodeId: options.hostNodeId,
				kind: "conversation_completed",
				title: workspaceName === undefined ? "Volt finished" : `Volt finished in ${workspaceName}`,
				body: "Your conversation is ready.",
				sessionId: final.sessionId,
				...workspace,
			};
	}
}

function reviewCompletion(
	record: ReviewWorkflowResultRecord,
	sessionId: string,
	hostNodeId: string,
	workspaceName: string | undefined,
): IrohRemotePushNotificationIntent | undefined {
	const workflowId = sanitizeIrohRemoteNotificationMetadata(record.workflowId);
	if (!workflowId) return undefined;
	const target = sanitizeIrohRemoteNotificationTarget(record.target.description) ?? "Review";
	const findingsCount =
		Number.isSafeInteger(record.findingsCount) && (record.findingsCount ?? -1) >= 0
			? record.findingsCount
			: undefined;
	const body =
		record.completionStatus === "incomplete"
			? findingsCount
				? `${target} review is incomplete with ${findingsCount} verified finding${findingsCount === 1 ? "" : "s"}.`
				: `${target} review is incomplete.`
			: findingsCount === undefined
				? `${target} completed. Open Volt to see the findings.`
				: findingsCount === 0
					? `${target} completed with no issues found.`
					: `${target} completed with ${findingsCount} finding${findingsCount === 1 ? "" : "s"}.`;
	return {
		eventId: `${workflowId}:completed`,
		hostNodeId,
		kind: "review_completed",
		title: "Your review is ready",
		body,
		sessionId,
		...(workspaceName === undefined ? {} : { workspaceName }),
		workflowId,
	};
}
