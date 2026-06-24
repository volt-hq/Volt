import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { REVIEW_BRANCH_ACTION_ID, REVIEW_UNCOMMITTED_ACTION_ID } from "../../core/host-actions.ts";
import {
	createIrohRemoteFilteredRpcTransport,
	createIrohRemoteOutboundFilteredRpcTransport,
	type IrohRemoteOutboundValueDecorator,
	type IrohRemotePushNotificationDelivery,
} from "../../core/remote/iroh/index.ts";
import {
	createIrohRpcTransport,
	type IrohRpcTransportOptions,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
} from "../../core/rpc/index.ts";
import { type RpcSessionChange, runRpcMode } from "./rpc-mode.ts";
import type { RpcRegisterPushTargetResponse } from "./rpc-types.ts";

export interface IrohRemoteRpcModeOptions extends IrohRpcTransportOptions {
	decorateOutbound?: IrohRemoteOutboundValueDecorator;
	disposeRuntimeOnClose?: boolean;
	notificationDelivery?: IrohRemotePushNotificationDelivery;
	onSessionChanged?: (session: RpcSessionChange) => void | Promise<void>;
	registerPushTarget?: (args: unknown) => Promise<RpcRegisterPushTargetResponse>;
	remoteWorkspacePath?: string;
	workspacePath: string;
}

export type IrohRemoteNotificationKind =
	| "conversation_completed"
	| "review_completed"
	| "action_completed"
	| "host_notice";

export interface IrohRemoteNotificationRequest {
	type: "notification_request";
	eventId: string;
	kind: IrohRemoteNotificationKind;
	title: string;
	body: string;
	sessionId?: string;
}

export interface IrohRemoteCompletionState {
	sessionId: string;
	runId?: string;
}

export interface IrohRemoteCompletedCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	finalState: IrohRemoteCompletionState | undefined;
	response?: Record<string, unknown>;
}

interface PendingIrohRemoteCommand {
	command: string;
	id: string | undefined;
	initialState: IrohRemoteCompletionState | undefined;
	done: Promise<void>;
	responseMatched: boolean;
	finish(): void;
}

interface IrohRemoteCloseDeferringRpcTransportOptions {
	transport: RpcTransport;
	getCompletionState?: () => IrohRemoteCompletionState;
	onCommandCompleted?: (completion: IrohRemoteCompletedCommand) => void | Promise<void>;
	waitForPromptCompletion(): Promise<void>;
}

interface IrohRemoteCloseDeferringRpcTransport extends RpcTransport {
	setRpcModeStartupComplete(startupComplete: boolean): void;
}

/** Run Volt RPC in-process over an authorized Iroh bidirectional stream. */
export function runIrohRemoteRpcMode(
	runtimeHost: AgentSessionRuntime,
	options: IrohRemoteRpcModeOptions,
): Promise<void> {
	const sentNotificationEventIds = new Set<string>();
	const outboundTransport = createIrohRemoteOutboundFilteredRpcTransport({
		decorate: options.decorateOutbound,
		remoteWorkspacePath: options.remoteWorkspacePath,
		transport: createIrohRpcTransport(options),
		workspacePath: options.workspacePath,
	});
	const deliverCompletionNotification = async (notification: IrohRemoteNotificationRequest): Promise<void> => {
		if (options.notificationDelivery) {
			const deliveryStatus = await options.notificationDelivery.deliverNotification(notification);
			if (deliveryStatus !== "no_push_target") {
				return;
			}
		}
		await outboundTransport.write(notification);
	};
	const closeDeferringTransport = createIrohRemoteCloseDeferringRpcTransport({
		transport: outboundTransport,
		getCompletionState: () => getIrohRemoteCompletionState(runtimeHost),
		onCommandCompleted: async (completion) => {
			const notification = createIrohRemoteCompletionNotification(completion);
			if (!notification || sentNotificationEventIds.has(notification.eventId)) {
				return;
			}
			sentNotificationEventIds.add(notification.eventId);
			await deliverCompletionNotification(notification);
		},
		waitForPromptCompletion: () => runtimeHost.session.waitForIdle(),
	});

	return runRpcMode(runtimeHost, {
		allowUiActionInvocation: true,
		disposeRuntimeOnClose: options.disposeRuntimeOnClose,
		onSessionChanged: options.onSessionChanged,
		requireRemoteSafeUiActions: true,
		transport: createIrohRemoteFilteredRpcTransport({
			transport: closeDeferringTransport,
		}),
		exitProcess: false,
		registerPushTarget: options.registerPushTarget,
	});
}

export function createIrohRemoteCloseDeferringRpcTransport(
	options: IrohRemoteCloseDeferringRpcTransportOptions,
): RpcTransport {
	const pendingCommands = new Set<PendingIrohRemoteCommand>();
	let rpcModeStartupComplete = true;
	let startupCompletedPendingCommand = false;
	let startupCleanClosePending = false;
	const startupCleanCloseHandlers = new Set<() => void>();

	const createPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand => {
		let finished = false;
		let resolveDone = () => {};
		const pending: PendingIrohRemoteCommand = {
			command,
			id,
			initialState: options.getCompletionState?.(),
			done: new Promise<void>((resolve) => {
				resolveDone = resolve;
			}),
			responseMatched: false,
			finish() {
				if (finished) {
					return;
				}
				finished = true;
				pendingCommands.delete(pending);
				if (!rpcModeStartupComplete) {
					startupCompletedPendingCommand = true;
				}
				resolveDone();
			},
		};
		pendingCommands.add(pending);
		return pending;
	};

	const waitForPendingCommands = async (): Promise<void> => {
		while (pendingCommands.size > 0) {
			await Promise.allSettled([...pendingCommands].map((pending) => pending.done));
		}
	};

	const findPendingCommand = (command: string, id: string | undefined): PendingIrohRemoteCommand | undefined => {
		for (const pending of pendingCommands) {
			if (!pending.responseMatched && pending.command === command && pending.id === id) {
				return pending;
			}
		}
		return undefined;
	};

	const trackInboundLine = (line: string): PendingIrohRemoteCommand | undefined => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return createPendingCommand("parse", undefined);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return createPendingCommand("unknown", undefined);
		}
		const command = parsed as Record<string, unknown>;
		if (typeof command.type !== "string") {
			return createPendingCommand("unknown", typeof command.id === "string" ? command.id : undefined);
		}
		if (command.type === "extension_ui_response") {
			return undefined;
		}
		return createPendingCommand(command.type, typeof command.id === "string" ? command.id : undefined);
	};

	const notifyCompletedCommand = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		await options.onCommandCompleted?.({
			command: pending.command,
			id: pending.id,
			initialState: pending.initialState,
			finalState: options.getCompletionState?.(),
			response,
		});
	};

	const finishAfterCommandCompletion = async (
		pending: PendingIrohRemoteCommand,
		response?: Record<string, unknown>,
	): Promise<void> => {
		try {
			await notifyCompletedCommand(pending, response);
		} finally {
			pending.finish();
		}
	};

	const finishAfterPromptCompletion = async (pending: PendingIrohRemoteCommand): Promise<void> => {
		try {
			// Prompt success is emitted just before AgentSession starts the run.
			// Steer/follow_up success means input was accepted into an active session run.
			// Yield once so waitForIdle observes that run or any accepted queued input.
			await Promise.resolve();
			await options.waitForPromptCompletion();
			await notifyCompletedCommand(pending);
		} finally {
			pending.finish();
		}
	};

	const trackOutboundResponse = (value: object): void => {
		const response = value as Record<string, unknown>;
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		const pending = findPendingCommand(response.command, typeof response.id === "string" ? response.id : undefined);
		if (!pending) {
			return;
		}
		pending.responseMatched = true;
		if (response.success === true && shouldWaitForRemoteResponseCompletion(pending.command, response)) {
			void finishAfterPromptCompletion(pending).catch(() => {});
			return;
		}
		if (response.success === true && isCompletedReviewInvocationResponse(pending.command, response)) {
			void finishAfterCommandCompletion(pending, response).catch(() => {});
			return;
		}
		pending.finish();
	};

	const finishPendingResponseAfterWriteFailure = (value: object): void => {
		const response = value as Record<string, unknown>;
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		const pending = findPendingCommand(response.command, typeof response.id === "string" ? response.id : undefined);
		if (pending) {
			pending.responseMatched = true;
			pending.finish();
		}
	};

	const transport: IrohRemoteCloseDeferringRpcTransport = {
		setRpcModeStartupComplete(startupComplete) {
			rpcModeStartupComplete = startupComplete;
			if (!rpcModeStartupComplete || !startupCleanClosePending) {
				if (rpcModeStartupComplete) {
					startupCompletedPendingCommand = false;
				}
				return;
			}
			startupCleanClosePending = false;
			startupCompletedPendingCommand = false;
			for (const handler of startupCleanCloseHandlers) {
				handler();
			}
		},
		write(value) {
			let result: void | Promise<void>;
			try {
				result = options.transport.write(value);
			} catch (error: unknown) {
				finishPendingResponseAfterWriteFailure(value);
				throw error;
			}
			trackOutboundResponse(value);
			return result;
		},
		onLine(handler: RpcLineHandler): () => void {
			return options.transport.onLine((line) => {
				const pending = trackInboundLine(line);
				try {
					handler(line);
				} catch (error: unknown) {
					pending?.finish();
					throw error;
				}
			});
		},
		onClose(handler: RpcCloseHandler): () => void {
			let active = true;
			const handleCleanClose = () => {
				void waitForPendingCommands().then(() => {
					if (active) {
						handler();
					}
				});
			};
			startupCleanCloseHandlers.add(handleCleanClose);
			const detach =
				options.transport.onClose?.((error) => {
					if (!active) {
						return;
					}
					if (error) {
						handler(error);
						return;
					}
					if (!rpcModeStartupComplete && (pendingCommands.size > 0 || startupCompletedPendingCommand)) {
						startupCleanClosePending = true;
						return;
					}
					handleCleanClose();
				}) ?? (() => {});
			return () => {
				active = false;
				startupCleanCloseHandlers.delete(handleCleanClose);
				detach();
			};
		},
		async waitForBackpressure() {
			await options.transport.waitForBackpressure?.();
		},
		async flush() {
			await options.transport.flush?.();
		},
		close() {
			return options.transport.close();
		},
	};
	return transport;
}

function getIrohRemoteCompletionState(runtimeHost: AgentSessionRuntime): IrohRemoteCompletionState {
	return {
		sessionId: runtimeHost.session.sessionId,
		runId: runtimeHost.session.sessionManager.getLeafId() ?? undefined,
	};
}

function createIrohRemoteCompletionNotification(
	completion: IrohRemoteCompletedCommand,
): IrohRemoteNotificationRequest | undefined {
	const finalState = getChangedFinalCompletionState(completion);
	if (!finalState) {
		return undefined;
	}
	if (isConversationCompletionCommand(completion.command)) {
		return {
			type: "notification_request",
			eventId: `conversation:${finalState.sessionId}:${finalState.runId}:completed`,
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			sessionId: finalState.sessionId,
		};
	}
	if (isCompletedReviewInvocationResponse(completion.command, completion.response)) {
		return {
			type: "notification_request",
			eventId: `review:${finalState.sessionId}:${finalState.runId}:completed`,
			kind: "review_completed",
			title: "Review complete",
			body: "Open Volt to see the findings.",
			sessionId: finalState.sessionId,
		};
	}
	return undefined;
}

function getChangedFinalCompletionState(
	completion: IrohRemoteCompletedCommand,
): Required<IrohRemoteCompletionState> | undefined {
	const finalState = completion.finalState;
	if (!finalState?.runId) {
		return undefined;
	}
	const initialState = completion.initialState;
	if (initialState?.sessionId === finalState.sessionId && initialState.runId === finalState.runId) {
		return undefined;
	}
	return { sessionId: finalState.sessionId, runId: finalState.runId };
}

function isConversationCompletionCommand(command: string): boolean {
	return command === "prompt" || command === "steer" || command === "follow_up";
}

function shouldWaitForRemoteResponseCompletion(command: string, response: Record<string, unknown>): boolean {
	if (isConversationCompletionCommand(command)) {
		return true;
	}
	if (command !== "invoke_ui_action") {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "accepted" || data.status === "queued";
}

function isCompletedReviewInvocationResponse(
	command: string,
	response: Record<string, unknown> | undefined,
): response is Record<string, unknown> & { data: { action: string; status: "completed" } } {
	if (command !== "invoke_ui_action" || !response) {
		return false;
	}
	const data = response.data;
	if (!isRecord(data)) {
		return false;
	}
	return data.status === "completed" && isReviewActionId(data.action);
}

function isReviewActionId(action: unknown): boolean {
	return action === REVIEW_UNCOMMITTED_ACTION_ID || action === REVIEW_BRANCH_ACTION_ID;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
