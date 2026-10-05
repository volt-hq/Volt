/**
 * The session's background jobs (tools/jobs.ts). Native bash and subagent
 * tools run as jobs in the session's job tool context: a job's settled
 * result passes the session's tool-result policy, unless the job outlived
 * its branch or extension generation, and extension hooks observe the job's
 * signal. Jobs run under the tool grant that started them: a running job
 * whose tool or the jobs tool is no longer granted is cancelled.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { AdmissionGate, AgentTool, Conversation } from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import type { BackgroundJobDiagnosticEvent } from "../background-job-diagnostics.ts";
import { cloneCanonicalData } from "../canonical-data.ts";
import type { ExtensionRunner } from "../extensions/index.ts";
import { withBackgroundJobs } from "../tools/background.ts";
import type { ToolDef } from "../tools/index.ts";
import { JobRuntime, type JobToolName, jobOfDetails, jobTool } from "../tools/jobs.ts";
import type { WorkRegistry } from "../work/registry.ts";
import type { SessionTurnPolicy } from "./turn-policy.ts";

export interface SessionJobsHost {
	readonly admissionGate: AdmissionGate;
	/** The conversation's work registry: jobs are its `job` work. */
	work(): WorkRegistry;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	turnPolicy(): SessionTurnPolicy;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	isDisposed(): boolean;
	/** The branch generation: changes exactly when the active branch switches. */
	generation(): number;
	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	hasSessionOperationBarrier(): boolean;
	/** Whether the turn is executing the tool call. */
	isToolExecutionPending(toolCallId: string): boolean;
	/** Whether `name` is granted for jobs: an active trusted built-in outside Plan mode. */
	isToolGranted(name: JobToolName | "jobs"): boolean;
	recordDiagnostic(event: BackgroundJobDiagnosticEvent): void;
}

export class SessionJobs {
	/** The conversation's jobs: the `job` work kind, its executors, reads, waits, and cancels. */
	readonly runtime: JobRuntime;
	private readonly host: SessionJobsHost;
	private readonly toolContext = new AsyncLocalStorage<{
		generation: number;
		runner: ExtensionRunner;
		signal?: AbortSignal;
	}>();
	private readonly startAcknowledgements = new Set<string>();

	constructor(host: SessionJobsHost) {
		this.host = host;
		this.runtime = new JobRuntime(
			() => host.work(),
			(event) => host.recordDiagnostic(event),
		);
	}

	/** The signal extension hooks observe: a job's, or the running operation's. */
	hookSignal(): AbortSignal | undefined {
		return this.toolContext.getStore()?.signal ?? this.host.conversation().operation?.signal;
	}

	/** Whether the tool result is a job's start acknowledgement; it is consumed. */
	takeStartAcknowledgement(toolName: string, toolCallId: string): boolean {
		return this.startAcknowledgements.delete(`${toolName}:${toolCallId}`);
	}

	/** No start acknowledgement outlives its run. */
	clearRunRecords(): void {
		this.startAcknowledgements.clear();
	}

	/** Cancel running jobs whose tool or the jobs tool is no longer granted. */
	revokeUngranted(): void {
		const work = this.host.work();
		const jobsGranted = this.host.isToolGranted("jobs");
		for (const record of work.running()) {
			if (record.kind !== "job" || (jobsGranted && this.host.isToolGranted(jobTool(record.input)))) continue;
			void work.cancel(record.workId).catch(() => undefined);
		}
	}

	/**
	 * A native bash or subagent tool that can run as a background job. It runs
	 * in the session's job tool context; a job's settled result passes the
	 * session's tool-result policy, unless the job outlived its branch or
	 * extension generation.
	 */
	wrapNativeTool(name: JobToolName, definition: ToolDef): ToolDef {
		const wrapped = withBackgroundJobs(definition, {
			start: async (job) => {
				this.host.admissionGate.assertOpen();
				if (!this.host.isToolGranted("jobs") || !this.host.isToolGranted(job.tool)) {
					throw new Error(`Background ${job.tool} requires both ${job.tool} and jobs to be active.`);
				}
				return await this.runtime.start(job);
			},
			finalize: async (toolName, toolCallId, input, result, signal) => {
				this.assertToolContextCurrent(signal);
				const context = this.toolContext.getStore()!;
				const owned = cloneCanonicalData(result, `Background ${toolName} result`);
				const replacement = await this.toolContext.run({ ...context, signal }, () =>
					this.host.turnPolicy().toolResult(
						{
							toolName,
							toolCallId,
							input,
							content: owned.content,
							...(owned.details === undefined ? {} : { details: owned.details as JsonValue }),
							isError: owned.isError === true,
						},
						true,
					),
				);
				this.assertToolContextCurrent(signal);
				return cloneCanonicalData({ ...owned, ...replacement }, `Background ${toolName} final result`);
			},
		});
		return {
			...wrapped,
			execute: async (...args: Parameters<typeof wrapped.execute>) => {
				this.host.assertActive();
				this.host.admissionGate.assertOpen();
				if (this.host.hasSessionOperationBarrier()) {
					throw new Error("Cannot start a native tool during a session mutation or abort; wait for it to finish");
				}
				const result = await this.toolContext.run(
					{ generation: this.host.generation(), runner: this.host.extensionRunner() },
					() => wrapped.execute(...args),
				);
				if (!this.host.isDisposed() && this.host.isToolExecutionPending(args[0]) && jobOfDetails(result.details)) {
					this.startAcknowledgements.add(`${name}:${args[0]}`);
				}
				return result;
			},
		} as ToolDef;
	}

	private assertToolContextCurrent(signal: AbortSignal): void {
		const context = this.toolContext.getStore();
		this.host.assertActive();
		if (
			signal.aborted ||
			context?.generation !== this.host.generation() ||
			context.runner !== this.host.extensionRunner()
		) {
			throw new Error("Background tool completion was cancelled or belongs to a stale session generation");
		}
	}
}
