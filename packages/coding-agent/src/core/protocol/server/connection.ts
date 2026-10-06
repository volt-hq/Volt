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
 * without holding later frames. Stopping intents (`abort`, `abort_bash`,
 * `abort_retry`, `cancel_work`) run in a lane of their own, in arrival order
 * among themselves but not after the other frames before them, so a stop
 * never waits behind a long intent such as `compact`; a client that needs an
 * earlier intent admitted first waits for its `accepted`. User shell commands
 * (`bash`), compactions (`compact`), and tree navigations (`navigate_tree`,
 * which may summarize the branch it leaves) run in a lane of their own the
 * same way: each runs as conversation activity, so the prompts, the queue's
 * withdrawal, and the intents sent while it runs do not wait for it. A
 * stopping intent is checked against the connection's
 * authority like any other. Non-input intents are deduplicated per
 * conversation by `intentId`, or, for a client the host knows across its
 * connections (`clientKey`), across the host's conversations; input intents
 * carry their durable `clientMessageId` as theirs. A structural intent that
 * moves the client answers `accepted{conversation}`, then ends the
 * subscriptions on the conversation it left with `ended{moved, target}`. A
 * client that follows its structural intents by redirect (a phone, the TUI)
 * stays where it is: after `ended{moved, target}` the connection closes, and
 * the client connects to the target.
 *
 * Every frame the host writes passes through the profile's redactor at one
 * send; the remote profile also bounds frames to its frame limit. The
 * connection's authority is checked before every frame in either direction,
 * and re-read from its store before every intent, query, subscription, and
 * answer: a client whose grant was revoked gets `fatal{revoked}` as its last
 * frame. A malformed frame ends the connection with `fatal`, an oversized one
 * with `fatal{frame_too_large}`.
 *
 * A client reads, but never acts on, the children its conversation's work
 * links (a subagent's conversation, the pass a review runs now), directly or
 * through linked children: an open child by subscription until it closes,
 * and a closed subagent child from its log (`subscribe` answers a snapshot,
 * then `ended{closed}`; `history`, `content`, and `work_output` read it).
 * Reading a closed log costs reads as a replay that long does.
 *
 * A connection without a conversation serves host intents and queries only
 * (a workspace stream).
 */

import { randomUUID } from "node:crypto";
import {
	type ControlRelayFrame,
	type ControlRelayOutcome,
	DYNAMIC_INTENT_PATTERN,
	DynamicIntentFrameSchema,
	ExtensionIntentFrameSchema,
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
	QUERY_FRAME_SCHEMAS,
	type QueryErrorCode,
	RELAY_INTENT_NAMES,
	RELAY_QUERY_NAMES,
	RESERVED_FRAME_TYPES,
	type RejectionReason,
	RpcConversationIdentifierSchema,
	RpcSafeNonNegativeIntegerSchema,
	SubscribeFrameSchema,
	UnsubscribeFrameSchema,
	type WithdrawnInput,
} from "@hansjm10/volt-protocol";
import { type Static, type TObject, type TSchema, Type } from "typebox";
import { Compile } from "typebox/compile";
import { VERSION } from "../../../config.ts";
import { isPathUnderWorktreesRoot } from "../../../daemon/worktree-manager.ts";
import type { ExtensionError, InputSource } from "../../extensions/index.ts";
import { ClientScope } from "../../host/client-scope.ts";
import type { ConversationHost } from "../../host/conversation-host.ts";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import type { LiveUpdate } from "../../host/live-state.ts";
import { openFork, openNewSession, openStoredSession } from "../../host/session-intents.ts";
import type { HostClient, HostClientMove, HostedRedirect, RedirectTarget } from "../../host/targets.ts";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../session-cwd.ts";
import { SessionManager } from "../../session-manager.ts";
import { SubscriptionUsageService } from "../../subscription-usage.ts";
import { EDITOR_TEXT_TIMEOUT_MS } from "../../ui/extension-ui.ts";
import { type ClosedChildLink, findClosedDescendant, linkedChildConversation } from "../../work/children.ts";
import { withdrawQueuedInput } from "../intents/conversation.ts";
import { intentRegistry, isBuiltinIntentName } from "../intents/index.ts";
import { type IntentContext, IntentRejectedError, type IntentServices } from "../intents/types.ts";
import type { Profile } from "../profiles.ts";
import { queryRegistry } from "../queries/index.ts";
import { QueryRejectedError } from "../queries/types.ts";
import { formatSchemaBoundError } from "../schema-errors.ts";
import { RpcFrameTooLargeError, type RpcTransport } from "../transport/transport.ts";
import { createLocalIntentServices } from "./local-services.ts";
import { logSnapshot, Subscription, type SubscriptionEnd, subscriptionReads } from "./subscription.ts";

/** Frames a connection holds for its intent and query lane, at most. */
const MAX_PENDING_FRAMES = 256;

/** Links to closed children a connection remembers, at most. */
const MAX_CLOSED_LINKS = 64;

/** Intents that may move the client to another conversation. */
const STRUCTURAL_INTENTS: ReadonlySet<string> = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"import_session",
	"review_open_session",
	"open_work",
]);

/**
 * Intents that stop what runs: they run on arrival, outside the lane, so a
 * stop never waits behind the long intent it stops.
 */
const STOPPING_INTENTS: ReadonlySet<string> = new Set(["abort", "abort_bash", "abort_retry", "cancel_work"]);

/**
 * Intents that run as conversation activity: one at a time in a lane of
 * their own, so a long shell command, compaction, or branch summary never
 * holds the frames after it.
 */
const ACTIVITY_INTENTS: ReadonlySet<string> = new Set(["bash", "compact", "navigate_tree"]);

/** Intents whose acceptance changes the `sessions` catalog without moving the client. */
const SESSIONS_INTENTS: ReadonlySet<string> = new Set(["delete_session", "set_session_name"]);

/** Intents whose acceptance changes the `settings` catalog. */
const SETTINGS_INTENTS: ReadonlySet<string> = new Set([
	"set_steering_mode",
	"set_follow_up_mode",
	"set_auto_compaction",
	"set_auto_retry",
	"set_compaction_threshold",
	"set_extension_settings",
	"set_settings",
	"set_profile",
	"set_model_scope",
]);

/** Intents whose acceptance changes the `models` catalog: which models are selectable, and the cycle scope. */
const MODELS_INTENTS: ReadonlySet<string> = new Set(["set_model_scope", "set_profile", "auth.login", "auth.logout"]);

/** Intents whose acceptance changes the `host` catalog. */
const HOST_INTENTS: ReadonlySet<string> = new Set(["set_keep_awake", "set_web_search_key"]);

/** Intents whose acceptance ends the connection: its `accepted` is the last frame before this fatal. */
const ENDING_INTENTS: ReadonlyMap<string, FatalCode> = new Map([["unregister_workspace", "workspace_unregistered"]]);

const INPUT_INTENTS: ReadonlySet<string> = new Set(INPUT_INTENT_NAMES);
const DYNAMIC_INTENT = new RegExp(DYNAMIC_INTENT_PATTERN);
const EXTENSION_INTENT_PREFIX = "extension.intent.";
const RESERVED: ReadonlySet<string> = new Set(RESERVED_FRAME_TYPES);
const RELAY_INTENTS: ReadonlySet<string> = new Set(RELAY_INTENT_NAMES);
const RELAY_QUERIES: ReadonlySet<string> = new Set(RELAY_QUERY_NAMES);

export interface ProtocolPeer {
	readonly name: string;
	readonly version: string;
}

/** Why a connection's authority no longer holds: the fatal code it ends with. */
export type AuthorityLoss = Extract<FatalCode, "revoked" | "workspace_unregistered">;

export interface ServeConnectionOptions {
	/** The host of the conversation; a connection without a conversation needs none. */
	readonly host?: ConversationHost;
	/**
	 * The conversation the connection's client attaches to once it says hello.
	 * Without one, the connection serves host intents and queries only.
	 */
	readonly conversation?: HostedConversation;
	/**
	 * Whether the client anchors its conversation: the conversation closes when
	 * the client leaves it, by a move or as the connection ends. By default a
	 * client that follows moves in place does and a redirect client does not;
	 * a host that shares the conversation keeps it open after the connection
	 * ends. A redirect client that anchors (the TUI in its in-process host)
	 * closes each conversation it leaves.
	 */
	readonly anchor?: boolean;
	/** What the host calls itself in `welcome`. */
	readonly server?: ProtocolPeer;
	/** An extension asked the host to shut down (`ctx.shutdown()`). */
	readonly onShutdownRequested?: () => void;
	/** The conversation the client is on lost its log: a commit it could not confirm. */
	readonly onLost?: (conversation: HostedConversation, error: Error) => void;
	/**
	 * The client follows its structural intents by redirect (a phone, the
	 * TUI): it stays on its conversation, its subscriptions there end `moved`,
	 * and the connection closes. `hostTarget` hosts the conversations the
	 * extension commands it invokes lead it to, with `hostsClientMoves` those
	 * its own intents lead it to too, and with `hostsStoredSessions` the stored
	 * ones a switch resumes that it takes (see `HostClientMove`).
	 */
	readonly redirect?: {
		readonly hostTarget?: (target: RedirectTarget) => Promise<HostedRedirect | undefined>;
		readonly hostsClientMoves?: boolean;
		readonly hostsStoredSessions?: boolean;
		/** The client's intent redirected it to `sessionId`. */
		readonly onRedirected?: (sessionId: string) => void;
	};
	/**
	 * Runs once the client attached to its conversation, before the client's
	 * intents and queries run: a host that recovers the conversation's durable
	 * queued input starts it here, so the client's own input never overtakes
	 * it. A failure is the host's to report; the client is served regardless.
	 */
	readonly beforeServing?: (conversation: HostedConversation) => Promise<void> | void;
	/** What intents get beyond the local services: the host's workspace, push, and settings services. */
	readonly services?: (conversation: HostedConversation | undefined) => IntentServices;
	/** The connection's authority, checked before every frame in either direction. */
	readonly authority?: () => AuthorityLoss | undefined;
	/** Re-read the connection's authority from its store before a client frame acts; false is a revocation. */
	readonly revalidate?: () => Promise<boolean>;
	/** The host's own admission of an intent on `conversation`: a reason refuses it. */
	readonly admit?: (intent: string, conversation: HostedConversation) => RejectionReason | undefined;
	/** Which intents and queries the connection serves at all; every one by default. */
	readonly allows?: (kind: "intent" | "query", name: string) => boolean;
	/** Run relay intents and queries where their state lives (a TUI serving a relayed phone forwards them to the daemon). */
	readonly relay?: (frame: ControlRelayFrame) => Promise<ControlRelayOutcome>;
	/**
	 * Who the client is across its connections (a paired device's node id,
	 * the TUI process): its retried intents answer from its own outcome window,
	 * which spans the host's conversations, so an intent retried after the
	 * client reconnected to another conversation of the host answers as it did.
	 * The editor text a move leaves for it waits for whichever of its
	 * connections shows the target. Clients without one share a window per
	 * conversation.
	 */
	readonly clientKey?: string;
	/** An intent of this client that starts a run (a prompt, a dynamic intent) was accepted on `conversation`. */
	readonly onInputAccepted?: (conversation: HostedConversation) => void;
	/** The source of the `input` event the client's prompts raise; `rpc` by default. */
	readonly inputSource?: InputSource;
}

export interface ProtocolConnection {
	readonly id: string;
	/** The connection's client on the host: in-process callers act as this client (the TUI's own paths until Phase 6 ends). */
	readonly client: HostClient;
	/** Resolves once the client said hello and its conversation's extensions are bound; rejects when that fails. */
	readonly ready: Promise<void>;
	/** Settles once the connection ended; rejects with the failure that ended it. */
	readonly closed: Promise<void>;
	/** The conversation the client is on, if any. */
	readonly conversation: HostedConversation | undefined;
	/** Tell the client to refetch a catalog. */
	changed(catalog: CatalogName): void;
	/** End every subscription with `ended{shutdown}`, then the connection with `fatal{host_shutdown}`. */
	shutdown(message?: string): Promise<void>;
	/** End every subscription with `ended{closed}`, then the connection: the host stopped serving the conversation here. */
	end(): Promise<void>;
	/** End the connection; with a code, the client is told why first, and nothing follows. */
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

const outcomeWindows = new WeakMap<object, Map<string, IntentOutcomeWindow>>();

/**
 * The outcome window of one client of a conversation (or of a host, for
 * host-only connections): a client's retries answer from its own window, and
 * no client's intents evict another's.
 */
function outcomeWindow(scope: object, clientKey: string): IntentOutcomeWindow {
	let windows = outcomeWindows.get(scope);
	if (!windows) {
		windows = new Map();
		outcomeWindows.set(scope, windows);
	}
	let window = windows.get(clientKey);
	if (!window) {
		window = new IntentOutcomeWindow();
		windows.set(clientKey, window);
	}
	return window;
}

/** Where the editor text a client's move leaves reaches the client: one of its connections, once it shows the target. */
interface ClientEditorTexts {
	/** The client's connections: each with its host client id, and whether a subscription of it shows a conversation's live lane. */
	readonly connections: Set<{ readonly clientId: string; showsLive(conversation: HostedConversation): boolean }>;
	/** Editor text a move left for the conversation the client moved to, until a connection of the client shows it. */
	pending: { readonly conversation: string; readonly text: string } | undefined;
}

const editorTexts = new WeakMap<object, Map<string, ClientEditorTexts>>();

/** The editor texts of the client `key` of a host (or of a host-less connection). */
function clientEditorTexts(scope: object, key: string): ClientEditorTexts {
	let clients = editorTexts.get(scope);
	if (!clients) {
		clients = new Map();
		editorTexts.set(scope, clients);
	}
	let texts = clients.get(key);
	if (!texts) {
		texts = { connections: new Set(), pending: undefined };
		clients.set(key, texts);
	}
	return texts;
}

/** Forget the editor texts of the client `key` once it has no connection and no text waits for it. */
function releaseEditorTexts(scope: object, key: string): void {
	const clients = editorTexts.get(scope);
	const texts = clients?.get(key);
	if (texts && texts.connections.size === 0 && texts.pending === undefined) clients?.delete(key);
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

/** The rejection a failed admission or run answers with. */
export function rejectionReason(error: unknown): RejectionReason {
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

/** The query error a failed admission or run answers with. */
export function queryErrorReason(
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

/** A frame check: the frame's schema, then the byte budgets the schema annotates (identifiers are at most 256 bytes). */
interface FrameValidator {
	Check(value: unknown): boolean;
}

const validators = new Map<string, FrameValidator>();

/** A compiled frame check, cached by key. */
function validator(key: string, schema: () => TSchema): FrameValidator {
	let compiled = validators.get(key);
	if (!compiled) {
		const resolved = schema();
		const check = Compile(resolved);
		compiled = { Check: (value) => check.Check(value) && formatSchemaBoundError(resolved, value) === undefined };
		validators.set(key, compiled);
	}
	return compiled;
}

/** The envelope schema of an intent frame: its frame schema with the input left to the registry. */
function intentEnvelopeValidator(type: string): FrameValidator {
	if (isBuiltinIntentName(type)) {
		return validator(`intent:${type}`, () => {
			const frame: TObject = INTENT_FRAME_SCHEMAS[type];
			return Type.Object(
				{ ...frame.properties, input: Type.Optional(Type.Unknown()) },
				{ additionalProperties: false },
			);
		});
	}
	if (type.startsWith(EXTENSION_INTENT_PREFIX)) {
		return validator("intent:extension", () =>
			Type.Object(
				{ ...ExtensionIntentFrameSchema.properties, input: Type.Optional(Type.Unknown()) },
				{ additionalProperties: false },
			),
		);
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

/**
 * Whether intent `type` is fenced to the client's branch position. Extension
 * commands, prompt templates, and skills send prompts: fenced. Extension
 * intents run their handler: not fenced.
 */
function isBranchFenced(type: string): boolean {
	if (isBuiltinIntentName(type)) return intentRegistry.get(type).fence === "branch";
	return !type.startsWith(EXTENSION_INTENT_PREFIX);
}

/**
 * Queries that cost a read of the connection's budget nothing: small answers
 * from state the host holds, which a client asks as its user types or after
 * `changed`. Every other query takes one read.
 */
const FREE_QUERIES: ReadonlySet<string> = new Set([
	"intent_completions",
	"settings",
	"host_status",
	"web_search_status",
]);

/** Reading a closed log would cost more reads than the connection's budget still holds. */
class ReadsExhaustedError extends Error {
	constructor() {
		super("Too many reads requested");
		this.name = "ReadsExhaustedError";
	}
}

/** Snapshots, replays, and queries a connection may still request: a refilling bucket. */
class ReadBudget {
	private readonly burst: number;
	private readonly refillMs: number;
	private tokens: number;
	private refilledAt = Date.now();

	constructor(burst: number, refillMs: number) {
		this.burst = burst;
		this.refillMs = refillMs;
		this.tokens = burst;
	}

	/** Take `count` reads; false (taking none) when the budget holds fewer. */
	take(count = 1): boolean {
		if (this.refillMs > 0) {
			const now = Date.now();
			const refilled = Math.floor((now - this.refilledAt) / this.refillMs);
			if (refilled > 0) {
				this.tokens = Math.min(this.burst, this.tokens + refilled);
				this.refilledAt += refilled * this.refillMs;
			}
		}
		if (this.tokens < count) return false;
		this.tokens -= count;
		return true;
	}

	/** Milliseconds until the next read is available. */
	get retryAfterMs(): number {
		return Math.max(0, this.refillMs - (Date.now() - this.refilledAt));
	}
}

/** Serve one client on `transport` with `profile`, until the transport closes or the connection is closed. */
export function serveConnection(
	transport: RpcTransport,
	profile: Profile,
	options: ServeConnectionOptions,
): ProtocolConnection {
	const host = options.host;
	if (options.conversation && !host) throw new Error("A connection to a conversation needs its host");
	const connectionId = randomUUID();
	const redirectClient = options.redirect !== undefined;
	const anchor = options.anchor ?? !redirectClient;
	const server = options.server ?? { name: "volt", version: VERSION };
	const redactor = profile.redactor();
	/** The outcome window scope of a connection without a host. */
	const outcomeScope = {};
	/** Where the editor text a move leaves for the client waits: for whichever connection of a client the host knows shows the target. */
	const editorTextScope = host ?? outcomeScope;
	const editorTextKey = options.clientKey ?? connectionId;
	const reads = new ReadBudget(profile.limits.readBurst, profile.limits.readRefillMs);
	const subscriptions = new Map<string, Subscription>();
	const subscriptionUsage = new SubscriptionUsageService();
	let home = options.conversation;
	let accepts: ReadonlySet<HostRequestKind> = new Set();
	let helloReceived = false;
	let closing: Promise<void> | undefined;
	/** A fatal frame was written: nothing follows it. */
	let fatalWritten = false;
	let lane: Promise<void> = Promise.resolve();
	/** Stopping intents, and activity intents, each in order, beside the lane. */
	const besideLanes: Record<"stop" | "activity", Promise<void>> = {
		stop: Promise.resolve(),
		activity: Promise.resolve(),
	};
	/** Subscribe, unsubscribe, and answers, in order, each after the authority check. */
	let controlLane: Promise<void> = Promise.resolve();
	let pendingFrames = 0;
	/** Lane frames running; moves a structural intent makes end the old subscriptions once its outcome is written. */
	let laneBusy = false;
	const moves: Array<{ from: HostedConversation; to: string }> = [];
	const ready = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<void>();
	void ready.promise.catch(() => undefined);
	void closed.promise.catch(() => undefined);
	let attached: Promise<void> | undefined;
	/** The client left its conversation by a redirect: the conversation closes, or stays, by the move's rules. */
	let redirected = false;
	let detachInput: () => void = () => {};
	let detachClose: () => void = () => {};
	let unsubscribeHome: () => void = () => {};
	let stopObservingClose: () => void = () => {};
	const pendingWrites = new Set<Promise<void>>();

	const write = (frame: HostFrame): void => {
		if (fatalWritten) return;
		if (closing && frame.type !== "fatal" && frame.type !== "ended") return;
		if (frame.type !== "fatal") {
			const loss = options.authority?.();
			if (loss !== undefined) {
				void close({ code: loss });
				return;
			}
		}
		let redacted: HostFrame | undefined;
		try {
			redacted = redactor.redact(frame);
		} catch (error) {
			void fail(error);
			return;
		}
		if (!redacted) return;
		if (redacted.type === "fatal") fatalWritten = true;
		try {
			const result = transport.write(redacted);
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
			subscription.notice("error", `${error.event}: ${error.error}`, error.extensionId, error.stack);
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
				} else if (event.type === "session_info_changed") {
					write({ type: "changed", catalog: "sessions" });
				}
			},
			{ monitorGitContext: false },
		);
		const unsubscribeReloads = session.subscribeReloads(() => {
			write({ type: "changed", catalog: "intents" });
			write({ type: "changed", catalog: "extensions" });
			// Only local clients read the conversation's resources and tools.
			if (profile.name === "local") write({ type: "changed", catalog: "resources" });
		});
		// A client in the host's trust domain slows the agent loop to its pace. A
		// remote client never does: its transport bounds what it queues instead.
		const unsubscribeBackpressure =
			profile.limits.sendQueueBytes === undefined
				? session.subscribeRuntimeEvents(async () => {
						try {
							await drain();
						} catch (error) {
							void fail(error);
						}
					})
				: () => {};
		// Extension settings saved by any client, an extension, or another conversation.
		const unsubscribeExtensionSettings = session.settingsManager.subscribeExtensionSettings(() => {
			write({ type: "changed", catalog: "settings" });
		});
		unsubscribeHome = () => {
			unsubscribeEvents();
			unsubscribeReloads();
			unsubscribeBackpressure();
			unsubscribeExtensionSettings();
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
		for (const { from, to } of moves.splice(0)) {
			endSubscriptionsOn(from, { reason: "moved", target: to });
			// A redirect client reconnects to the target: its connection here is done.
			if (redirectClient) void close();
		}
	};

	const move: HostClientMove = redirectClient
		? {
				kind: "redirect",
				redirect: (sessionId) => {
					if (!home) return;
					redirected = true;
					options.redirect?.onRedirected?.(sessionId);
					moves.push({ from: home, to: sessionId });
					if (!laneBusy) flushMoves();
				},
				...(options.redirect?.hostTarget === undefined ? {} : { hostTarget: options.redirect.hostTarget }),
				...(options.redirect?.hostsClientMoves === undefined
					? {}
					: { hostsClientMoves: options.redirect.hostsClientMoves }),
				...(options.redirect?.hostsStoredSessions === undefined
					? {}
					: { hostsStoredSessions: options.redirect.hostsStoredSessions }),
			}
		: {
				kind: "in_place",
				prepare: (to) => {
					home = to;
				},
				onMoved: (to, from) => {
					observeLoss(to);
					observeHome(to);
					if (from) moves.push({ from, to: to.id });
					if (!laneBusy) flushMoves();
				},
			};

	const currentHost = (): ConversationHost => {
		if (!host) throw new Error("The connection has no conversation host");
		return host;
	};

	const currentHome = (): HostedConversation => {
		if (!home) throw new Error("The connection has no conversation");
		return home;
	};

	/** Whether the client edits input: a local client that answers `editor_text`. */
	const hasEditor = (): boolean => profile.name === "local" && accepts.has("editor_text");

	/** Whether a subscription of the client shows `conversation`'s live lane. */
	const showsLive = (conversation: HostedConversation): boolean =>
		[...subscriptions.values()].some(
			(subscription) =>
				subscription.conversation === conversation && subscription.receivesLive && !subscription.isEnded,
		);

	/**
	 * The theme an extension asked the local client's conversation to show
	 * before a subscription of the client showed its live lane (from its
	 * `session_start`, as the client attached): it reaches the client once one does.
	 */
	let pendingTheme: { readonly conversation: HostedConversation; readonly name: string } | undefined;

	/** The client's own view of its conversation's live state, before and beside its subscriptions. */
	const applyOwnLive = (update: LiveUpdate): void => {
		const conversation = home;
		if (profile.name !== "local" || !conversation || showsLive(conversation)) return;
		for (const item of update.items) {
			if (item.type === "directive" && item.directive === "set_theme")
				pendingTheme = { conversation, name: item.name };
		}
	};

	/**
	 * Replace the client's editor text with `text` once it shows the
	 * conversation `conversationId`: at once when a subscription shows it,
	 * else when the client subscribes there after its move, on this
	 * connection or, for a redirect client the host knows, the one it
	 * reconnects on.
	 */
	const setEditorTextOn = (conversationId: string, text: string): void => {
		const texts = clientEditorTexts(editorTextScope, editorTextKey);
		texts.pending = undefined;
		if (!hasEditor()) return;
		const conversation = host?.get(conversationId);
		const showing =
			conversation === undefined
				? undefined
				: [...texts.connections].find((connection) => connection.showsLive(conversation));
		if (conversation && showing) conversation.liveState.setEditorText(text, { client: showing.clientId });
		else texts.pending = { conversation: conversationId, text };
	};
	const editorTextReceiver = { clientId: connectionId, showsLive };
	clientEditorTexts(editorTextScope, editorTextKey).connections.add(editorTextReceiver);

	/** Put `text` in the client's editor when the draft it reports is empty. */
	const fillEmptyEditor = async (conversation: HostedConversation, text: string): Promise<void> => {
		if (!hasEditor() || !showsLive(conversation)) return;
		const draft = await conversation.liveState.request(
			{ kind: "editor_text", timeoutMs: EDITOR_TEXT_TIMEOUT_MS },
			{ client: client.id },
		);
		if (draft.status !== "answered" || !("value" in draft.response) || draft.response.value.trim()) return;
		conversation.liveState.setEditorText(text, { client: client.id });
	};

	/**
	 * The working directory a stored session that lost its own runs in
	 * instead: the current one, when the client confirms it; undefined when
	 * it declines. Only a local client is asked: the question names host
	 * paths. A session of a daemon-managed worktree whose checkout is gone
	 * never runs elsewhere, and a client that is not asked gets the error.
	 */
	const continueInCurrentCwd = async (error: MissingSessionCwdError): Promise<string | undefined> => {
		const conversation = currentHome();
		if (isPathUnderWorktreesRoot(conversation.services.agentDir, error.issue.sessionCwd)) {
			throw new Error(
				`This session ran in a daemon-managed worktree whose checkout is missing: ${error.issue.sessionCwd}. ` +
					"Recreate the worktree (volt remote worktree add) or remove the session; refusing to open it in another directory.",
			);
		}
		if (profile.name !== "local" || !accepts.has("confirm")) throw error;
		const outcome = await conversation.liveState.request(
			{ kind: "confirm", title: "Session cwd not found", message: formatMissingSessionCwdPrompt(error.issue) },
			{ client: client.id },
		);
		const confirmed = outcome.status === "answered" && "confirmed" in outcome.response && outcome.response.confirmed;
		return confirmed ? error.issue.fallbackCwd : undefined;
	};

	/**
	 * An extension's `ctx.abort()` in a command this client invoked: the
	 * queued input is taken back, the run stops, and the input's text returns
	 * to this client's editor, before the draft the client reports (pasted at
	 * its cursor when it reports none). Only a local client with an editor (it
	 * answers `editor_text`) that shows the conversation's live lane takes the
	 * queue back, and only for a call in its own scope; otherwise the run stops
	 * and the queue stays.
	 */
	const abortForCommand = async (): Promise<void> => {
		const conversation = home;
		if (!conversation || conversation.closed) return;
		const session = conversation.session;
		if (!hasEditor() || !showsLive(conversation) || ClientScope.current() !== client.id) {
			await session.abort();
			return;
		}
		let withdrawn: WithdrawnInput[] = [];
		try {
			withdrawn = await withdrawQueuedInput(session);
		} finally {
			void session.abort("host_action").catch(() => undefined);
		}
		const queued = withdrawn.map((input) => input.text).join("\n\n");
		if (!queued.trim()) return;
		const draft = await conversation.liveState.request(
			{ kind: "editor_text", timeoutMs: EDITOR_TEXT_TIMEOUT_MS },
			{ client: client.id },
		);
		if (draft.status !== "answered" || !("value" in draft.response)) {
			// No draft reported: paste the queue where the editor's cursor is rather than replace what it holds.
			conversation.liveState.insertEditorText(queued, { client: client.id });
			return;
		}
		const text = [queued, draft.response.value].filter((part) => part.trim()).join("\n\n");
		conversation.liveState.setEditorText(text, { client: client.id });
	};

	const client: HostClient = {
		id: connectionId,
		...(anchor ? { anchor: true } : {}),
		...(profile.name === "remote" ? { remote: true } : {}),
		recoversInput: true,
		// Keeps the client asked the host requests it accepts before it subscribes; each subscription shows them.
		live: { acceptsHostRequest: (kind) => accepts.has(kind), apply: applyOwnLive },
		surface: {
			commandContextActions: {
				waitForIdle: () => currentHome().session.waitForIdle(),
				// The moves an extension command starts for its client.
				newSession: (newSessionOptions) =>
					openNewSession(currentHost(), client, { ...newSessionOptions, origin: "extension" }),
				fork: async (entryId, forkOptions) => {
					const result = await openFork(currentHost(), client, entryId, { ...forkOptions, origin: "extension" });
					if (result.cancelled) return result;
					// The client's editor takes the text of the message the fork was taken before.
					setEditorTextOn(result.sessionId, result.selectedText ?? "");
					return { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const conversation = currentHome();
					const result = await conversation.session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					// Navigating to before a user message hands its text to an empty editor.
					if (!result.cancelled && result.editorText) await fillEmptyEditor(conversation, result.editorText);
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionRef, switchOptions) => {
					try {
						return await openStoredSession(currentHost(), client, sessionRef, {
							...switchOptions,
							origin: "extension",
						});
					} catch (error) {
						if (!(error instanceof MissingSessionCwdError)) throw error;
						const cwdOverride = await continueInCurrentCwd(error);
						if (cwdOverride === undefined) return { cancelled: true };
						return openStoredSession(currentHost(), client, sessionRef, {
							...switchOptions,
							cwdOverride,
							origin: "extension",
						});
					}
				},
				reload: () => currentHome().session.reload(),
			},
			abortHandler: () => void abortForCommand().catch(() => undefined),
			shutdownHandler: () => options.onShutdownRequested?.(),
			onError: onExtensionError,
		},
		move,
	};

	/** The conversation an intent or subscription names: the client's own, or another the profile may target. */
	const resolveTarget = (id: string | undefined): HostedConversation | undefined => {
		if (!home) return undefined;
		if (id === undefined || id === home.id) return home;
		const conversation = host?.get(id);
		return conversation && profile.conversations(id) ? conversation : undefined;
	};

	/** A remote client never reads a local-only child, or what it links. */
	const observer = { remote: profile.name !== "local" };

	/**
	 * A child a client may read but not act on: an open conversation the
	 * client's conversation links by its work (a subagent's child, a review's
	 * pass), directly or through linked children, when the profile admits
	 * children of it. A remote client never reads a local-only child.
	 */
	const resolveChild = (id: string): HostedConversation | undefined => {
		if (!home || !profile.conversations(id, home.id)) return undefined;
		return linkedChildConversation(home, id, observer);
	};

	/** Links to closed children found from the client's conversation, by that conversation and the child. */
	const closedLinks = new Map<string, ClosedChildLink>();
	/** Snapshot tails of the closed logs read last, by conversation: a read of one again charges as much before it loads. */
	const closedPages = new Map<string, number>();
	/** Open children whose close ends their subscriptions here. */
	const watchedChildren = new WeakSet<HostedConversation>();

	/**
	 * A closed child's log, read-only, charged as a replay that long: one read
	 * per snapshot tail of entries it holds, one of them (or as many as it held
	 * when this connection read it last) before it loads, the rest after.
	 * Undefined when the log cannot be read, or is not the subagent
	 * conversation of the conversation whose work links it. Throws
	 * {@link ReadsExhaustedError} when the budget does not cover it.
	 */
	const readClosedLog = async (link: ClosedChildLink): Promise<SessionManager | undefined> => {
		// A log read before charges what it held then before it loads again: a log too long to read is not reloaded.
		const charged = closedPages.get(link.conversation) ?? 1;
		if (!reads.take(charged)) throw new ReadsExhaustedError();
		let manager: SessionManager;
		try {
			manager = await SessionManager.openReadOnly(link.ref);
		} catch {
			return undefined;
		}
		let kept = false;
		try {
			const pages = Math.max(1, Math.ceil(manager.getOrdinal() / profile.limits.snapshotTail));
			closedPages.delete(link.conversation);
			closedPages.set(link.conversation, pages);
			for (const oldest of closedPages.keys()) {
				if (closedPages.size <= MAX_CLOSED_LINKS) break;
				closedPages.delete(oldest);
			}
			if (!reads.take(Math.max(0, pages - charged))) throw new ReadsExhaustedError();
			const header = manager.getHeader();
			kept =
				header?.origin === "subagent" &&
				header.parentSession?.sessionId === link.parent &&
				manager.getSessionId() === link.conversation;
			return kept ? manager : undefined;
		} finally {
			if (!kept) await manager.closePersistence().catch(() => undefined);
		}
	};

	/**
	 * A closed child a client may read: its conversation is not open, but work
	 * that the client's conversation links at any depth records its log. The
	 * search reads closed children's logs as {@link readClosedLog} does; a
	 * link found is remembered, since a log's links never change.
	 */
	const resolveClosedChild = async (id: string): Promise<ClosedChildLink | undefined> => {
		if (!home || !profile.conversations(id, home.id)) return undefined;
		const key = `${home.id}\u0000${id}`;
		const remembered = closedLinks.get(key);
		if (remembered) return remembered;
		const link = await findClosedDescendant(home, id, readClosedLog, observer);
		if (!link) return undefined;
		closedLinks.set(key, link);
		for (const oldest of closedLinks.keys()) {
			if (closedLinks.size <= MAX_CLOSED_LINKS) break;
			closedLinks.delete(oldest);
		}
		return link;
	};

	/** A conversation a client may subscribe to or read: a target, or a linked child. */
	const resolveReadable = (id: string | undefined): HostedConversation | undefined => {
		const target = resolveTarget(id);
		if (target || id === undefined) return target;
		return resolveChild(id);
	};

	const intentServices = (conversation: HostedConversation | undefined): IntentServices => ({
		...(conversation === undefined ? {} : createLocalIntentServices(conversation, { subscriptionUsage })),
		...options.services?.(conversation),
	});

	const intentContext = (conversation: HostedConversation | undefined, intentId?: string): IntentContext => ({
		...(conversation === undefined || host === undefined
			? {}
			: { target: { session: conversation.session, conversation, host, client } }),
		services: intentServices(conversation),
		profile: profile.intents,
		subscriber: profile,
		...(intentId === undefined ? {} : { intentId }),
		...(options.inputSource === undefined ? {} : { inputSource: options.inputSource }),
	});

	/** Re-read the connection's authority; a lost one ends the connection. */
	const stillAuthorized = async (): Promise<boolean> => {
		const loss = options.authority?.();
		if (loss !== undefined) {
			await close({ code: loss });
			return false;
		}
		if (!options.revalidate) return true;
		let current = false;
		try {
			current = await options.revalidate();
		} catch {
			current = false;
		}
		if (!current) await close({ code: "revoked", message: "The device's access changed; reconnect" });
		return current && !closing;
	};

	const relayed = async (frame: ControlRelayFrame): Promise<void> => {
		const relay = options.relay;
		if (!relay) return;
		let outcome: ControlRelayOutcome;
		try {
			outcome = await relay(frame);
		} catch (error) {
			outcome =
				frame.type === "query"
					? {
							type: "query_error",
							queryId: frame.queryId,
							reason: { code: "unavailable", message: errorMessage(error) },
						}
					: {
							type: "rejected",
							intentId: frame.intentId,
							reason: { code: "unavailable", message: errorMessage(error) },
						};
		}
		write(outcome);
		if (outcome.type !== "accepted") return;
		if (HOST_INTENTS.has(frame.type)) write({ type: "changed", catalog: "host" });
		const ending = ENDING_INTENTS.get(frame.type);
		// Nothing the client pipelined after the intent is served.
		if (ending !== undefined) void close({ code: ending });
	};

	const runIntent = async (frame: IntentEnvelope): Promise<void> => {
		const reject = (reason: RejectionReason): void => {
			write({ type: "rejected", intentId: frame.intentId, reason });
		};
		if (!(await stillAuthorized())) return;
		if (options.allows && !options.allows("intent", frame.type)) {
			reject({ code: "unavailable", message: `${frame.type} is not available on this stream` });
			return;
		}
		const type = frame.type;
		if (options.relay && RELAY_INTENTS.has(type) && isBuiltinIntentName(type)) {
			const schema: TSchema = INTENT_FRAME_SCHEMAS[type];
			const relayFrame: unknown = frame;
			if (!validator(`relay:${type}`, () => schema).Check(relayFrame)) {
				reject({ code: "invalid_input", message: `Invalid ${type} input` });
				return;
			}
			// The host's admission covers relayed intents too: a subagent conversation's client only stops it.
			const refused = home === undefined ? undefined : options.admit?.(type, home);
			if (refused) {
				reject(refused);
				return;
			}
			await relayed(frame as unknown as ControlRelayFrame);
			return;
		}
		const conversation = home === undefined ? undefined : resolveTarget(frame.conversation);
		if (frame.conversation !== undefined && !conversation) {
			if (resolveChild(frame.conversation)) {
				reject({ code: "read_only", message: "Child conversations are observe-only" });
				return;
			}
			reject({ code: "ended", message: `Conversation ${frame.conversation} is not open` });
			return;
		}
		if (conversation?.closed) {
			reject({ code: "ended", message: `Conversation ${conversation.id} is not open` });
			return;
		}
		if (conversation && conversation !== home && STRUCTURAL_INTENTS.has(frame.type)) {
			reject({ code: "unavailable", message: `${frame.type} acts on the conversation the client is on` });
			return;
		}
		if (profile.name === "remote" && frame.expectedOrdinal === undefined && isBranchFenced(frame.type)) {
			reject({ code: "invalid_input", message: `${frame.type} needs the client's expectedOrdinal` });
			return;
		}
		if (conversation) {
			const refused = options.admit?.(frame.type, conversation);
			if (refused) {
				reject(refused);
				return;
			}
		}
		const input = INPUT_INTENTS.has(frame.type);
		const windowScope =
			options.clientKey === undefined ? (conversation ?? host ?? outcomeScope) : (host ?? outcomeScope);
		const window = input ? undefined : outcomeWindow(windowScope, options.clientKey ?? "");
		const fingerprint = JSON.stringify([frame.type, frame.input ?? null, frame.expectedOrdinal ?? null]);
		const remembered = window?.get(frame.intentId);
		if (remembered) {
			if (remembered.fingerprint !== fingerprint) {
				reject({ code: "conflict", message: `Intent id ${frame.intentId} was used for another intent` });
				return;
			}
			// A dynamic intent answers once admitted, without holding later frames, retried or not.
			if (!isBuiltinIntentName(frame.type)) void remembered.outcome.then(write);
			else write(await remembered.outcome);
			return;
		}
		const outcome = Promise.withResolvers<IntentOutcomeFrame>();
		const settle = (result: IntentOutcomeFrame): void => {
			write(result);
			outcome.resolve(result);
			if (result.type !== "accepted") return;
			const ending = ENDING_INTENTS.get(frame.type);
			if (ending !== undefined) {
				// Nothing the client pipelined after the intent is served.
				void close({ code: ending });
				return;
			}
			if (SETTINGS_INTENTS.has(frame.type)) write({ type: "changed", catalog: "settings" });
			if (MODELS_INTENTS.has(frame.type)) write({ type: "changed", catalog: "models" });
			if (HOST_INTENTS.has(frame.type)) write({ type: "changed", catalog: "host" });
			if (result.conversation !== undefined || SESSIONS_INTENTS.has(frame.type)) {
				write({ type: "changed", catalog: "sessions" });
			}
			// Prompts and dynamic intents (prompt templates, skills, extension commands) start runs.
			if ((input || !isBuiltinIntentName(frame.type)) && conversation) options.onInputAccepted?.(conversation);
		};
		const rejected = (error: unknown): IntentOutcomeFrame => ({
			type: "rejected",
			intentId: frame.intentId,
			reason: rejectionReason(error),
		});
		let prepared: ReturnType<typeof intentRegistry.prepareFrame>;
		try {
			prepared = ClientScope.run(client.id, () =>
				intentRegistry.prepareFrame(intentContext(conversation, frame.intentId), frame.type, frame.input, {
					...(frame.expectedOrdinal === undefined ? {} : { expectedOrdinal: frame.expectedOrdinal }),
				}),
			);
		} catch (error) {
			// A refusal is not remembered: a retry is admitted afresh.
			settle(rejected(error));
			return;
		}
		window?.set(frame.intentId, fingerprint, outcome.promise);
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
				settle(result);
				if (!laneBusy) flushMoves();
			});
			return;
		}
		settle(await run);
	};

	const runQuery = async (frame: QueryEnvelope): Promise<void> => {
		const refuse = (code: QueryErrorCode, message: string, retryAfterMs?: number): void => {
			write({
				type: "query_error",
				queryId: frame.queryId,
				reason: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
			});
		};
		if (!(await stillAuthorized())) return;
		if (options.allows && !options.allows("query", frame.query)) {
			refuse("unavailable", `${frame.query} is not available on this stream`);
			return;
		}
		if (!FREE_QUERIES.has(frame.query) && !reads.take()) {
			refuse("unavailable", `Too many ${frame.query} reads; retry later`, Math.min(30_000, reads.retryAfterMs));
			return;
		}
		if (options.relay && RELAY_QUERIES.has(frame.query)) {
			const schema = (QUERY_FRAME_SCHEMAS as Record<string, TSchema>)[frame.query];
			if (!schema || !validator(`query:${frame.query}`, () => schema).Check(frame)) {
				refuse("invalid_input", `Invalid ${frame.query} parameters`);
				return;
			}
			await relayed(frame as unknown as ControlRelayFrame);
			return;
		}
		const conversation = home === undefined ? undefined : resolveReadable(frame.conversation);
		if (frame.conversation !== undefined && !conversation && home !== undefined) {
			await runClosedQuery(frame, frame.conversation, refuse);
			return;
		}
		if ((frame.conversation !== undefined && !conversation) || conversation?.closed) {
			refuse("unavailable", `Conversation ${frame.conversation ?? home?.id} is not open`);
			return;
		}
		try {
			const data = await ClientScope.run(client.id, () =>
				queryRegistry.runFrame(intentContext(conversation), frame.query, frame.params),
			);
			write({ type: "result", queryId: frame.queryId, data });
		} catch (error) {
			write({ type: "query_error", queryId: frame.queryId, reason: queryErrorReason(error) });
		}
	};

	/**
	 * A query of a conversation that is not open: the queries that read logs
	 * (`history`, `content`, `work_output`) read a closed child's log, charged
	 * as reading it costs; every other query, or any other conversation, is
	 * refused as not open.
	 */
	const runClosedQuery = async (
		frame: QueryEnvelope,
		id: string,
		refuse: (code: QueryErrorCode, message: string, retryAfterMs?: number) => void,
	): Promise<void> => {
		const notOpen = (): void => refuse("unavailable", `Conversation ${id} is not open`);
		if (!queryRegistry.has(frame.query)) {
			refuse("unknown_query", `Unknown query: ${frame.query}`);
			return;
		}
		if (!queryRegistry.readsClosedLogs(frame.query)) {
			notOpen();
			return;
		}
		// A query the profile refuses, or with invalid parameters, reads nothing.
		try {
			queryRegistry.admit({ profile: profile.intents }, frame.query, frame.params);
		} catch (error) {
			write({ type: "query_error", queryId: frame.queryId, reason: queryErrorReason(error) });
			return;
		}
		let log: SessionManager | undefined;
		try {
			const link = await resolveClosedChild(id);
			log = link === undefined ? undefined : await readClosedLog(link);
		} catch (error) {
			if (error instanceof ReadsExhaustedError) {
				refuse("unavailable", `Too many ${frame.query} reads; retry later`, Math.min(30_000, reads.retryAfterMs));
			} else notOpen();
			return;
		}
		if (!log) {
			notOpen();
			return;
		}
		const closedLog = log;
		try {
			const data = await ClientScope.run(client.id, () =>
				queryRegistry.runFrame({ ...intentContext(undefined), closedLog }, frame.query, frame.params),
			);
			write({ type: "result", queryId: frame.queryId, data });
		} catch (error) {
			write({ type: "query_error", queryId: frame.queryId, reason: queryErrorReason(error) });
		} finally {
			await closedLog.closePersistence().catch(() => undefined);
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

	/**
	 * Run a stopping intent in the stop lane, or an activity intent in the
	 * activity lane, once the client is attached: beside the intent and query
	 * lane, so it never waits behind a long intent nor holds the frames after
	 * it, and one at a time in arrival order within its lane, so stops re-read
	 * the connection's authority one at a time. It counts toward the pending
	 * frames as a lane frame does.
	 */
	const enqueueBeside = (lane: "stop" | "activity", task: () => Promise<void>): void => {
		if (pendingFrames >= MAX_PENDING_FRAMES) {
			void close({ code: "invalid_frame", message: `More than ${MAX_PENDING_FRAMES} frames are pending` });
			return;
		}
		pendingFrames++;
		besideLanes[lane] = besideLanes[lane].then(async () => {
			try {
				await attached;
				if (closing) return;
				await task();
			} catch {
				// Each frame answers its own failure.
			} finally {
				pendingFrames--;
			}
		});
	};

	/** Run a subscription change or an answer in order, once the connection's authority is re-read. */
	const enqueueControl = (task: () => void | Promise<void>): void => {
		if (pendingFrames >= MAX_PENDING_FRAMES) {
			void close({ code: "invalid_frame", message: `More than ${MAX_PENDING_FRAMES} frames are pending` });
			return;
		}
		pendingFrames++;
		controlLane = controlLane.then(async () => {
			try {
				if (closing || !(await stillAuthorized())) return;
				await task();
			} catch {
				// Each frame answers its own failure.
			} finally {
				pendingFrames--;
			}
		});
	};

	const answer = (requestId: string, sent: HostResponse): void => {
		const response = redactor.response(requestId, sent);
		const candidates = new Map<HostedConversation, string>();
		if (home && host?.conversationOf(client) === home) candidates.set(home, client.id);
		for (const subscription of subscriptions.values()) {
			// A child is observe-only: its requests are not the client's to answer.
			if (resolveTarget(subscription.conversation.id) !== subscription.conversation) continue;
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

	/**
	 * A closed child, read-only: its log as a snapshot from its last position,
	 * then `ended{closed}`. A read the connection's budget does not cover ends
	 * the connection, as too many subscriptions do.
	 */
	const subscribeClosedChild = async (frame: Static<typeof SubscribeFrameSchema>): Promise<void> => {
		const ended = () => write({ type: "ended", subscriptionId: frame.subscriptionId, reason: "closed" });
		let log: SessionManager | undefined;
		try {
			const link = await resolveClosedChild(frame.conversation);
			log = link === undefined ? undefined : await readClosedLog(link);
		} catch (error) {
			if (error instanceof ReadsExhaustedError) {
				void close({ code: "invalid_frame", message: "Too many subscriptions requested" });
				return;
			}
			log = undefined;
		}
		if (log) {
			try {
				if (closing) return;
				const ordinal = log.getOrdinal();
				write({
					type: "snapshot",
					subscriptionId: frame.subscriptionId,
					conversation: log.getSessionId(),
					ordinal,
					state: logSnapshot(log, profile, ordinal),
				});
			} catch {
				// A log that cannot be read ends the subscription like one that does not exist.
			} finally {
				await log.closePersistence().catch(() => undefined);
			}
		}
		ended();
	};

	const subscribe = (frame: Static<typeof SubscribeFrameSchema>): void | Promise<void> => {
		if (subscriptions.has(frame.subscriptionId)) {
			void close({ code: "invalid_frame", message: `Subscription ${frame.subscriptionId} is already active` });
			return;
		}
		if (subscriptions.size >= profile.limits.subscriptions) {
			void close({ code: "invalid_frame", message: `More than ${profile.limits.subscriptions} subscriptions` });
			return;
		}
		const target = resolveTarget(frame.conversation);
		const conversation = target ?? resolveChild(frame.conversation);
		if (!conversation || conversation.closed) {
			if (conversation === undefined && home !== undefined) return subscribeClosedChild(frame);
			write({ type: "ended", subscriptionId: frame.subscriptionId, reason: "closed" });
			return;
		}
		if (!reads.take(subscriptionReads(conversation, profile, frame.after))) {
			void close({ code: "invalid_frame", message: "Too many subscriptions requested" });
			return;
		}
		const subscription = new Subscription({
			subscriptionId: frame.subscriptionId,
			liveClientId: `${connectionId}:${frame.subscriptionId}`,
			liveOwner: connectionId,
			conversation,
			profile,
			sink,
			live: frame.live ?? true,
			// A child's host requests never wait for an observer: they resolve as if no client were there.
			accepts: (kind) => target !== undefined && accepts.has(kind),
		});
		subscriptions.set(frame.subscriptionId, subscription);
		void conversation.lost.then(() => {
			if (subscriptions.get(frame.subscriptionId) !== subscription) return;
			subscriptions.delete(frame.subscriptionId);
			subscription.end({ reason: "lost" });
		});
		// A child is not the host's: its subscriptions end when it closes, such as a review's pass once it ran.
		if (!target && !watchedChildren.has(conversation)) {
			watchedChildren.add(conversation);
			void conversation.whenClosed().then(() => endSubscriptionsOn(conversation, { reason: "closed" }));
		}
		try {
			subscription.start(frame.after);
		} catch {
			subscriptions.delete(frame.subscriptionId);
			subscription.end({ reason: "closed" });
			return;
		}
		// The editor text the client's move left for the conversation it moved to.
		const texts = clientEditorTexts(editorTextScope, editorTextKey);
		const editorText = texts.pending;
		if (editorText?.conversation === conversation.id && target !== undefined && subscription.receivesLive) {
			texts.pending = undefined;
			conversation.liveState.setEditorText(editorText.text, { client: client.id });
		}
		// The theme an extension asked for before the client subscribed.
		const theme = pendingTheme;
		if (theme?.conversation === conversation && subscription.receivesLive) {
			pendingTheme = undefined;
			conversation.liveState.setTheme(theme.name, { client: client.id });
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
		let joined: Promise<void>;
		if (home && host) {
			observeHome(home);
			// The live view attaches synchronously, so a dialog an extension asks from session_start waits for the client.
			joined = host.attach(client, home);
		} else {
			joined = Promise.resolve();
		}
		joined.then(
			() => ready.resolve(),
			(error: unknown) => {
				ready.reject(error);
				void fail(error);
			},
		);
		const beforeServing = options.beforeServing;
		const served = home;
		attached =
			beforeServing === undefined || served === undefined
				? joined
				: joined.then(async () => {
						try {
							await beforeServing(served);
						} catch {
							// The host reports what it could not do; the client is served regardless.
						}
					});
		write({
			type: "welcome",
			protocol: PROTOCOL_VERSION,
			connectionId,
			profile: profile.name,
			server: { name: server.name, version: server.version },
			...(home === undefined ? {} : { conversation: home.id }),
		});
	};

	const receive = (value: unknown): void => {
		if (closing) return;
		const loss = options.authority?.();
		if (loss !== undefined) {
			void close({ code: loss });
			return;
		}
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
			case "subscribe": {
				if (!validator("subscribe", () => SubscribeFrameSchema).Check(value)) break;
				const frame = value as Static<typeof SubscribeFrameSchema>;
				enqueueControl(() => subscribe(frame));
				return;
			}
			case "unsubscribe": {
				if (!validator("unsubscribe", () => UnsubscribeFrameSchema).Check(value)) break;
				const subscriptionId = (value as Static<typeof UnsubscribeFrameSchema>).subscriptionId;
				enqueueControl(() => {
					const subscription = subscriptions.get(subscriptionId);
					subscriptions.delete(subscriptionId);
					if (subscription) subscription.end({ reason: "unsubscribed" });
					else write({ type: "ended", subscriptionId, reason: "unsubscribed" });
				});
				return;
			}
			case "host_response": {
				if (!validator("host_response", () => HostResponseFrameSchema).Check(value)) break;
				const frame = value as Static<typeof HostResponseFrameSchema>;
				enqueueControl(() => answer(frame.requestId, frame.response));
				return;
			}
			case "query":
				if (!validator("query", () => QueryEnvelopeSchema).Check(value)) break;
				enqueue(() => runQuery(value as unknown as QueryEnvelope));
				return;
			default:
				if (RESERVED.has(type) || !intentEnvelopeValidator(type).Check(value)) break;
				if (STOPPING_INTENTS.has(type)) enqueueBeside("stop", () => runIntent(value as unknown as IntentEnvelope));
				else if (ACTIVITY_INTENTS.has(type)) {
					enqueueBeside("activity", () => runIntent(value as unknown as IntentEnvelope));
				} else enqueue(() => runIntent(value as unknown as IntentEnvelope));
				return;
		}
		void close({ code: "invalid_frame", message: `Invalid ${type} frame` });
	};

	/**
	 * Leave the host once: a client that never attached still closes an
	 * anchored conversation, and one its redirect moved away closed or kept it
	 * by the move's rules.
	 */
	let left: Promise<void> | undefined;
	const leaveHost = (): Promise<void> => {
		left ??= (async () => {
			stopObservingClose();
			unsubscribeHome();
			const texts = clientEditorTexts(editorTextScope, editorTextKey);
			texts.connections.delete(editorTextReceiver);
			if (options.clientKey === undefined) texts.pending = undefined;
			releaseEditorTexts(editorTextScope, editorTextKey);
			if (!host) return;
			if (host.conversationOf(client) !== undefined) await host.detach(client);
			else if (anchor && !redirected && home && !home.closed) await host.close(home);
		})();
		return left;
	};

	const finish = async (failure?: { error: unknown }): Promise<void> => {
		detachInput();
		detachClose();
		for (const subscription of subscriptions.values()) subscription.dispose();
		subscriptions.clear();
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

	if (home) observeLoss(home);
	stopObservingClose =
		host?.onClosed((conversation) => {
			// A conversation the client moved away from ends its subscriptions as moved.
			if (moves.some((pending) => pending.from === conversation)) return;
			endSubscriptionsOn(conversation, { reason: "closed" });
			// A redirect client leaves when its conversation closes: it reconnects to wherever the conversation opens.
			if (redirectClient && conversation === home) void close();
		}) ?? (() => {});

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
	detachClose =
		transport.onClose?.((error) => {
			if (error instanceof RpcFrameTooLargeError) {
				void close({ code: "frame_too_large", message: error.message });
				return;
			}
			void (error ? fail(error) : close());
		}) ?? (() => {});

	return {
		id: connectionId,
		client,
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
		async end() {
			if (closing) return closing;
			for (const [id, subscription] of [...subscriptions]) {
				subscriptions.delete(id);
				subscription.end({ reason: "closed" });
			}
			return close();
		},
		close,
	};
}
