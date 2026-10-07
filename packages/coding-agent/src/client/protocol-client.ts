/**
 * A protocol 1 client (docs/rpc.md): it says hello, subscribes to the
 * conversation the host attached it to, and keeps that conversation's state
 * as the client fold of the entries it received and the live fold of its live
 * frames. It sends intents and queries and answers host requests.
 *
 * When an intent moves it to another conversation, it follows: the old
 * subscription ends `moved` and it subscribes to the target from a snapshot,
 * on the same connection or, following moves by reconnecting, on the next
 * one. On a gap in the live lane it resubscribes after its position.
 * `connect` again on a new transport resumes after its position; a client
 * that resumes after a lost connection (`resumeAfterLoss`) waits for that
 * instead of failing when its connection ends unannounced. Beside it,
 * `observe` subscribes to a conversation the client may read but not act on,
 * such as a child its conversation's work links, open or closed.
 *
 * `createLoopbackClient` serves a conversation of an in-process host on the
 * local profile; `spawnRpcClient` runs `volt --mode rpc` as a child process.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ImageContent } from "@hansjm10/volt-ai";
import {
	type BuiltinIntentName,
	ClientFoldError,
	type ClientState,
	clientAdvance,
	clientFold,
	clientRestore,
	emptyClientState,
	emptyLiveFold,
	foldLiveCommit,
	foldLiveFrame,
	type HostFrame,
	type HostRequestKind,
	type HostResponse,
	INPUT_INTENT_NAMES,
	type IntentInput,
	type IntentOutput,
	type LiveFoldState,
	LivePatchError,
	type LiveValue,
	liveCommitOf,
	PROTOCOL_VERSION,
	type QueryErrorCode,
	type QueryName,
	type QueryParams,
	type QueryResult,
	type RejectionReason,
	type RemoteCapability,
} from "@hansjm10/volt-protocol";
import { VERSION } from "../config.ts";
import type { ConversationHost } from "../core/host/conversation-host.ts";
import type { HostedConversation } from "../core/host/hosted-conversation.ts";
import { localProfile } from "../core/protocol/profiles.ts";
import { serveConnection } from "../core/protocol/server/connection.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../core/protocol/transport/jsonl.ts";
import { createLoopbackRpcTransportPair } from "../core/protocol/transport/loopback-transport.ts";
import type { RpcTransport } from "../core/protocol/transport/transport.ts";

type AcceptedFrame = Extract<HostFrame, { type: "accepted" }>;
type WelcomeFrame = Extract<HostFrame, { type: "welcome" }>;
type PhaseValue = Extract<LiveValue, { kind: "phase" }>;

/** The host refused an intent, or its run failed. */
export class ProtocolRejectedError extends Error {
	readonly reason: RejectionReason;

	constructor(intent: string, reason: RejectionReason) {
		super(reason.message || `${intent} was rejected: ${reason.code}`);
		this.name = "ProtocolRejectedError";
		this.reason = reason;
	}
}

/**
 * The connection to the host was lost before an intent answered: it may or
 * may not have run, and the client does not send it again.
 */
export class ProtocolConnectionLostError extends Error {
	readonly intent: string;

	constructor(intent: string, cause: Error) {
		super(`The connection to the host was lost before ${intent} answered; it may have run`, { cause });
		this.name = "ProtocolConnectionLostError";
		this.intent = intent;
	}
}

/** A query failed. */
export class ProtocolQueryError extends Error {
	readonly code: QueryErrorCode;
	readonly requiredCapability?: RemoteCapability;

	constructor(
		query: string,
		reason: { code: QueryErrorCode; message: string; requiredCapability?: RemoteCapability },
	) {
		super(reason.message || `${query} failed: ${reason.code}`);
		this.name = "ProtocolQueryError";
		this.code = reason.code;
		if (reason.requiredCapability !== undefined) this.requiredCapability = reason.requiredCapability;
	}
}

export interface ProtocolClientOptions {
	/** What the client calls itself in `hello`. */
	readonly name?: string;
	readonly version?: string;
	/** The host request kinds the client answers; it is asked only those. None by default. */
	readonly hostRequests?: readonly HostRequestKind[];
	/** Milliseconds to wait for an intent's or query's answer; 30 seconds by default. */
	readonly requestTimeoutMs?: number;
	/** Text added to errors, such as a child process's stderr. */
	readonly errorContext?: () => string;
	/** Observes every host frame from the first, `welcome` included. */
	readonly onFrame?: (frame: HostFrame, client: ProtocolClient) => void;
	/**
	 * How the client follows a move to another conversation: on the same
	 * connection (`"subscribe"`, the default), or, for a host that redirects
	 * its clients (a daemon worker, the TUI's host), by reconnecting
	 * (`"reconnect"`): the client lets go of the connection after
	 * `ended{moved}`, and the next `connect` subscribes to the target from a
	 * snapshot. Intents and queries pending at the move, and those sent while
	 * the client moves, go out again on that connection with their ids, in the
	 * order they were sent; a host that knows the client across connections
	 * (`clientKey`) answers a retried intent as it answered it.
	 */
	readonly followMoves?: "subscribe" | "reconnect";
	/**
	 * Whether a connection that ends without its host ending the client's
	 * subscription for good (the transport closed, or the host shut down:
	 * `ended{shutdown}`, `fatal{host_shutdown}`) lets go of the connection
	 * without failing, as a move does: the client keeps what it holds of the
	 * conversation, reports `disconnected`, and holds what it asks; the next
	 * `connect` resumes after its position and sends again, in order, the
	 * queries not answered yet, the input intents (which the log dedupes by
	 * their id), and what it held. An intent that went out and was not
	 * answered fails with `ProtocolConnectionLostError`: it may have run on a
	 * host the client no longer reaches.
	 */
	readonly resumeAfterLoss?: boolean;
}

/**
 * The client lost its connection and waits for the next one (see
 * `resumeAfterLoss`): `shutdown` when its host ended it shutting down, else
 * `lost`.
 */
export interface ProtocolClientDisconnected {
	readonly type: "disconnected";
	readonly reason: "lost" | "shutdown";
	readonly error: Error;
}

/**
 * What changed the client: the frame it applied (a snapshot, entry, head, or
 * live frame, an `ended` subscription, or a `changed` catalog), its lost
 * connection, or nothing when the client failed.
 */
export type ProtocolClientChange = HostFrame | ProtocolClientDisconnected | undefined;

export interface ProtocolIntentOptions {
	/** The intent id; minted when absent. Input intents use it as their durable `clientMessageId`. */
	readonly intentId?: string;
	/** The conversation the intent targets; the one the client is on by default. */
	readonly conversation?: string;
	/** The client's position, for branch-fenced intents. */
	readonly expectedOrdinal?: number;
}

export interface ProtocolPromptOptions {
	readonly images?: ImageContent[];
	/** How the prompt is delivered while the agent is busy. */
	readonly streamingBehavior?: "steer" | "followUp";
	/** The prompt's durable identity; minted when absent. */
	readonly clientMessageId?: string;
}

/** Why an observation ended: its conversation closed (a closed one ends after its snapshot), lost its log, or the observation or client stopped. */
export type ObservationEnd = "closed" | "lost" | "stopped";

/**
 * A read-only subscription to a conversation the client is not on: its client
 * fold and live fold, from a snapshot. A conversation that is closed ends
 * right after its snapshot.
 */
export interface ConversationObservation {
	readonly conversation: string;
	/** Whether the snapshot arrived. */
	readonly received: boolean;
	/** Whether the live state arrived after the snapshot: what the observation holds is current. */
	readonly caughtUp: boolean;
	readonly state: ClientState;
	readonly live: LiveFoldState;
	/** Why the observation ended, once it did. */
	readonly ended: ObservationEnd | undefined;
	/** Called after the state, the live state, or `ended` changed. */
	onChange(listener: () => void): () => void;
	/** Stop observing. */
	stop(): void;
}

class Observation implements ConversationObservation {
	readonly conversation: string;
	received = false;
	caughtUp = false;
	state: ClientState = emptyClientState();
	live: LiveFoldState = emptyLiveFold();
	ended: ObservationEnd | undefined;
	subscriptionId = "";
	private liveSeq = 0;
	private readonly listeners = new Set<() => void>();
	private readonly owner: {
		readonly subscribe: (observation: Observation, after: number | "snapshot") => void;
		readonly unsubscribe: (observation: Observation) => void;
	};

	constructor(conversation: string, owner: Observation["owner"]) {
		this.conversation = conversation;
		this.owner = owner;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	stop(): void {
		if (this.ended !== undefined) return;
		this.owner.unsubscribe(this);
		this.end("stopped");
	}

	/** Subscribe afresh: after the position held, or from a snapshot when nothing is. */
	start(after: number | "snapshot"): void {
		this.liveSeq = 0;
		this.owner.subscribe(this, after);
	}

	end(reason: ObservationEnd): void {
		if (this.ended !== undefined) return;
		this.ended = reason;
		this.changed();
	}

	apply(frame: HostFrame): void {
		if (this.ended !== undefined) return;
		switch (frame.type) {
			case "snapshot":
				this.state = clientRestore(frame.ordinal, frame.state);
				this.live = emptyLiveFold();
				this.received = true;
				break;
			case "entry":
				try {
					this.state = clientFold([frame.entry], this.state);
				} catch (error) {
					if (!(error instanceof ClientFoldError)) throw error;
					this.owner.unsubscribe(this);
					this.state = emptyClientState();
					this.live = emptyLiveFold();
					this.start("snapshot");
					return;
				}
				this.live = foldLiveCommit(this.live, liveCommitOf(frame.entry));
				break;
			case "head":
				this.state = clientAdvance(this.state, frame.ordinal);
				break;
			case "live":
				if (frame.reset !== true && frame.seq !== this.liveSeq + 1) {
					this.owner.unsubscribe(this);
					this.start(this.state.ordinal);
					return;
				}
				this.liveSeq = frame.seq;
				try {
					this.live = foldLiveFrame(this.live, frame);
				} catch (error) {
					if (!(error instanceof LivePatchError)) throw error;
					this.owner.unsubscribe(this);
					this.start(this.state.ordinal);
					return;
				}
				if (frame.reset === true) this.caughtUp = true;
				break;
			case "ended":
				this.end(frame.reason === "lost" ? "lost" : frame.reason === "unsubscribed" ? "stopped" : "closed");
				return;
			default:
				return;
		}
		this.changed();
	}

	private changed(): void {
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// Listeners are observers.
			}
		}
	}
}

interface Pending<T> {
	readonly name: string;
	/** The frame that asked, sent again on the next connection when the client moves before its answer. */
	readonly frame: Record<string, unknown>;
	/** Whether the frame went out on a connection (else the client held it while it moved or was disconnected). */
	sent: boolean;
	/** The order the client asked in, across intents and queries. */
	readonly order: number;
	readonly resolve: (value: T) => void;
	readonly reject: (error: Error) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Intents the conversation's log dedupes by their id: safe to send again after a lost connection. */
const INPUT_INTENTS: ReadonlySet<string> = new Set(INPUT_INTENT_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ProtocolClient {
	private readonly options: ProtocolClientOptions;
	private transport: RpcTransport | undefined;
	/** A transport the client stopped using after a failure, still to be closed by `stop`. */
	private failedTransport: RpcTransport | undefined;
	private detachTransport: Array<() => void> = [];
	private readonly intents = new Map<string, Pending<AcceptedFrame>>();
	private readonly queries = new Map<string, Pending<unknown>>();
	private readonly frameListeners = new Set<(frame: HostFrame) => void>();
	private readonly changeListeners = new Set<(change: ProtocolClientChange) => void>();
	private welcomeFrame: WelcomeFrame | undefined;
	private welcomeWaiter: { resolve: (frame: WelcomeFrame) => void; reject: (error: Error) => void } | undefined;
	private subscription: { readonly id: string; readonly conversation: string; caughtUp: boolean } | undefined;
	/** Observations of other conversations, by subscription id. */
	private readonly observations = new Map<string, Observation>();
	private readonly caughtUpWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
	private clientState: ClientState = emptyClientState();
	private liveState: LiveFoldState = emptyLiveFold();
	private liveSeq = 0;
	/** The ordinal of the newest entry that changed the pending inputs. */
	private queueChangedAt = 0;
	/** The `basedOn` of the newest live frame that set the run phase. */
	private phaseBasedOn = -1;
	private failure: Error | undefined;
	/** The conversation a move redirected the client to, until the next `connect` subscribes to it. */
	private movingTo: string | undefined;
	/** The connection the client lost, until the next `connect` resumes (`resumeAfterLoss`). */
	private lostConnection: ProtocolClientDisconnected | undefined;
	private requestOrder = 0;

	constructor(options: ProtocolClientOptions = {}) {
		this.options = options;
		const onFrame = options.onFrame;
		if (onFrame) this.frameListeners.add((frame) => onFrame(frame, this));
	}

	/** The conversation's client fold: its entries, leaf, branch values, labels, and pending inputs. */
	get state(): ClientState {
		return this.clientState;
	}

	/** The conversation's live state: keyed values (phase, usage, host requests, ...) and what streams. */
	get live(): LiveFoldState {
		return this.liveState;
	}

	/** The conversation the client is subscribed to, or moves to. */
	get conversation(): string | undefined {
		return this.movingTo ?? this.subscription?.conversation;
	}

	/**
	 * The conversation a move redirected the client to, while the client has
	 * no connection to it yet (it follows moves by reconnecting).
	 */
	get moving(): string | undefined {
		return this.movingTo;
	}

	/**
	 * While the client moves and has no connection to its target yet, move it
	 * to `conversation` instead (such as back to the one it left, when its
	 * target cannot be reached): the next `connect` subscribes there.
	 */
	retarget(conversation: string): void {
		if (this.movingTo === undefined) throw new Error("The client is not moving");
		this.movingTo = conversation;
	}

	/** Whether the client lost its connection and waits for the next one (`resumeAfterLoss`). */
	get disconnected(): boolean {
		return this.lostConnection !== undefined;
	}

	get connectionId(): string | undefined {
		return this.welcomeFrame?.connectionId;
	}

	/** Every host frame, as it arrives. */
	onFrame(listener: (frame: HostFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	/**
	 * Called after a frame changed the state or the live state, ended the
	 * subscription, or told the client to refetch a catalog, with that frame;
	 * and without one after the client failed.
	 */
	onChange(listener: (change: ProtocolClientChange) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	/**
	 * Say hello on `transport` and subscribe: from a snapshot to the conversation
	 * the host attached the client to, or to the one a move redirected it to;
	 * reconnecting, after the position the client holds. The intents and
	 * queries still waiting for an answer go out again. Resolves once the
	 * subscription caught up with the log.
	 */
	async connect(transport: RpcTransport): Promise<void> {
		if (this.transport) throw new Error("The client is connected");
		this.failure = undefined;
		const resuming = this.lostConnection !== undefined;
		this.lostConnection = undefined;
		this.transport = transport;
		this.detachTransport = [
			transport.onValue
				? transport.onValue((value) => this.receive(value))
				: transport.onLine((line) => {
						let value: unknown;
						try {
							value = JSON.parse(line);
						} catch {
							this.fail(new Error(this.withContext(`Malformed frame from the host: ${line.slice(0, 200)}`)));
							return;
						}
						this.receive(value);
					}),
			transport.onClose?.((error) => this.dropped(error ?? new Error(this.withContext("The connection closed")))) ??
				(() => {}),
		];
		const welcome = await this.withTimeout(
			"welcome",
			new Promise<WelcomeFrame>((resolve, reject) => {
				this.welcomeWaiter = { resolve, reject };
				this.send({
					type: "hello",
					protocol: PROTOCOL_VERSION,
					client: { name: this.options.name ?? "volt-protocol-client", version: this.options.version ?? VERSION },
					accepts: { hostRequests: [...(this.options.hostRequests ?? [])] },
				});
			}),
		);
		const moving = this.movingTo;
		const resume = moving === undefined ? this.subscription : undefined;
		const conversation = moving ?? resume?.conversation ?? welcome.conversation;
		if (conversation === undefined) throw new Error("The host attached the client to no conversation");
		this.movingTo = undefined;
		this.subscribe(conversation, resume ? this.clientState.ordinal : "snapshot");
		if (moving !== undefined || resuming) {
			// What the client asked before its move or its lost connection, or since, in the order it asked.
			const waiting = [...this.intents.values(), ...this.queries.values()].sort(
				(left, right) => left.order - right.order,
			);
			for (const pending of waiting) {
				pending.sent = true;
				this.send(pending.frame);
			}
		}
		await this.withTimeout("the subscription", this.caughtUp());
	}

	/** `promise`, failing the client when it does not settle within the request timeout. */
	private withTimeout<T>(what: string, promise: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new Error(this.withContext(`Timeout waiting for ${what}`));
				this.dropped(error);
				reject(error);
			}, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
			timer.unref?.();
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error: unknown) => {
					clearTimeout(timer);
					reject(error);
				},
			);
		});
	}

	/** Resolves once the subscription caught up with the log (its first live reset arrived). */
	caughtUp(): Promise<void> {
		if (this.failure) return Promise.reject(this.failure);
		if (this.subscription?.caughtUp) return Promise.resolve();
		return new Promise((resolve, reject) => this.caughtUpWaiters.add({ resolve, reject }));
	}

	/** Send an intent; resolves with its acceptance, rejects with {@link ProtocolRejectedError}. */
	intent<N extends BuiltinIntentName>(
		name: N,
		input?: IntentInput<N>,
		options?: ProtocolIntentOptions,
	): Promise<AcceptedFrame & { result?: IntentOutput<N> }>;
	intent(name: string, input?: Record<string, unknown>, options?: ProtocolIntentOptions): Promise<AcceptedFrame>;
	intent(name: string, input?: unknown, options: ProtocolIntentOptions = {}): Promise<AcceptedFrame> {
		const intentId = options.intentId ?? randomUUID();
		return this.request(this.intents, intentId, name, {
			type: name,
			intentId,
			...(options.conversation === undefined ? {} : { conversation: options.conversation }),
			...(options.expectedOrdinal === undefined ? {} : { expectedOrdinal: options.expectedOrdinal }),
			...(input === undefined ? {} : { input }),
		});
	}

	/** Run a query; resolves with its result, rejects with {@link ProtocolQueryError}. */
	query<N extends QueryName>(
		name: N,
		params?: QueryParams<N>,
		options: { conversation?: string } = {},
	): Promise<QueryResult<N>> {
		const queryId = randomUUID();
		return this.request(this.queries, queryId, name, {
			type: "query",
			queryId,
			query: name,
			...(options.conversation === undefined ? {} : { conversation: options.conversation }),
			...(params === undefined ? {} : { params }),
		}) as Promise<QueryResult<N>>;
	}

	/** Send a prompt; resolves once the host admitted it. */
	prompt(message: string, options: ProtocolPromptOptions = {}): Promise<AcceptedFrame> {
		return this.intent(
			"prompt",
			{
				message,
				...(options.images === undefined ? {} : { images: options.images }),
				...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
			},
			{ intentId: options.clientMessageId ?? randomUUID() },
		);
	}

	/**
	 * Answer a host request the client was asked; a client that moved away
	 * from the request's conversation, or lost its connection, answers nothing
	 * (a request still pending reaches it again once it resumes).
	 */
	answer(requestId: string, response: HostResponse): void {
		if (this.movingTo !== undefined || this.lostConnection !== undefined) return;
		this.send({ type: "host_response", requestId, response });
	}

	/** The run phase the live state holds, if any. */
	get phase(): PhaseValue | undefined {
		const value = this.liveState.values.get("phase");
		return value?.kind === "phase" ? value : undefined;
	}

	/**
	 * Whether the conversation is idle: no operation runs, no input is pending,
	 * and the phase was published after the last input left the queue.
	 */
	isIdle(): boolean {
		const phase = this.phase;
		return (
			phase !== undefined &&
			!phase.busy &&
			this.clientState.queue.length === 0 &&
			this.phaseBasedOn >= this.queueChangedAt
		);
	}

	/** Resolves once the conversation is idle (see {@link isIdle}). */
	waitForIdle(timeoutMs = 60_000): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(
				() => finish(new Error(this.withContext("Timeout waiting for the conversation to become idle"))),
				timeoutMs,
			);
			const unsubscribe = this.onChange(() => {
				if (this.failure) finish(this.failure);
				else if (this.isIdle()) finish();
			});
			if (this.failure) finish(this.failure);
			else if (this.isIdle()) finish();
		});
	}

	/** Send a prompt and wait until the conversation is idle again. */
	async promptAndWait(message: string, options: ProtocolPromptOptions & { timeoutMs?: number } = {}): Promise<void> {
		await this.prompt(message, options);
		await this.waitForIdle(options.timeoutMs);
	}

	/**
	 * Start over on the conversation from a snapshot, as the host projects its
	 * log now: with the presenters the host has now.
	 */
	resync(): void {
		if (this.failure || !this.transport) return;
		this.resubscribeFromSnapshot();
	}

	/**
	 * Observe `conversation` read-only beside the conversation the client is
	 * on: a conversation the host lets it read, such as a child its
	 * conversation's work links at any depth, open or closed.
	 */
	observe(conversation: string): ConversationObservation {
		const observation = new Observation(conversation, {
			subscribe: (subscribed, after) => {
				const id = randomUUID();
				subscribed.subscriptionId = id;
				this.observations.set(id, subscribed);
				this.send({ type: "subscribe", subscriptionId: id, conversation, after });
			},
			unsubscribe: (subscribed) => {
				if (!this.observations.delete(subscribed.subscriptionId)) return;
				if (this.transport) this.send({ type: "unsubscribe", subscriptionId: subscribed.subscriptionId });
			},
		});
		if (this.failure || !this.transport) observation.end("stopped");
		else observation.start("snapshot");
		return observation;
	}

	/** Close the transport; pending intents and queries fail, with `reason` when given. A stopped client moves nowhere. */
	async stop(reason: Error = new Error("The client stopped")): Promise<void> {
		const transport = this.transport ?? this.failedTransport;
		this.movingTo = undefined;
		this.fail(reason);
		this.failedTransport = undefined;
		await transport?.close();
	}

	private subscribe(conversation: string, after: number | "snapshot"): void {
		const id = randomUUID();
		this.subscription = { id, conversation, caughtUp: false };
		this.liveSeq = 0;
		this.send({ type: "subscribe", subscriptionId: id, conversation, after });
	}

	/** Start over on the same conversation after the client's position. */
	private resubscribe(): void {
		const subscription = this.subscription;
		if (!subscription) return;
		this.send({ type: "unsubscribe", subscriptionId: subscription.id });
		this.subscribe(subscription.conversation, this.clientState.ordinal);
	}

	private request<T>(
		pending: Map<string, Pending<T>>,
		id: string,
		name: string,
		frame: Record<string, unknown>,
	): Promise<T> {
		if (this.failure) return Promise.reject(this.failure);
		// A client that moves, or lost its connection, holds what it asks until it connected again.
		const held = this.movingTo !== undefined || this.lostConnection !== undefined;
		if (!this.transport && !held) return Promise.reject(new Error("The client is not connected"));
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(this.withContext(`Timeout waiting for ${name}`)));
			}, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
			timer.unref?.();
			pending.set(id, { name, frame, sent: !held, order: this.requestOrder++, resolve, reject, timer });
			if (!held) this.send(frame);
		});
	}

	private send(frame: Record<string, unknown>): void {
		const transport = this.transport;
		if (!transport) throw new Error("The client is not connected");
		try {
			const written = transport.write(frame);
			if (written) void Promise.resolve(written).catch((error: unknown) => this.dropped(error));
		} catch (error) {
			this.dropped(error);
		}
	}

	private receive(value: unknown): void {
		if (this.failure || !isRecord(value) || typeof value.type !== "string") return;
		const frame = value as HostFrame;
		for (const listener of [...this.frameListeners]) {
			try {
				listener(frame);
			} catch {
				// Listeners are observers.
			}
		}
		this.apply(frame);
	}

	private apply(frame: HostFrame): void {
		const observation = "subscriptionId" in frame ? this.observations.get(frame.subscriptionId) : undefined;
		if (observation) {
			if (frame.type === "ended") this.observations.delete(frame.subscriptionId);
			observation.apply(frame);
			return;
		}
		const subscription = this.subscription;
		const ours = "subscriptionId" in frame && subscription?.id === frame.subscriptionId;
		switch (frame.type) {
			case "welcome":
				this.welcomeFrame = frame;
				this.welcomeWaiter?.resolve(frame);
				this.welcomeWaiter = undefined;
				return;
			case "snapshot":
				if (!ours) return;
				this.clientState = clientRestore(frame.ordinal, frame.state);
				this.liveState = emptyLiveFold();
				this.queueChangedAt = frame.ordinal;
				this.changed(frame);
				return;
			case "entry": {
				if (!ours) return;
				const before = this.clientState.queue;
				try {
					this.clientState = clientFold([frame.entry], this.clientState);
				} catch (error) {
					if (error instanceof ClientFoldError) {
						this.resubscribeFromSnapshot();
						return;
					}
					throw error;
				}
				if (this.clientState.queue !== before) this.queueChangedAt = frame.entry.ordinal;
				this.liveState = foldLiveCommit(this.liveState, liveCommitOf(frame.entry));
				this.changed(frame);
				return;
			}
			case "head":
				if (!ours) return;
				this.clientState = clientAdvance(this.clientState, frame.ordinal);
				this.changed(frame);
				return;
			case "live":
				if (!ours || !subscription) return;
				if (frame.reset !== true && frame.seq !== this.liveSeq + 1) {
					this.resubscribe();
					return;
				}
				this.liveSeq = frame.seq;
				try {
					this.liveState = foldLiveFrame(this.liveState, frame);
				} catch (error) {
					// A patch of a value this client does not hold as the host does: start over after its position.
					if (error instanceof LivePatchError) {
						this.resubscribe();
						return;
					}
					throw error;
				}
				if (frame.items.some((item) => item.type === "set" && item.key === "phase") || frame.reset === true) {
					this.phaseBasedOn = frame.basedOn;
				}
				if (frame.reset === true && !subscription.caughtUp) {
					subscription.caughtUp = true;
					for (const waiter of this.caughtUpWaiters) waiter.resolve();
					this.caughtUpWaiters.clear();
				}
				this.changed(frame);
				return;
			case "ended":
				if (!ours) return;
				if (frame.reason === "moved") {
					this.clientState = emptyClientState();
					this.liveState = emptyLiveFold();
					this.queueChangedAt = 0;
					this.phaseBasedOn = -1;
					if (this.options.followMoves === "reconnect") this.redirected(frame.target);
					else this.subscribe(frame.target, "snapshot");
				} else if (frame.reason === "shutdown" && this.options.resumeAfterLoss === true) {
					// The host shuts down: the client resumes on the host it reconnects to.
					this.lose(new Error(this.withContext("The host shut down")), "shutdown");
					return;
				} else if (frame.reason !== "unsubscribed") {
					this.fail(new Error(this.withContext(`The subscription ended: ${frame.reason}`)));
				}
				this.changed(frame);
				return;
			case "accepted":
			case "rejected": {
				const pending = this.intents.get(frame.intentId);
				if (!pending) return;
				this.intents.delete(frame.intentId);
				clearTimeout(pending.timer);
				if (frame.type === "accepted") pending.resolve(frame);
				else pending.reject(new ProtocolRejectedError(pending.name, frame.reason));
				return;
			}
			case "result":
			case "query_error": {
				const pending = this.queries.get(frame.queryId);
				if (!pending) return;
				this.queries.delete(frame.queryId);
				clearTimeout(pending.timer);
				if (frame.type === "result") pending.resolve(frame.data);
				else pending.reject(new ProtocolQueryError(pending.name, frame.reason));
				return;
			}
			case "changed":
				this.changed(frame);
				return;
			case "fatal":
				if (frame.code === "host_shutdown" && this.options.resumeAfterLoss === true) {
					this.lose(new Error(this.withContext("The host shut down")), "shutdown");
					return;
				}
				this.fail(
					new Error(
						this.withContext(
							`The host ended the connection: ${frame.code}${frame.message ? ` (${frame.message})` : ""}`,
						),
					),
				);
				return;
			default:
				return;
		}
	}

	/**
	 * The host redirected the client to `target` and ends this connection: let
	 * go of it without failing. What the client asked and was not answered
	 * waits for the next connection, which subscribes to `target`.
	 */
	private redirected(target: string): void {
		const transport = this.transport;
		this.movingTo = target;
		this.subscription = undefined;
		for (const detach of this.detachTransport.splice(0)) detach();
		this.transport = undefined;
		// What the client observed beside the conversation it left ends with it.
		const observations = [...this.observations.values()];
		this.observations.clear();
		for (const observation of observations) observation.end("stopped");
		if (transport) void (async () => transport.close())().catch(() => undefined);
	}

	/**
	 * The connection ended without the host ending the client's subscription
	 * for good: a client that resumes after a lost connection waits for the
	 * next one, any other fails.
	 */
	private dropped(error: unknown): void {
		const cause = error instanceof Error ? error : new Error(String(error));
		if (this.options.resumeAfterLoss === true) this.lose(cause, "lost");
		else this.fail(cause);
	}

	/**
	 * Let go of the connection without failing: the client keeps what it
	 * holds of the conversation and what waits for an answer, and the next
	 * `connect` resumes after its position. What it observed beside its
	 * conversation ends.
	 */
	private lose(error: Error, reason: ProtocolClientDisconnected["reason"]): void {
		if (this.failure || this.lostConnection) return;
		const transport = this.transport;
		for (const detach of this.detachTransport.splice(0)) detach();
		this.transport = undefined;
		if (this.subscription) this.subscription.caughtUp = false;
		// A `connect` in flight fails; the next one resumes.
		this.welcomeWaiter?.reject(error);
		this.welcomeWaiter = undefined;
		for (const waiter of this.caughtUpWaiters) waiter.reject(error);
		this.caughtUpWaiters.clear();
		const observations = [...this.observations.values()];
		this.observations.clear();
		for (const observation of observations) observation.end("stopped");
		// An intent that went out and was not answered may have run on a host the next connection may not reach
		// (a worker that exited takes its outcomes with it): it is not sent again, except input, which the
		// conversation's log dedupes by its id. Queries are sent again; what was held goes out for the first time.
		for (const [intentId, pending] of [...this.intents]) {
			if (!pending.sent || INPUT_INTENTS.has(pending.name)) continue;
			this.intents.delete(intentId);
			clearTimeout(pending.timer);
			pending.reject(new ProtocolConnectionLostError(pending.name, error));
		}
		const lost: ProtocolClientDisconnected = { type: "disconnected", reason, error };
		this.lostConnection = lost;
		if (transport) void (async () => transport.close())().catch(() => undefined);
		this.changed(lost);
	}

	private resubscribeFromSnapshot(): void {
		const subscription = this.subscription;
		if (!subscription) return;
		this.send({ type: "unsubscribe", subscriptionId: subscription.id });
		this.clientState = emptyClientState();
		this.liveState = emptyLiveFold();
		this.subscribe(subscription.conversation, "snapshot");
	}

	private changed(change?: HostFrame | ProtocolClientDisconnected): void {
		for (const listener of [...this.changeListeners]) {
			try {
				listener(change);
			} catch {
				// Listeners are observers.
			}
		}
	}

	private fail(error: unknown): void {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (this.failure) return;
		this.failure = failure;
		this.lostConnection = undefined;
		for (const detach of this.detachTransport.splice(0)) detach();
		this.failedTransport = this.transport ?? this.failedTransport;
		this.transport = undefined;
		if (this.subscription) this.subscription.caughtUp = false;
		this.welcomeWaiter?.reject(failure);
		this.welcomeWaiter = undefined;
		for (const waiter of this.caughtUpWaiters) waiter.reject(failure);
		this.caughtUpWaiters.clear();
		for (const pending of [...this.intents.values(), ...this.queries.values()]) {
			clearTimeout(pending.timer);
			pending.reject(failure);
		}
		this.intents.clear();
		this.queries.clear();
		const observations = [...this.observations.values()];
		this.observations.clear();
		for (const observation of observations) observation.end("stopped");
		this.changed();
	}

	private withContext(message: string): string {
		const context = this.options.errorContext?.();
		return context ? `${message}. ${context}` : message;
	}
}

export interface LoopbackClientOptions extends ProtocolClientOptions {
	/**
	 * Defaults to true. The client anchors the conversation: stopping it closes
	 * the conversation. Set false when another owner keeps the conversation
	 * open after the client stops.
	 */
	readonly anchor?: boolean;
}

/** A client of a conversation in an in-process host, over a loopback connection on the local profile. */
export class LoopbackClient extends ProtocolClient {
	/** Settles once the connection ended; rejects with what ended it. */
	readonly closed: Promise<void>;

	constructor(options: ProtocolClientOptions, closed: Promise<void>) {
		super(options);
		this.closed = closed;
	}

	/** Close the connection and wait until the host let go of it. */
	override async stop(): Promise<void> {
		await super.stop();
		await this.closed.catch(() => undefined);
	}
}

/**
 * Serve `conversation` of `host` to a new client over an in-process loopback,
 * on the local profile. Resolves once the client caught up with the log and
 * the conversation's extensions are bound.
 */
export async function createLoopbackClient(
	host: ConversationHost,
	conversation: HostedConversation,
	options: LoopbackClientOptions = {},
): Promise<LoopbackClient> {
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, localProfile, {
		host,
		conversation,
		...(options.anchor === undefined ? {} : { anchor: options.anchor }),
	});
	const client = new LoopbackClient(options, connection.closed);
	try {
		await client.connect(pair.client);
		await connection.ready;
	} catch (error) {
		await client.stop();
		throw error;
	}
	return client;
}

export interface SpawnRpcClientOptions extends ProtocolClientOptions {
	/** The CLI entry point; `dist/cli.js` by default. */
	readonly cliPath?: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly provider?: string;
	readonly model?: string;
	/** More CLI arguments. */
	readonly args?: readonly string[];
}

/** A client of `volt --mode rpc` running as a child process. */
export class RpcProcessClient extends ProtocolClient {
	private readonly readStderr: () => string;

	constructor(options: ProtocolClientOptions, stderr: () => string) {
		super({ ...options, errorContext: () => `Stderr: ${stderr()}` });
		this.readStderr = stderr;
	}

	/** What the child wrote to stderr. */
	stderr(): string {
		return this.readStderr();
	}
}

/** Run `volt --mode rpc` as a child process and connect to it. Stopping the client ends the process. */
export async function spawnRpcClient(options: SpawnRpcClientOptions = {}): Promise<RpcProcessClient> {
	const args = [options.cliPath ?? "dist/cli.js", "--mode", "rpc"];
	if (options.provider) args.push("--provider", options.provider);
	if (options.model) args.push("--model", options.model);
	if (options.args) args.push(...options.args);
	const child = spawn("node", args, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});
	const client = new RpcProcessClient(options, () => stderr);
	try {
		await client.connect(childProcessTransport(child, () => stderr));
	} catch (error) {
		await client.stop().catch(() => undefined);
		throw error;
	}
	return client;
}

/** A transport over a child process's stdio; closing it ends the child. */
function childProcessTransport(child: ChildProcess, stderr: () => string): RpcTransport {
	const closeHandlers = new Set<(error?: Error) => void>();
	let ended = false;
	const end = (error?: Error): void => {
		if (ended) return;
		ended = true;
		for (const handler of closeHandlers) handler(error);
	};
	child.once("exit", (code, signal) =>
		end(new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${stderr()}`)),
	);
	child.once("error", (error) => end(new Error(`Agent process error: ${error.message}. Stderr: ${stderr()}`)));
	child.stdin?.on("error", (error) => end(new Error(`Agent process stdin error: ${error.message}`)));
	return {
		write(value) {
			const stdin = child.stdin;
			if (!stdin || stdin.destroyed || !stdin.writable) throw new Error("Agent process stdin is not writable");
			stdin.write(serializeJsonLine(value));
		},
		onLine(handler) {
			return child.stdout ? attachJsonlLineReader(child.stdout, handler) : () => {};
		},
		onClose(handler) {
			closeHandlers.add(handler);
			return () => closeHandlers.delete(handler);
		},
		async close() {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.stdin?.end();
			const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
			const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
			await exited;
			clearTimeout(timer);
			clearTimeout(kill);
		},
	};
}
