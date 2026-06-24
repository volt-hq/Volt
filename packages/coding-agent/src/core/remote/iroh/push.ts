import { createHash } from "node:crypto";
import type { RpcRegisterPushTargetArgs, RpcRegisterPushTargetResponse } from "../../rpc/types.ts";
import type { IrohRemoteAuditEventInput, IrohRemoteAuditLogger } from "./audit.ts";
import type { IrohRemotePushTarget, IrohRemotePushTargetPlatform, IrohRemotePushTargetProvider } from "./state.ts";
import type { IrohRemoteHostStateManager } from "./state-manager.ts";

export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_ATTEMPTS = 3;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_DELAY_MS = 250;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_TIMEOUT_MS = 10_000;
export const DEFAULT_IROH_REMOTE_PUSH_RELAY_URL = "https://us-central1-volt-3fae7.cloudfunctions.net/pushRelay";

export type IrohRemotePushTargetRegistrationRequest = RpcRegisterPushTargetArgs;
export type IrohRemotePushTargetRegistrationResult = RpcRegisterPushTargetResponse;

export interface IrohRemotePushNotificationIntent {
	eventId: string;
	kind: string;
	title: string;
	body: string;
	sessionId?: string;
}

export interface IrohRemotePushRelayNotificationRequest {
	pushTargetId: string;
	pushTargetAuthToken: string;
	relayUrl?: string;
	eventId: string;
	kind: string;
	title: string;
	body: string;
	data: {
		eventId: string;
		kind: string;
		sessionId?: string;
	};
}

export type IrohRemotePushRelayNotificationResult = { status: "sent" } | { status: "invalid_target" };

export interface IrohRemotePushRelayClient {
	sendNotification(request: IrohRemotePushRelayNotificationRequest): Promise<IrohRemotePushRelayNotificationResult>;
}

export type IrohRemotePushNotificationDeliveryStatus =
	| "sent"
	| "no_push_target"
	| "duplicate"
	| "failed"
	| "invalid_target";

export interface IrohRemotePushNotificationDelivery {
	deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus>;
}

export interface IrohRemotePushNotificationDeduper {
	tryMark(clientNodeId: string, eventId: string): boolean;
}

export interface IrohRemotePushNotificationDispatcherOptions {
	auditLogger?: IrohRemoteAuditLogger;
	clientNodeId: string;
	deduper?: IrohRemotePushNotificationDeduper;
	now?: () => number;
	relayClient: IrohRemotePushRelayClient;
	retryAttempts?: number;
	retryDelayMs?: number;
	stateManager: IrohRemoteHostStateManager;
	workspace?: string;
}

export interface IrohRemotePushRelayHttpClientOptions {
	authToken?: string;
	baseUrl?: string;
	fetcher?: (input: string, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
}

export class IrohRemoteInMemoryPushNotificationDeduper implements IrohRemotePushNotificationDeduper {
	private readonly sentEventIdsByClient = new Map<string, Set<string>>();

	tryMark(clientNodeId: string, eventId: string): boolean {
		let sentEventIds = this.sentEventIdsByClient.get(clientNodeId);
		if (!sentEventIds) {
			sentEventIds = new Set();
			this.sentEventIdsByClient.set(clientNodeId, sentEventIds);
		}
		if (sentEventIds.has(eventId)) {
			return false;
		}
		sentEventIds.add(eventId);
		return true;
	}
}

export class IrohRemotePushRelayHttpError extends Error {
	readonly status: number;
	readonly transient: boolean;

	constructor(status: number, transient: boolean) {
		super(`Push relay request failed with HTTP ${status}`);
		this.name = "IrohRemotePushRelayHttpError";
		this.status = status;
		this.transient = transient;
	}
}

export class IrohRemotePushRelayHttpClient implements IrohRemotePushRelayClient {
	private readonly authToken: string | undefined;
	private readonly baseUrl: string;
	private readonly fetcher: (input: string, init: RequestInit) => Promise<Response>;
	private readonly timeoutMs: number;

	constructor(options: IrohRemotePushRelayHttpClientOptions) {
		this.authToken = options.authToken;
		const baseUrl = options.baseUrl ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_URL;
		this.baseUrl = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
		this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
		this.timeoutMs = options.timeoutMs ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_TIMEOUT_MS;
	}

	async sendNotification(
		request: IrohRemotePushRelayNotificationRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		const baseUrl = this.getRequestBaseUrl(request);
		const response = await this.fetcher(new URL("v1/notifications", baseUrl).toString(), {
			body: JSON.stringify(request),
			headers: this.createHeaders(),
			method: "POST",
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (response.ok) {
			return { status: "sent" };
		}
		if (response.status === 404 || response.status === 410) {
			return { status: "invalid_target" };
		}
		throw new IrohRemotePushRelayHttpError(response.status, isTransientHttpStatus(response.status));
	}

	private getRequestBaseUrl(request: IrohRemotePushRelayNotificationRequest): string {
		if (!request.relayUrl) {
			return this.baseUrl;
		}
		return request.relayUrl.endsWith("/") ? request.relayUrl : `${request.relayUrl}/`;
	}

	private createHeaders(): Record<string, string> {
		return {
			"content-type": "application/json",
			...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
		};
	}
}

export class IrohRemotePushNotificationDispatcher implements IrohRemotePushNotificationDelivery {
	private readonly auditLogger: IrohRemoteAuditLogger | undefined;
	private readonly clientNodeId: string;
	private readonly deduper: IrohRemotePushNotificationDeduper;
	private readonly now: () => number;
	private readonly relayClient: IrohRemotePushRelayClient;
	private readonly retryAttempts: number;
	private readonly retryDelayMs: number;
	private readonly stateManager: IrohRemoteHostStateManager;
	private readonly workspace: string | undefined;

	constructor(options: IrohRemotePushNotificationDispatcherOptions) {
		this.auditLogger = options.auditLogger;
		this.clientNodeId = options.clientNodeId;
		this.deduper = options.deduper ?? new IrohRemoteInMemoryPushNotificationDeduper();
		this.now = options.now ?? Date.now;
		this.relayClient = options.relayClient;
		this.retryAttempts = Math.max(
			1,
			Math.trunc(options.retryAttempts ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_ATTEMPTS),
		);
		this.retryDelayMs = Math.max(
			0,
			Math.trunc(options.retryDelayMs ?? DEFAULT_IROH_REMOTE_PUSH_RELAY_RETRY_DELAY_MS),
		);
		this.stateManager = options.stateManager;
		this.workspace = options.workspace;
	}

	async registerPushTarget(args: unknown): Promise<RpcRegisterPushTargetResponse> {
		const registration = parseRegisterPushTargetArgs(args);
		try {
			const now = this.now();
			const pushTarget: IrohRemotePushTarget = {
				id: registration.pushTargetId,
				provider: registration.provider,
				platform: registration.platform,
				pushTargetAuthToken: registration.pushTargetAuthToken,
				...(registration.relayUrl === undefined ? {} : { relayUrl: registration.relayUrl }),
				...(registration.tokenHash === undefined ? {} : { tokenHash: registration.tokenHash }),
				enabled: registration.enabled,
				createdAt: now,
				updatedAt: now,
			};
			const client = await this.stateManager.upsertClientPushTarget(this.clientNodeId, pushTarget);
			if (!client) {
				throw new Error("paired client not found");
			}
			await this.log({
				type: "push_target_registered",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: true,
				details: getPushTargetAuditDetails(pushTarget),
			});
			return { status: "registered", pushTargetId: registration.pushTargetId };
		} catch (error: unknown) {
			const errorMessage = toErrorMessage(error);
			const redactedError =
				registration.pushTargetAuthToken.length === 0
					? errorMessage
					: errorMessage.split(registration.pushTargetAuthToken).join("[redacted-push-target-auth-token]");
			await this.log({
				type: "push_target_registered",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: false,
				error: redactedError,
				details: {
					pushTargetId: registration.pushTargetId,
					provider: registration.provider,
					platform: registration.platform,
					relayUrl: registration.relayUrl,
					tokenHash: registration.tokenHash,
					enabled: registration.enabled,
				},
			});
			throw new Error(redactedError);
		}
	}

	async deliverNotification(
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus> {
		if (!this.deduper.tryMark(this.clientNodeId, notification.eventId)) {
			await this.log({
				type: "push_notification_deduplicated",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: true,
				details: { eventId: notification.eventId, kind: notification.kind },
			});
			return "duplicate";
		}

		const client = await this.stateManager.getClient(this.clientNodeId);
		const pushTarget = selectEnabledPushTarget(client?.pushTargets ?? []);
		if (!pushTarget) {
			await this.log({
				type: "push_notification_fallback",
				clientNodeId: this.clientNodeId,
				workspace: this.workspace,
				success: true,
				details: { eventId: notification.eventId, kind: notification.kind, reason: "no_push_target" },
			});
			return "no_push_target";
		}

		const relayRequest = createRelayNotificationRequest(pushTarget, notification);
		try {
			const relayResult = await this.sendNotificationWithRetry(relayRequest);
			if (relayResult.status === "invalid_target") {
				await this.stateManager.disableClientPushTarget(this.clientNodeId, pushTarget.id, this.now());
				await this.logPushDelivery(pushTarget, notification, false, "push target is invalid or unregistered");
				return "invalid_target";
			}
			await this.logPushDelivery(pushTarget, notification, true);
			return "sent";
		} catch (error: unknown) {
			await this.logPushDelivery(pushTarget, notification, false, toErrorMessage(error));
			return "failed";
		}
	}

	private async sendNotificationWithRetry(
		request: IrohRemotePushRelayNotificationRequest,
	): Promise<IrohRemotePushRelayNotificationResult> {
		let lastError: unknown;
		for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
			try {
				return await this.relayClient.sendNotification(request);
			} catch (error: unknown) {
				lastError = error;
				if (attempt >= this.retryAttempts || !isTransientPushRelayError(error)) {
					throw error;
				}
				await delay(this.retryDelayMs * attempt);
			}
		}
		throw lastError;
	}

	private async logPushDelivery(
		pushTarget: IrohRemotePushTarget,
		notification: IrohRemotePushNotificationIntent,
		success: boolean,
		error?: string,
	): Promise<void> {
		await this.log({
			type: "push_notification_delivered",
			clientNodeId: this.clientNodeId,
			workspace: this.workspace,
			success,
			error,
			details: {
				eventId: notification.eventId,
				kind: notification.kind,
				pushTargetId: pushTarget.id,
				provider: pushTarget.provider,
				platform: pushTarget.platform,
				tokenHash: pushTarget.tokenHash,
			},
		});
	}

	private async log(event: IrohRemoteAuditEventInput): Promise<void> {
		if (!this.auditLogger) {
			return;
		}
		try {
			await this.auditLogger.log(event);
		} catch {
			// Push relay side effects should not be reinterpreted as RPC failures if audit I/O fails.
		}
	}
}

export function hashIrohRemotePushToken(token: string): string {
	return `sha256:${createHash("sha256").update(token, "utf8").digest("base64url")}`;
}

export function parseRegisterPushTargetArgs(value: unknown): RpcRegisterPushTargetArgs {
	const args = expectRecord(value, "register_push_target args");
	return {
		provider: expectPushProvider(args.provider),
		platform: expectPushPlatform(args.platform),
		pushTargetId: expectString(args.pushTargetId, "push target id"),
		pushTargetAuthToken: expectString(args.pushTargetAuthToken, "push target auth token"),
		relayUrl: expectOptionalString(args.relayUrl, "push relay URL"),
		tokenHash: expectOptionalString(args.tokenHash, "push token hash"),
		enabled: expectBoolean(args.enabled, "push enabled"),
	};
}

function selectEnabledPushTarget(pushTargets: IrohRemotePushTarget[]): IrohRemotePushTarget | undefined {
	return pushTargets
		.filter((target) => target.enabled)
		.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0];
}

function createRelayNotificationRequest(
	pushTarget: IrohRemotePushTarget,
	notification: IrohRemotePushNotificationIntent,
): IrohRemotePushRelayNotificationRequest {
	return {
		pushTargetId: pushTarget.id,
		pushTargetAuthToken: pushTarget.pushTargetAuthToken,
		...(pushTarget.relayUrl === undefined ? {} : { relayUrl: pushTarget.relayUrl }),
		eventId: notification.eventId,
		kind: notification.kind,
		title: notification.title,
		body: notification.body,
		data: {
			eventId: notification.eventId,
			kind: notification.kind,
			...(notification.sessionId === undefined ? {} : { sessionId: notification.sessionId }),
		},
	};
}

function getPushTargetAuditDetails(pushTarget: IrohRemotePushTarget): Record<string, unknown> {
	return {
		pushTargetId: pushTarget.id,
		provider: pushTarget.provider,
		platform: pushTarget.platform,
		relayUrl: pushTarget.relayUrl,
		tokenHash: pushTarget.tokenHash,
		enabled: pushTarget.enabled,
		createdAt: pushTarget.createdAt,
		updatedAt: pushTarget.updatedAt,
	};
}

function isTransientPushRelayError(error: unknown): boolean {
	if (error instanceof IrohRemotePushRelayHttpError) {
		return error.transient;
	}
	return true;
}

function isTransientHttpStatus(status: number): boolean {
	return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${label} must be a non-empty string`);
	}
	return value;
}

function expectOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	return expectString(value, label);
}

function expectBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`${label} must be a boolean`);
	}
	return value;
}

function expectPushProvider(value: unknown): IrohRemotePushTargetProvider {
	if (value === "fcm") {
		return value;
	}
	throw new Error("push provider must be fcm");
}

function expectPushPlatform(value: unknown): IrohRemotePushTargetPlatform {
	if (value === "ios") {
		return value;
	}
	throw new Error("push platform must be ios");
}

function delay(ms: number): Promise<void> {
	if (ms === 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}
