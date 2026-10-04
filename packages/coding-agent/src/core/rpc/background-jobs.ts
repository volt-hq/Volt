import { stripVTControlCharacters } from "node:util";
import { RpcBackgroundJobSnapshotSchema } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";
import type { BackgroundJobSource } from "../background-jobs.ts";
import { autoCompactionState, compactionThresholdState } from "../protocol/intents/state.ts";
import { LOCAL_INTENT_PROFILE } from "../protocol/intents/types.ts";
import { isUsableRpcConversationIdentifier } from "./correlation.ts";
import type { RpcBackgroundJobSnapshot, RpcBackgroundJobSummary, RpcBackgroundJobsChangedEvent } from "./types.ts";
import { CONTEXT_AUTO_COMPACTION_ACTION_ID, CONTEXT_COMPACTION_THRESHOLD_ACTION_ID } from "./ui-action-ids.ts";

/** Whitelist metadata; never copy retained output into state or change events. */
export function projectRpcBackgroundJob(job: RpcBackgroundJobSnapshot): RpcBackgroundJobSummary {
	return {
		id: job.id,
		toolName: job.toolName,
		...(isUsableRpcConversationIdentifier(job.toolCallId) ? { toolCallId: job.toolCallId } : {}),
		label: stripVTControlCharacters(job.label).replace(/[\u0000-\u001f\u007f]/g, " "),
		status: job.status,
		startedAt: job.startedAt,
		...(job.endedAt === undefined ? {} : { endedAt: job.endedAt }),
		...(job.lastOutputAt === undefined ? {} : { lastOutputAt: job.lastOutputAt }),
		outputTruncated: job.outputTruncated,
	};
}

const backgroundJobSnapshotValidator = Compile(RpcBackgroundJobSnapshotSchema);

/** Persisted tool details are snapshots, never authority to recover or control a live job. */
export function projectRpcBackgroundJobDetails(
	details: unknown,
): { backgroundJob: RpcBackgroundJobSummary } | undefined {
	if (!details || typeof details !== "object" || !("backgroundJob" in details)) return undefined;
	return backgroundJobSnapshotValidator.Check(details.backgroundJob)
		? { backgroundJob: projectRpcBackgroundJob(details.backgroundJob) }
		: undefined;
}

export function listRpcBackgroundJobs(source: BackgroundJobSource): RpcBackgroundJobSummary[] {
	return source.list().map((job) => projectRpcBackgroundJob(source.get(job.id)));
}

/**
 * Both direct RPC and the ordered runtime feed observe the same job source.
 * Coalesce output bursts into metadata-only invalidations (at most ten per second).
 * Snapshots are captured at delivery time, so a pending callback cannot replay an
 * old branch's jobs after navigation. Detachment cancels the pending callback.
 */
export function subscribeRpcSessionEvents(
	session: Pick<AgentSession, "subscribe" | "backgroundJobs"> &
		Partial<Pick<AgentSession, "settingsManager" | "model" | "isStreaming" | "isCompacting" | "isBusy">>,
	listener: (event: AgentSessionEvent | RpcBackgroundJobsChangedEvent) => void,
	options?: { monitorGitContext?: boolean },
): () => void {
	const unsubscribeSession = session.subscribe(listener, options);
	// The same settings source backs CLI edits and remote actions, in both
	// headless and TUI-owned runtimes. Convert committed edits/profile reloads
	// into the existing ordered action-state event, never a second wire schema.
	const unsubscribeSettings = session.settingsManager?.subscribeCompactionSettings(() => {
		const view = {
			state: {
				isBusy: session.isBusy,
				isStreaming: session.isStreaming ?? false,
				isCompacting: session.isCompacting ?? false,
				model: session.model,
				settingsManager: session.settingsManager,
			},
			services: {},
			profile: LOCAL_INTENT_PROFILE,
		};
		listener({
			type: "ui_action_state_changed",
			action: CONTEXT_AUTO_COMPACTION_ACTION_ID,
			state: autoCompactionState(view),
		});
		listener({
			type: "ui_action_state_changed",
			action: CONTEXT_COMPACTION_THRESHOLD_ACTION_ID,
			state: compactionThresholdState(view),
		});
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const unsubscribeJobs = session.backgroundJobs.subscribe(() => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			try {
				listener({ type: "background_jobs_changed", jobs: listRpcBackgroundJobs(session.backgroundJobs) });
			} catch {
				// Passive presentation failures must not affect worker settlement.
			}
		}, 100);
		timer.unref();
	});
	return () => {
		unsubscribeSession();
		unsubscribeSettings?.();
		unsubscribeJobs();
		if (timer !== undefined) clearTimeout(timer);
	};
}
