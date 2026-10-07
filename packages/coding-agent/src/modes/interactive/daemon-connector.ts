/**
 * The volt CLI's connector (Phase 7 plan §1, "The TUI as a client"): the
 * TUI's conversations run in the daemon's conversation workers, and the TUI
 * is a client of each over a stream the daemon relays (daemon-hosted
 * conversations RFC §4.3, §6, §7).
 *
 * The connector keeps one control connection to the daemon as a TUI. It
 * starts the daemon when none runs (`ensureDaemonRunning`; the daemon is
 * mandatory for the TUI), checks that it runs this Volt version (D7: an idle
 * daemon of another version that a terminal started is restarted in place
 * once, else the TUI refuses with what to run), and opens each conversation with
 * `conversation_open`: the TUI's environment, working directory, and CLI
 * options as its spawn options, and the TUI process's client key, which the
 * worker answers retried intents by. The answer's single-use relay ticket
 * dials the TUI's end of the stream, a JSONL transport for the TUI's
 * protocol client.
 *
 * A conversation in a sensitive directory no workspace holds is registered
 * only once the user answered how (D17): shared with paired devices, or
 * local to this host. The worker opening a conversation decides its project
 * trust (P7-8b): what it asks meanwhile (its trust prompt, a `project_trust`
 * hook's dialog) reaches the TUI as `conversation_host_request` on this
 * control connection, which the open's client answers; `--approve` and
 * `--no-approve` go only to the startup conversation's project. A move
 * leads the client to a conversation by id: the connector finds where it is
 * stored (read-only; a conversation only a worker holds, such as a
 * `--no-session` one, has no store) and opens it there, in the working
 * directory the client was in when its own is gone (the user confirmed that
 * before the move), saying why when a session change of the client's own
 * led there (its `session_start` reason, and the conversation it left). A
 * stored conversation whose managed worktree checkout was archived is
 * restored first, pinned for as long as the control connection lasts.
 *
 * Connections can end unannounced (a worker exited, the daemon restarted):
 * the client resumes on a connection the connector opens again
 * (`reconnects`), unless the conversation's workspace was unregistered
 * meanwhile. When the daemon announced its shutdown (`daemon_shutdown`,
 * D16), the connector waits 10 s for a restart before it starts the daemon
 * itself. Quitting the TUI detaches it; its conversations keep running in
 * their workers (`runsInBackground`, D6).
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { HostResponse } from "@hansjm10/volt-protocol";
import {
	type ConnectorDaemon,
	type ConnectorOpenOptions,
	type ConnectorTarget,
	type ConversationConnector,
	ConversationUnavailableError,
	type OpenedConversation,
	type SessionChangeCause,
} from "../../client/conversation-connector.ts";
import {
	DaemonConversationOpenError,
	openDaemonConversation,
	openNotices,
	WorkspaceConfirmationRequiredError,
} from "../../client/daemon-conversation.ts";
import { VERSION } from "../../config.ts";
import { projectTrustPath } from "../../core/project-trust.ts";
import type { RpcTransport } from "../../core/protocol/transport/transport.ts";
import { findSessionByExactId } from "../../core/session-lookup.ts";
import { findSessionInfoById } from "../../core/session-manager.ts";
import { time } from "../../core/timings.ts";
import { createDaemonClient, type DaemonClient } from "../../daemon/control-client.ts";
import {
	type ControlEvent,
	type ConversationOpenCause,
	type ConversationOpenTarget,
	PROTOCOL_VERSION,
	type WorkerSpawnOptions,
	type WorkspaceRegistration,
} from "../../daemon/control-protocol.ts";
import { getDaemonPaths } from "../../daemon/paths.ts";
import { isDaemonServiceProcess } from "../../daemon/service-install.ts";
import { type DaemonProbeResult, ensureDaemonRunning, probeDaemon, waitForDaemonExit } from "../../daemon/spawn.ts";
import { isPathUnderWorktreesRoot } from "../../daemon/worktree-manager.ts";

/** How long after the daemon announced its shutdown the TUI waits for a restart before starting the daemon itself (D16). */
export const DAEMON_RESTART_GRACE_MS = 10_000;
/** How long a daemon whose readiness the start could not confirm (it waits for a previous daemon's workers) is waited for. */
const DAEMON_START_EXTRA_WAIT_MS = 90_000;
const DAEMON_START_POLL_MS = 500;
/** How long a connection its host ended shutting down waits for the daemon to announce its shutdown. */
const SHUTDOWN_ANNOUNCEMENT_WAIT_MS = 1_000;

/** Refusals of an open that another try does not change. */
const FINAL_OPEN_REFUSALS = new Set([
	"forbidden",
	"invalid_request",
	"invalid_cwd",
	"session_not_found",
	"session_exists",
	"session_unavailable",
	"conversation_in_use",
	"open_failed",
]);

/** How the connector reaches the daemon; the daemon's own spawn module by default. */
export interface DaemonConnectorDaemon extends ConnectorDaemon {
	/** Whether the login service runs the daemon with this pid. */
	isServiceProcess(pid: number): Promise<boolean>;
}

const DEFAULT_DAEMON: DaemonConnectorDaemon = {
	ensure: (agentDir) => ensureDaemonRunning(agentDir),
	probe: (agentDir) => probeDaemon(agentDir),
	waitForExit: (options) => waitForDaemonExit(options),
	isServiceProcess: (pid) => isDaemonServiceProcess(pid),
};

export interface DaemonConnectorOptions {
	readonly agentDir: string;
	/** The conversation the TUI opens first, and the working directory it runs in. */
	readonly startup: { readonly target: ConversationOpenTarget; readonly cwd: string };
	/** What the TUI opens every conversation with: its environment, working directory, and CLI options. */
	readonly spawn: WorkerSpawnOptions;
	/** The TUI's `--session-dir`: where it looks for the stored conversations its moves lead to, else every project's. */
	readonly sessionDir?: string;
	readonly daemon?: DaemonConnectorDaemon;
}

/** A conversation's open target, and the working directory it runs in as far as the connector knows. */
interface Located {
	readonly target: ConversationOpenTarget;
	readonly cwd: string;
}

/** A refusal to attach to a daemon of another version (D7), with what to do about it. */
function versionSkewMessage(daemonVersion: string, workers: number): string {
	const busy = workers > 0 ? ` with ${workers} running conversation${workers === 1 ? "" : "s"}` : "";
	return (
		`The Volt daemon runs ${daemonVersion}${busy}; this terminal runs ${VERSION}. ` +
		`Run \`volt daemon restart\` to restart it from this installation${workers > 0 ? " (it stops those conversations)" : ""}, then start volt again.`
	);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonConnector implements ConversationConnector {
	readonly runsInBackground = true;
	readonly reconnects = true;
	private readonly agentDir: string;
	private readonly startup: { readonly target: ConversationOpenTarget; readonly cwd: string };
	private readonly spawn: WorkerSpawnOptions;
	private readonly sessionDir: string | undefined;
	readonly daemon: DaemonConnectorDaemon;
	/** Who the TUI process is across its connections: its retried intents answer as they did. */
	private readonly clientKey = randomUUID();
	private control: DaemonClient | undefined;
	private connecting: Promise<DaemonClient> | undefined;
	/** Whether a control connection was ever made: a later one of another version refuses at once. */
	private connectedOnce = false;
	private restartedForVersion = false;
	/** When the daemon announced its shutdown, until the next connection. */
	private shutdownAt: number | undefined;
	/** The conversations opened, by id: the target each opened with, which a resume opens again, and its working directory. */
	private readonly targets = new Map<string, Located>();
	/** The conversation the client is on, as far as the connector knows: where it runs and is stored. */
	private current: Located;
	private workspaceName: string | undefined;
	/** Conversations whose archived checkout this control connection restored (and pins). */
	private restored = new Set<string>();
	private readonly transports = new Set<RpcTransport>();
	/** The opens in flight, the latest last: what their workers ask meanwhile, the latest one's client answers. */
	private readonly openings: ConnectorOpenOptions[] = [];
	/** The questions shown, until answered or no open waits for them. */
	private readonly questions = new Set<AbortController>();
	private readonly themeListeners = new Set<(themeName: string) => void>();
	private stopped = false;
	private disposing: Promise<void> | undefined;

	constructor(options: DaemonConnectorOptions) {
		this.agentDir = options.agentDir;
		this.startup = options.startup;
		this.spawn = options.spawn;
		this.sessionDir = options.sessionDir;
		this.daemon = options.daemon ?? DEFAULT_DAEMON;
		this.current = { target: options.startup.target, cwd: options.startup.cwd };
	}

	/**
	 * Open `target` in a worker: the startup conversation, or one by id. A
	 * refusal that another try does not change rejects with
	 * `ConversationUnavailableError`.
	 */
	async open(target: ConnectorTarget, options: ConnectorOpenOptions = {}): Promise<OpenedConversation> {
		this.openings.push(options);
		try {
			if (this.stopped) throw new ConversationUnavailableError("The TUI stopped");
			const located = target.kind === "startup" ? this.startup : await this.locate(target.sessionId);
			const openTarget = located.target;
			const cause =
				target.kind === "session" && target.cause !== undefined ? this.openCause(target.cause) : undefined;
			let workspaceRegistration: WorkspaceRegistration | undefined;
			for (;;) {
				const control = await this.connect(options);
				if (target.kind === "session" && target.resume === true) await this.assertWorkspaceKept(control);
				await this.restoreCheckout(control, openTarget);
				options.onStatus?.("Opening the conversation");
				try {
					const { opened, transport } = await openDaemonConversation(control, {
						target: openTarget,
						spawn: this.spawnFor(located.cwd),
						clientKey: this.clientKey,
						...(workspaceRegistration === undefined ? {} : { workspaceRegistration }),
						...(cause === undefined ? {} : { cause }),
					});
					time(opened.spawned ? "daemon.conversationOpen(spawned)" : "daemon.conversationOpen(attached)");
					if (this.stopped) {
						await transport.close();
						throw new ConversationUnavailableError("The TUI stopped");
					}
					this.opened(located, opened.sessionId, opened.workspaceName, transport);
					return {
						transport,
						sessionId: opened.sessionId,
						workspaceName: opened.workspaceName,
						notices: openNotices(opened),
					};
				} catch (error) {
					if (!(error instanceof WorkspaceConfirmationRequiredError) || workspaceRegistration !== undefined) {
						throw error;
					}
					options.onStatus?.(undefined);
					const answer = await options.askWorkspaceRegistration?.(error.directory);
					if (answer === undefined) {
						throw new ConversationUnavailableError(
							`${error.directory} is not registered as a Volt workspace, so Volt cannot open a conversation there.`,
							{ cause: error },
						);
					}
					workspaceRegistration = answer;
				}
			}
		} catch (error) {
			if (error instanceof DaemonConversationOpenError && FINAL_OPEN_REFUSALS.has(error.code)) {
				const message =
					!this.spawn.persist && error.code === "session_not_found"
						? "This conversation was kept only in its worker's memory (--no-session), and that worker exited"
						: error.message;
				throw new ConversationUnavailableError(message, { cause: error });
			}
			throw error;
		} finally {
			this.openings.splice(this.openings.indexOf(options), 1);
			if (this.openings.length === 0) this.endQuestions();
			options.onStatus?.(undefined);
		}
	}

	/** The host ended the client's connection shutting down: whether the daemon announced its own shutdown, or is gone. */
	async hostRestarting(): Promise<boolean> {
		const announced = (): boolean => this.shutdownAt !== undefined || this.control?.connectionState !== "connected";
		const deadline = Date.now() + SHUTDOWN_ANNOUNCEMENT_WAIT_MS;
		while (!announced() && Date.now() < deadline) await delay(50);
		return announced();
	}

	stopServing(): void {
		this.stopped = true;
	}

	/** Detach: the client's streams and the control connection close; the conversations keep running in their workers. */
	dispose(options: { beforeDispose?: () => void } = {}): Promise<void> {
		this.stopped = true;
		this.endQuestions();
		this.disposing ??= (async () => {
			options.beforeDispose?.();
			const transports = [...this.transports];
			this.transports.clear();
			await Promise.allSettled(transports.map((transport) => transport.close()));
			const control = this.control;
			this.control = undefined;
			await control?.close().catch(() => undefined);
		})();
		return this.disposing;
	}

	daemonWorkspaceName(): string | undefined {
		return this.workspaceName;
	}

	onThemeSnapshot(listener: (themeName: string) => void): () => void {
		this.themeListeners.add(listener);
		return () => {
			this.themeListeners.delete(listener);
		};
	}

	/**
	 * The spawn options of an open in `cwd`. `--approve`/`--no-approve` apply
	 * to the startup conversation's project only: the worker of a
	 * conversation in another project decides its trust itself.
	 */
	private spawnFor(cwd: string): WorkerSpawnOptions {
		const { trust, ...config } = this.spawn.config;
		if (trust === undefined) return this.spawn;
		const decided = projectTrustPath(this.agentDir, this.startup.cwd);
		if (decided !== undefined && projectTrustPath(this.agentDir, cwd) === decided) return this.spawn;
		return { ...this.spawn, config };
	}

	/**
	 * Why the client opens a conversation a session change of its own led it
	 * to: the change's reason, and the conversation it left with the session
	 * directory that holds it as far as the connector knows (in no store for
	 * a `--no-session` TUI), which the daemon checks.
	 */
	private openCause(cause: SessionChangeCause): ConversationOpenCause {
		if (!this.spawn.persist) return { reason: cause.reason };
		const sessionDir = (this.targets.get(cause.previousSessionId) ?? this.current).target.sessionDir;
		return {
			reason: cause.reason,
			previous: { sessionId: cause.previousSessionId, ...(sessionDir === undefined ? {} : { sessionDir }) },
		};
	}

	/** Track the conversation the client is on now: where it runs, and the target that opens it again. */
	private opened(located: Located, sessionId: string, workspaceName: string, transport: RpcTransport): void {
		this.workspaceName = workspaceName;
		this.transports.add(transport);
		transport.onClose?.(() => this.transports.delete(transport));
		this.current = located;
		if (located.target.kind === "session") this.targets.set(sessionId, located);
		// In memory: only its worker holds it.
		else if (!this.spawn.persist)
			this.targets.set(sessionId, { target: { kind: "session", sessionId }, cwd: located.cwd });
	}

	/**
	 * Where the conversation `sessionId` a move led the client to opens: as
	 * it opened before, else in the store holding it (the directory of the
	 * conversation the client was on first), in the client's working
	 * directory when its own is gone; a conversation no store holds only its
	 * worker has. A `--no-session` TUI's conversations are all in memory.
	 */
	private async locate(sessionId: string): Promise<Located> {
		const known = this.targets.get(sessionId);
		if (known !== undefined) return known;
		const here = this.current;
		const hosted: Located = { target: { kind: "session", sessionId }, cwd: here.cwd };
		if (!this.spawn.persist) return hosted;
		const currentDir = here.target.sessionDir;
		const found = await findSessionByExactId(
			sessionId,
			here.cwd,
			this.sessionDir,
			currentDir === undefined ? [] : [currentDir],
		).catch(() => undefined);
		if (found === undefined) return hosted;
		const gone = found.cwd !== "" && !existsSync(found.cwd) && !isPathUnderWorktreesRoot(this.agentDir, found.cwd);
		return {
			target: {
				kind: "session",
				sessionId,
				sessionDir: found.ref.sessionDirectory,
				...(gone ? { cwdOverride: here.cwd } : {}),
			},
			cwd: gone || !found.cwd ? here.cwd : found.cwd,
		};
	}

	/**
	 * A conversation the client lost its connection to reopens only while its
	 * workspace is still registered: when it was unregistered (which retired
	 * its worker), opening it again would register its directory anew, behind
	 * the user's back.
	 */
	private async assertWorkspaceKept(control: DaemonClient): Promise<void> {
		const name = this.workspaceName;
		if (name === undefined) return;
		const status = await control.request({ type: "status" });
		if (status.type !== "status_result" || status.workspaces.some((workspace) => workspace.name === name)) return;
		throw new ConversationUnavailableError(
			`The workspace ${name} was unregistered, so Volt does not reopen its conversation here. Start volt again to open it anew.`,
		);
	}

	/**
	 * A stored conversation whose managed worktree checkout is gone (archived)
	 * runs nowhere else: the daemon restores it and pins it for as long as the
	 * control connection lasts.
	 */
	private async restoreCheckout(control: DaemonClient, target: ConversationOpenTarget): Promise<void> {
		if (target.kind !== "session" || target.sessionDir === undefined || target.cwdOverride !== undefined) return;
		if (this.restored.has(target.sessionId)) return;
		const info = await findSessionInfoById(target.sessionDir, target.sessionId).catch(() => undefined);
		if (info === undefined || !info.cwd || existsSync(info.cwd)) return;
		if (!isPathUnderWorktreesRoot(this.agentDir, info.cwd)) return;
		const response = await control.request({ type: "worktree_restore", path: info.cwd, sessionRef: info.ref });
		if (response.type !== "ok") {
			throw new ConversationUnavailableError(
				`Cannot restore the session's managed worktree at ${info.cwd}: ${response.type === "error" ? response.message : response.type}`,
			);
		}
		this.restored.add(target.sessionId);
	}

	/** The control connection: the one there is, else a new one (starting the daemon when none runs). */
	private async connect(options: ConnectorOpenOptions): Promise<DaemonClient> {
		if (this.control?.connectionState === "connected") return this.control;
		this.connecting ??= this.dial(options).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	private async dial(options: ConnectorOpenOptions): Promise<DaemonClient> {
		const previous = this.control;
		this.control = undefined;
		this.restored = new Set();
		await previous?.close().catch(() => undefined);
		const ensured = await this.reachDaemon(options);
		let client = await this.createClient(ensured);
		if (client.serverInfo?.version !== VERSION) client = await this.resolveVersionSkew(client, ensured, options);
		time("daemon.hello");
		this.control = client;
		this.connectedOnce = true;
		this.shutdownAt = undefined;
		return client;
	}

	/**
	 * A healthy daemon: the one running, or one started now. Within 10 s of
	 * the daemon's announced shutdown, only one another process (a restart)
	 * started. A start whose readiness is unconfirmed (the new daemon waits
	 * for the previous daemon's workers to exit, up to 75 s) is waited for.
	 */
	private async reachDaemon(options: ConnectorOpenOptions): Promise<DaemonProbeResult> {
		const restarting = this.shutdownAt !== undefined && Date.now() - this.shutdownAt < DAEMON_RESTART_GRACE_MS;
		if (restarting) {
			options.onStatus?.("Waiting for the Volt daemon to restart");
			const probe = await this.daemon.probe(this.agentDir);
			if (!probe.healthy) throw new Error(`The Volt daemon is ${probe.state}`);
			return probe;
		}
		options.onStatus?.("Starting the Volt daemon");
		const ensured = await this.daemon.ensure(this.agentDir);
		time("daemon.ensure");
		if (ensured.healthy) return ensured;
		if (ensured.state === "starting") {
			options.onStatus?.("Waiting for the Volt daemon (it waits for the previous daemon's conversations to stop)");
			const deadline = Date.now() + DAEMON_START_EXTRA_WAIT_MS;
			while (Date.now() < deadline) {
				await delay(DAEMON_START_POLL_MS);
				const probe = await this.daemon.probe(this.agentDir);
				if (probe.healthy) return probe;
			}
		}
		const logPath = getDaemonPaths(this.agentDir).logPath;
		if (ensured.state === "protocol-mismatch") {
			throw new ConversationUnavailableError(
				`The Volt daemon${ensured.version === undefined ? "" : ` (${ensured.version})`} speaks another control protocol (${ensured.protocolVersion ?? "unknown"}; this terminal speaks ${PROTOCOL_VERSION}). ` +
					"Run `volt daemon restart` to restart it from this installation, then start volt again.",
			);
		}
		if (ensured.state === "auth-failed") {
			throw new ConversationUnavailableError(
				`The Volt daemon rejected this terminal's credentials. Check the daemon log: ${logPath}`,
			);
		}
		if (ensured.invalidState !== undefined) {
			throw new ConversationUnavailableError(
				`${ensured.error ?? "The Volt daemon's state is invalid"}. Run \`volt daemon regenerate-state\`, then start volt again.`,
			);
		}
		throw new Error(
			`The Volt daemon is not available (${ensured.error ?? ensured.state}). Check the daemon log: ${logPath}`,
		);
	}

	private async createClient(endpoint: { socketPath: string; authToken?: string }): Promise<DaemonClient> {
		const client: DaemonClient = createDaemonClient({
			socketPath: endpoint.socketPath,
			client: "tui",
			version: VERSION,
			...(endpoint.authToken === undefined ? {} : { authToken: endpoint.authToken }),
			reconnect: false,
			onEvent: (event) => this.onEvent(client, event),
			onConnectionStateChange: (state) => {
				if (state !== "gone") return;
				if (this.control === client) this.control = undefined;
				// What the daemon asked on it can no longer be answered.
				this.endQuestions();
			},
		});
		try {
			await client.connect();
		} catch (error) {
			await client.close().catch(() => undefined);
			throw error;
		}
		return client;
	}

	/**
	 * The daemon runs another Volt version (D7): workers always run the
	 * daemon's installation, so the TUI never attaches across versions. An
	 * idle daemon (no workers, no phones) that a terminal started
	 * is restarted in place from this installation, once, at startup. A busy
	 * one is left running, and one the login service runs is never replaced
	 * behind the service's back: the TUI refuses with what to run.
	 */
	private async resolveVersionSkew(
		client: DaemonClient,
		ensured: DaemonProbeResult,
		options: ConnectorOpenOptions,
	): Promise<DaemonClient> {
		const daemonVersion = client.serverInfo?.version ?? "an unknown version";
		const status = await client.request({ type: "status" }).catch(() => undefined);
		const refuse = async (message: string): Promise<never> => {
			await client.close().catch(() => undefined);
			throw new ConversationUnavailableError(message);
		};
		if (status?.type !== "status_result") return refuse(versionSkewMessage(daemonVersion, 0));
		const workers = status.workers.length;
		const idle = workers === 0 && status.phoneConnections === 0;
		if (!idle || this.connectedOnce || this.restartedForVersion)
			return refuse(versionSkewMessage(daemonVersion, workers));
		if (await this.daemon.isServiceProcess(status.pid)) {
			return refuse(
				`The Volt daemon runs ${daemonVersion} under the login service; this terminal runs ${VERSION}. ` +
					"Run `volt daemon install-service` from this installation to point the service here, then start volt again.",
			);
		}
		this.restartedForVersion = true;
		options.onStatus?.(`Restarting the Volt daemon (it runs ${daemonVersion}; this terminal runs ${VERSION})`);
		await client.request({ type: "shutdown" }).catch(() => undefined);
		await client.close().catch(() => undefined);
		const exited = await this.daemon.waitForExit({
			agentDir: this.agentDir,
			pid: status.pid,
			socketPath: ensured.socketPath,
		});
		if (exited !== "exited") {
			throw new ConversationUnavailableError(
				`The Volt daemon ${daemonVersion} did not stop for the restart. Run \`volt daemon restart\`, then start volt again.`,
			);
		}
		const restarted = await this.reachDaemon(options);
		const next = await this.createClient(restarted);
		if (next.serverInfo?.version !== VERSION) {
			await next.close().catch(() => undefined);
			throw new ConversationUnavailableError(versionSkewMessage(next.serverInfo?.version ?? daemonVersion, 0));
		}
		return next;
	}

	/** Close the questions shown: nothing answers them now. */
	private endQuestions(): void {
		for (const question of [...this.questions]) question.abort();
		this.questions.clear();
	}

	/**
	 * A worker opening a conversation for this TUI asks it (P7-8b): the
	 * client of the latest open in flight shows the question, and its answer
	 * goes back on the connection that asked. A worker asks one question at a
	 * time, so a new one closes any still shown (one it gave up on, such as a
	 * hook's that timed out). Without an open in flight, or a client that
	 * answers, it answers nothing.
	 */
	private async answerQuestion(
		control: DaemonClient,
		event: Extract<ControlEvent, { type: "conversation_host_request" }>,
	): Promise<void> {
		const options = this.openings.at(-1);
		const ask = options?.askHostRequest;
		let response: HostResponse | undefined;
		if (options !== undefined && ask !== undefined && !this.stopped) {
			this.endQuestions();
			const question = new AbortController();
			this.questions.add(question);
			options.onStatus?.(undefined);
			try {
				response = await ask(event.request, question.signal);
			} catch {
				response = undefined;
			} finally {
				this.questions.delete(question);
			}
			if (question.signal.aborted) response = undefined;
			else if (this.openings.includes(options)) options.onStatus?.("Opening the conversation");
		}
		await control
			.request({
				type: "conversation_host_response",
				requestId: event.requestId,
				...(response === undefined ? {} : { response }),
			})
			.catch(() => undefined);
	}

	private onEvent(control: DaemonClient, event: ControlEvent): void {
		if (event.type === "conversation_host_request") {
			void this.answerQuestion(control, event);
			return;
		}
		if (event.type === "daemon_shutdown") {
			this.shutdownAt = Date.now();
			return;
		}
		if (event.type === "theme_snapshot") {
			for (const listener of [...this.themeListeners]) {
				try {
					listener(event.themeName);
				} catch {
					// Listeners are observers.
				}
			}
		}
	}
}
