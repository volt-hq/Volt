/**
 * Background job metadata as clients see it: the live `jobs` value, the
 * `cancel_job` result, `job_output`, and the job a tool result's details
 * name. Output never leaves through these; only `job_output` carries it.
 */

import { Buffer } from "node:buffer";
import { stripVTControlCharacters } from "node:util";
import {
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	type RpcBackgroundJobSnapshot,
	RpcBackgroundJobSnapshotSchema,
	type RpcBackgroundJobSummary,
} from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import type { BackgroundJobSource } from "../../background-jobs.ts";

/** Whether `value` fits the wire's identifier schema, including its UTF-8 byte bound. */
function isWireIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value === value.trim() &&
		Buffer.byteLength(value, "utf8") <= RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES
	);
}

/** Whitelist metadata; never copy retained output into state or change events. */
export function projectRpcBackgroundJob(job: RpcBackgroundJobSnapshot): RpcBackgroundJobSummary {
	return {
		id: job.id,
		toolName: job.toolName,
		...(isWireIdentifier(job.toolCallId) ? { toolCallId: job.toolCallId } : {}),
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
