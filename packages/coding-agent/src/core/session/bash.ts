/**
 * User shell commands (`!` and `!!`): running one as conversation activity,
 * and recording its result in session history. A result recorded while a
 * turn holds the conversation waits until the turn settles, so it never
 * splits a tool call from its result.
 */

import type { AdmissionGate, AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import { type BashResult, executeBashWithOperations } from "../bash-executor.ts";
import type { GitContextProvider } from "../git-context-provider.ts";
import type { BashExecutionMessage } from "../messages.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type BashOperations, createLocalBashOperations } from "../tools/bash.ts";

export interface SessionBashHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly gitContextProvider: GitContextProvider;
	readonly admissionGate: AdmissionGate;
	conversation(): Conversation<AgentTool>;
	sessionWriter(): SessionWriter;
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

export class SessionBash {
	private readonly host: SessionBashHost;
	private abortController: AbortController | undefined = undefined;
	private pendingMessages: BashExecutionMessage[] = [];

	constructor(host: SessionBashHost) {
		this.host = host;
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
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.host.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this.abortController.signal,
				},
			);

			await this.record(command, result, options);
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
	 * the streaming turn ends.
	 */
	async record(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): Promise<void> {
		this.host.assertActive();
		if (this.host.isDisposed()) return;
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

		// While a turn holds the conversation, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.host.turnActive()) {
			// Queue for later - committed when the turn settles
			this.pendingMessages.push(bashMessage);
		} else {
			await this.host.sessionWriter().appendMessage(bashMessage);
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
		await this.host.conversation().append(pending.map((message) => ({ type: "message", payload: { message } })));
	}
}
