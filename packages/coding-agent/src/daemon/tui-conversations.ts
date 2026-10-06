/**
 * Conversations a local TUI opens in workers (Phase 7 plan §1, "Open and
 * attach"; D12, D15, D17): `conversation_open`, and the relayed streams
 * that reach the workers hosting them.
 *
 * Only a control connection that said hello as a TUI, with the daemon's
 * control token, opens one: the control server refuses the request on any
 * other connection, and phones never reach the control socket. The open
 * resolves its conversation's workspace from the conversation's working
 * directory: the managed worktree containing it (its parent workspace, the
 * checkout as its root), else the innermost registered workspace containing
 * it, else the directory registered as a workspace of its own (D17, as the
 * TUI registered it before). The conversation resolves read-only: a new one
 * gets its id here (the spawn creates its log, or a `--no-session` worker
 * keeps it in memory), a stored one is found in its session directory or in
 * the worker hosting it, and a fork's copy is written by the spawn. The
 * registry then attaches the TUI to the live worker hosting it, or spawns
 * one with the TUI's environment and options; an attach to a live worker
 * applies the open's session-level options once the TUI attached, and names
 * the spawn-only ones the worker does not share.
 *
 * The answer carries a single-use relay id and token for the TUI's end of
 * its stream, valid for 10 s, during which the worker counts as attached.
 * When the TUI dials it, the daemon mints the worker's end: a local relay
 * offer, whose preamble carries the TUI's client key, its model scope, and
 * those session-level options. Local preambles are minted here only, for a
 * TUI's open; a phone's relay never carries one. The TUI's environment
 * reaches the worker's process only: it is never logged, never in a spawn
 * spec or preamble, and never leaves the local socket.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { basename, join } from "node:path";
import { uuidv7 } from "@hansjm10/volt-agent-core";
import type { IrohRemoteAuditEventInput } from "../core/remote/iroh/audit.ts";
import { isIrohRemoteWorkspaceName } from "../core/remote/iroh/handshake.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../core/remote/iroh/state.ts";
import { getIrohRemoteWorkspaceNameAlias } from "../core/remote/iroh/workspace.ts";
import { getDefaultSessionDirPath, SessionManager, type SessionReference } from "../core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../core/session-store/index.ts";
import type {
	ControlEvent,
	ControlRequest,
	ControlResponse,
	LocalRelayPreamble,
	WorkerSessionOptions,
	WorkerSpawnOnlyOption,
} from "./control-protocol.ts";
import {
	createDaemonProof,
	encodeControlLine,
	type HelloBinding,
	type HelloProof,
	helloProofMatches,
} from "./control-protocol.ts";
import type { ControlConnection } from "./control-server.ts";
import {
	adaptRelaySocketToIrohStream,
	RELAY_TOKEN_TTL_MS,
	type RelayLifecycleOwner,
	RelayRegistry,
} from "./relay-stream.ts";
import { type LiveWorker, WorkerOpenError, type WorkerRegistry, type WorkerSpawnInput } from "./worker-registry.ts";
import {
	checkWorkerSpawnOptions,
	differingSpawnOnlyOptions,
	normalizeWorkerAgentConfig,
} from "./worker-spawn-options.ts";
import { isPathInside } from "./workspace-directory.ts";

type ConversationOpenRequest = Extract<ControlRequest, { type: "conversation_open" }>;

export interface TuiConversationsOptions {
	readonly agentDir: string;
	readonly workers: WorkerRegistry;
	/** The registered workspaces now. */
	workspaces(): readonly IrohRemoteWorkspace[];
	/** The daemon-managed worktrees now. */
	worktrees(): Promise<readonly IrohRemoteWorkspaceWorktree[]>;
	/** A workspace's current authority generation; undefined once it is unregistered. */
	currentGeneration(workspaceName: string): number | undefined;
	/**
	 * Register a workspace for a TUI's working directory no workspace contains
	 * (D17), only when no workspace has the name; resolves whether it did.
	 */
	registerWorkspace(name: string, path: string): Promise<boolean>;
	/** Bind a session created in a managed worktree to it, so it stays there across restarts. */
	bindWorktreeSession(workspaceName: string, worktreeId: string, sessionId: string): Promise<void>;
	sendTo(connectionId: string, event: ControlEvent): boolean;
	audit(event: IrohRemoteAuditEventInput): void;
}

/** Names an auto-registration tries before it gives up. */
const MAX_REGISTRATION_ATTEMPTS = 100;

/** An open the daemon refused, with the control error code it answers. */
class TuiOpenError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "TuiOpenError";
		this.code = code;
	}
}

/** Where a conversation runs: its workspace, and the root its working directory stays inside. */
interface Placement {
	readonly workspace: IrohRemoteWorkspace;
	/** The workspace, or the managed worktree checkout the working directory is in. */
	readonly root: string;
	readonly worktree?: IrohRemoteWorkspaceWorktree;
}

/** A TUI's conversation, resolved read-only. */
interface ResolvedOpen {
	readonly placement: Placement;
	readonly sessionId: string;
	readonly selection: "created" | "resumed";
	/** Whether a spawn keeps the conversation in memory (`--no-session`). */
	readonly inMemory: boolean;
	prepare(generation: number): Promise<WorkerSpawnInput>;
}

/** The TUI's end of a relay, issued with `conversation_opened` and redeemed once. */
interface Ticket {
	readonly relayId: string;
	/** Single-use; the TUI proves it in its relay hello. */
	readonly token: string;
	readonly worker: LiveWorker;
	readonly workspaceName: string;
	readonly sessionId: string;
	/** The TUI's control connection. */
	readonly connectionId: string;
	readonly preamble: Omit<LocalRelayPreamble, "type" | "relayId">;
	/** Ends the worker's attachment for this stream. */
	readonly release: () => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The real path of a directory; refused when it is not one. */
async function realDirectory(path: string): Promise<string> {
	try {
		const real = await realpath(path);
		if ((await stat(real)).isDirectory()) return real;
	} catch {
		// Refused below.
	}
	throw new TuiOpenError("invalid_cwd", "The conversation's working directory is not an accessible directory");
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
	try {
		return await realpath(path);
	} catch {
		return undefined;
	}
}

function hasSessionStore(directory: string): boolean {
	return existsSync(join(directory, SESSION_STORE_DATABASE_FILENAME));
}

/** A session's reference in `directory`, without creating a store there. */
async function findStored(directory: string, sessionId: string): Promise<SessionReference | undefined> {
	return hasSessionStore(directory) ? SessionManager.findForResume(directory, sessionId) : undefined;
}

export class TuiConversations {
	private readonly options: TuiConversationsOptions;
	/** The TUIs' ends of their relays, by relay id, until redeemed or expired. */
	private readonly tickets = new Map<string, Ticket>();
	/** The workers' ends: offered to a worker once its TUI dialed. */
	private readonly relays = new RelayRegistry();
	private readonly relayWorkers = new Map<RelayLifecycleOwner, string>();
	/** Registrations run one at a time: two opens of a new directory register it once. */
	private registering: Promise<unknown> = Promise.resolve();
	private closed = false;

	constructor(options: TuiConversationsOptions) {
		this.options = options;
	}

	/** Answer a TUI's `conversation_open`. */
	async open(connection: ControlConnection, request: ConversationOpenRequest): Promise<ControlResponse> {
		const refuse = (code: string, message: string): ControlResponse => ({
			type: "error",
			id: request.id,
			code,
			message,
		});
		// The control server admits the request from TUIs only; this holds wherever it is called from.
		if (connection.client !== "tui") return refuse("forbidden", "Only a TUI opens conversations");
		if (this.closed) return refuse("shutting_down", "The daemon is shutting down");
		const invalid = checkWorkerSpawnOptions(request.spawn, request.target);
		if (invalid !== undefined) return refuse("invalid_request", invalid);
		try {
			const resolved = await this.resolve(request);
			const workspaceName = resolved.placement.workspace.name;
			const generation = this.options.currentGeneration(workspaceName);
			if (generation === undefined) throw new TuiOpenError("workspace_unavailable", "The workspace is unregistered");
			const opened = await this.options.workers.open(
				{ workspaceName, workspaceGeneration: generation, sessionId: resolved.sessionId },
				{
					origin: "tui",
					client: request.clientKey,
					exclusive: resolved.inMemory,
					env: request.spawn.env,
					prepare: () => resolved.prepare(generation),
					attach: (worker, spawned) => this.issueTicket(connection, request, resolved, worker, spawned),
				},
			);
			return {
				type: "conversation_opened",
				id: request.id,
				relayId: opened.ticket.relayId,
				relayToken: opened.ticket.token,
				sessionId: resolved.sessionId,
				selection: resolved.selection,
				workspaceName,
				spawned: opened.spawned,
				ignoredOptions: opened.ignoredOptions,
			};
		} catch (error) {
			if (error instanceof TuiOpenError) return refuse(error.code, error.message);
			if (error instanceof WorkerOpenError) return refuse(error.outcome ?? "open_failed", error.message);
			return refuse("open_failed", errorMessage(error));
		}
	}

	/**
	 * Count the TUI's stream as attached to `worker`, in the turn the registry
	 * looked it up in, and issue its end of the relay.
	 */
	private issueTicket(
		connection: ControlConnection,
		request: ConversationOpenRequest,
		resolved: ResolvedOpen,
		worker: LiveWorker,
		spawned: boolean,
	): { ticket: Ticket; spawned: boolean; ignoredOptions: WorkerSpawnOnlyOption[] } {
		if (this.closed) throw new TuiOpenError("shutting_down", "The daemon is shutting down");
		const session = request.spawn.session;
		const apply: WorkerSessionOptions | undefined =
			spawned || Object.keys(session).length === 0 ? undefined : session;
		const release = worker.attach("local");
		const relayId = `rl-${uuidv7()}`;
		const ticket: Ticket = {
			relayId,
			token: randomBytes(32).toString("base64url"),
			worker,
			workspaceName: worker.workspaceName,
			sessionId: resolved.sessionId,
			connectionId: connection.connectionId,
			preamble: {
				kind: "local",
				sessionId: resolved.sessionId,
				clientKey: request.clientKey,
				...(request.spawn.modelScopePatterns === undefined
					? {}
					: { modelScopePatterns: [...request.spawn.modelScopePatterns] }),
				...(apply === undefined ? {} : { apply }),
			},
			release,
			timer: setTimeout(() => {
				if (this.tickets.get(relayId) !== ticket) return;
				this.tickets.delete(relayId);
				release();
			}, RELAY_TOKEN_TTL_MS),
		};
		ticket.timer.unref?.();
		this.tickets.set(relayId, ticket);
		return {
			ticket,
			spawned,
			ignoredOptions: spawned ? [] : differingSpawnOnlyOptions(request.spawn.config, worker.spec),
		};
	}

	/**
	 * A relay hello: the TUI's end of a ticket (its stream is offered to the
	 * worker), or the worker redeeming that offer. False when it is neither.
	 */
	admitRelay(
		relayId: string,
		proof: HelloProof | undefined,
		binding: HelloBinding,
		socket: Socket,
		bufferedRemainder: Buffer,
	): boolean {
		const ticket = this.tickets.get(relayId);
		if (!ticket) return proof !== undefined && this.relays.admit(relayId, proof, binding, socket, bufferedRemainder);
		// The TUI proves the ticket's token on this connection, without sending it; the daemon proves it back.
		if (proof === undefined || !helloProofMatches("relay", ticket.token, binding, proof)) return false;
		this.tickets.delete(relayId);
		clearTimeout(ticket.timer);
		if (this.closed) {
			ticket.release();
			return false;
		}
		socket.write(
			encodeControlLine({
				type: "hello_ack",
				ok: true,
				daemonProof: createDaemonProof("relay", ticket.token, binding, proof),
			}),
		);
		if (bufferedRemainder.length > 0) socket.unshift(bufferedRemainder);
		const stream = adaptRelaySocketToIrohStream(socket);
		const { worker } = ticket;
		let owner: RelayLifecycleOwner;
		try {
			owner = this.relays.mint({
				workspaceName: ticket.workspaceName,
				sessionId: ticket.sessionId,
				clientNodeId: "tui",
				connectionId: ticket.connectionId,
				ownerControlConnectionId: worker.connectionId,
				streamId: relayId,
				stream,
				preamble: ticket.preamble,
				// The TUI sees its stream end, and opens again.
				rejectPending: () => stream.close(),
				onSettled: (outcome) => {
					ticket.release();
					this.relayWorkers.delete(owner);
					this.options.sendTo(worker.connectionId, {
						type: "relay_closed",
						relayId: owner.relayId,
						reason: outcome.reason,
					});
					this.options.audit({
						type: "relay_closed",
						workspace: ticket.workspaceName,
						success: outcome.error === undefined,
						...(outcome.error === undefined ? {} : { error: outcome.error }),
						details: {
							relayId: owner.relayId,
							client: "tui",
							workerId: worker.workerId,
							reason: outcome.reason,
							bytesUp: outcome.bytesUp,
							bytesDown: outcome.bytesDown,
							durationMs: outcome.durationMs,
						},
					});
				},
			});
		} catch (error) {
			ticket.release();
			stream.close();
			this.options.audit({
				type: "relay_opened",
				workspace: ticket.workspaceName,
				success: false,
				error: errorMessage(error),
				details: { client: "tui", workerId: worker.workerId, sessionId: ticket.sessionId },
			});
			return true;
		}
		this.relayWorkers.set(owner, worker.workerId);
		const delivered = this.options.sendTo(worker.connectionId, {
			type: "relay_offer",
			clientKind: "local",
			relayId: owner.relayId,
			relayToken: owner.relayToken,
			workspaceName: ticket.workspaceName,
			sessionId: ticket.sessionId,
		});
		// The worker's connection closed meanwhile: the offer closes as an expired one does.
		if (!delivered) void owner.close("error");
		this.options.audit({
			type: "relay_opened",
			workspace: ticket.workspaceName,
			success: true,
			details: {
				relayId: owner.relayId,
				client: "tui",
				workerId: worker.workerId,
				sessionId: ticket.sessionId,
				connectionId: ticket.connectionId,
			},
		});
		return true;
	}

	/** A worker exited: its TUIs' streams close (D19), and their unredeemed ends expire now. */
	workerExited(workerId: string): void {
		for (const [relayId, ticket] of this.tickets) {
			if (ticket.worker.workerId !== workerId) continue;
			this.tickets.delete(relayId);
			clearTimeout(ticket.timer);
			ticket.release();
		}
		for (const [owner, owningWorker] of this.relayWorkers) {
			if (owningWorker === workerId) void owner.close("worker_exited");
		}
	}

	/** The daemon stopped its workers: nothing more opens, and the streams left close. */
	close(): void {
		this.closed = true;
		for (const [relayId, ticket] of this.tickets) {
			this.tickets.delete(relayId);
			clearTimeout(ticket.timer);
			ticket.release();
		}
		for (const owner of this.relayWorkers.keys()) void owner.close("host_shutdown");
	}

	// ==========================================================================
	// Resolution
	// ==========================================================================

	/** The conversation `request` names, read-only. */
	private async resolve(request: ConversationOpenRequest): Promise<ResolvedOpen> {
		const { target, spawn } = request;
		const defaultDirectory = (cwd: string) => getDefaultSessionDirPath(cwd, this.options.agentDir);
		if (target.kind === "session") {
			const directory = target.sessionDir ?? defaultDirectory(spawn.cwd);
			const ref = await findStored(directory, target.sessionId);
			if (ref !== undefined) return this.resolveStored(ref, target.cwdOverride, request);
			// Not stored there: a conversation a worker hosts (a `--no-session` one, or one a move led to).
			const hostingWorkspace = this.options.workers.workspaceHosting(target.sessionId);
			const workspace = this.options.workspaces().find((candidate) => candidate.name === hostingWorkspace);
			if (workspace === undefined) throw new TuiOpenError("session_not_found", "No such conversation");
			return {
				placement: { workspace, root: workspace.path },
				sessionId: target.sessionId,
				selection: "resumed",
				inMemory: false,
				prepare: () => Promise.reject(new TuiOpenError("session_not_found", "The conversation is not stored")),
			};
		}
		const cwd = await realDirectory(spawn.cwd);
		const placement = await this.placement(cwd);
		const sessionDir = target.sessionDir ?? defaultDirectory(cwd);
		if (target.kind === "new") {
			if (!spawn.persist) {
				if (target.sessionId !== undefined) {
					throw new TuiOpenError("invalid_request", "A conversation without a session file gets its id here");
				}
				const sessionId = uuidv7();
				return {
					placement,
					sessionId,
					selection: "created",
					inMemory: true,
					prepare: async (generation) =>
						this.spec(placement, generation, { sessionId, inMemory: true }, cwd, request),
				};
			}
			// An id the store or a worker has already resumes that conversation, as `--session-id` does.
			const existing = target.sessionId === undefined ? undefined : await findStored(sessionDir, target.sessionId);
			if (existing !== undefined) return this.resolveStored(existing, undefined, request);
			if (target.sessionId !== undefined && this.options.workers.workspaceHosting(target.sessionId) !== undefined) {
				return this.resolve({ ...request, target: { kind: "session", sessionId: target.sessionId, sessionDir } });
			}
			const sessionId = target.sessionId ?? uuidv7();
			return {
				placement,
				sessionId,
				selection: "created",
				inMemory: false,
				prepare: (generation) =>
					this.created(placement, generation, cwd, request, sessionId, () =>
						SessionManager.create(cwd, sessionDir, { id: sessionId }),
					),
			};
		}
		const source = await findStored(target.source.sessionDir ?? defaultDirectory(spawn.cwd), target.source.sessionId);
		if (source === undefined) throw new TuiOpenError("session_not_found", "No such conversation to fork");
		if (target.sessionId !== undefined && (await findStored(sessionDir, target.sessionId)) !== undefined) {
			throw new TuiOpenError("session_exists", "A conversation with that id exists");
		}
		const sessionId = target.sessionId ?? uuidv7();
		return {
			placement,
			sessionId,
			selection: "created",
			inMemory: false,
			prepare: (generation) =>
				this.created(placement, generation, cwd, request, sessionId, () =>
					SessionManager.forkFrom(source, cwd, sessionDir, { id: sessionId }),
				),
		};
	}

	/** A stored conversation, run in (the real path of) its own working directory or `cwdOverride`. */
	private async resolveStored(
		ref: SessionReference,
		cwdOverride: string | undefined,
		request: ConversationOpenRequest,
	): Promise<ResolvedOpen> {
		let storedCwd: string;
		const reader = await SessionManager.openReadOnly(ref);
		try {
			storedCwd = reader.getCwd();
		} finally {
			await reader.closePersistence();
		}
		// The conversation runs in the real directory its root was resolved from, not through a link re-pointed later.
		const cwd = await realDirectory(cwdOverride ?? storedCwd);
		const placement = await this.placement(cwd);
		return {
			placement,
			sessionId: ref.sessionId,
			selection: "resumed",
			inMemory: false,
			prepare: async (generation) => this.spec(placement, generation, ref, cwd, request),
		};
	}

	/** Create the conversation's log with `create`, bind it to its worktree, and build its spawn. */
	private async created(
		placement: Placement,
		generation: number,
		cwd: string,
		request: ConversationOpenRequest,
		sessionId: string,
		create: () => Promise<SessionManager>,
	): Promise<WorkerSpawnInput> {
		const manager = await create();
		let ref: SessionReference | undefined;
		try {
			ref = manager.getSessionRef();
		} finally {
			await manager.closePersistence();
		}
		if (ref === undefined || ref.sessionId !== sessionId) throw new Error("The conversation's log has no reference");
		// A session created in a managed worktree stays bound to it across daemon restarts (#83).
		if (placement.worktree !== undefined) {
			await this.options.bindWorktreeSession(placement.workspace.name, placement.worktree.id, sessionId);
		}
		return this.spec(placement, generation, ref, cwd, request);
	}

	/** The spawn of a worker for a TUI's conversation in `cwd`, with the TUI's options. */
	private spec(
		placement: Placement,
		generation: number,
		session: SessionReference | { readonly sessionId: string; readonly inMemory: true },
		cwd: string,
		request: ConversationOpenRequest,
	): WorkerSpawnInput {
		const { spawn } = request;
		return {
			origin: "tui",
			workspace: { name: placement.workspace.name, path: placement.workspace.path, generation },
			session: "inMemory" in session ? { sessionId: session.sessionId, inMemory: true } : session,
			cwd,
			root: placement.root,
			projectCwd: placement.root,
			...(placement.worktree?.baseRef === undefined ? {} : { baseRef: placement.worktree.baseRef }),
			config: normalizeWorkerAgentConfig(spawn.config),
			sessionOptions: spawn.session,
			...(spawn.modelScopePatterns === undefined ? {} : { modelScopePatterns: [...spawn.modelScopePatterns] }),
		};
	}

	/**
	 * Where a conversation in the real directory `cwd` runs: the managed
	 * worktree containing it, else the innermost registered workspace
	 * containing it, else a workspace registered for it (D17).
	 */
	private async placement(cwd: string): Promise<Placement> {
		const workspaces = this.options.workspaces();
		let worktreeMatch: { worktree: IrohRemoteWorkspaceWorktree; root: string } | undefined;
		for (const worktree of await this.options.worktrees()) {
			const root = await realPathOrUndefined(worktree.path);
			if (root === undefined || !isPathInside(root, cwd)) continue;
			if (worktreeMatch === undefined || root.length > worktreeMatch.root.length) worktreeMatch = { worktree, root };
		}
		if (worktreeMatch !== undefined) {
			const workspace = workspaces.find((candidate) => candidate.name === worktreeMatch.worktree.workspaceName);
			if (workspace !== undefined) return { workspace, root: worktreeMatch.root, worktree: worktreeMatch.worktree };
		}
		const containing = await this.containingWorkspace(workspaces, cwd);
		if (containing !== undefined) return containing;
		return this.register(cwd);
	}

	private async containingWorkspace(
		workspaces: readonly IrohRemoteWorkspace[],
		cwd: string,
	): Promise<Placement | undefined> {
		let match: Placement | undefined;
		for (const workspace of workspaces) {
			const root = await realPathOrUndefined(workspace.path);
			if (root === undefined || !isPathInside(root, cwd)) continue;
			if (match === undefined || root.length > match.root.length) match = { workspace, root };
		}
		return match;
	}

	/** Register `cwd` as a workspace named after it, unless one now contains it. */
	private register(cwd: string): Promise<Placement> {
		const registration = this.registering.then(async (): Promise<Placement> => {
			const workspaces = this.options.workspaces();
			const containing = await this.containingWorkspace(workspaces, cwd);
			if (containing !== undefined) return containing;
			const taken = new Set(workspaces.map((workspace) => getIrohRemoteWorkspaceNameAlias(workspace.name)));
			const directoryName = basename(cwd);
			const base =
				isIrohRemoteWorkspaceName(directoryName) && directoryName.length <= 200 ? directoryName : "workspace";
			// Insert-only: a name another client registered meanwhile is never replaced, so no authority needs fencing.
			for (let suffix = 1; suffix <= MAX_REGISTRATION_ATTEMPTS; suffix++) {
				const name = suffix === 1 ? base : `${base}-${suffix}`;
				if (taken.has(getIrohRemoteWorkspaceNameAlias(name))) continue;
				if (!(await this.options.registerWorkspace(name, cwd))) continue;
				const workspace = this.options.workspaces().find((candidate) => candidate.name === name);
				if (workspace === undefined) break;
				return { workspace, root: cwd };
			}
			throw new TuiOpenError("workspace_unavailable", "The working directory's workspace was not registered");
		});
		this.registering = registration.catch(() => undefined);
		return registration;
	}
}
