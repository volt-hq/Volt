/**
 * The conversations one process hosts. A conversation serves one log for its
 * whole life: new, resume, fork, clone, and import open another conversation,
 * and the client moves to it. The new conversation opens before the client
 * leaves the source, so a failed open keeps the client where it was.
 *
 * Moving a client fires, in order: `session_before_switch` or
 * `session_before_fork` on the source (which may cancel), the new
 * conversation's `session_start` when the client's surface binds its
 * extensions, then the source's `session_shutdown` when it closes. A source
 * closes when its anchor leaves, or when its last client leaves and the host
 * closes unattached conversations. A client may not leave a busy source, and
 * no client may leave an owner-lifetime conversation such as a subagent's.
 */

import { existsSync } from "node:fs";
import {
	closeLocalSessionManager,
	releaseLocalSessionWorktree,
	restoreLocalSessionWorktree,
	retainLocalSessionWorktree,
} from "../../daemon/session-worktree.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ProjectTrustContext, ReplacedSessionContext, SessionStartEvent } from "../extensions/index.ts";
import { assertSessionCwdExists, MissingSessionCwdError } from "../session-cwd.ts";
import {
	assertCurrentSessionSnapshot,
	importSessionFromJsonlInMemory,
	loadEntriesFromFile,
	type NewSessionOptions,
	SessionManager,
} from "../session-manager.ts";
import {
	type ConversationLifetime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	HostedConversation,
	type HostedConversationSession,
	type SubagentRuntimeContext,
} from "./hosted-conversation.ts";
import { sameFilesystemLocation } from "./session-summaries.ts";
import type { ConversationTarget, HostClient } from "./targets.ts";

/** Thrown when an import names a JSONL file that does not exist. */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

/** What happens to a conversation whose last client left: it closes, stays open, or closes after `retainMs` without a client. */
export type WhenUnattached = "close" | "keep" | { readonly retainMs: number };

export interface ConversationHostOptions {
	readonly factory: CreateAgentSessionRuntimeFactory;
	readonly agentDir: string;
	/** Default: "close". */
	readonly whenUnattached?: WhenUnattached;
}

export interface OpenConversationOptions {
	/**
	 * The conversation the opener is leaving. Its extensions see
	 * `session_before_switch` or `session_before_fork` first and may cancel;
	 * it must be idle; the new conversation inherits its settings profile, and
	 * its Git workspace context when the cwd matches.
	 */
	readonly from?: HostedConversation;
	/** Runs once the source accepted the change, before the target opens, such as a host acquiring a lease. */
	readonly onOpening?: () => Promise<void>;
	readonly subagentContext?: SubagentRuntimeContext;
	readonly projectTrustContext?: (cwd: string) => ProjectTrustContext;
	/** Default: "owner" with a subagent context, else "clients". */
	readonly lifetime?: ConversationLifetime;
	/** Settings profile; the source's requested profile by default. */
	readonly profile?: string;
	/** Host-owned workspace display name for the Git context. */
	readonly workspaceName?: string;
	/** Managed-worktree base ref for the Git context. */
	readonly baseRef?: string;
	/** The `session_start` an adopted log reports; startup by default. */
	readonly sessionStartEvent?: SessionStartEvent;
}

export type OpenConversationResult =
	| { readonly cancelled: true }
	| {
			readonly cancelled: false;
			readonly conversation: HostedConversation;
			/** Forks before a user message: that message's text. */
			readonly selectedText?: string;
	  };

export interface OpenForResult {
	readonly cancelled: boolean;
	/** Whether `withSession` ran to completion against the new conversation. */
	readonly seeded: boolean;
	readonly conversation?: HostedConversation;
	readonly selectedText?: string;
}

/** Thrown for a structural intent inside an owner-lifetime conversation. */
export class PinnedConversationError extends Error {
	constructor() {
		super("Session changes are not available in a subagent conversation");
		this.name = "PinnedConversationError";
	}
}

interface Attachment {
	readonly client: HostClient;
	readonly conversation: HostedConversation;
	detachSurface?: () => void;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

async function closeOwnedSessionManager(manager: SessionManager, error: unknown, message: string): Promise<never> {
	try {
		await closeLocalSessionManager(manager);
	} catch (closeError) {
		throw new AggregateError([error, closeError], message);
	}
	throw error;
}

/** Dispose a created session no conversation took over. */
async function disposeUnownedSession(created: CreateAgentSessionRuntimeResult, error: unknown): Promise<never> {
	const cleanupErrors: unknown[] = [];
	try {
		await created.session.disposeSubagentToolManager();
	} catch (cleanupError) {
		cleanupErrors.push(cleanupError);
	}
	try {
		created.session.dispose("disposal");
		await created.session.waitForClosed();
	} catch (cleanupError) {
		cleanupErrors.push(cleanupError);
	}
	try {
		await releaseLocalSessionWorktree(created.session.sessionManager);
	} catch (cleanupError) {
		cleanupErrors.push(cleanupError);
	}
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			[error, ...cleanupErrors],
			"Conversation open failed and its session could not be disposed",
		);
	}
	throw error;
}

/** The source's `session_shutdown` reason when a client moves to `conversation`: why that one opened. */
function shutdownReasonFor(conversation: HostedConversation): "new" | "resume" | "fork" {
	return conversation.openedAs === "new" || conversation.openedAs === "fork" ? conversation.openedAs : "resume";
}

export class ConversationHost {
	private readonly factory: CreateAgentSessionRuntimeFactory;
	private readonly agentDir: string;
	private readonly whenUnattached: WhenUnattached;
	private readonly conversations = new Set<HostedConversation>();
	private readonly closing = new Map<HostedConversation, Promise<void>>();
	private readonly attachments = new Map<string, Attachment>();
	private readonly retention = new Map<HostedConversation, ReturnType<typeof setTimeout>>();
	private readonly clientTails = new Map<string, Promise<unknown>>();
	private readonly openedListeners = new Set<(conversation: HostedConversation) => void>();
	private readonly closedListeners = new Set<(conversation: HostedConversation) => void>();

	constructor(options: ConversationHostOptions) {
		this.factory = options.factory;
		this.agentDir = options.agentDir;
		this.whenUnattached = options.whenUnattached ?? "close";
	}

	/** The open conversation of `sessionId`, if any. */
	get(sessionId: string): HostedConversation | undefined {
		for (const conversation of this.conversations) {
			if (conversation.id === sessionId) return conversation;
		}
		return undefined;
	}

	/** Every open conversation. */
	list(): HostedConversation[] {
		return [...this.conversations];
	}

	/** The conversation `client` is attached to, if any. */
	conversationOf(client: HostClient): HostedConversation | undefined {
		return this.attachments.get(client.id)?.conversation;
	}

	/** The clients attached to `conversation`. */
	clientsOf(conversation: HostedConversation): HostClient[] {
		return [...this.attachments.values()]
			.filter((attachment) => attachment.conversation === conversation)
			.map((attachment) => attachment.client);
	}

	onOpened(listener: (conversation: HostedConversation) => void): () => void {
		this.openedListeners.add(listener);
		return () => {
			this.openedListeners.delete(listener);
		};
	}

	onClosed(listener: (conversation: HostedConversation) => void): () => void {
		this.closedListeners.add(listener);
		return () => {
			this.closedListeners.delete(listener);
		};
	}

	/**
	 * Open a conversation. No client is attached to it yet; its extensions
	 * bind when the first client with a surface attaches. A failed open closes
	 * whatever it created and leaves `from` as it was.
	 */
	async open(target: ConversationTarget, options: OpenConversationOptions = {}): Promise<OpenConversationResult> {
		let accepted: boolean;
		try {
			accepted = await this.acceptOpen(target, options);
		} catch (error) {
			if (target.kind !== "adopt") throw error;
			return await closeOwnedSessionManager(
				target.sessionManager,
				error,
				"Conversation open failed and its session manager could not be closed",
			);
		}
		if (!accepted) {
			if (target.kind === "adopt") await closeLocalSessionManager(target.sessionManager);
			return { cancelled: true };
		}
		const from = options.from;
		const importPath = target.kind === "import" ? resolvePath(target.path) : undefined;
		let selectedText: string | undefined;
		let sessionManager: SessionManager;
		switch (target.kind) {
			case "new":
				sessionManager = await this.createNewSessionManager(target, from);
				break;
			case "session": {
				if (from?.id === target.ref.sessionId) {
					throw new Error(
						"Cannot replace the current session with a different persisted reference using the same session ID",
					);
				}
				if (this.get(target.ref.sessionId)) {
					throw new Error(`Session ${target.ref.sessionId} is already open in this host`);
				}
				sessionManager = await SessionManager.open(target.ref, target.cwdOverride);
				break;
			}
			case "fork": {
				const branched = await this.createBranchedSessionManager(target.source, target.entryId, target.position);
				sessionManager = branched.sessionManager;
				selectedText = branched.selectedText;
				break;
			}
			case "import":
				sessionManager = await this.createImportedSessionManager(importPath!, target, from);
				break;
			case "adopt":
				sessionManager = target.sessionManager;
				break;
		}
		const conversation = await this.createConversation(target, sessionManager, options);
		this.conversations.add(conversation);
		for (const listener of [...this.openedListeners]) listener(conversation);
		return { cancelled: false, conversation, ...(selectedText === undefined ? {} : { selectedText }) };
	}

	/**
	 * Check that the opener may leave its source, let the source's extensions
	 * cancel, and run the opener's preparation. Resolves false when cancelled.
	 */
	private async acceptOpen(target: ConversationTarget, options: OpenConversationOptions): Promise<boolean> {
		const from = options.from;
		if (from) {
			if (from.closed) throw new Error("The source conversation is closed");
			if (from.lifetime === "owner") throw new PinnedConversationError();
			from.assertCanLeave();
		}
		if (target.kind === "import") {
			const importPath = resolvePath(target.path);
			if (!existsSync(importPath)) throw new SessionImportFileNotFoundError(importPath);
		}
		if (from) {
			if (await this.emitBeforeLeave(from, target)) return false;
			from.assertCanLeave();
		}
		await options.onOpening?.();
		return true;
	}

	private async emitBeforeLeave(from: HostedConversation, target: ConversationTarget): Promise<boolean> {
		const runner = from.session.extensionRunner;
		if (target.kind === "fork") {
			if (!runner.hasHandlers("session_before_fork")) return false;
			const result = await runner.emit({
				type: "session_before_fork",
				entryId: target.entryId,
				position: target.position,
			});
			return result?.cancel === true;
		}
		if (!runner.hasHandlers("session_before_switch")) return false;
		const result = await runner.emit({
			type: "session_before_switch",
			reason: target.kind === "new" ? "new" : "resume",
			targetSessionRef: target.kind === "session" ? target.ref : undefined,
		});
		return result?.cancel === true;
	}

	private async createNewSessionManager(
		target: Extract<ConversationTarget, { kind: "new" }>,
		from: HostedConversation | undefined,
	): Promise<SessionManager> {
		const cwd = target.cwd ?? from?.cwd;
		if (cwd === undefined) throw new Error("A new conversation without a source needs a cwd");
		const persist = target.persist ?? from?.session.sessionManager.isPersisted() ?? true;
		const sessionOptions: NewSessionOptions = {
			...(target.id === undefined ? {} : { id: target.id }),
			...(target.parentSessionRef === undefined ? {} : { parentSession: target.parentSessionRef }),
		};
		const sessionManager = persist
			? await SessionManager.create(
					cwd,
					target.sessionDir ?? (from?.session.sessionManager.getSessionDir() || undefined),
					sessionOptions,
				)
			: SessionManager.inMemory(cwd, sessionOptions);
		if (!target.seed) return sessionManager;
		try {
			await target.seed(sessionManager.logWriter);
			return sessionManager;
		} catch (error) {
			return await closeOwnedSessionManager(
				sessionManager,
				error,
				"New conversation seeding failed and its session manager could not be closed",
			);
		}
	}

	private async createBranchedSessionManager(
		source: HostedConversation,
		entryId: string,
		position: "before" | "at",
	): Promise<{ sessionManager: SessionManager; selectedText?: string }> {
		const selectedEntry = source.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}
		if (position === "at") {
			return {
				sessionManager: await SessionManager.createBranched(source.session.sessionManager, selectedEntry.id),
			};
		}
		if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
			throw new Error("Invalid entry ID for forking");
		}
		const selectedText = extractUserMessageText(selectedEntry.message.content);
		return {
			sessionManager: await SessionManager.createBranched(source.session.sessionManager, selectedEntry.parentId),
			selectedText,
		};
	}

	private async createImportedSessionManager(
		inputPath: string,
		target: Extract<ConversationTarget, { kind: "import" }>,
		from: HostedConversation | undefined,
	): Promise<SessionManager> {
		const fileEntries = loadEntriesFromFile(inputPath);
		if (fileEntries.length === 0) {
			throw new Error(`Session file has no valid session header: ${inputPath}`);
		}
		const header = assertCurrentSessionSnapshot(fileEntries);
		const fallbackCwd = from?.cwd ?? process.cwd();
		const importedCwd = resolvePath(target.cwdOverride ?? (header.cwd || fallbackCwd));
		if (target.cwdOverride === undefined && !existsSync(importedCwd)) {
			throw new MissingSessionCwdError({ sessionCwd: importedCwd, fallbackCwd });
		}
		const persist = from?.session.sessionManager.isPersisted() ?? true;
		return persist
			? await SessionManager.importFromJsonl(
					inputPath,
					importedCwd,
					target.sessionDir ?? (from?.session.sessionManager.getSessionDir() || undefined),
					target.id === undefined ? undefined : { id: target.id },
				)
			: await importSessionFromJsonlInMemory(inputPath, importedCwd);
	}

	/** Create the conversation over `sessionManager`, which this call owns: a failure closes it. */
	private async createConversation(
		target: ConversationTarget,
		sessionManager: SessionManager,
		options: OpenConversationOptions,
	): Promise<HostedConversation> {
		const from = options.from;
		const sessionStartEvent: SessionStartEvent | undefined =
			target.kind === "adopt"
				? options.sessionStartEvent
				: {
						type: "session_start",
						reason: target.kind === "new" ? "new" : target.kind === "fork" ? "fork" : "resume",
						previousSessionRef: from?.session.sessionRef,
					};
		const subagentContext = options.subagentContext;
		let created: CreateAgentSessionRuntimeResult;
		let cwd: string;
		try {
			if (from) retainLocalSessionWorktree(from.session.sessionManager, sessionManager);
			await restoreLocalSessionWorktree(sessionManager, this.agentDir);
			const fallbackCwd = (target.kind === "adopt" ? target.cwd : undefined) ?? from?.cwd ?? process.cwd();
			assertSessionCwdExists(sessionManager, fallbackCwd);
			cwd = (target.kind === "adopt" ? target.cwd : undefined) ?? sessionManager.getCwd();
			const inheritsGitContext = from !== undefined && sameFilesystemLocation(cwd, from.cwd);
			const workspaceName =
				options.workspaceName ??
				(target.kind === "new" ? target.workspaceName : undefined) ??
				(inheritsGitContext ? from.services.workspaceName : undefined);
			const baseRef =
				options.baseRef ??
				(target.kind === "new" ? target.baseRef : undefined) ??
				(inheritsGitContext ? from.services.baseRef : undefined);
			const profile = Object.hasOwn(options, "profile")
				? { profile: options.profile }
				: from
					? { profile: from.services.settingsManager.getRequestedProfile() }
					: {};
			const projectTrustContext = options.projectTrustContext?.(cwd);
			created = await this.factory({
				cwd,
				agentDir: this.agentDir,
				sessionManager,
				...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
				...(projectTrustContext === undefined ? {} : { projectTrustContext }),
				...profile,
				...(subagentContext === undefined ? {} : { subagentContext }),
				...(workspaceName === undefined ? {} : { workspaceName }),
				...(baseRef === undefined ? {} : { baseRef }),
			});
		} catch (error) {
			return await closeOwnedSessionManager(
				sessionManager,
				error,
				"Conversation open failed and its session manager could not be closed",
			);
		}
		try {
			return new HostedConversation(created, {
				openedAs: sessionStartEvent?.reason ?? "startup",
				lifetime: options.lifetime ?? (subagentContext ? "owner" : "clients"),
				...(subagentContext === undefined ? {} : { subagentContext }),
			});
		} catch (error) {
			return await disposeUnownedSession(created, error);
		}
	}

	/**
	 * Host a session created outside the host, such as one an SDK caller built
	 * with `createAgentSession`. The conversation owns the session from here.
	 */
	adoptSession(
		created: HostedConversationSession,
		options: { readonly subagentContext?: SubagentRuntimeContext; readonly lifetime?: ConversationLifetime } = {},
	): HostedConversation {
		const conversation = new HostedConversation(created, {
			openedAs: "startup",
			lifetime: options.lifetime ?? (options.subagentContext ? "owner" : "clients"),
			...(options.subagentContext === undefined ? {} : { subagentContext: options.subagentContext }),
		});
		this.conversations.add(conversation);
		for (const listener of [...this.openedListeners]) listener(conversation);
		return conversation;
	}

	/** Attach `client`, which is attached nowhere, to `conversation`; its surface binds the conversation's extensions. */
	async attach(client: HostClient, conversation: HostedConversation): Promise<void> {
		if (this.attachments.has(client.id)) {
			throw new Error(`Client ${client.id} is already attached; move it instead`);
		}
		await this.join(client, conversation);
	}

	/** Detach `client` from its conversation, which closes if it was the anchor or the last client and the host closes unattached conversations. */
	async detach(client: HostClient): Promise<void> {
		const attachment = this.attachments.get(client.id);
		if (!attachment) return;
		this.leave(attachment);
		await this.afterLeave(attachment.conversation, client, { reason: "quit" });
	}

	/**
	 * Move `client` to `to`. The source must be idle and is fenced against new
	 * work meanwhile; the client's surface leaves the source before it joins
	 * `to`, so the source's `session_shutdown` reaches none of the client's UI.
	 * If the client cannot join `to`, it stays on the source. Once it joined,
	 * the source closes per its anchor and the host's unattached rule, even if
	 * the client's own move handler fails.
	 */
	async move(client: HostClient, to: HostedConversation): Promise<void> {
		const attachment = this.attachments.get(client.id);
		const from = attachment?.conversation;
		if (from === to) return;
		if (to.closed) throw new Error("Cannot move to a closed conversation");
		if (from?.lifetime === "owner") throw new PinnedConversationError();
		const releaseSource = from?.holdForLeave();
		if (attachment) this.leave(attachment);
		if (client.move.kind === "in_place") {
			try {
				await this.join(client, to);
			} catch (error) {
				if (from && !from.closed) await this.join(client, from).catch(() => undefined);
				releaseSource?.();
				throw error;
			}
		}
		const errors: unknown[] = [];
		try {
			if (client.move.kind === "in_place") await client.move.onMoved(to, from);
			else await client.move.redirect(to.id);
		} catch (error) {
			errors.push(error);
		}
		if (from) {
			try {
				const closed = await this.afterLeave(from, client, {
					reason: shutdownReasonFor(to),
					targetSessionRef: to.session.sessionRef,
				});
				if (!closed) releaseSource?.();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Conversation move did not complete");
	}

	/**
	 * Open `target` for `client` and move the client there, then close the
	 * source per its anchor and the host's unattached rule. One client's
	 * structural intents run one at a time. `withSession` runs against the new
	 * conversation after the move.
	 */
	async openFor(
		client: HostClient,
		target: ConversationTarget,
		options: Omit<OpenConversationOptions, "from"> & {
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		} = {},
	): Promise<OpenForResult> {
		const { withSession, ...openOptions } = options;
		const moved = await this.serialize(client.id, async () => {
			const from = this.conversationOf(client);
			const opened = await this.open(target, { ...openOptions, ...(from === undefined ? {} : { from }) });
			if (opened.cancelled) return undefined;
			const to = opened.conversation;
			try {
				await this.move(client, to);
			} catch (error) {
				if (this.clientsOf(to).length === 0 && !to.closed) {
					await this.discard(to).catch(() => undefined);
				}
				throw error;
			}
			return opened;
		});
		if (!moved) return { cancelled: true, seeded: false };
		let seeded = false;
		if (withSession) {
			await withSession(moved.conversation.session.createReplacedSessionContext());
			seeded = true;
		}
		return {
			cancelled: false,
			seeded,
			conversation: moved.conversation,
			...(moved.selectedText === undefined ? {} : { selectedText: moved.selectedText }),
		};
	}

	/** Close `conversation`, detaching its clients. Every caller joins one close. */
	close(
		conversation: HostedConversation,
		event: Parameters<HostedConversation["close"]>[0] = { reason: "quit" },
	): Promise<void> {
		const pending = this.closing.get(conversation);
		if (pending) return pending;
		const closing = this.finishClose(conversation, conversation.close(event));
		this.closing.set(conversation, closing);
		return closing;
	}

	/** Close an opened conversation no client joined: its extensions never started, so no `session_shutdown`. */
	discard(conversation: HostedConversation): Promise<void> {
		const pending = this.closing.get(conversation);
		if (pending) return pending;
		const closing = this.finishClose(conversation, conversation.discard());
		this.closing.set(conversation, closing);
		return closing;
	}

	/** Clients still attached see the conversation's `session_shutdown`; its disposal releases them. */
	private async finishClose(conversation: HostedConversation, closing: Promise<void>): Promise<void> {
		this.cancelRetention(conversation);
		try {
			await closing;
		} finally {
			for (const attachment of [...this.attachments.values()]) {
				if (attachment.conversation === conversation) this.leave(attachment);
			}
			this.conversations.delete(conversation);
			for (const listener of [...this.closedListeners]) listener(conversation);
		}
	}

	/** Close every open conversation. */
	async dispose(): Promise<void> {
		const results = await Promise.allSettled([...this.conversations].map((conversation) => this.close(conversation)));
		const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (errors.length === 1) throw errors[0];
		if (errors.length > 1) throw new AggregateError(errors, "Conversation host disposal did not complete");
	}

	private async join(client: HostClient, conversation: HostedConversation): Promise<void> {
		if (conversation.closed) throw new Error("Cannot attach to a closed conversation");
		this.cancelRetention(conversation);
		const attachment: Attachment = { client, conversation };
		this.attachments.set(client.id, attachment);
		if (!client.surface) return;
		const extensions = conversation.session.attachExtensionClient({ ...client.surface, id: client.id });
		attachment.detachSurface = extensions.detach;
		try {
			await extensions.ready;
		} catch (error) {
			if (this.attachments.get(client.id) === attachment) this.attachments.delete(client.id);
			throw error;
		}
	}

	private leave(attachment: Attachment): void {
		if (this.attachments.get(attachment.client.id) === attachment) this.attachments.delete(attachment.client.id);
		attachment.detachSurface?.();
		attachment.detachSurface = undefined;
	}

	/** Apply the close rules to a conversation a client left; resolves whether it closes. */
	private async afterLeave(
		conversation: HostedConversation,
		client: HostClient,
		event: Parameters<HostedConversation["close"]>[0],
	): Promise<boolean> {
		if (conversation.closed) return true;
		if (client.anchor) {
			await this.close(conversation, event);
			return true;
		}
		if (this.clientsOf(conversation).length > 0) return false;
		const rule = this.whenUnattached;
		if (rule === "close") {
			await this.close(conversation, event);
			return true;
		}
		if (rule !== "keep") {
			const timer = setTimeout(() => {
				this.retention.delete(conversation);
				void this.close(conversation).catch(() => undefined);
			}, rule.retainMs);
			timer.unref?.();
			this.retention.set(conversation, timer);
		}
		return false;
	}

	private cancelRetention(conversation: HostedConversation): void {
		const timer = this.retention.get(conversation);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.retention.delete(conversation);
	}

	private serialize<T>(clientId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.clientTails.get(clientId) ?? Promise.resolve();
		const result = previous.then(operation, operation);
		const tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.clientTails.set(clientId, tail);
		void tail.then(() => {
			if (this.clientTails.get(clientId) === tail) this.clientTails.delete(clientId);
		});
		return result;
	}
}
