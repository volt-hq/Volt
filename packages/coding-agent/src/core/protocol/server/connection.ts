/**
 * The protocol server (RFC §6): one client connection over a transport, on
 * one profile. The same frames run over stdio, the in-process loopback, the
 * daemon relay, and Iroh; a transport is framing plus admission.
 *
 * A connection opens with `hello`; the host attaches the connection's client
 * to its conversation and answers `welcome`. The client subscribes to
 * conversations by position (subscription.ts), invokes intents, runs queries,
 * and answers host requests. Intents and queries run one at a time in arrival
 * order; input intents (prompts) and dynamic intents answer once admitted
 * without holding later frames. Non-input intents are deduplicated per
 * conversation by `intentId`; input intents carry their durable
 * `clientMessageId` as theirs. A structural intent that moves the client
 * answers `accepted{conversation}`, then ends the subscriptions on the
 * conversation it left with `ended{moved, target}`.
 *
 * A malformed frame ends the connection with `fatal`.
 */

import { randomUUID } from "node:crypto";
import {
	DYNAMIC_INTENT_PATTERN,
	DynamicIntentFrameSchema,
	type FatalCode,
	HelloFrameSchema,
	type HostFrame,
	type HostRequestKind,
	type HostResponse,
	HostResponseFrameSchema,
	INPUT_INTENT_NAMES,
	INTENT_FRAME_SCHEMAS,
	INTENT_OUTCOME_WINDOW,
	LogSessionIdSchema,
	PROTOCOL_VERSION,
	type QueryErrorCode,
	RESERVED_FRAME_TYPES,
	type RejectionReason,
	RpcConversationIdentifierSchema,
	RpcSafeNonNegativeIntegerSchema,
	SubscribeFrameSchema,
	UnsubscribeFrameSchema,
} from "@hansjm10/volt-protocol";
import { type Static, type TObject, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { VERSION } from "../../../config.ts";
import type { ExtensionError } from "../../extensions/index.ts";
import { ClientScope } from "../../host/client-scope.ts";
import type { ConversationHost } from "../../host/conversation-host.ts";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import { openFork, openNewSession, openStoredSession } from "../../host/session-intents.ts";
import type { HostClient } from "../../host/targets.ts";
import type { RpcTransport } from "../../rpc/transport.ts";
import { SubscriptionUsageService } from "../../subscription-usage.ts";
import { intentRegistry, isBuiltinIntentName } from "../intents/index.ts";
import { type IntentContext, IntentRejectedError } from "../intents/types.ts";
import type { Profile } from "../profiles.ts";
import { queryRegistry } from "../queries/index.ts";
import { QueryRejectedError } from "../queries/types.ts";
import { ConnectionSubagents, createLocalIntentServices, PendingReviewWorkflows } from "./local-services.ts";
import { Subscription, type SubscriptionEnd } from "./subscription.ts";

/** Frames a connection holds for its intent and query lane, at most. */
const MAX_PENDING_FRAMES = 256;

/** Intents that move the client to another conversation. */
const STRUCTURAL_INTENTS: ReadonlySet<string> = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"review_open_session",
]);

/** Intents whose acceptance changes the `settings` catalog. */
const SETTINGS_INTENTS: ReadonlySet<string> = new Set([
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"set_compaction_threshold",
]);

const INPUT_INTENTS: ReadonlySet<string> = new Set(INPUT_INTENT_NAMES);
const DYNAMIC_INTENT = new RegExp(DYNAMIC_INTENT_PATTERN);
const RESERVED: ReadonlySet<string> = new Set(RESERVED_FRAME_TYPES);

export interface ProtocolPeer {
	readonly name: string;
	readonly version: string;
}

export interface ServeConnectionOptions {
	readonly host: ConversationHost;
	/** The conversation the connection's client attaches to once it says hello. */
	readonly conversation: HostedConversation;
	/**
	 * Defaults to true. The client anchors its conversation: the conversation
	 * closes when the connection ends. A host that shares the conversation
	 * keeps it open after the connection ends.
	 */
	readonly anchor?: boolean;
	/** What the host calls itself in `welcome`. */
	readonly server?: ProtocolPeer;
	/** An extension asked the host to shut down (`ctx.shutdown()`). */
	readonly onShutdownRequested?: () => void;
	/** The conversation the client is on lost its log: a commit it could not confirm. */
	readonly onLost?: (conversation: HostedConversation, error: Error) => void;
}

export interface ProtocolConnection {
	readonly id: string;
	/** Resolves once the client said hello and its conversation's extensions are bound; rejects when that fails. */
	readonly ready: Promise<void>;
	/** Settles once the connection ended; rejects with the failure that ended it. */
	readonly closed: Promise<void>;
	/** The conversation the client is on. */
	readonly conversation: HostedConversation;
	/** Tell the client to refetch a catalog. */
	changed(catalog: CatalogName): void;
	/** End every subscription with `ended{shutdown}`, then the connection with `fatal{host_shutdown}`. */
	shutdown(message?: string): Promise<void>;
	/** End the connection; with a code, the client is told why first. */
	close(fatal?: { readonly code: FatalCode; readonly message?: string }): Promise<void>;
}

interface IntentEnvelope {
	readonly type: string;
	readonly intentId: string;
	readonly conversation?: string;
	readonly expectedOrdinal?: number;
	readonly input?: unknown;
}

interface QueryEnvelope {
	readonly type: "query";
	readonly queryId: string;
	readonly query: string;
	readonly conversation?: string;
	readonly params?: unknown;
}

type IntentOutcomeFrame = Extract<HostFrame, { type: "accepted" | "rejected" }>;
type CatalogName = Extract<HostFrame, { type: "changed" }>["catalog"];

/** Outcomes of non-input intents a conversation remembers, so a retried intent id answers the same. */
class IntentOutcomeWindow {
	private readonly outcomes = new Map<string, { fingerprint: string; outcome: Promise<IntentOutcomeFrame> }>();

	get(intentId: string): { fingerprint: string; outcome: Promise<IntentOutcomeFrame> } | undefined {
		return this.outcomes.get(intentId);
	}

	set(intentId: string, fingerprint: string, outcome: Promise<IntentOutcomeFrame>): void {
		this.outcomes.set(intentId, { fingerprint, outcome });
		while (this.outcomes.size > INTENT_OUTCOME_WINDOW) {
			const oldest = this.outcomes.keys().next().value;
			if (oldest === undefined) break;
			this.outcomes.delete(oldest);
		}
	}
}

const outcomeWindows = new WeakMap<HostedConversation, IntentOutcomeWindow>();

function outcomeWindow(conversation: HostedConversation): IntentOutcomeWindow {
	let window = outcomeWindows.get(conversation);
	if (!window) {
		window = new IntentOutcomeWindow();
		outcomeWindows.set(conversation, window);
	}
	return window;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Rejection codes of the coded errors a run can fail with; any other failure is `failed`. */
const CODED_REJECTIONS: Readonly<Record<string, RejectionReason["code"]>> = {
	client_input_conflict: "conflict",
	conversation_locked: "locked",
};

function rejection(error: unknown): RejectionReason {
	if (error instanceof IntentRejectedError) {
		return {
			code: error.code,
			message: error.message,
			...(error.ordinal === undefined ? {} : { ordinal: error.ordinal }),
			...(error.requiredCapability === undefined ? {} : { requiredCapability: error.requiredCapability }),
		};
	}
	const code = isRecord(error) && typeof error.code === "string" ? CODED_REJECTIONS[error.code] : undefined;
	return { code: code ?? "failed", message: errorMessage(error) };
}

function queryError(
	error: unknown,
): { code: QueryErrorCode; message: string } & Pick<QueryRejectedError, "requiredCapability"> {
	if (error instanceof QueryRejectedError) {
		return {
			code: error.code,
			message: error.message,
			...(error.requiredCapability === undefined ? {} : { requiredCapability: error.requiredCapability }),
		};
	}
	if (error instanceof IntentRejectedError && (error.code === "invalid_input" || error.code === "unavailable")) {
		return { code: error.code, message: error.message };
	}
	return { code: "failed", message: errorMessage(error) };
}

const intentEnvelopeFields = {
	conversation: Type.Optional(LogSessionIdSchema),
	expectedOrdinal: Type.Optional(RpcSafeNonNegativeIntegerSchema),
	input: Type.Optional(Type.Unknown()),
};
const QueryEnvelopeSchema = Type.Object(
	{
		type: Type.Literal("query"),
		queryId: RpcConversationIdentifierSchema,
		query: Type.String(),
		conversation: Type.Optional(LogSessionIdSchema),
		params: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
const UnknownIntentEnvelopeSchema = Type.Object(
	{ type: Type.String(), intentId: RpcConversationIdentifierSchema, ...intentEnvelopeFields },
	{ additionalProperties: false },
);

const validators = new Map<string, Validator>();

/** A compiled validator, cached by key. */
function validator(key: string, schema: () => TSchema): Validator {
	let compiled = validators.get(key);
	if (!compiled) {
		compiled = Compile(schema());
		validators.set(key, compiled);
	}
	return compiled;
}

/** The envelope schema of an intent frame: its frame schema with the input left to the registry. */
function intentEnvelopeValidator(type: string): Validator {
	if (isBuiltinIntentName(type)) {
		return validator(`intent:${type}`, () => {
			const frame: TObject = INTENT_FRAME_SCHEMAS[type];
			return Type.Object(
				{ ...frame.properties, input: Type.Optional(Type.Unknown()) },
				{ additionalProperties: false },
			);
		});
	}
	if (DYNAMIC_INTENT.test(type)) {
		return validator("intent:dynamic", () =>
			Type.Object(
				{ ...DynamicIntentFrameSchema.properties, input: Type.Optional(Type.Unknown()) },
				{ additionalProperties: false },
			),
		);
	}
	return validator("intent:unknown", () => UnknownIntentEnvelopeSchema);
}

/** Serve one client on `transport` with `profile`, until the transport closes or the connection is closed. */
export function serveConnection(
	transport: RpcTransport,
	profile: Profile,
	options: ServeConnectionOptions,
): ProtocolConnection {
	const host = options.host;
	const connectionId = randomUUID();
	const anchor = options.anchor ?? true;
	const server = options.server ?? { name: "volt", version: VERSION };
	const subscriptions = new Map<string, Subscription>();
	const subscriptionUsage = new SubscriptionUsageService();
	const reviews = new PendingReviewWorkflows();
	let home = options.conversation;
	const subagents = new ConnectionSubagents(() => home);
	let accepts: ReadonlySet<HostRequestKind> = new Set();
	let helloReceived = false;
	let closing: Promise<void> | undefined;
	let lane: Promise<void> = Promise.resolve();
	let pendingFrames = 0;
	/** Lane frames running; moves a structural intent makes end the old subscriptions once its outcome is written. */
	let laneBusy = false;
	const moves: Array<{ from: HostedConversation; to: HostedConversation }> = [];
	const ready = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	void ready.promise.catch(() => undefined);
	void closed.promise.catch(() => undefined);
	let attached: Promise<void> | undefined;
	let detachInput: () => void = () => {};
	let detachClose: () => void = () => {};
	let unsubscribeHome: () => void = () => {};
	let stopObservingClose: () => void = () => {};
	const pendingWrites = new Set<Promise<void>>();

	const write = (frame: HostFrame): void => {
		if (closing && frame.type !== "fatal" && frame.type !== "ended") return;
		try {
			const result = transport.write(profile.redact(frame));
			if (result) {
				const tracked = Promise.resolve(result).then(
					() => undefined,
					(error: unknown) => void fail(error),
				);
				pendingWrites.add(tracked);
				void tracked.finally(() => pendingWrites.delete(tracked));
			}
		} catch (error) {
			void fail(error);
		}
	};
	const sink = { send: write };

	/** Wait until what was written drained: a slow client slows the agent loop instead of growing a buffer. */
	const drain = async (): Promise<void> => {
		while (pendingWrites.size > 0) await Promise.all([...pendingWrites]);
		await transport.waitForBackpressure?.();
	};

	const onExtensionError = (error: ExtensionError): void => {
		for (const subscription of subscriptions.values()) {
			if (subscription.conversation !== home) continue;
			subscription.notice("error", `${error.event}: ${error.error}`, error.extensionPath);
		}
	};

	const observeLoss = (conversation: HostedConversation): void => {
		void conversation.lost.then((error) => {
			if (conversation === home && !closing) options.onLost?.(conversation, error);
		});
	};

	/** Observe what the client's conversation tells about catalogs, and throttle it to the transport. */
	const observeHome = (conversation: HostedConversation): void => {
		unsubscribeHome();
		const session = conversation.session;
		const unsubscribeEvents = session.subscribe(
			(event) => {
				if (
					event.type === "mcp_servers_changed" ||
					event.type === "mcp_server_status_changed" ||
					event.type === "mcp_auth_update"
				) {
					write({ type: "changed", catalog: "mcp" });
				}
			},
			{ monitorGitContext: false },
		);
		const unsubscribeBackpressure = session.subscribeRuntimeEvents(async () => {
			try {
				await drain();
			} catch (error) {
				void fail(error);
			}
		});
		unsubscribeHome = () => {
			unsubscribeEvents();
			unsubscribeBackpressure();
		};
	};

	const endSubscriptionsOn = (conversation: HostedConversation, end: SubscriptionEnd): void => {
		for (const [id, subscription] of [...subscriptions]) {
			if (subscription.conversation !== conversation) continue;
			subscriptions.delete(id);
			subscription.end(end);
		}
	};

	const flushMoves = (): void => {
		for (const { from, to } of moves.splice(0)) endSubscriptionsOn(from, { reason: "moved", target: to.id });
	};

	const client: HostClient = {
		id: connectionId,
		...(anchor ? { anchor: true } : {}),
		recoversInput: true,
		// Keeps the client asked the host requests it accepts before it subscribes; each subscription shows them.
		live: { acceptsHostRequest: (kind) => accepts.has(kind), apply: () => {} },
		surface: {
			commandContextActions: {
				waitForIdle: () => home.session.waitForIdle(),
				newSession: (newSessionOptions) => openNewSession(host, client, newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await openFork(host, client, entryId, forkOptions);
					return result.cancelled
						? result
						: { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await home.session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: (sessionRef, switchOptions) => openStoredSession(host, client, sessionRef, switchOptions),
				reload: () => home.session.reload(),
			},
			shutdownHandler: () => options.onShutdownRequested?.(),
			onError: onExtensionError,
		},
		move: {
			kind: "in_place",
			prepare: (to) => {
				home = to;
			},
			onMoved: async (to, from) => {
				observeLoss(to);
				observeHome(to);
				await subagents.disposeAll();
				if (from) moves.push({ from, to });
				if (!laneBusy) flushMoves();
			},
		},
	};

	/** The conversation a frame names: the client's own, or another open one of the host. */
	const resolveTarget = (id: string | undefined): HostedConversation | undefined => {
		if (id === undefined || id === home.id) return home;
		const conversation = host.get(id);
		return conversation && profile.conversations(id) ? conversation : undefined;
	};

	/** A conversation a client may subscribe to or read: a target, or a subagent child this connection started. */
	const resolveReadable = (id: string | undefined): HostedConversation | undefined => {
		const target = resolveTarget(id);
		if (target || id === undefined) return target;
		const child = subagents.conversation(id);
		return child && profile.conversations(id) ? child : undefined;
	};

	const intentContext = (conversation: HostedConversation, intentId?: string): IntentContext => ({
		target: { session: conversation.session, conversation, host, client },
		services: createLocalIntentServices(conversation, { subagents, reviews, subscriptionUsage }),
		profile: profile.intents,
		subscriber: profile,
		...(intentId === undefined ? {} : { intentId }),
	});

	const runIntent = async (frame: IntentEnvelope): Promise<void> => {
		const reject = (reason: RejectionReason): void => {
			write({ type: "rejected", intentId: frame.intentId, reason });
		};
		const conversation = resolveTarget(frame.conversation);
		if (!conversation || conversation.closed) {
			reject({ code: "ended", message: `Conversation ${frame.conversation ?? home.id} is not open` });
			return;
		}
		if (conversation !== home && STRUCTURAL_INTENTS.has(frame.type)) {
			reject({ code: "unavailable", message: `${frame.type} acts on the conversation the client is on` });
			return;
		}
		const input = INPUT_INTENTS.has(frame.type);
		const window = input ? undefined : outcomeWindow(conversation);
		const fingerprint = JSON.stringify([frame.type, frame.input ?? null, frame.expectedOrdinal ?? null]);
		const remembered = window?.get(frame.intentId);
		if (remembered) {
			if (remembered.fingerprint !== fingerprint) {
				reject({ code: "conflict", message: `Intent id ${frame.intentId} was used for another intent` });
				return;
			}
			write(await remembered.outcome);
			return;
		}
		const outcome = Promise.withResolvers<IntentOutcomeFrame>();
		window?.set(frame.intentId, fingerprint, outcome.promise);
		/** Prompt-like intents settle off the lane, where a lane intent's pending reviews are not theirs. */
		const settle = (result: IntentOutcomeFrame, onLane: boolean): void => {
			if (onLane && result.type === "accepted") reviews.launchAll();
			else if (onLane) reviews.cancelAll();
			write(result);
			outcome.resolve(result);
			if (result.type === "accepted" && SETTINGS_INTENTS.has(frame.type))
				write({ type: "changed", catalog: "settings" });
		};
		const rejected = (error: unknown): IntentOutcomeFrame => ({
			type: "rejected",
			intentId: frame.intentId,
			reason: rejection(error),
		});
		let prepared: ReturnType<typeof intentRegistry.prepareFrame>;
		try {
			prepared = ClientScope.run(client.id, () =>
				intentRegistry.prepareFrame(intentContext(conversation, frame.intentId), frame.type, frame.input, {
					...(frame.expectedOrdinal === undefined ? {} : { expectedOrdinal: frame.expectedOrdinal }),
				}),
			);
		} catch (error) {
			settle(rejected(error), true);
			return;
		}
		const run = ClientScope.run(client.id, () => prepared.run()).then(
			(invocation): IntentOutcomeFrame => ({
				type: "accepted",
				intentId: frame.intentId,
				ordinals: invocation.ordinals,
				...(invocation.conversation === undefined ? {} : { conversation: invocation.conversation }),
				...(invocation.result === undefined ? {} : { result: invocation.result }),
			}),
			rejected,
		);
		// Prompts and dynamic intents answer once admitted, without holding later frames.
		if (input || !isBuiltinIntentName(frame.type)) {
			void run.then((result) => {
				settle(result, false);
				if (!laneBusy) flushMoves();
			});
			return;
		}
		settle(await run, true);
	};

	const runQuery = async (frame: QueryEnvelope): Promise<void> => {
		const conversation = resolveReadable(frame.conversation);
		if (!conversation || conversation.closed) {
			write({
				type: "query_error",
				queryId: frame.queryId,
				reason: { code: "unavailable", message: `Conversation ${frame.conversation ?? home.id} is not open` },
			});
			return;
		}
		try {
			const data = await ClientScope.run(client.id, () =>
				queryRegistry.runFrame(intentContext(conversation), frame.query, frame.params),
			);
			write({ type: "result", queryId: frame.queryId, data });
		} catch (error) {
			write({ type: "query_error", queryId: frame.queryId, reason: queryError(error) });
		}
	};

	/** Run intents and queries one at a time, once the client is attached. */
	const enqueue = (task: () => Promise<void>): void => {
		if (pendingFrames >= MAX_PENDING_FRAMES) {
			void close({ code: "invalid_frame", message: `More than ${MAX_PENDING_FRAMES} frames are pending` });
			return;
		}
		pendingFrames++;
		lane = lane.then(async () => {
			try {
				await attached;
				if (closing) return;
				laneBusy = true;
				await task();
			} catch {
				// Each frame answers its own failure; the lane goes on.
			} finally {
				laneBusy = false;
				pendingFrames--;
				flushMoves();
			}
		});
	};

	const answer = (requestId: string, response: HostResponse): void => {
		const candidates = new Map<HostedConversation, string>();
		if (host.conversationOf(client) === home) candidates.set(home, client.id);
		for (const subscription of subscriptions.values()) {
			if (!candidates.has(subscription.conversation)) {
				candidates.set(subscription.conversation, `${connectionId}:${subscription.id}`);
			}
		}
		for (const [conversation, clientId] of candidates) {
			if (!conversation.liveState.pendingRequest(requestId)) continue;
			conversation.liveState.answer(requestId, response, clientId);
			return;
		}
	};

	const subscribe = (frame: Static<typeof SubscribeFrameSchema>): void => {
		if (subscriptions.has(frame.subscriptionId)) {
			void close({ code: "invalid_frame", message: `Subscription ${frame.subscriptionId} is already active` });
			return;
		}
		const conversation = resolveReadable(frame.conversation);
		if (!conversation || conversation.closed) {
			write({ type: "ended", subscriptionId: frame.subscriptionId, reason: "closed" });
			return;
		}
		const subscription = new Subscription({
			subscriptionId: frame.subscriptionId,
			liveClientId: `${connectionId}:${frame.subscriptionId}`,
			conversation,
			profile,
			sink,
			live: frame.live ?? true,
			accepts: (kind) => accepts.has(kind),
		});
		subscriptions.set(frame.subscriptionId, subscription);
		void conversation.lost.then(() => {
			if (subscriptions.get(frame.subscriptionId) !== subscription) return;
			subscriptions.delete(frame.subscriptionId);
			subscription.end({ reason: "lost" });
		});
		try {
			subscription.start(frame.after);
		} catch {
			subscriptions.delete(frame.subscriptionId);
			subscription.end({ reason: "closed" });
		}
	};

	const hello = (value: Record<string, unknown>): void => {
		if (value.protocol !== PROTOCOL_VERSION) {
			void close({ code: "protocol_mismatch", message: `This host speaks protocol ${PROTOCOL_VERSION}` });
			return;
		}
		if (!validator("hello", () => HelloFrameSchema).Check(value)) {
			void close({ code: "invalid_frame", message: "Invalid hello frame" });
			return;
		}
		const frame = value as Static<typeof HelloFrameSchema>;
		helloReceived = true;
		accepts = profile.hostRequests(frame.accepts.hostRequests);
		observeHome(home);
		// The live view attaches synchronously, so a dialog an extension asks from session_start waits for the client.
		attached = host.attach(client, home);
		attached.then(
			() => ready.resolve(),
			(error: unknown) => {
				ready.reject(error);
				void fail(error);
			},
		);
		write({
			type: "welcome",
			protocol: PROTOCOL_VERSION,
			connectionId,
			profile: profile.name,
			server: { name: server.name, version: server.version },
			conversation: home.id,
		});
	};

	const receive = (value: unknown): void => {
		if (closing) return;
		if (!isRecord(value) || typeof value.type !== "string") {
			void close({ code: "invalid_frame", message: "A frame is a JSON object with a string type" });
			return;
		}
		const type = value.type;
		if (!helloReceived) {
			if (type === "hello") hello(value);
			else void close({ code: "invalid_frame", message: "The first frame must be hello" });
			return;
		}
		switch (type) {
			case "subscribe":
				if (!validator("subscribe", () => SubscribeFrameSchema).Check(value)) break;
				subscribe(value as Static<typeof SubscribeFrameSchema>);
				return;
			case "unsubscribe": {
				if (!validator("unsubscribe", () => UnsubscribeFrameSchema).Check(value)) break;
				const subscriptionId = (value as Static<typeof UnsubscribeFrameSchema>).subscriptionId;
				const subscription = subscriptions.get(subscriptionId);
				subscriptions.delete(subscriptionId);
				if (subscription) subscription.end({ reason: "unsubscribed" });
				else write({ type: "ended", subscriptionId, reason: "unsubscribed" });
				return;
			}
			case "host_response": {
				if (!validator("host_response", () => HostResponseFrameSchema).Check(value)) break;
				const frame = value as Static<typeof HostResponseFrameSchema>;
				answer(frame.requestId, frame.response);
				return;
			}
			case "query":
				if (!validator("query", () => QueryEnvelopeSchema).Check(value)) break;
				enqueue(() => runQuery(value as unknown as QueryEnvelope));
				return;
			default:
				if (RESERVED.has(type) || !intentEnvelopeValidator(type).Check(value)) break;
				enqueue(() => runIntent(value as unknown as IntentEnvelope));
				return;
		}
		void close({ code: "invalid_frame", message: `Invalid ${type} frame` });
	};

	/** Leave the host once: a client that never attached still closes an anchored conversation. */
	let left: Promise<void> | undefined;
	const leaveHost = (): Promise<void> => {
		left ??= (async () => {
			stopObservingClose();
			unsubscribeHome();
			await subagents.disposeAll();
			if (host.conversationOf(client) !== undefined) await host.detach(client);
			else if (anchor && !home.closed) await host.close(home);
		})();
		return left;
	};

	const finish = async (failure?: { error: unknown }): Promise<void> => {
		detachInput();
		detachClose();
		for (const subscription of subscriptions.values()) subscription.dispose();
		subscriptions.clear();
		reviews.cancelAll();
		const errors: unknown[] = failure ? [failure.error] : [];
		try {
			// Not waiting for the attach: its session_start may wait for a dialog only leaving ends.
			await leaveHost();
		} catch (error) {
			errors.push(error);
		}
		try {
			if (!failure) await drain();
			await transport.flush?.();
		} catch (error) {
			if (!failure) errors.push(error);
		}
		try {
			await transport.close();
		} catch (error) {
			errors.push(error);
		}
		if (!helloReceived) ready.reject(new Error("The connection closed before hello"));
		if (errors.length === 0) closed.resolve();
		else closed.reject(errors.length === 1 ? errors[0] : new AggregateError(errors, "Protocol connection ended"));
	};

	function close(fatal?: { readonly code: FatalCode; readonly message?: string }): Promise<void> {
		if (closing) return closing;
		if (fatal)
			write({ type: "fatal", code: fatal.code, ...(fatal.message === undefined ? {} : { message: fatal.message }) });
		closing = finish();
		return closing;
	}

	function fail(error: unknown): Promise<void> {
		if (closing) return closing;
		closing = finish({ error });
		return closing;
	}

	observeLoss(home);
	stopObservingClose = host.onClosed((conversation) => {
		// A conversation the client moved away from ends its subscriptions as moved.
		if (moves.some((move) => move.from === conversation)) return;
		endSubscriptionsOn(conversation, { reason: "closed" });
	});

	detachInput = transport.onValue
		? transport.onValue(receive)
		: transport.onLine((line) => {
				let value: unknown;
				try {
					value = JSON.parse(line);
				} catch {
					void close({ code: "invalid_frame", message: "A frame is one line of JSON" });
					return;
				}
				receive(value);
			});
	detachClose = transport.onClose?.((error) => void (error ? fail(error) : close())) ?? (() => {});

	return {
		id: connectionId,
		ready: ready.promise,
		closed: closed.promise,
		get conversation() {
			return home;
		},
		changed(catalog) {
			write({ type: "changed", catalog });
		},
		async shutdown(message) {
			if (closing) return closing;
			for (const [id, subscription] of [...subscriptions]) {
				subscriptions.delete(id);
				subscription.end({ reason: "shutdown" });
			}
			return close({ code: "host_shutdown", ...(message === undefined ? {} : { message }) });
		},
		close,
	};
}
