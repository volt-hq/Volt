/**
 * The provider stream the session's conversation sends turn and summary
 * requests through: request diagnostics, the tool-progress queue metrics of
 * the latest stream, and no provider retries while compacting.
 */

import { randomUUID } from "node:crypto";
import type { AgentTool, Conversation, StreamFn } from "@hansjm10/volt-agent-core";
import type { ActiveAgentRun } from "../agent-session.ts";
import type { BackgroundJobDiagnosticEvent, BackgroundJobDiagnostics } from "../background-job-diagnostics.ts";
import type { ToolProgressDiagnostics } from "../tool-progress-diagnostics.ts";

export interface SessionProviderStreamHost {
	readonly diagnostics: BackgroundJobDiagnostics;
	readonly toolProgressDiagnostics: ToolProgressDiagnostics;
	/** The provider stream requests go to. */
	readonly providerStream: StreamFn;
	conversation(): Conversation<AgentTool>;
	/** The running agent run: only its requests are diagnosed. */
	activeRun(): ActiveAgentRun | undefined;
	/** Whether a compaction or its summary request is running. */
	isCompacting(): boolean;
}

export class SessionProviderStream {
	private readonly host: SessionProviderStreamHost;
	private diagnosticRequestId?: string;

	constructor(host: SessionProviderStreamHost) {
		this.host = host;
	}

	/** Record an optional diagnostic, tagged with the running operation and request. */
	recordDiagnostic(event: BackgroundJobDiagnosticEvent): void {
		try {
			const runId = this.host.conversation()?.operation?.id;
			this.host.diagnostics.record({
				...(runId === undefined ? {} : { runId }),
				...(this.diagnosticRequestId === undefined ? {} : { requestId: this.diagnosticRequestId }),
				...event,
			});
		} catch {
			// Performance observation cannot affect the session.
		}
	}

	/** A run started or ended; its end also ends the request it last made. */
	recordRunDiagnostic(kind: "run_start" | "run_end"): void {
		this.recordDiagnostic({ kind });
		if (kind === "run_end") this.diagnosticRequestId = undefined;
	}

	async stream(
		model: Parameters<StreamFn>[0],
		context: Parameters<StreamFn>[1],
		options: Parameters<StreamFn>[2],
	): Promise<Awaited<ReturnType<StreamFn>>> {
		const compacting = this.host.isCompacting();
		const requestOptions = compacting ? { ...options, maxRetries: 0 } : options;
		const requestId =
			this.host.activeRun() && !compacting && this.host.diagnostics.enabled ? randomUUID() : undefined;
		const runId = this.host.conversation().operation?.id;
		const identity = {
			...(runId === undefined ? {} : { runId }),
			...(requestId === undefined ? {} : { requestId }),
		};
		if (requestId) {
			this.diagnosticRequestId = requestId;
			this.recordDiagnostic({ kind: "request_start", ...identity, provider: model.provider, model: model.id });
		}
		let stream: Awaited<ReturnType<StreamFn>>;
		try {
			stream = await this.host.providerStream(model, context, requestOptions);
		} catch (error) {
			if (requestId) this.recordDiagnostic({ kind: "request_end", ...identity, isError: true });
			throw error;
		}
		if (requestId) {
			void stream
				.result()
				.then((result) => {
					this.recordDiagnostic({
						kind: "request_end",
						...identity,
						usage: result.usage,
						isError: result.stopReason === "error" || result.stopReason === "aborted",
					});
				})
				.catch(() => this.recordDiagnostic({ kind: "request_end", ...identity, isError: true }));
		}
		this.host.toolProgressDiagnostics.setQueueMetricsReader(() => stream.getQueueMetrics());
		return stream;
	}
}
