/**
 * User shell commands (`!` and `!!`): running one as conversation activity,
 * and recording its result in session history. A result recorded while a
 * turn holds the conversation waits until the turn settles, so it never
 * splits a tool call from its result.
 *
 * A command a client runs shows in the live state as the `bash` value from
 * when it starts until its `bashExecution` entry commits: its output grows by
 * `append_lines` patches, and its exit code or cancellation is set once it
 * ends. Extensions see `user_bash` first and may run it themselves (their
 * result is recorded as given) or supply the operations it runs with.
 */

import type { AdmissionGate, AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import { UI_NODE_LINE_MAX_CHARS, UI_NODE_TERMINAL_MAX_LINES, type UiPatchOp } from "@hansjm10/volt-protocol";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import type { ExtensionRunner } from "../extensions/index.ts";
import type { GitContextProvider } from "../git-context-provider.ts";
import type { LiveState } from "../host/live-state.ts";
import type { BashExecutionMessage } from "../messages.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";

export interface SessionBashHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly gitContextProvider: GitContextProvider;
	readonly admissionGate: AdmissionGate;
	/** The conversation's live state, where the running command shows. */
	readonly liveState: LiveState;
	conversation(): Conversation<AgentTool>;
	sessionWriter(): SessionWriter;
	extensionRunner(): ExtensionRunner;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	assertNotLost(): void;
	isDisposed(): boolean;
	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	hasSessionOperationBarrier(): boolean;
	/** A turn holds the conversation, a prompt's reservation included. */
	turnActive(): boolean;
	/** An `isBusy` input changed. */
	activityChanged(): void;
}

/** How long output waits for more before it is published, in milliseconds. */
const LIVE_OUTPUT_FLUSH_MS = 50;

/** The live key of the running command. */
const BASH_KEY = "bash";

/** One output line as a terminal line holds it: no terminal controls, within the line bound. */
function terminalLine(text: string): string {
	const line = stripTerminalControls(text).replace(/[\u0080-\u009f]/g, "");
	return line.length <= UI_NODE_LINE_MAX_CHARS ? line : `${line.slice(0, UI_NODE_LINE_MAX_CHARS - 1)}…`;
}

/** A result an extension returned for `user_bash`, as the session records it. */
function extensionResult(result: BashResult): BashResult {
	const exitCode = result.exitCode;
	return {
		output: typeof result.output === "string" ? result.output : String(result.output ?? ""),
		exitCode: Number.isSafeInteger(exitCode) ? exitCode : undefined,
		cancelled: result.cancelled === true,
		truncated: result.truncated === true,
		...(typeof result.fullOutputPath === "string" ? { fullOutputPath: result.fullOutputPath } : {}),
	};
}

/**
 * The live `bash` value of one command: set when the command starts, its
 * output appended as complete lines arrive (the newest lines within the
 * terminal bound, older ones counted as omitted), and its outcome set once it
 * ends. Clearing removes it only while it is still this command's.
 */
class LiveBashOutput {
	private readonly live: LiveState;
	private readonly base: { kind: "bash"; command: string; excludeFromContext?: boolean };
	/** Output after the last line feed. */
	private partial = "";
	/** Complete lines not yet published, at most the terminal bound of the newest. */
	private queued: string[] = [];
	/** Lines that arrived before the queued ones and were dropped unpublished. */
	private skipped = 0;
	/** The lines the published value holds, and how many older ones it counts as omitted. */
	private lines: string[] = [];
	private omitted = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private ended = false;

	constructor(live: LiveState, command: string, excludeFromContext: boolean) {
		this.live = live;
		this.base = {
			kind: "bash",
			command: stripTerminalControls(command),
			...(excludeFromContext ? { excludeFromContext: true } : {}),
		};
		this.publish();
	}

	append(chunk: string): void {
		// A command a later one replaced shows no more output.
		if (this.ended || chunk.length === 0 || !this.owns()) return;
		const parts = (this.partial + chunk).split("\n");
		// A line longer than a terminal line is cut when it is shown.
		this.partial = (parts.pop() ?? "").slice(0, UI_NODE_LINE_MAX_CHARS + 1);
		for (const part of parts) this.queued.push(terminalLine(part));
		if (this.queued.length > UI_NODE_TERMINAL_MAX_LINES) {
			this.skipped += this.queued.length - UI_NODE_TERMINAL_MAX_LINES;
			this.queued = this.queued.slice(-UI_NODE_TERMINAL_MAX_LINES);
		}
		if (this.queued.length > 0 && this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), LIVE_OUTPUT_FLUSH_MS);
			this.timer.unref?.();
		}
	}

	/** The command ended: its last line and its outcome are published, unless a later command shows. */
	end(result: Pick<BashResult, "exitCode" | "cancelled" | "truncated">): void {
		if (this.ended) return;
		if (this.partial.length > 0) this.queued.push(terminalLine(this.partial));
		this.partial = "";
		this.ended = true;
		this.take();
		if (!this.owns()) return;
		this.publish({
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
			...(result.cancelled ? { cancelled: true } : {}),
			...(result.truncated ? { truncated: true } : {}),
		});
	}

	/** Remove the value, unless another command's replaced it. */
	clear(): void {
		this.stopTimer();
		this.ended = true;
		if (this.owns()) this.live.clear(BASH_KEY);
	}

	private flush(): void {
		this.timer = undefined;
		if (this.ended || this.queued.length === 0 || !this.owns()) return;
		const omittedBefore = this.omitted;
		const appended = this.take();
		if (appended === undefined) {
			this.publish();
			return;
		}
		const op: UiPatchOp = {
			op: "append_lines",
			path: ["output"],
			lines: appended,
			...(this.omitted === omittedBefore ? {} : { omittedLines: this.omitted }),
		};
		try {
			this.live.patch(BASH_KEY, [op]);
		} catch {
			// The value changed under the patch: publish it whole.
			this.publish();
		}
	}

	/**
	 * Move the queued lines into the held ones within the terminal bound: the
	 * lines an `append_lines` patch adds, or undefined when more arrived than
	 * one patch can carry and the value is published whole.
	 */
	private take(): string[] | undefined {
		this.stopTimer();
		const queued = this.queued;
		const skipped = this.skipped;
		this.queued = [];
		this.skipped = 0;
		if (queued.length === 0 && skipped === 0) return [];
		const held = this.lines.length;
		const kept = [...this.lines, ...queued];
		const dropped = Math.max(0, kept.length - UI_NODE_TERMINAL_MAX_LINES);
		this.lines = kept.slice(dropped);
		this.omitted += dropped + skipped;
		// Lines dropped from what arrived never reached the client: no patch can skip them.
		return skipped > 0 || dropped > held ? undefined : queued;
	}

	private stopTimer(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** Whether the live value is still this command's: a later command replaces it. */
	private owns(): boolean {
		return LiveBashOutput.current.get(this.live) === this && this.live.get(BASH_KEY) !== undefined;
	}

	private publish(outcome: { exitCode?: number; cancelled?: boolean; truncated?: boolean } = {}): void {
		LiveBashOutput.current.set(this.live, this);
		try {
			this.live.set(BASH_KEY, {
				...this.base,
				output: {
					type: "terminal",
					key: "output",
					lines: [...this.lines],
					...(this.omitted === 0 ? {} : { omittedLines: this.omitted }),
				},
				...outcome,
			});
		} catch {
			// The live value is presentation: a command it cannot show still runs and records.
		}
	}

	/** The command each live state shows. */
	private static readonly current = new WeakMap<LiveState, LiveBashOutput>();
}

export class SessionBash {
	private readonly host: SessionBashHost;
	private abortController: AbortController | undefined = undefined;
	private pendingMessages: Array<{ message: BashExecutionMessage; live: LiveBashOutput }> = [];

	constructor(host: SessionBashHost) {
		this.host = host;
	}

	/**
	 * Run a user shell command for a client: extensions see `user_bash` first
	 * and may return its result, which is recorded as given, or the operations
	 * it runs with.
	 */
	async runUserCommand(command: string, options: { excludeFromContext?: boolean } = {}): Promise<BashResult> {
		const excludeFromContext = options.excludeFromContext === true;
		const handled = await this.host.extensionRunner().emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.host.sessionManager.getCwd(),
		});
		if (handled?.result) {
			const result = extensionResult(handled.result);
			await this.record(command, result, { excludeFromContext });
			return result;
		}
		return this.execute(command, undefined, {
			excludeFromContext,
			...(handled?.operations === undefined ? {} : { operations: handled.operations }),
		});
	}

	/**
	 * Execute a bash command and record its result.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async execute(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		this.host.assertActive();
		if (this.host.isDisposed()) {
			throw new Error("Cannot execute bash on a disposed session");
		}
		this.host.admissionGate.assertOpen();
		if (this.host.hasSessionOperationBarrier()) {
			throw new Error("Cannot execute bash while a session mutation is active");
		}
		// A `!` command counts as conversation activity, so the session is busy while it runs.
		const releaseActivity = this.host.conversation().beginActivity("bash");
		this.abortController = new AbortController();
		this.host.activityChanged();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.host.settingsManager.getShellCommandPrefix();
		const shellPath = this.host.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			const live = new LiveBashOutput(this.host.liveState, command, options?.excludeFromContext === true);
			let result: BashResult;
			try {
				result = await executeBashWithOperations(
					resolvedCommand,
					this.host.sessionManager.getCwd(),
					options?.operations ?? createLocalBashOperations({ shellPath }),
					{
						onChunk: (chunk) => {
							live.append(chunk);
							onChunk?.(chunk);
						},
						signal: this.abortController.signal,
					},
				);
			} catch (error) {
				live.clear();
				throw error;
			}
			await this.record(command, result, options, live);
			return result;
		} finally {
			this.abortController = undefined;
			releaseActivity();
			this.host.activityChanged();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Resolves after the result commits, or at once when it is deferred until
	 * the streaming turn ends. The live `bash` value shows it until it commits.
	 */
	async record(
		command: string,
		result: BashResult,
		options?: { excludeFromContext?: boolean },
		running?: LiveBashOutput,
	): Promise<void> {
		try {
			this.host.assertActive();
		} catch (error) {
			running?.clear();
			throw error;
		}
		if (this.host.isDisposed()) {
			running?.clear();
			return;
		}
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
			cancelled: result.cancelled,
			truncated: result.truncated,
			...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
			timestamp: Date.now(),
			...(options?.excludeFromContext === undefined ? {} : { excludeFromContext: options.excludeFromContext }),
		};
		let live = running;
		if (live === undefined) {
			live = new LiveBashOutput(this.host.liveState, command, options?.excludeFromContext === true);
			live.append(result.output);
		}
		live.end(result);

		// While a turn holds the conversation, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.host.turnActive()) {
			// Queue for later - committed when the turn settles
			this.pendingMessages.push({ message: bashMessage, live });
		} else {
			try {
				await this.host.sessionWriter().appendMessage(bashMessage);
			} finally {
				live.clear();
			}
		}
		this.host.gitContextProvider.scheduleRefresh();
	}

	/** Cancel the running command. */
	abort(): void {
		this.abortController?.abort();
	}

	/** Whether a bash command is currently running */
	get running(): boolean {
		return this.abortController !== undefined;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingMessages(): boolean {
		return this.pendingMessages.length > 0;
	}

	/**
	 * Commit the results deferred while a turn held the conversation.
	 * Called after the turn settles to maintain proper message ordering.
	 */
	async flushPending(): Promise<void> {
		if (this.pendingMessages.length === 0) return;
		this.host.assertNotLost();

		const pending = this.pendingMessages;
		this.pendingMessages = [];
		try {
			await this.host
				.conversation()
				.append(pending.map(({ message }) => ({ type: "message", payload: { message } })));
		} finally {
			for (const { live } of pending) live.clear();
		}
	}
}
