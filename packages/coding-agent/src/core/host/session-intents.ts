/**
 * A client's structural intents: new session, switch, fork, clone, and
 * import. Each opens another conversation through the client's host and moves
 * the client there, in place or by redirect (see `HostClientMove`). An intent
 * runs against the conversation the client is on when it is requested; one
 * that waited while the client moved, or while that conversation's branch
 * changed, fails as stale. Owner-lifetime conversations (subagents) and review
 * finding discussions reject them.
 */

import { resolvePath } from "../../utils/paths.ts";
import type { ProjectTrustContext, ReplacedSessionContext, SessionIntentResult } from "../extensions/index.ts";
import { PR_CHECKOUT_CHANGED, readPrReviewBinding } from "../pr-review-binding.ts";
import {
	hostReviewSourceWriter,
	prepareReviewGeneralReplacement,
	type ReviewSourceWriter,
	registerReviewHandoffAliases,
} from "../review-links.ts";
import { listReviewRuns } from "../review-state.ts";
import {
	assertValidSessionId,
	findSessionInfoById,
	getDefaultSessionDir,
	type SessionInfo,
	SessionManager,
	type SessionReference,
} from "../session-manager.ts";
import type { LogWriter } from "../session-writer.ts";
import { type ConversationHost, PinnedConversationError } from "./conversation-host.ts";
import type { HostedConversation } from "./hosted-conversation.ts";
import { sameFilesystemLocation } from "./session-summaries.ts";
import type { ConversationTarget, HostClient, HostedRedirect } from "./targets.ts";

export interface SwitchSessionIntentOptions {
	/** Run in this cwd instead of the stored one ("continue in current cwd"); the store keeps the original. */
	cwdOverride?: string;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	/** A caller's own lease on the conversation, revalidated wherever the intent checks it is current. */
	assertConversationGenerationCurrent?: () => void;
}

export interface NewSessionIntentOptions {
	parentSessionRef?: SessionReference;
	preserveReviewRunId?: string;
	replaceReviewGeneral?: boolean;
	/** Writes a review run's source log for `replaceReviewGeneral`; by default through this host or by opening it. */
	reviewSourceWriter?: ReviewSourceWriter;
	/** Override the new session's cwd (e.g. a daemon-managed worktree checkout). */
	cwd?: string;
	/** Override the session dir (e.g. the parent workspace's default dir for worktree sessions). */
	sessionDir?: string;
	/** Host-owned workspace display name for the new session's Git context. */
	workspaceName?: string;
	/** Trusted managed-worktree base ref for the new session's Git context. */
	baseRef?: string;
	/** Write the new session before it opens, through its log writer. */
	setup?: (writer: LogWriter) => Promise<void>;
	/**
	 * Runs once the new session opened, before the client leaves the current
	 * one, which is still open and admits no new work: a handoff writes its
	 * acknowledgement through the source's own writer here. A failure keeps the
	 * client on the current session and discards the new one.
	 */
	beforeMove?: (source: HostedConversation) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	/** A caller's own lease on the conversation, revalidated wherever the intent checks it is current. */
	assertConversationGenerationCurrent?: () => void;
}

export type ForkIntentResult =
	| { readonly cancelled: true }
	| {
			readonly cancelled: false;
			readonly sessionId: string;
			readonly seeded: boolean;
			readonly selectedText?: string;
	  };

interface IntentSource {
	readonly conversation: HostedConversation;
	readonly assertCurrent: () => void;
}

/** The conversation an intent leaves, and a check that the client is still there on the same branch. */
function intentSource(
	host: ConversationHost,
	client: HostClient,
	assertConversationGenerationCurrent?: () => void,
): IntentSource {
	const conversation = host.conversationOf(client);
	if (!conversation) throw new Error("The client is not attached to a conversation");
	if (conversation.session.isReviewDiscussion) {
		throw new Error("Finding discussion identity is source-linked; reset context from the source review");
	}
	if (conversation.lifetime === "owner") throw new PinnedConversationError();
	// A client that moves in place may not leave a busy conversation; the host checks again before it opens anything.
	if (client.move.kind === "in_place") conversation.assertNotBusy();
	const generation = conversation.session.conversationGenerationRevision;
	return {
		conversation,
		assertCurrent: () => {
			assertConversationGenerationCurrent?.();
			if (
				host.conversationOf(client) !== conversation ||
				conversation.session.conversationGenerationRevision !== generation
			) {
				throw new Error("Stale session change: the client's conversation changed since it was requested");
			}
		},
	};
}

interface MoveOptions {
	projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
	beforeMove?: (source: HostedConversation) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	/** The last durable step, with the target's log, after the move and `withSession`. */
	publish?: (target: SessionManager) => Promise<void>;
}

/**
 * Open `target` from `source` and move the client there: in place, or, for a
 * client that follows moves by redirect, by opening the target where the
 * client's `hostTarget` takes it over, or by writing its log for the host the
 * client reconnects through. A redirected client's `withSession` never runs.
 */
async function moveClient(
	host: ConversationHost,
	client: HostClient,
	source: IntentSource,
	target: Exclude<ConversationTarget, { kind: "adopt" }>,
	options: MoveOptions = {},
): Promise<ForkIntentResult> {
	const { beforeMove, publish } = options;
	const move = client.move;
	if (move.kind === "in_place") {
		const moved = await host.openFor(client, target, {
			assertCurrent: source.assertCurrent,
			...(options.projectTrustContextFactory ? { projectTrustContext: options.projectTrustContextFactory } : {}),
			...(beforeMove === undefined
				? {}
				: {
						beforeMove: async (from: HostedConversation | undefined) => {
							if (from) await beforeMove(from);
						},
					}),
			...(options.withSession === undefined ? {} : { withSession: options.withSession }),
			...(publish === undefined
				? {}
				: {
						publish: async (to: HostedConversation) => {
							// The publication names the exact conversation and branch the client is on.
							const generation = to.session.conversationGenerationRevision;
							const assertPublicationCurrent = (boundary: "before" | "during"): void => {
								if (
									host.conversationOf(client) !== to ||
									to.session.conversationGenerationRevision !== generation
								) {
									throw new Error(`The session changed ${boundary} its durable publication`);
								}
							};
							assertPublicationCurrent("before");
							await publish(to.session.sessionManager);
							assertPublicationCurrent("during");
						},
					}),
		});
		if (moved.cancelled) return moved;
		return {
			cancelled: false,
			sessionId: moved.sessionId,
			seeded: moved.seeded,
			...(moved.selectedText === undefined ? {} : { selectedText: moved.selectedText }),
		};
	}
	const hostTarget = move.hostTarget;
	if (hostTarget && target.kind !== "session") {
		const opened = await host.openFor(client, target, {
			assertCurrent: source.assertCurrent,
			beforeMove: async (from, to) => {
				// The target closes without its extensions having started.
				const discard = () => host.discard(to).catch(() => undefined);
				let hosted: HostedRedirect;
				try {
					hosted = await hostTarget({ sessionId: to.id, conversation: to });
				} catch (error) {
					await discard();
					throw error;
				}
				// What can fail is prepared before anything is written through the source.
				try {
					source.assertCurrent();
					if (from) await beforeMove?.(from);
					await publish?.(to.session.sessionManager);
				} catch (error) {
					await hosted.abort().catch(() => undefined);
					await discard();
					throw error;
				}
				try {
					await hosted.commit();
				} catch (error) {
					await discard();
					throw error;
				}
			},
		});
		if (opened.cancelled) return opened;
		return {
			cancelled: false,
			sessionId: opened.sessionId,
			seeded: false,
			...(opened.selectedText === undefined ? {} : { selectedText: opened.selectedText }),
		};
	}
	const redirected = await host.redirectFor(client, target, {
		beforeMove: async (from) => {
			source.assertCurrent();
			const hosted =
				hostTarget && target.kind === "session" ? await hostTarget({ sessionId: target.ref.sessionId }) : undefined;
			try {
				await beforeMove?.(from);
			} catch (error) {
				await hosted?.abort().catch(() => undefined);
				throw error;
			}
			await hosted?.commit();
		},
		...(publish === undefined ? {} : { publish }),
	});
	if (redirected.cancelled) return redirected;
	return {
		cancelled: false,
		sessionId: redirected.sessionId,
		seeded: false,
		...(redirected.selectedText === undefined ? {} : { selectedText: redirected.selectedText }),
	};
}

function toIntentResult(result: ForkIntentResult): SessionIntentResult {
	return result.cancelled ? result : { cancelled: false, sessionId: result.sessionId, seeded: result.seeded };
}

function sessionRefsEqual(left: SessionReference, right: SessionReference): boolean {
	return (
		resolvePath(left.sessionDirectory) === resolvePath(right.sessionDirectory) &&
		left.storeId === right.storeId &&
		left.sessionId === right.sessionId &&
		left.sessionGeneration === right.sessionGeneration
	);
}

/**
 * Resume a stored session. A cwd override lives only in memory; the store
 * keeps the original, possibly missing, cwd. The session opens for writing,
 * taking its lock while the source still holds its own; locks never wait, so
 * holding both cannot deadlock. A switch to the current session moves nothing
 * and never runs `withSession`.
 */
async function switchFrom(
	host: ConversationHost,
	client: HostClient,
	source: IntentSource,
	sessionRef: SessionReference,
	options: SwitchSessionIntentOptions | undefined,
): Promise<SessionIntentResult> {
	const currentSessionRef = source.conversation.session.sessionRef;
	if (currentSessionRef !== undefined && sessionRefsEqual(sessionRef, currentSessionRef)) {
		return { cancelled: false, sessionId: source.conversation.id, seeded: false };
	}
	return toIntentResult(
		await moveClient(
			host,
			client,
			source,
			{
				kind: "session",
				ref: sessionRef,
				...(options?.cwdOverride === undefined ? {} : { cwdOverride: options.cwdOverride }),
			},
			{
				...(options?.projectTrustContextFactory
					? { projectTrustContextFactory: options.projectTrustContextFactory }
					: {}),
				...(options?.withSession === undefined ? {} : { withSession: options.withSession }),
			},
		),
	);
}

/** Move `client` to the stored session `sessionRef`. */
export async function openStoredSession(
	host: ConversationHost,
	client: HostClient,
	sessionRef: SessionReference,
	options?: SwitchSessionIntentOptions,
): Promise<SessionIntentResult> {
	return switchFrom(
		host,
		client,
		intentSource(host, client, options?.assertConversationGenerationCurrent),
		sessionRef,
		options,
	);
}

/**
 * The stored session `sessionId` as `conversation` finds it: in its
 * workspace (its session directory, with its cwd), or, with `scope: "all"`,
 * also in every session directory the `sessions` query lists with that
 * scope. Undefined when there is none.
 */
export async function findStoredSession(
	conversation: HostedConversation,
	sessionId: string,
	scope: "workspace" | "all" = "workspace",
): Promise<SessionInfo | undefined> {
	assertValidSessionId(sessionId);
	const manager = conversation.session.sessionManager;
	const sessionDir = manager.getSessionDir() || getDefaultSessionDir(conversation.cwd);
	const found = await findSessionInfoById(sessionDir, sessionId);
	if (found && (!found.cwd || sameFilesystemLocation(found.cwd, conversation.cwd))) return found;
	if (scope === "workspace") return undefined;
	const all = manager.usesDefaultSessionDir()
		? await SessionManager.listAll()
		: await SessionManager.listAll(manager.getSessionDir());
	return all.find((info) => info.id === sessionId);
}

/**
 * Move `client` to the stored session `sessionId` of its conversation's
 * workspace or, with `scope: "all"`, of any session directory the `sessions`
 * query lists with that scope.
 */
export async function openStoredSessionById(
	host: ConversationHost,
	client: HostClient,
	sessionId: string,
	options?: SwitchSessionIntentOptions & { readonly scope?: "workspace" | "all" },
): Promise<SessionIntentResult> {
	const source = intentSource(host, client, options?.assertConversationGenerationCurrent);
	assertValidSessionId(sessionId);
	const conversation = source.conversation;
	if (sessionId === conversation.id) return { cancelled: false, sessionId, seeded: false };
	const target = await findStoredSession(conversation, sessionId, options?.scope);
	source.assertCurrent();
	if (!target) {
		throw new Error(
			options?.scope === "all"
				? `Session not found: ${sessionId}`
				: `Session not found in current workspace: ${sessionId}`,
		);
	}
	return switchFrom(
		host,
		client,
		source,
		target.ref,
		target.cwd ? options : { ...options, cwdOverride: options?.cwdOverride ?? conversation.cwd },
	);
}

/**
 * Move `client` to a new session. Review runs the source's log carries keep
 * their membership in the new session as handoff aliases, and it records the
 * source's pull-request review binding before it opens. With
 * `replaceReviewGeneral`, the preserved run's General discussion moves to the
 * new session as the intent's last durable step.
 */
export async function openNewSession(
	host: ConversationHost,
	client: HostClient,
	options?: NewSessionIntentOptions,
): Promise<SessionIntentResult> {
	const source = intentSource(host, client, options?.assertConversationGenerationCurrent);
	if (options?.replaceReviewGeneral && !options.preserveReviewRunId) {
		throw new Error("replaceReviewGeneral requires preserveReviewRunId");
	}
	const sourceManager = source.conversation.session.sessionManager;
	const cwd = options?.cwd ?? source.conversation.cwd;
	let generalReplacement: Awaited<ReturnType<typeof prepareReviewGeneralReplacement>> | undefined;
	return toIntentResult(
		await moveClient(
			host,
			client,
			source,
			{
				kind: "new",
				cwd,
				...(options?.sessionDir === undefined ? {} : { sessionDir: options.sessionDir }),
				...(options?.parentSessionRef === undefined ? {} : { parentSessionRef: options.parentSessionRef }),
				...(options?.workspaceName === undefined ? {} : { workspaceName: options.workspaceName }),
				...(options?.baseRef === undefined ? {} : { baseRef: options.baseRef }),
				seed: async (writer) => {
					if (options?.replaceReviewGeneral) {
						generalReplacement = await prepareReviewGeneralReplacement(
							sourceManager,
							options.preserveReviewRunId!,
							options.reviewSourceWriter ?? hostReviewSourceWriter(host),
						);
					}
					await options?.setup?.(writer);
					const targetManager = writer.sessionManager;
					// A new General carries its run whether or not the setup copied the run's record.
					const runIds = new Set(listReviewRuns(targetManager, { limit: 50 }).runs.map((run) => run.runId));
					if (generalReplacement && options?.preserveReviewRunId) runIds.add(options.preserveReviewRunId);
					await registerReviewHandoffAliases(sourceManager, writer, [...runIds]);
					// Persist the trusted handoff's binding before publication: subsequent runs
					// are canonical here and must not depend on retained aliases for enforcement.
					const binding = await readPrReviewBinding(targetManager);
					if (binding) {
						if (!sameFilesystemLocation(cwd, binding.cwd)) throw new Error(PR_CHECKOUT_CHANGED);
						await writer.recordPrReviewBinding(binding);
					}
				},
			},
			{
				...(options?.beforeMove === undefined ? {} : { beforeMove: options.beforeMove }),
				...(options?.withSession === undefined ? {} : { withSession: options.withSession }),
				...(options?.replaceReviewGeneral
					? {
							publish: async (target: SessionManager) => {
								if (!generalReplacement) throw new Error("Review General replacement was not prepared");
								await generalReplacement.commit(target);
							},
						}
					: {}),
			},
		),
	);
}

/**
 * Move `client` to a fork of its conversation: before the user message
 * `entryId` (the message's text is returned as `selectedText`), or at an
 * entry, which at the leaf is a clone.
 */
export async function openFork(
	host: ConversationHost,
	client: HostClient,
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
): Promise<ForkIntentResult> {
	const source = intentSource(host, client);
	return moveClient(
		host,
		client,
		source,
		{ kind: "fork", source: source.conversation, entryId, position: options?.position ?? "before" },
		options?.withSession === undefined ? {} : { withSession: options.withSession },
	);
}

/**
 * Move `client` to a session imported from a JSONL file.
 *
 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
 */
export async function openImport(
	host: ConversationHost,
	client: HostClient,
	inputPath: string,
	cwdOverride?: string,
	options?: { readonly assertConversationGenerationCurrent?: () => void },
): Promise<SessionIntentResult> {
	return toIntentResult(
		await moveClient(host, client, intentSource(host, client, options?.assertConversationGenerationCurrent), {
			kind: "import",
			path: inputPath,
			...(cwdOverride === undefined ? {} : { cwdOverride }),
		}),
	);
}
